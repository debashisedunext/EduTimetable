/**
 * §21 (Phase 14.1) — Auto-resolve.
 *
 * The Readiness Dashboard names every problem and recommends a fix. This
 * applies the recommendation, for the issues where "the recommendation" is a
 * definite thing rather than a judgement call.
 *
 * Three rules shape the whole module:
 *
 *   1. **The server never applies a change the engine did not propose.** A
 *      request names issue keys and the changes the admin consented to; the
 *      engine is re-run here and only its own current remedies are applied.
 *      A crafted payload cannot write anything, because the payload is not
 *      what gets written — it is only what gets *matched*.
 *   2. **Compare and set.** Every change carries the value the field held when
 *      the admin looked at it. If it has moved since, that change is skipped
 *      and said so. Same discipline as the drag-drop board's `expect`.
 *   3. **Fixed is a verdict, not a claim.** After applying, feasibility is
 *      re-run and an issue counts as fixed only if it has actually gone. A
 *      remedy that applies cleanly and resolves nothing is reported as such,
 *      because that is a bug in the remedy and hiding it would be worse than
 *      the bug.
 */
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { runFeasibility, type FeasibilityIssue, type RemedyChange } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { buildFeasibilitySnapshot } from "../solver/input";
import { ReadinessService } from "./readiness.service";

/**
 * The only fields auto-resolve may write, by entity.
 *
 * This is the security boundary, not documentation: a `field` arriving in a
 * request is a string, and without this list it would reach Prisma. Adding a
 * remedy that touches something new means adding it here on purpose.
 */
const WRITABLE: Record<string, string[]> = {
  teacher: ["classTeacherPeriodRule", "alternateDaySet", "periodPattern", "maxPeriodsPerDay", "minPeriodsPerDay"],
  classSection: ["classTeacherId", "homeRoomId"],
  mapping: ["teacherId", "periodsPerWeek"],
  electiveOption: ["teacherId", "roomId"],
  // `placement` only — never `fixedSlots`. Auto-resolve may hand a pinned
  // block back to the solver (§4.9 Phase 15), because that is a rule the
  // school set and can be shown the cost of. It may not silently move the
  // block to a different day: choosing when a whole grade changes rooms is
  // not a decision a resolver gets to make on somebody's behalf.
  electiveBlock: ["maxPeriodsPerDay", "placement"],
  classSubject: ["maxPeriodsPerDay", "periodsPerWeek", "samePeriodAcrossWeek", "consecutiveBlockSize", "consecutiveBlocksPerWeek"],
};

/**
 * All three kinds are appliable — but only ever one at a time and only ever
 * because the admin named it.
 *
 * `relax` is not gated here because the server cannot tell "the admin ticked
 * this" from "a blanket consent swept it up": both arrive as the same list.
 * The gate that matters is on the client, where "do not ask again" covers
 * `complete` and `redistribute` and never `relax`. What the server owes is
 * the record — every outcome carries its kind, so a run that loosened a limit
 * says so in `auto_fix_runs` for as long as the log is kept.
 */
const ALLOWED_KINDS = new Set(["complete", "redistribute", "relax"]);

/** Just enough of a Prisma delegate for the two calls made here. */
interface PrismaRowDelegate {
  findFirst(args: { where: { id: number } }): Promise<Record<string, unknown> | null>;
  update(args: { where: { id: number }; data: Record<string, unknown> }): Promise<unknown>;
}

export type Outcome = "fixed" | "applied-not-resolved" | "already-resolved" | "changed" | "stale" | "refused";

export interface IssueOutcome {
  key: string;
  code: string;
  outcome: Outcome;
  /** §21: which kind of remedy this was — a relax is worth seeing in the log. */
  kind?: string;
  detail?: string;
}

/** What the client consented to, per issue. */
export interface AutoFixRequest {
  key: string;
  changes: RemedyChange[];
}

/** A change plus what it turned out to have been, so undo can reverse it. */
interface AppliedChange {
  change: RemedyChange;
  /** for `create`, the row id that came back — undo deletes it */
  createdId?: number;
}

@Injectable()
export class AutoFixService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  private async issuesOf(configId: number): Promise<{ issues: FeasibilityIssue[]; score: number }> {
    const snap = await buildFeasibilitySnapshot(this.prisma as never, configId);
    const result = runFeasibility(snap);
    return { issues: [...result.blockers, ...result.warnings], score: result.score };
  }

  /** Two change lists are the same consent, order included. */
  private same(a: RemedyChange[], b: RemedyChange[]): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  async apply(configId: number, schoolId: number, userId: number | null, requested: AutoFixRequest[]) {
    if (requested.length === 0) throw new BadRequestException("Nothing to apply");
    const config = await this.prisma.timetableConfig.findFirst({ where: { id: configId } });
    if (!config) throw new NotFoundException("Timetable config not found");

    const { issues, score: scoreBefore } = await this.issuesOf(configId);
    const byKey = new Map(issues.map((i) => [i.key ?? "", i]));

    const outcomes: IssueOutcome[] = [];
    const staged: Array<{ key: string; code: string; kind: string; changes: RemedyChange[] }> = [];

    for (const req of requested) {
      const issue = byKey.get(req.key);
      if (!issue) {
        outcomes.push({ key: req.key, code: "?", outcome: "already-resolved", detail: "Gone by the time we got here" });
        continue;
      }
      if (!issue.remedy) {
        outcomes.push({ key: req.key, code: issue.code, outcome: "refused", detail: "No remedy for this issue" });
        continue;
      }
      if (!ALLOWED_KINDS.has(issue.remedy.kind)) {
        outcomes.push({
          key: req.key, code: issue.code, outcome: "refused",
          detail: `A '${issue.remedy.kind}' remedy loosens a rule and is not applied automatically`,
        });
        continue;
      }
      // The consented change list must still be what the engine proposes. If
      // the school's data moved under the admin, the recommendation may have
      // moved with it, and applying the old one is not what they agreed to.
      if (!this.same(issue.remedy.changes, req.changes)) {
        outcomes.push({
          key: req.key, code: issue.code, outcome: "changed",
          detail: "The recommendation changed since you reviewed it — look again",
        });
        continue;
      }
      staged.push({ key: req.key, code: issue.code, kind: issue.remedy.kind, changes: issue.remedy.changes });
    }

    const applied: AppliedChange[] = [];
    const appliedKeys: string[] = [];

    if (staged.length > 0) {
      await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        for (const s of staged) {
          const stale = await this.applyChanges(tx, schoolId, s.changes, applied);
          if (stale) {
            outcomes.push({ key: s.key, code: s.code, kind: s.kind, outcome: "stale", detail: stale });
            continue;
          }
          appliedKeys.push(s.key);
        }
      });
    }

    await this.readiness.invalidate(schoolId);
    const { issues: after, score: scoreAfter } = await this.issuesOf(configId);
    const stillThere = new Set(after.map((i) => i.key));

    for (const s of staged) {
      if (!appliedKeys.includes(s.key)) continue;
      outcomes.push(
        stillThere.has(s.key)
          ? { key: s.key, code: s.code, kind: s.kind, outcome: "applied-not-resolved", detail: "The change was made but the issue remains" }
          : { key: s.key, code: s.code, kind: s.kind, outcome: "fixed" },
      );
    }

    const run = applied.length
      ? await this.prisma.autoFixRun.create({
          data: {
            schoolId,
            timetableConfigId: configId,
            appliedById: userId,
            scoreBefore,
            scoreAfter,
            changes: applied as unknown as Prisma.InputJsonValue,
            outcomes: outcomes as unknown as Prisma.InputJsonValue,
          },
        })
      : null;

    return {
      runId: run?.id ?? null,
      scoreBefore,
      scoreAfter,
      fixed: outcomes.filter((o) => o.outcome === "fixed").length,
      outcomes,
    };
  }

  /**
   * Apply one issue's changes. Returns a reason when a value has moved since
   * the admin looked, in which case nothing of this issue is written — a
   * half-applied remedy is not a remedy.
   */
  private async applyChanges(
    tx: Prisma.TransactionClient,
    schoolId: number,
    changes: RemedyChange[],
    applied: AppliedChange[],
  ): Promise<string | null> {
    const staged: AppliedChange[] = [];

    for (const c of changes) {
      if (c.op === "set") {
        const fields = WRITABLE[c.entity];
        if (!fields?.includes(c.field)) return `${c.entity}.${c.field} is not a field auto-resolve may write`;
        const row = await this.readOne(tx, c.entity, c.id);
        if (!row) return `${c.entity} #${c.id} no longer exists`;
        if (JSON.stringify(row[c.field] ?? null) !== JSON.stringify(c.from ?? null)) {
          return `${c.entity} #${c.id} ${c.field} is now ${JSON.stringify(row[c.field])}, not ${JSON.stringify(c.from)}`;
        }
        staged.push({ change: c });
      } else if (c.op === "link" || c.op === "create") {
        staged.push({ change: c });
      }
    }

    for (const s of staged) {
      const c = s.change;
      if (c.op === "set") {
        await this.delegate(tx, c.entity).update({ where: { id: c.id }, data: { [c.field]: c.to } });
      } else if (c.op === "link") {
        if (c.entity === "teacherClass") {
          // Idempotent: the pair either exists or it does not, and a second
          // press must not fail on a row the first one already made.
          await tx.teacherClassEligibility.upsert({
            where: { teacherId_classId: { teacherId: c.id, classId: c.otherId } },
            create: { teacherId: c.id, classId: c.otherId, schoolId },
            update: {},
          });
        } else {
          await tx.roomSubject.upsert({
            where: { roomId_subjectId: { roomId: c.id, subjectId: c.otherId } },
            create: { roomId: c.id, subjectId: c.otherId, schoolId },
            update: {},
          });
        }
      } else if (c.op === "create" && c.entity === "mapping") {
        const created = await tx.teacherSubjectClassSection.create({
          data: {
            schoolId,
            teacherId: Number(c.data.teacherId),
            subjectId: Number(c.data.subjectId),
            classSectionId: Number(c.data.classSectionId),
            periodsPerWeek: Number(c.data.periodsPerWeek),
          },
        });
        s.createdId = created.id;
      }
      applied.push(s);
    }
    return null;
  }

  /**
   * The Prisma model behind a remedy entity.
   *
   * Typed loosely on purpose: the five delegates have five different generated
   * argument types, and the only things called on them here are `findFirst`
   * and `update` with a field the WRITABLE list has already vetted. Narrowing
   * this properly would mean five branches of near-identical code to buy
   * type-safety that the allow-list already provides.
   */
  private delegate(tx: Prisma.TransactionClient, entity: string): PrismaRowDelegate {
    switch (entity) {
      case "teacher": return tx.teacher as unknown as PrismaRowDelegate;
      case "classSection": return tx.classSection as unknown as PrismaRowDelegate;
      case "mapping": return tx.teacherSubjectClassSection as unknown as PrismaRowDelegate;
      case "electiveOption": return tx.electiveOption as unknown as PrismaRowDelegate;
      case "electiveBlock": return tx.electiveBlock as unknown as PrismaRowDelegate;
      case "classSubject": return tx.classSubject as unknown as PrismaRowDelegate;
      default: throw new BadRequestException(`Unknown entity ${entity}`);
    }
  }

  private async readOne(tx: Prisma.TransactionClient, entity: string, id: number) {
    return this.delegate(tx, entity).findFirst({ where: { id } });
  }

  /**
   * Put a run back. Each change is reversed only if the field still holds what
   * the run left there — so an edit made by hand since is never stamped over,
   * and the ones that cannot be reversed are named rather than skipped quietly.
   */
  async undo(configId: number, schoolId: number, runId: number) {
    const run = await this.prisma.autoFixRun.findFirst({ where: { id: runId, timetableConfigId: configId } });
    if (!run) throw new NotFoundException("Auto-resolve run not found");
    if (run.undoneAt) throw new BadRequestException("This run has already been undone");

    const applied = run.changes as unknown as AppliedChange[];
    const skipped: string[] = [];
    let reversed = 0;

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Reverse order: a run can touch one field twice, and the earlier value
      // is only correct if the later change is undone first.
      for (const a of [...applied].reverse()) {
        const c = a.change;
        if (c.op === "set") {
          const row = await this.readOne(tx, c.entity, c.id);
          if (!row) { skipped.push(`${c.entity} #${c.id} no longer exists`); continue; }
          if (JSON.stringify(row[c.field] ?? null) !== JSON.stringify(c.to ?? null)) {
            skipped.push(`${c.entity} #${c.id} ${c.field} has been edited since`);
            continue;
          }
          await this.delegate(tx, c.entity).update({ where: { id: c.id }, data: { [c.field]: c.from } });
        } else if (c.op === "link") {
          if (c.entity === "teacherClass") {
            await tx.teacherClassEligibility.deleteMany({ where: { teacherId: c.id, classId: c.otherId } });
          } else {
            await tx.roomSubject.deleteMany({ where: { roomId: c.id, subjectId: c.otherId } });
          }
        } else if (c.op === "create" && a.createdId !== undefined) {
          await tx.teacherSubjectClassSection.deleteMany({ where: { id: a.createdId } });
        }
        reversed++;
      }
      await tx.autoFixRun.update({ where: { id: runId }, data: { undoneAt: new Date() } });
    });

    await this.readiness.invalidate(schoolId);
    const { score } = await this.issuesOf(configId);
    return { ok: true, reversed, skipped, score };
  }

  async runs(configId: number) {
    const rows = await this.prisma.autoFixRun.findMany({
      where: { timetableConfigId: configId },
      orderBy: { id: "desc" },
      take: 20,
    });
    return rows.map((r) => ({
      id: r.id,
      scoreBefore: r.scoreBefore,
      scoreAfter: r.scoreAfter,
      changeCount: (r.changes as unknown as unknown[]).length,
      undoneAt: r.undoneAt,
      createdAt: r.createdAt,
    }));
  }

  /** Guard for a config that is not this school's — §17.8 wants 404, not a no-op. */
  async assertOwned(configId: number) {
    const found = await this.prisma.timetableConfig.findFirst({ where: { id: configId }, select: { id: true } });
    if (!found) throw new NotFoundException(`Timetable config ${configId} not found`);
    return found;
  }
}
