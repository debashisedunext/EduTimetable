/**
 * §22 Phase 17 — the named drafts of a timetable config.
 *
 * A school does not generate once and publish. They generate, look, tweak the
 * masters, generate again, hand-edit one, and only then decide which of the
 * three the school will live with for a term. This service owns that registry
 * and — importantly — owns the arithmetic behind the numbers they decide on.
 *
 * The stats are computed HERE and stamped onto the row. Nothing recounts 2,000
 * slots per render (§14), and nothing re-derives "how many lessons does this
 * school need" at a call site: that figure comes from Feasibility Check 1's own
 * function, the same rule §20's `min-day.ts` establishes.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { BoardEngine, runFeasibility, type SlotRow } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CacheKeysService } from "../redis/cache-keys.service";
import { buildFeasibilitySnapshot, buildSolverInput } from "../solver/input";

/**
 * §22.2 — at most this many drafts live at once per config. The limit is about
 * legibility, not disk: a Compare table nobody can read is not a comparison.
 * `discarded` rows do not count.
 */
export const MAX_LIVE_DRAFTS = 5;

/** The statuses that occupy one of those five places. */
const LIVE = ["draft", "published", "archived"] as const;

export interface DraftStats {
  requiredLessons: number;
  placedLessons: number;
  generationPct: number;
  errorCount: number;
  warningCount: number;
  lockedCount: number;
  manualCount: number;
}

@Injectable()
export class DraftsService {
  private readonly logger = new Logger(DraftsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly keys: CacheKeysService,
  ) {}

  /** Every draft of a config, newest first, with its stamped numbers. */
  async list(configId: number) {
    await this.assertConfig(configId);
    const rows = await this.prisma.timetableDraft.findMany({
      where: { timetableConfigId: configId, status: { not: "discarded" } },
      orderBy: { draftNo: "desc" },
    });
    return rows.map((d) => ({
      id: d.id,
      draftNo: d.draftNo,
      label: d.label,
      status: d.status,
      requiredLessons: d.requiredLessons,
      placedLessons: d.placedLessons,
      generationPct: d.generationPct === null ? null : Number(d.generationPct),
      errorCount: d.errorCount,
      warningCount: d.warningCount,
      lockedCount: d.lockedCount,
      manualCount: d.manualCount,
      solverStats: d.solverStats,
      generatedAt: d.generatedAt,
      createdAt: d.createdAt,
      publishedAt: d.publishedAt,
    }));
  }

  /**
   * The draft a request means when it does not say.
   *
   * Prefers the newest editable draft, falling back to the newest of anything
   * that is not discarded. This is what keeps Phase 17 invisible to a school
   * that only ever has one draft: every existing screen keeps working without
   * passing an id, and sees exactly what it saw before.
   */
  async currentId(configId: number): Promise<number | null> {
    // The newest editable draft THAT HAS SOMETHING IN IT.
    //
    // `slots: { some: {} }` is load-bearing, not a tidy-up. Generate creates
    // its draft immediately and the worker fills it seconds later; without
    // this the board would switch to the empty new draft the moment the button
    // was pressed and show a blank week until the solver finished — silently
    // losing sight of the timetable the admin was looking at. An empty draft
    // becomes current the moment it has rows, which is exactly when it is
    // worth looking at.
    const filled = await this.prisma.timetableDraft.findFirst({
      where: { timetableConfigId: configId, status: "draft", slots: { some: {} } },
      orderBy: { draftNo: "desc" },
      select: { id: true },
    });
    if (filled) return filled.id;
    const editable = await this.prisma.timetableDraft.findFirst({
      where: { timetableConfigId: configId, status: "draft" },
      orderBy: { draftNo: "desc" },
      select: { id: true },
    });
    if (editable) return editable.id;
    const any = await this.prisma.timetableDraft.findFirst({
      where: { timetableConfigId: configId, status: { not: "discarded" } },
      orderBy: { draftNo: "desc" },
      select: { id: true },
    });
    return any?.id ?? null;
  }

  /**
   * Resolve a caller-supplied draft id, or fall back to the current one.
   * Refuses an id belonging to another config — a draft id is not a capability.
   */
  async resolve(configId: number, draftId?: number | null): Promise<number | null> {
    if (draftId === undefined || draftId === null) return this.currentId(configId);
    const row = await this.prisma.timetableDraft.findFirst({
      where: { id: draftId, timetableConfigId: configId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException(`Draft ${draftId} is not a draft of this timetable`);
    return row.id;
  }

  /** Create the next draft, optionally seeded from an existing one. */
  async create(
    configId: number,
    opts: { label?: string | null; copyFromDraftId?: number | null; copyPublished?: boolean } = {},
  ) {
    await this.assertConfig(configId);
    const live = await this.prisma.timetableDraft.count({
      where: { timetableConfigId: configId, status: { in: [...LIVE] } },
    });
    if (live >= MAX_LIVE_DRAFTS) {
      // Name BOTH ways out. The message used to offer only "discard one", which
      // reads as "throw work away to carry on" — and the Generate screen's own
      // draft picker is the other answer: overwrite one you no longer want.
      throw new BadRequestException(
        `This timetable already has ${live} drafts, the most that stay readable side by side. ` +
          `Choose an existing draft to generate into on the Generate screen, or discard one on the Board.`,
      );
    }
    const last = await this.prisma.timetableDraft.findFirst({
      where: { timetableConfigId: configId },
      orderBy: { draftNo: "desc" },
      select: { draftNo: true },
    });
    const schoolId = this.tenant.requireSchoolId();
    const draft = await this.prisma.timetableDraft.create({
      data: {
        schoolId,
        timetableConfigId: configId,
        draftNo: (last?.draftNo ?? 0) + 1,
        label: opts.label ? String(opts.label).slice(0, 80) : null,
      },
    });

    if (opts.copyFromDraftId != null || opts.copyPublished) {
      await this.copyInto(configId, draft.id, opts);
      await this.recompute(configId, draft.id);
    }
    return draft;
  }

  /**
   * Seed a new draft from another draft or from the published set.
   *
   * `source='extra'` rows are deliberately never copied: §18 puts them outside
   * any draft, once per config, in both statuses. Copying them would give the
   * config two of every extra class the moment a second draft existed.
   */
  private async copyInto(
    configId: number,
    intoDraftId: number,
    opts: { copyFromDraftId?: number | null; copyPublished?: boolean },
  ) {
    const rows = await this.prisma.timetableSlot.findMany({
      where: opts.copyFromDraftId != null
        ? { timetableConfigId: configId, status: "draft", draftId: opts.copyFromDraftId, source: { not: "extra" } }
        : { timetableConfigId: configId, status: "published", source: { not: "extra" } },
    });
    if (rows.length === 0) return;
    await this.prisma.timetableSlot.createMany({
      data: rows.map((r) => ({
        schoolId: r.schoolId,
        timetableConfigId: configId,
        status: "draft" as const,
        draftId: intoDraftId,
        classSectionId: r.classSectionId,
        dayOfWeek: r.dayOfWeek,
        periodNumber: r.periodNumber,
        subjectId: r.subjectId,
        teacherId: r.teacherId,
        roomId: r.roomId,
        mergedGroupId: r.mergedGroupId,
        electiveBlockId: r.electiveBlockId,
        electiveOptionId: r.electiveOptionId,
        teacherOccupancyKey: r.teacherOccupancyKey,
        isLocked: r.isLocked,
        source: r.source,
      })),
    });
  }

  async rename(configId: number, draftId: number, label: string | null) {
    await this.assertOwned(configId, draftId);
    await this.prisma.timetableDraft.update({
      where: { id: draftId },
      data: { label: label ? String(label).slice(0, 80) : null },
    });
    return { ok: true };
  }

  /**
   * Discard a draft: its slots go, the registry row stays as `discarded`.
   *
   * The rows must be deleted explicitly and first — the FK is RESTRICT because
   * `draft_id` is the base column of the generated `draft_scope`, and MySQL
   * refuses SET NULL there. That refusal is right on the merits: orphaned rows
   * would collapse to scope 0 and collide with the published set.
   */
  async discard(configId: number, draftId: number) {
    const draft = await this.assertOwned(configId, draftId);
    if (draft.status === "published") {
      throw new BadRequestException(
        "This draft is the published timetable — publish another one before discarding it",
      );
    }
    await this.prisma.$transaction([
      this.prisma.timetableSlot.deleteMany({ where: { timetableConfigId: configId, draftId } }),
      this.prisma.timetableDraft.update({ where: { id: draftId }, data: { status: "discarded" } }),
    ]);
    // The discarded draft's cached payload would otherwise outlive it, and
    // discarding also changes which draft a request with no id resolves to.
    await this.keys.invalidateTimetable(configId);
    return { ok: true };
  }

  async archive(configId: number, draftId: number, archived: boolean) {
    // Archiving moves a draft out of `status:'draft'`, so the draft a request
    // with no id resolves to can change — the cached default must go with it.
    const draft = await this.assertOwned(configId, draftId);
    if (draft.status === "published") {
      throw new BadRequestException("The published draft cannot be archived");
    }
    await this.prisma.timetableDraft.update({
      where: { id: draftId },
      data: { status: archived ? "archived" : "draft" },
    });
    await this.keys.invalidateTimetable(configId);
    return { ok: true };
  }

  /**
   * §22.3 — recompute this draft's numbers and stamp them on the row.
   *
   * Required and placed are BOTH counted in grid cells. Counting placed as
   * "section rows + elective option rows" (the *lesson* meaning) against a
   * required figure that counts a block once per member section reports 105%
   * for any school with electives — the two sides have to share a unit.
   */
  async recompute(configId: number, draftId: number, extra?: { solverStats?: unknown; generatedAt?: Date }) {
    await this.assertOwned(configId, draftId);
    const stats = await this.computeStats(configId, draftId);
    await this.prisma.timetableDraft.update({
      where: { id: draftId },
      data: {
        requiredLessons: stats.requiredLessons,
        placedLessons: stats.placedLessons,
        generationPct: stats.generationPct,
        errorCount: stats.errorCount,
        warningCount: stats.warningCount,
        lockedCount: stats.lockedCount,
        manualCount: stats.manualCount,
        ...(extra?.solverStats !== undefined ? { solverStats: extra.solverStats as never } : {}),
        ...(extra?.generatedAt ? { generatedAt: extra.generatedAt } : {}),
      },
    });
    return stats;
  }

  async computeStats(configId: number, draftId: number): Promise<DraftStats> {
    const snapshot = await buildFeasibilitySnapshot(this.prisma, configId);
    // Check 1's own arithmetic — never re-derived here (the §20 rule).
    const requiredLessons = runFeasibility(snapshot).stats.totalRequiredSlots;

    const rows = await this.prisma.timetableSlot.findMany({
      where: { timetableConfigId: configId, status: "draft", draftId },
    });
    const teaching = new Set(
      (
        await this.prisma.period.findMany({
          where: { timetableConfigId: configId, isBreak: false, isExtra: false },
          select: { periodNumber: true },
        })
      )
        .map((p) => p.periodNumber)
        .filter((n): n is number => n !== null && n !== 0),
    );

    const cells = rows.filter(
      (r) => r.classSectionId !== null && r.source !== "extra" && teaching.has(r.periodNumber),
    );
    const placedLessons = cells.length;
    const lockedCount = cells.filter((r) => r.isLocked).length;
    const manualCount = cells.filter((r) => r.source === "manual").length;

    // Hard-constraint violations on the grid as stored (§22.3). Zero right
    // after a solve; they appear when the masters move underneath a draft.
    let violations = 0;
    try {
      const input = await buildSolverInput(this.prisma, configId, draftId);
      const slotRows: SlotRow[] = rows
        .filter((r) => r.source !== "extra")
        .filter((r) => r.electiveBlockId !== null || (r.subjectId !== null && r.teacherId !== null))
        .map((r) => ({
          classSectionId: r.classSectionId,
          dayOfWeek: r.dayOfWeek,
          periodNumber: r.periodNumber,
          subjectId: r.subjectId,
          teacherId: r.teacherId,
          roomId: r.roomId,
          mergedGroupId: r.mergedGroupId,
          electiveBlockId: r.electiveBlockId,
          electiveOptionId: r.electiveOptionId,
          isLocked: r.isLocked,
        }));
      violations = new BoardEngine(input, slotRows).violations().length;
    } catch (e) {
      // A config too incomplete to build a solver input cannot be replayed —
      // report the unplaced count alone rather than failing the whole card.
      this.logger.warn(`draft ${draftId}: violation replay skipped — ${(e as Error).message}`);
    }

    const unplaced = Math.max(0, requiredLessons - placedLessons);
    return {
      requiredLessons,
      placedLessons,
      generationPct: requiredLessons > 0 ? Math.round((placedLessons / requiredLessons) * 10000) / 100 : 0,
      errorCount: unplaced + violations,
      // §20 short teacher days and friends arrive from the solver's own stats;
      // until a draft has been generated there is nothing advisory to report.
      warningCount: 0,
      lockedCount,
      manualCount,
    };
  }

  /** Public form of the same check, for controllers that must run it first. */
  async assertConfigOwned(configId: number) {
    return this.assertConfig(configId);
  }

  private async assertConfig(configId: number) {
    const cfg = await this.prisma.timetableConfig.findFirst({ where: { id: configId }, select: { id: true } });
    if (!cfg) throw new NotFoundException("Timetable config not found");
  }

  /** A draft id from a request is never trusted to belong to this config. */
  async assertOwned(configId: number, draftId: number) {
    const draft = await this.prisma.timetableDraft.findFirst({
      where: { id: draftId, timetableConfigId: configId },
    });
    if (!draft) throw new NotFoundException(`Draft ${draftId} is not a draft of this timetable`);
    return draft;
  }

  /**
   * §22 — a draft that generation may write into.
   *
   * `assertOwned` on its own would accept a *discarded* one, which is not shown
   * anywhere: generating into it would silently resurrect a draft the school
   * threw away, and the result would appear on no screen and in no picker.
   */
  async assertWritable(configId: number, draftId: number) {
    const draft = await this.assertOwned(configId, draftId);
    if (draft.status === "discarded") {
      throw new BadRequestException(
        `Draft #${draft.draftNo} was discarded, so generating into it would produce a timetable no screen shows. ` +
          `Pick another draft, or create a new one.`,
      );
    }
    return draft;
  }
}
