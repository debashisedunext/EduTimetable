/**
 * §23 — ERP master-data sync: one master, one button, one log row.
 *
 * Fetch the ERP's list → work out what would change → show the admin exactly
 * that, including what else it takes with it → write it in one transaction →
 * record what happened.
 *
 * Four rules the writes below hold to:
 *
 *  1. **Only ERP-owned fields are ever updated** on a row that survives. The
 *     payload is built from the reconciled plan, not from the incoming row, so
 *     a field the ownership table does not list cannot reach the database even
 *     if the adapter fetched it.
 *  2. **Nothing is deleted without a counted, consented impact.** Deleting a
 *     master row is not a small write here: `timetable_slots` has no foreign
 *     keys to the masters, so the database would let a teacher vanish out from
 *     under a published timetable without a word. `dependencies.ts` does that
 *     arithmetic; this file refuses to write until an admin has agreed to it.
 *  3. **The plan is recomputed on commit**, and matched against the preview by
 *     fingerprint. The request says which master and which mode — never which
 *     rows. A preview taken an hour ago cannot authorise today's deletion.
 *  4. **Every run is logged**, including the ones that fail and the ones that
 *     are refused. "We synced and nothing changed" and "the sync could not
 *     reach the ERP" look the same from the outside.
 */
import { BadRequestException, ConflictException, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  ERP_OWNED,
  SYNC_DEPENDS_ON,
  keyOf,
  reconcileSheet,
  updatePayload,
  type SyncMode,
  type SyncSheet,
  type SyncSheetPlan,
} from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { classSequence } from "../masters/class-sequence";
import { ReadinessService } from "../readiness/readiness.service";
import { ResourceGroupService } from "../groups/resource-group.service";
import { CacheKeysService } from "../redis/cache-keys.service";
import { cascadeDelete, countImpact, describeImpact, type Impact } from "./dependencies";
import { ErpSourceService } from "./erp-source.service";

export interface SyncPreview {
  sheet: SyncSheet;
  mode: SyncMode;
  configured: boolean;
  endpoint: string | null;
  plan: SyncSheetPlan;
  impact: Impact;
  /** things that will not stop the sync but change what it achieves */
  warnings: string[];
  /** true when this run deletes something — the confirmation is not optional */
  confirmRequired: boolean;
  /** binds a confirmation to the exact impact it was shown */
  fingerprint: string;
}

export interface SyncOutcome {
  runId: number;
  sheet: SyncSheet;
  mode: SyncMode;
  status: "ok" | "failed" | "blocked";
  fetched: number;
  created: number;
  updated: number;
  deleted: number;
  durationMs: number;
  error: string | null;
  /** rows the ERP sent that could not be filed — named, never silently dropped */
  unresolved: string[];
}

const yes = (v: unknown) =>
  v === true || v === 1 || v === "1" || /^(y|yes|true|active)$/i.test(String(v ?? ""));

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpSourceService,
    private readonly readiness: ReadinessService,
    private readonly cache: CacheKeysService,
    private readonly groups: ResourceGroupService,
  ) {}

  /** What we already hold, in the same column keys the ERP rows arrive in. */
  private async mine(sheet: SyncSheet): Promise<Record<string, unknown>[]> {
    switch (sheet) {
      case "Academic Years": {
        const rows = await this.prisma.academicYear.findMany();
        return rows.map((r) => ({
          id: r.id, name: r.name,
          startDate: r.startDate.toISOString().slice(0, 10),
          endDate: r.endDate.toISOString().slice(0, 10),
          isActive: r.isActive,
        }));
      }
      case "Classes": {
        const rows = await this.prisma.schoolClass.findMany();
        return rows.map((r) => ({ id: r.id, className: r.name, sequence: r.sequence }));
      }
      case "Class Sections": {
        const rows = await this.prisma.classSection.findMany({
          include: { class: true, section: true, academicYear: true },
        });
        return rows.map((r) => ({
          id: r.id,
          className: r.class.name,
          sectionName: r.section.name,
          academicYear: r.academicYear.name,
          strength: r.strength,
        }));
      }
      case "Subjects": {
        const rows = await this.prisma.subject.findMany();
        return rows.map((r) => ({ id: r.id, subjectName: r.name, code: r.code }));
      }
      case "Teachers": {
        const rows = await this.prisma.teacher.findMany();
        return rows.map((r) => ({
          id: r.id, employeeCode: r.employeeCode, name: r.name, isActive: r.isActive,
        }));
      }
    }
  }

  private label(sheet: SyncSheet, row: Record<string, unknown>): string {
    switch (sheet) {
      case "Class Sections": return `${row.className}-${row.sectionName} (${row.academicYear})`;
      case "Teachers": return `${row.employeeCode} — ${row.name}`;
      case "Subjects": return String(row.subjectName ?? "?");
      case "Classes": return String(row.className ?? "?");
      case "Academic Years": return String(row.name ?? "?");
    }
  }

  /** How many rows we hold of each master this one depends on. */
  private async dependencyWarnings(sheet: SyncSheet): Promise<string[]> {
    const out: string[] = [];
    for (const parent of SYNC_DEPENDS_ON[sheet]) {
      const held =
        parent === "Classes"
          ? await this.prisma.schoolClass.count()
          : await this.prisma.academicYear.count();
      if (held === 0) {
        out.push(
          `No ${parent} exist yet. A class-section is a class, a section and a session at once — ` +
            `sync ${parent} first or its rows cannot be filed.`,
        );
      }
    }
    return out;
  }

  /**
   * What this sync would do. Reads the ERP and our own tables; writes nothing.
   *
   * The impact count is the reason this endpoint exists. Without it the
   * confirmation could only say "this deletes data", which is not a fact
   * anybody can act on.
   */
  async preview(schoolCode: string, sheet: SyncSheet, mode: SyncMode, actingUser?: string | null): Promise<SyncPreview> {
    return (await this.gather(schoolCode, sheet, mode, actingUser)).preview;
  }

  /**
   * The preview, plus the ERP rows behind it.
   *
   * The rows are returned rather than stashed on the service: this is a
   * singleton shared by every request and every school, so instance state here
   * would leak one school's ERP rows into another school's sync (§17) — and
   * would let a second run write rows a first run had fetched.
   */
  private async gather(
    schoolCode: string,
    sheet: SyncSheet,
    mode: SyncMode,
    actingUser?: string | null,
  ): Promise<{ preview: SyncPreview; rows: Map<string, Record<string, unknown>> }> {
    const configured = this.erp.isSheetConfigured(sheet);
    const endpoint = this.erp.endpointPath(sheet);
    if (!configured) {
      throw new BadRequestException(this.erp.unconfiguredReason(sheet) ?? "This master has no API configured.");
    }

    const erpSchoolId = await this.erp.resolveSchool(schoolCode, actingUser);
    const incoming = await this.erp.fetchSheet(sheet, erpSchoolId, actingUser);
    const plan = reconcileSheet(sheet, incoming, await this.mine(sheet), (r) => this.label(sheet, r), mode);
    const rows = new Map<string, Record<string, unknown>>();
    for (const r of incoming) rows.set(keyOf(sheet, r), r);

    const removeIds = idsToRemove(plan);
    const impact = await countImpact(this.prisma, sheet, removeIds);
    const warnings = await this.dependencyWarnings(sheet);
    if (plan.read === 0) {
      warnings.push(
        `The ERP returned no ${sheet} for this school. ` +
          (mode === "replace"
            ? "Replacing with an empty list would delete everything this school holds."
            : "Nothing will be added, and every row we hold is treated as removed."),
      );
    }

    return {
      preview: {
        sheet, mode, configured, endpoint, plan, impact, warnings,
        confirmRequired: plan.remove > 0,
        fingerprint: fingerprint(sheet, mode, plan, impact),
      },
      rows,
    };
  }

  /**
   * Do it.
   *
   * The plan is recomputed here from the ERP and our own tables — the request
   * names the master, the mode and what the admin agreed to, never the rows.
   * If the recomputed impact differs from the one shown, the run is refused
   * rather than silently doing more than was consented to.
   */
  async apply(input: {
    schoolId: number;
    schoolCode: string;
    schoolName: string;
    sheet: SyncSheet;
    mode: SyncMode;
    /** the school's name, typed, when the run deletes anything */
    confirm?: string;
    /** the fingerprint the preview returned */
    fingerprint?: string;
    userId?: number | null;
    /** §23.8 — the ERP's own id for this admin, propagated to the ERP */
    actingErpUserId?: string | null;
  }): Promise<SyncOutcome> {
    const { schoolId, schoolCode, sheet, mode } = input;
    const started = Date.now();
    const endpoint = this.erp.endpointPath(sheet);

    const fail = (status: "failed" | "blocked", error: string, detail?: unknown) =>
      this.record({
        schoolId, sheet, mode, status, endpoint, error, detail,
        durationMs: Date.now() - started, userId: input.userId ?? null,
        fetched: 0, created: 0, updated: 0, deleted: 0, unresolved: [],
      });

    let preview: SyncPreview;
    let fetched: Map<string, Record<string, unknown>>;
    try {
      ({ preview, rows: fetched } = await this.gather(schoolCode, sheet, mode, input.actingErpUserId));
    } catch (e) {
      // A run that could not even read the ERP is logged too — this is the
      // history somebody checks when a card says "last sync failed".
      return fail("failed", (e as Error).message);
    }

    if (preview.impact.blocked) return fail("blocked", preview.impact.blocked);

    if (preview.confirmRequired) {
      const typed = String(input.confirm ?? "").trim().toLowerCase();
      if (typed !== input.schoolName.trim().toLowerCase()) {
        return fail(
          "blocked",
          `This run deletes ${preview.plan.remove} ${sheet} row(s) and with them ${describeImpact(preview.impact)}. ` +
            `Type the school's name to confirm.`,
          { impact: preview.impact },
        );
      }
      // Compare-and-set on what the admin actually saw (§21's discipline): the
      // ERP is somebody else's live system and its answer can change between
      // the preview and the press.
      if (input.fingerprint && input.fingerprint !== preview.fingerprint) {
        throw new ConflictException(
          "The ERP's answer changed since you previewed this. Review the new figures before applying.",
        );
      }
    }

    const removeIds = idsToRemove(preview.plan);
    const unresolved: string[] = [];
    let created = 0;
    let updated = 0;
    let deleted = 0;

    try {
      await this.prisma.$transaction(async (tx) => {
        // Deletions first: in `replace` the incoming rows carry the same names
        // and unique keys as the ones going out, so creating first would
        // collide on every row.
        if (removeIds.length > 0) {
          await cascadeDelete(tx, sheet, removeIds);
          deleted = await this.deleteMasters(tx, sheet, removeIds);
        }
        for (const row of preview.plan.rows) {
          if (row.verdict === "update") {
            if (row.id === null || row.id === undefined) continue;
            await this.applyUpdate(tx, sheet, row.id, updatePayload(row));
            updated++;
          } else if (row.verdict === "new") {
            const made = await this.applyCreate(tx, sheet, schoolId, fetched.get(row.key));
            if (made) created++;
            else unresolved.push(row.label);
          }
        }
      }, { timeout: 120_000 });
    } catch (e) {
      return fail("failed", (e as Error).message);
    }

    // Masters moved and slots may have gone with them, so everything derived
    // from either is stale — readiness, the matrix, the board, the reports.
    await this.cache.invalidateSchool(schoolId);
    await this.readiness.invalidate(schoolId);

    const outcome = await this.record({
      schoolId, sheet, mode, status: "ok", endpoint, error: null,
      durationMs: Date.now() - started, userId: input.userId ?? null,
      fetched: preview.plan.read, created, updated, deleted, unresolved,
      detail: {
        impact: preview.impact,
        changed: preview.plan.rows
          .filter((r) => r.verdict !== "unchanged")
          .slice(0, 200)
          .map((r) => ({ verdict: r.verdict, label: r.label, changes: r.changes })),
      },
    });
    this.logger.log(
      `ERP sync ${sheet} (${mode}): ${created} added, ${updated} updated, ${deleted} removed`,
    );
    return outcome;
  }

  /** The run log, newest first. */
  async runs(sheet?: SyncSheet, limit = 25) {
    return this.prisma.erpSyncRun.findMany({
      where: sheet ? { sheet } : {},
      orderBy: { id: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  /** The latest run per master, for the cards. */
  async lastRuns(): Promise<Record<string, unknown>> {
    const rows = await this.prisma.erpSyncRun.findMany({ orderBy: { id: "desc" }, take: 200 });
    const out: Record<string, unknown> = {};
    for (const r of rows) if (!out[r.sheet]) out[r.sheet] = r;
    return out;
  }

  private async record(input: {
    schoolId: number;
    sheet: SyncSheet;
    mode: SyncMode;
    status: "ok" | "failed" | "blocked";
    endpoint: string | null;
    error: string | null;
    durationMs: number;
    userId: number | null;
    fetched: number;
    created: number;
    updated: number;
    deleted: number;
    unresolved: string[];
    detail?: unknown;
  }): Promise<SyncOutcome> {
    const run = await this.prisma.erpSyncRun.create({
      data: {
        schoolId: input.schoolId,
        sheet: input.sheet,
        mode: input.mode,
        status: input.status,
        endpoint: input.endpoint?.slice(0, 255) ?? null,
        fetched: input.fetched,
        created: input.created,
        updated: input.updated,
        deleted: input.deleted,
        durationMs: input.durationMs,
        error: input.error,
        detail: (input.detail ?? (input.unresolved.length > 0 ? { unresolved: input.unresolved } : null)) as any,
        runById: input.userId,
      },
    });
    return {
      runId: run.id,
      sheet: input.sheet,
      mode: input.mode,
      status: input.status,
      fetched: input.fetched,
      created: input.created,
      updated: input.updated,
      deleted: input.deleted,
      durationMs: input.durationMs,
      error: input.error,
      unresolved: input.unresolved,
    };
  }

  /** The master rows themselves. Their dependents have already gone. */
  private async deleteMasters(tx: any, sheet: SyncSheet, ids: number[]): Promise<number> {
    const where = { id: { in: ids } };
    switch (sheet) {
      case "Academic Years": return (await tx.academicYear.deleteMany({ where })).count;
      case "Classes": return (await tx.schoolClass.deleteMany({ where })).count;
      // The `sections` rows (A, B, C under a class) are deliberately left: they
      // are the class's own alphabet, not the ERP's, and the next sync reuses
      // them rather than minting duplicates.
      case "Class Sections": return (await tx.classSection.deleteMany({ where })).count;
      case "Subjects": return (await tx.subject.deleteMany({ where })).count;
      case "Teachers": return (await tx.teacher.deleteMany({ where })).count;
    }
  }

  /** ERP-owned fields only — the payload already carries nothing else. */
  private async applyUpdate(tx: any, sheet: SyncSheet, id: number, data: Record<string, unknown>) {
    if (Object.keys(data).length === 0) return;
    // Belt and braces on top of the payload builder: if a field ever reached
    // here that the table does not own, this is where it stops.
    for (const k of Object.keys(data)) {
      if (!ERP_OWNED[sheet].includes(k)) {
        throw new Error(`§23: refusing to write ${sheet}.${k} — the ERP does not own that field`);
      }
    }
    switch (sheet) {
      case "Academic Years":
        return tx.academicYear.update({
          where: { id },
          data: {
            ...(data.name !== undefined ? { name: String(data.name) } : {}),
            ...(data.startDate !== undefined ? { startDate: new Date(String(data.startDate)) } : {}),
            ...(data.endDate !== undefined ? { endDate: new Date(String(data.endDate)) } : {}),
            ...(data.isActive !== undefined ? { isActive: yes(data.isActive) } : {}),
          },
        });
      case "Classes":
        return tx.schoolClass.update({
          where: { id },
          data: {
            ...(data.className !== undefined ? { name: String(data.className) } : {}),
            ...(data.sequence !== undefined ? { sequence: Number(data.sequence) || 0 } : {}),
          },
        });
      case "Class Sections":
        return tx.classSection.update({
          where: { id },
          data: { ...(data.strength !== undefined ? { strength: Number(data.strength) || null } : {}) },
        });
      case "Subjects":
        return tx.subject.update({
          where: { id },
          data: {
            ...(data.subjectName !== undefined ? { name: String(data.subjectName) } : {}),
            ...(data.code !== undefined ? { code: data.code === null ? null : String(data.code).slice(0, 10) } : {}),
          },
        });
      case "Teachers":
        return tx.teacher.update({
          where: { id },
          data: {
            ...(data.name !== undefined ? { name: String(data.name) } : {}),
            ...(data.isActive !== undefined ? { isActive: yes(data.isActive) } : {}),
          },
        });
    }
  }

  /**
   * A new row gets the app's own defaults for everything the ERP does not own —
   * `max_periods_per_day`, the period pattern, whether a subject is a lab. The
   * ERP has no opinion on those and inventing one from its data would be worse
   * than the default, which at least an admin knows to review.
   *
   * Returns false when the row could not be filed; the caller NAMES it rather
   * than letting it disappear into a count that looks like success.
   */
  private async applyCreate(
    tx: any,
    sheet: SyncSheet,
    schoolId: number,
    row: Record<string, unknown> | undefined,
  ): Promise<boolean> {
    if (!row) return false;
    switch (sheet) {
      case "Academic Years":
        await tx.academicYear.create({
          data: {
            schoolId, name: String(row.name),
            startDate: new Date(String(row.startDate)),
            endDate: new Date(String(row.endDate)),
            isActive: yes(row.isActive),
          },
        });
        return true;
      case "Classes": {
        // Never 0 — see `classSequence`. An ERP that does not send an order
        // used to hand every class the same one, which is not "no order", it
        // is a tie MySQL resolves differently on different days.
        const highest = await tx.schoolClass.aggregate({ where: { schoolId }, _max: { sequence: true } });
        await tx.schoolClass.create({
          data: {
            schoolId,
            name: String(row.className),
            sequence: classSequence(String(row.className), row.sequence, (highest._max.sequence ?? 0) + 1),
          },
        });
        return true;
      }
      case "Class Sections": {
        const cls = await tx.schoolClass.findFirst({ where: { schoolId, name: String(row.className) } });
        const year = await tx.academicYear.findFirst({ where: { schoolId, name: String(row.academicYear) } });
        if (!cls || !year) return false;
        const section =
          (await tx.section.findFirst({ where: { classId: cls.id, name: String(row.sectionName) } })) ??
          (await tx.section.create({ data: { schoolId, classId: cls.id, name: String(row.sectionName) } }));
        await tx.classSection.create({
          data: {
            schoolId, classId: cls.id, sectionId: section.id, academicYearId: year.id,
            // §30 — the session's shared pool, because the row is created
            // unassigned. Written explicitly and not by the type checker's
            // insistence: `tx` here is `any`, so this file is one of the few
            // where a missing required column compiles and fails at runtime.
            resourceGroupId: await this.groups.defaultFor(year.id),
            strength: row.strength === null ? null : Number(row.strength) || null,
            // Deliberately unassigned: which timetable a section belongs to is
            // a §3.10 decision the ERP knows nothing about.
            timetableConfigId: null,
          },
        });
        return true;
      }
      case "Subjects":
        await tx.subject.create({
          data: {
            schoolId, name: String(row.subjectName),
            code: row.code === null ? null : String(row.code).slice(0, 10),
          },
        });
        return true;
      case "Teachers":
        await tx.teacher.create({
          data: {
            schoolId,
            employeeCode: String(row.employeeCode).slice(0, 20),
            name: String(row.name).slice(0, 100),
            isActive: yes(row.isActive),
            // Everything below is the app's default, not the ERP's opinion.
          },
        });
        return true;
    }
  }
}

/** Our own ids the plan says to remove. */
function idsToRemove(plan: SyncSheetPlan): number[] {
  return plan.rows
    .filter((r) => r.verdict === "remove" && r.id !== null && r.id !== undefined)
    .map((r) => r.id as number);
}

/**
 * A short, stable summary of exactly what the admin was shown.
 *
 * Binds a confirmation to its own impact: if the ERP's answer moves between the
 * preview and the press, the numbers move with it and the token stops matching.
 */
export function fingerprint(sheet: SyncSheet, mode: SyncMode, plan: SyncSheetPlan, impact: Impact): string {
  const body = [
    sheet, mode,
    `c${plan.create}`, `u${plan.update}`, `r${plan.remove}`,
    ...impact.lines.map((l) => `${l.label}:${l.count}`),
    `p${impact.publishedSlots}`,
  ].join("|");
  return createHash("sha1").update(body).digest("hex").slice(0, 12);
}
