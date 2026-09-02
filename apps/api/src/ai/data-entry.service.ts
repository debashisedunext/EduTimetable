/**
 * §13.5 — natural-language master-data entry.
 *
 * The assistant NEVER writes. It drafts rows; this service checks them with the
 * same `validateWorkbook` the Excel importer and the ERP sync use, stashes the
 * proposal server-side, and writes only when a human presses Apply.
 *
 * Three properties hold the whole thing up:
 *
 *  1. **One validator.** A proposal is checked by exactly the rules an upload
 *     is — duplicate detection, cross-sheet references, §4.8 blocks, the weekly
 *     capacity guard. A second validator for the AI path would eventually
 *     disagree with the first, and the disagreement would be silent.
 *  2. **The client never carries the rows.** Apply names a proposal id; the
 *     rows are re-read from the stash and RE-VALIDATED at the moment of the
 *     write. Nothing a browser holds can become a write, and a proposal drafted
 *     against yesterday's masters cannot be applied against today's.
 *  3. **The stash is school-scoped and short-lived.** Keys are `s{schoolId}:…`
 *     like every other cached value (§17), and a proposal belonging to another
 *     school is not found rather than refused — the two are the same answer
 *     from outside, which is the point.
 */
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { toRawSheets, type DraftIssue, type DraftSheet } from "@edutimetable/shared";
import { ImportService } from "../import/import.service";
import { applyUpdates, planUpdates } from "./data-entry.store";
import type { RowUpdate } from "./data-entry.update";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { REDIS } from "../redis/redis.tokens";

/** Long enough to read a preview and think; short enough not to go stale. */
const PROPOSAL_TTL_SECONDS = 30 * 60;

/** A drafted batch is a conversation's worth of rows, not a data migration. */
const MAX_ROWS_PER_PROPOSAL = 500;

export interface ProposalResult {
  proposalId: string | null;
  ok: boolean;
  /** per sheet: read / create / skip (already exists) / errors */
  sheets: Array<{ sheet: string; title: string; read: number; create: number; skip: number; errors: number }>;
  totals: { read: number; create: number; skip: number; errors: number };
  /** validator issues plus anything the adapter could not place */
  issues: Array<{ sheet: string; row: number | null; cell?: string; message: string; fix: string; severity: string }>;
  /** §13.5 Phase B — existing rows whose values would change, field by field */
  updates: RowUpdate[];
  /** a short line the assistant can read back to the user */
  summary: string;
}

@Injectable()
export class AiDataEntryService {
  private readonly logger = new Logger(AiDataEntryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly importer: ImportService,
    private readonly readiness: ReadinessService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private key(schoolId: number, id: string) {
    return `s${schoolId}:aiproposal:${id}`;
  }

  /**
   * Check a drafted batch and keep it for an Apply. Writes nothing.
   *
   * Returns a proposal id ONLY when there is something valid to write — an id
   * for a batch that cannot be applied is an invitation to press a button that
   * will fail.
   */
  async propose(schoolId: number, drafts: DraftSheet[], userId: number | null): Promise<ProposalResult> {
    if (!Array.isArray(drafts) || drafts.length === 0) {
      throw new BadRequestException("No rows were drafted.");
    }
    const rowCount = drafts.reduce((n, d) => n + (d.rows?.length ?? 0), 0);
    if (rowCount > MAX_ROWS_PER_PROPOSAL) {
      throw new BadRequestException(
        `That is ${rowCount} rows; ${MAX_ROWS_PER_PROPOSAL} is the most one proposal may carry. ` +
          `Use Import from Excel for a bulk load of this size.`,
      );
    }

    const { sheets, issues: adapterIssues, mentioned } = toRawSheets(drafts);
    if (sheets.length === 0) {
      return this.empty(adapterIssues, "Nothing could be drafted — see the notes below.");
    }

    const { plan, rows } = await this.importer.dryRunSheets(schoolId, sheets);
    // Phase B: a row that already exists is no longer simply skipped — work out
    // whether the draft actually changes anything on it. `planUpdates` reads
    // the current values, so "already exists" and "exists and differs" stop
    // being the same answer.
    const planned = plan.ok
      ? await planUpdates(this.prisma, schoolId, rows, mentioned)
      : { updates: [], issues: [] };
    const updates = planned.updates;

    const issues = [
      ...adapterIssues.map((i) => ({ ...i, severity: "warning", cell: undefined })),
      // "The sheet Academic Years is not in this file" is a true and useful
      // thing to say about an upload, and meaningless about a sentence — a
      // drafted batch names the masters it is about and no others. Ten of these
      // on every proposal buried the notes that matter.
      ...plan.issues
        .filter((i) => i.code !== "SHEET_MISSING")
        .map((i) => ({
          sheet: i.sheet, row: i.row, cell: i.cell, message: i.message, fix: i.fix, severity: i.severity,
        })),
      ...planned.issues.map((i) => ({ ...i, cell: undefined })),
    ];

    // Phase C: a refusal raised while planning a mapping change — an
    // ineligible teacher, an over-capacity load, a merged group whose teacher
    // cannot move — blocks the batch exactly as a validator error does. It is
    // the same refusal the Mapping screen gives, so it must have the same
    // force: the whole point of planning it here rather than at write time is
    // that the admin reads it beside the row instead of meeting a 400.
    const ok = plan.ok && planned.issues.every((i) => i.severity !== "error");

    // An id is minted only for a batch that can actually be applied.
    let proposalId: string | null = null;
    if (ok && (plan.totals.create > 0 || updates.length > 0)) {
      proposalId = randomUUID();
      await this.redis.set(
        this.key(schoolId, proposalId),
        JSON.stringify({ sheets, drafts, mentioned, userId, at: new Date().toISOString() }),
        "EX",
        PROPOSAL_TTL_SECONDS,
      );
    }

    // Counted from the list that is actually shown, so the number and the notes
    // beneath it cannot disagree — the SHEET_MISSING warnings are filtered out
    // above and must not still be counted here.
    const totals = {
      ...plan.totals,
      errors: issues.filter((i) => i.severity === "error").length,
      warnings: issues.filter((i) => i.severity !== "error").length,
    };
    return {
      proposalId,
      ok,
      sheets: plan.sheets.map((s) => ({
        sheet: s.sheet, title: s.title, read: s.read, create: s.create, skip: s.skip, errors: s.errors,
      })),
      totals,
      issues,
      updates,
      summary: this.summarise(totals, ok, updates.length),
    };
  }

  /**
   * Apply a proposal. The rows come from the stash, never from the request.
   *
   * Re-validated inside `commitSheets`, so a proposal drafted before somebody
   * else added the same subject is refused as a duplicate rather than being
   * written twice.
   */
  async apply(schoolId: number, proposalId: string, userId: number | null) {
    const raw = await this.redis.get(this.key(schoolId, proposalId));
    if (!raw) {
      throw new NotFoundException(
        "That proposal has expired or was already applied. Ask the assistant to draft it again.",
      );
    }
    const { sheets, mentioned } = JSON.parse(raw) as {
      sheets: Parameters<ImportService["commitSheets"]>[1];
      mentioned: Parameters<typeof planUpdates>[3];
    };

    // Re-planned here, never taken from the stash: the row may have changed
    // since the preview, and a diff computed half an hour ago is not the diff
    // that should be written now.
    const { rows } = await this.importer.dryRunSheets(schoolId, sheets);
    const replanned = await planUpdates(this.prisma, schoolId, rows, mentioned ?? []);
    const updates = replanned.updates;
    // The §18 and capacity guards ran when the preview was drawn; the world may
    // have moved since. A refusal now is refused now — never written past.
    const blocking = replanned.issues.filter((i) => i.severity === "error");
    if (blocking.length > 0) {
      throw new BadRequestException(
        `${blocking[0].message} ${blocking[0].fix} Nothing has been written — ask the assistant to draft it again.`,
      );
    }

    const result = await this.importer.commitSheets(schoolId, sheets);
    let changed = { updated: 0, skipped: [] as string[] };
    if (updates.length > 0) {
      changed = await this.prisma.$transaction(async (tx) => applyUpdates(tx, schoolId, updates), { timeout: 60_000 });
      // `applyValidated` invalidates readiness when it creates something, and
      // returns early when there is nothing to create — so a batch that ONLY
      // changes rows (the whole of Phase B and C) left the Readiness Score
      // cached at its old value. Changing a curriculum row's periods per week
      // is about as direct a change to readiness as exists.
      await this.readiness.invalidate(schoolId);
    }

    // Single-use: an applied proposal must not be applicable twice, which is
    // the whole difference between "add these ten teachers" and "add them
    // again because somebody refreshed".
    await this.redis.del(this.key(schoolId, proposalId));

    await this.prisma.auditLog.create({
      data: {
        schoolId,
        userId: userId ?? 0,
        action: "ai.data-entry.apply",
        detail: { proposalId, created: result.created, updated: changed.updated, changes: updates } as never,
      },
    });
    this.logger.log(
      `AI data entry applied: ${JSON.stringify(result.created)}, ${changed.updated} updated`,
    );
    return { ...result, updated: changed.updated, skippedFields: changed.skipped };
  }

  private empty(adapterIssues: DraftIssue[], summary: string): ProposalResult {
    return {
      proposalId: null,
      ok: false,
      sheets: [],
      totals: { read: 0, create: 0, skip: 0, errors: adapterIssues.length },
      issues: adapterIssues.map((i) => ({ ...i, severity: "error", cell: undefined })),
      updates: [],
      summary,
    };
  }

  /** What the assistant reads back. Plain counts, no encouragement. */
  private summarise(
    t: { read: number; create: number; skip: number; errors: number },
    ok: boolean,
    updateCount: number,
  ): string {
    if (!ok) return `${t.errors} problem(s) to fix before this can be written. Nothing has been written.`;
    const parts: string[] = [];
    if (t.create > 0) parts.push(`${t.create} row(s) to add`);
    if (updateCount > 0) parts.push(`${updateCount} to change`);
    // `skip` counts every existing row; the ones that differ are reported above
    // as changes, so only the genuinely untouched are worth mentioning.
    const untouched = Math.max(t.skip - updateCount, 0);
    if (untouched > 0) parts.push(`${untouched} already correct`);
    if (parts.length === 0 || (t.create === 0 && updateCount === 0)) {
      return `All ${t.read} row(s) already match what is stored — nothing to do.`;
    }
    return `${parts.join(", ")}. Nothing is written until you press Apply.`;
  }
}
