import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type Redis from "ioredis";
import { DEFAULT_WEIGHTS, PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { REDIS } from "../redis/redis.module";
import { CacheKeysService } from "../redis/cache-keys.service";
import { ReadinessService } from "../readiness/readiness.service";
import { DraftsService } from "../drafts/drafts.service";
import { FreezeService } from "../freeze/freeze.service";
import { toInt, type AuthedRequest } from "../masters/crud.util";

export const SOLVER_QUEUE = "solver";

@Controller("timetable-configs/:id")
export class SolverController {
  constructor(
    @InjectQueue(SOLVER_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
    private readonly keys: CacheKeysService,
    private readonly drafts: DraftsService,
    private readonly freeze: FreezeService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Trigger generation (§8 screen 4). Hard-gated on Phase A: not ready → 400.
   *  Phase 6: `mode: "optimized"` adds the CP-SAT soft-objective pass (§5.6). */
  @Post("generate")
  @RequirePermission(PERMISSIONS.TIMETABLE_GENERATE)
  async generate(@Req() _req: AuthedRequest, @Param("id") id: string, @Body() body?: any) {
    const configId = toInt(id, "id");
    // §29.1 — asked BEFORE readiness, so a frozen timetable is refused for
    // being frozen rather than for a blocker somebody would then try to fix.
    await this.freeze.assertConfigs([configId], "the timetable");
    const readiness = await this.readiness.getReadiness(configId);
    if (!readiness.ready) {
      throw new BadRequestException(
        `Readiness is ${readiness.score}% with ${readiness.blockers.length} blocker(s) — generation is only offered at 100% (§4)`,
      );
    }
    const mode = body?.mode === "optimized" ? "optimized" : "fast";
    const w = body?.weights ?? {};
    const weight = (v: unknown, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= 20 ? Math.round(n) : fallback;
    };
    // §22 Phase 17 — a generation writes into its OWN draft by default, so no
    // button a person presses to explore an alternative can destroy work they
    // did by hand. `draftId` in the body targets an existing one deliberately.
    const draft =
      body?.draftId != null
        ? await this.drafts.assertWritable(configId, toInt(body.draftId, "draftId"))
        : await this.drafts.create(configId, { label: body?.label ?? null });
    const job = await this.queue.add("solve", {
      configId,
      draftId: draft.id,
      // The worker opens its tenant context from this, and the gateway routes
      // progress events by it — a solver job is not school-agnostic work
      // (9.1 / §17).
      schoolId: _req.user.schoolId,
      // ...and which database that school lives in (9.4 / §17.5)
      tenantId: _req.user.tenantId ?? null,
      userId: _req.user.sub,
      mode,
      weights: {
        teacherGaps: weight(w.teacherGaps, DEFAULT_WEIGHTS.teacherGaps),
        dailyLoadBalance: weight(w.dailyLoadBalance, DEFAULT_WEIGHTS.dailyLoadBalance),
        roomChanges: weight(w.roomChanges, DEFAULT_WEIGHTS.roomChanges),
      },
      optimizeBudgetSec: Math.min(120, Math.max(5, Number(body?.optimizeBudgetSec) || 30)),
    });
    return { jobId: job.id, mode, draftId: draft.id, draftNo: draft.draftNo, draftStatus: draft.status };
  }

  /**
   * Compact slot matrix (§8.3, perf budget §14): flat arrays, no ORM graphs,
   * Redis-cached until the next write. meta carries the display dictionaries.
   */
  @Get("slots")
  @RequirePermission(PERMISSIONS.TIMETABLE_VIEW_ALL)
  async slots(
    @Param("id") id: string,
    @Query("status") statusQ?: string,
    @Query("date") dateQ?: string,
    @Query("draftId") draftQ?: string,
  ) {
    const configId = toInt(id, "id");
    const status = statusQ === "published" ? "published" : "draft";
    // §22 — which named draft to render. Omitted means the config's current
    // one, so every screen that has never heard of drafts keeps working and a
    // single-draft school sees exactly what it saw before Phase 17.
    const draftId =
      status === "draft"
        ? await this.drafts.resolve(configId, draftQ ? toInt(draftQ, "draftId") : null)
        : null;
    // §6 overlay (task 4.5): a date on the published view layers that day's
    // substitutions over the base grid — the stored rows are never mutated
    const date = status === "published" && dateQ && /^\d{4}-\d{2}-\d{2}$/.test(dateQ) ? dateQ : null;
    const cacheKey = this.keys.slots(
      configId,
      `${status}${draftId !== null ? `:d${draftId}` : ""}${date ? `:${date}` : ""}`,
    );
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const [slots, sections, config] = await Promise.all([
      this.prisma.timetableSlot.findMany({
        // §18 extras belong to no draft and show in both statuses, so they are
        // included whichever alternative future is being looked at.
        where: {
          timetableConfigId: configId,
          status,
          ...(draftId !== null ? { OR: [{ draftId }, { source: "extra" as const }] } : {}),
        },
        select: {
          id: true, classSectionId: true, dayOfWeek: true, periodNumber: true,
          subjectId: true, teacherId: true, roomId: true, mergedGroupId: true, isLocked: true,
          electiveBlockId: true,
        },
      }),
      this.prisma.classSection.findMany({
        where: { timetableConfigId: configId },
        include: { class: true, section: true },
        orderBy: [{ class: { sequence: "asc" } }, { section: { name: "asc" } }],
      }),
      this.prisma.timetableConfig.findUnique({
        where: { id: configId },
        include: {
          periods: {
            orderBy: { sortOrder: "asc" },
            // §28.3 — the duty teacher and the room travel with the band, so a
            // timetable can print "Assembly · 20 min · R.J. · Hall" without a
            // second round trip per row.
            include: {
              activity: {
                include: {
                  teacher: { select: { name: true, initials: true } },
                  room: { select: { name: true } },
                },
              },
            },
          },
        },
      }),
    ]);
    if (!config) throw new BadRequestException("Timetable config not found");

    // §4.9 split electives. The grid is per class-section, so only the member
    // rows are cells; the option rows (class_section_id NULL) are the lessons
    // underneath, and they travel as a dictionary the cell can point into.
    const blockIds = [...new Set(slots.map((s) => s.electiveBlockId).filter((x): x is number => x !== null))];
    const blockRows = blockIds.length
      ? await this.prisma.electiveBlock.findMany({
          where: { id: { in: blockIds } },
          include: { options: { include: { subject: true, teacher: true, room: true } } },
        })
      : [];
    const blocks = Object.fromEntries(
      blockRows.map((b) => [
        b.id,
        {
          name: b.name,
          options: b.options.map((o) => ({
            subject: o.subject.name,
            teacher: o.teacher.name,
            room: o.room.name,
          })),
        },
      ]),
    );

    // date overlay: slotId -> substitute teacher for that specific date
    const subBydSlot = new Map<string, number>();
    if (date) {
      const subs = await this.prisma.substitutionLog.findMany({
        where: { date: new Date(`${date}T00:00:00.000Z`), timetableSlotId: { in: slots.map((s) => s.id) } },
      });
      for (const r of subs) subBydSlot.set(r.timetableSlotId.toString(), r.substituteTeacherId);
    }

    const subjectIds = [...new Set(slots.map((s) => s.subjectId).filter((x): x is number => x !== null))];
    const teacherIds = [
      ...new Set([
        ...slots.map((s) => s.teacherId).filter((x): x is number => x !== null),
        ...subBydSlot.values(),
      ]),
    ];
    const roomIds = [...new Set(slots.map((s) => s.roomId).filter((x): x is number => x !== null))];
    const [subjects, teachers, rooms] = await Promise.all([
      this.prisma.subject.findMany({ where: { id: { in: subjectIds } } }),
      this.prisma.teacher.findMany({ where: { id: { in: teacherIds } } }),
      this.prisma.room.findMany({ where: { id: { in: roomIds } } }),
    ]);

    const payload = {
      status,
      draftId,
      workingDays: config.workingDays as number[],
      periods: config.periods.map((p) => ({
        periodNumber: p.periodNumber, startTime: p.startTime, endTime: p.endTime,
        isBreak: p.isBreak, breakName: p.breakName,
        // §18: after the teaching day, rendered as its own band.
        isExtra: p.isExtra,
        // §28.3/28.4: assembly, dispersal. `breakName` carries the label — the
        // column is the row's name whether it is a break or an activity — and
        // these two say who is on duty, which is the whole difference.
        isActivity: p.isActivity,
        activityTeacher: p.activity?.teacher?.initials ?? p.activity?.teacher?.name ?? null,
        activityRoom: p.activity?.room?.name ?? null,
        activityDays: (p.activity?.days as number[] | undefined) ?? null,
      })),
      sections: sections.map((cs) => ({ id: cs.id, label: `${cs.class.name}-${cs.section.name}` })),
      subjects: Object.fromEntries(subjects.map((s) => [s.id, s.name])),
      teachers: Object.fromEntries(teachers.map((t) => [t.id, t.name])),
      rooms: Object.fromEntries(rooms.map((r) => [r.id, r.name])),
      date,
      /** §4.9 blocks referenced by the tuples below: name + its parallel options. */
      blocks,
      // compact tuples: [classSectionId, day, period, subjectId, teacherId, roomId, mergedGroupId, locked, substituted, electiveBlockId]
      // with a date overlay, teacherId is the SUBSTITUTE for that date and substituted = 1
      //
      // §4.9 invariant 9 draws the line between "a grid cell" and "a lesson",
      // and this payload feeds BOTH: the By Class-Section grid (cells) and the
      // By Teacher grid (lessons). It used to drop option rows here, which
      // made a teacher who ONLY takes elective options — a third-language
      // teacher, typically — look completely unscheduled on the Allocation
      // Matrix and the Draft Board. The filtering belongs at each consumer,
      // where the meaning is known: `classSectionId === null` marks an option
      // row, so a section grid skips it and a teacher grid keeps it.
      slots: slots
        .map((s) => {
          const sub = subBydSlot.get(s.id.toString());
          return [
            s.classSectionId, s.dayOfWeek, s.periodNumber,
            s.subjectId, sub ?? s.teacherId, s.roomId, s.mergedGroupId, s.isLocked ? 1 : 0,
            sub !== undefined ? 1 : 0, s.electiveBlockId,
          ];
        }),
    };
    await this.redis.set(cacheKey, JSON.stringify(payload), "EX", 3600);
    return payload;
  }

  /** Latest solver job summary for the Generate screen's result panel. */
  @Get("generate/latest")
  @RequirePermission(PERMISSIONS.TIMETABLE_GENERATE)
  async latest(@Req() req: AuthedRequest, @Param("id") id: string) {
    const configId = toInt(id, "id");
    // Scoped, so another school's config simply is not here. Without this the
    // endpoint answered `{state: "none"}` for it — truthful about the job, but
    // it makes "that timetable is not yours" and "that timetable has never
    // been generated" the same reply (§17.8).
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId },
      select: { id: true },
    });
    if (!config) throw new NotFoundException("Timetable config not found");

    const jobs = await this.queue.getJobs(["completed", "failed", "active", "waiting"], 0, 20);
    const mine = jobs
      // BullMQ is one shared queue across every school, so the school must be
      // matched as well as the config — a config id alone would expose another
      // school's job summary, unplaced list and failure reason (9.1 / §17).
      .filter((j) => j.data?.configId === configId && j.data?.schoolId === req.user.schoolId)
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (!mine) return { state: "none" };
    const state = await mine.getState();
    return {
      state,
      jobId: mine.id,
      result: mine.returnvalue ?? null,
      failedReason: mine.failedReason ?? null,
    };
  }
}
