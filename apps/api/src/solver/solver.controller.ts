import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type Redis from "ioredis";
import { DEFAULT_WEIGHTS, PERMISSIONS, initialsOf } from "@edutimetable/shared";
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
      /**
       * §31 — the same people, in the width a Master Grid cell actually has.
       *
       * A 27-pixel cell holds two or three characters, so the full-name map
       * above cannot serve it; `teachers.initials` is the school's own answer
       * and `initialsOf` falls back to deriving one only when they have never
       * given it. A *second* map rather than a wider `teachers` value because
       * every existing consumer of this payload indexes it as `id → name`.
       *
       * This payload is Redis-cached for an hour, so a school mid-cache will
       * be served one that predates this field. The client derives from the
       * name when the map has nothing for an id — the same function, so the
       * stale answer and the fresh one agree.
       */
      teacherInitials: Object.fromEntries(teachers.map((t) => [t.id, initialsOf(t.name, t.initials)])),
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

  /**
   * §31 — everything the Master Grid needs that a **placement** does not carry.
   *
   * `/slots` above says where the lessons ended up. This says what the school
   * intended and who the rows are: the curriculum (which is the Lesson grid
   * tab outright), each class-section's home room and class teacher, and each
   * teacher's weekly cap and what they carry in the *other* timetables of the
   * pool.
   *
   * ## One endpoint, because the strip must cost nothing to open
   *
   * §31.6's strip fills in when a cell is clicked. Clicking has to stay cheap
   * enough to do idly — that is how a screen like this is actually used — so
   * fetching four facts per click was never an option, and four endpoints for
   * one strip would be four round trips on page load instead. One payload,
   * fetched once beside `/slots`.
   *
   * ## Read off the snapshot, never re-derived
   *
   * The curriculum, the teacher caps and `crossConfigTeacherLoad` all come from
   * `buildFeasibilitySnapshot` — the same builder the solver and Readiness use.
   * The cross-pool figure especially: CLAUDE.md names it "the only
   * cross-timetable calculation in the codebase" and says never to add a
   * second, and a strip quoting a different number from the one Check 2
   * enforces would be worse than a strip that quoted none.
   *
   * Deliberately not `/class-subjects`, which serves the same curriculum rows:
   * that controller is `masters.manage` and this screen is
   * `timetable.view.all`, so a principal who may look at the whole school's
   * week would have met a 403 on one tab out of five. Same controller and same
   * permission as `/slots` means the screen answers to exactly one authority.
   *
   * Cached under the config's own slot prefix, so `invalidateTimetable` sweeps
   * it with everything else and a master-data edit (which sweeps the school)
   * takes it too. Without the cache every page load would pay for a full
   * feasibility snapshot.
   */
  @Get("context")
  @RequirePermission(PERMISSIONS.TIMETABLE_VIEW_ALL)
  async context(@Param("id") id: string) {
    const configId = toInt(id, "id");
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId },
      select: {
        id: true, workingDays: true,
        periods: { select: { periodNumber: true, isBreak: true, isExtra: true, isActivity: true } },
      },
    });
    // §17.8 — another school's id is a 404, never an empty grid that reads as
    // "this timetable teaches nothing". Asked explicitly and before anything
    // else, rather than left to the snapshot builder's own failure.
    if (!config) throw new NotFoundException("Timetable config not found");

    const cacheKey = this.keys.slots(configId, "context");
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const [sections, snapshot] = await Promise.all([
      // Its own query rather than the snapshot's `classSections`, for two
      // things the snapshot has no reason to carry: school order, and the home
      // room. `classTeacherId` is in both; the NAME is not.
      this.prisma.classSection.findMany({
        where: { timetableConfigId: configId },
        include: {
          class: true, section: true,
          homeRoom: { select: { name: true } },
          classTeacher: { select: { name: true } },
        },
        orderBy: [{ class: { sequence: "asc" } }, { section: { name: "asc" } }],
      }),
      this.readiness.buildSnapshot(configId),
    ]);

    // §3.11 — the snapshot already filters the curriculum to the config's own
    // year, which is why this does not filter it again. A class that has run
    // for three sessions would otherwise contribute three curricula to one
    // grid and the cell would show whichever loaded last.
    const requirements = snapshot.subjectRequirements;
    const subjects = [...new Map(requirements.map((r) => [r.subjectId, r.subjectName])).entries()]
      .map(([sid, name]) => ({ id: sid, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // §18: the extra window is teaching, but it is not what the timetable has
    // to fill — the same exclusion the Matrix's fill rate makes, so the row
    // total and the fill percentage are measured against the same week.
    const teaching = config.periods.filter(
      (p) => !p.isBreak && !p.isExtra && !p.isActivity && p.periodNumber !== 0 && p.periodNumber !== null,
    );

    const payload = {
      /**
       * `classId` travels with each row because **periods are a class fact**
       * (§27): `class_subjects` is keyed by class, so 5-A and 5-B are two rows
       * showing one curriculum. Emitting the cells per class rather than per
       * section is what says so — a per-section payload would look like two
       * answers that merely happen to agree.
       */
      sections: sections.map((cs) => ({
        id: cs.id,
        classId: cs.classId,
        label: `${cs.class.name}-${cs.section.name}`,
        // §19 — the room the solver claims for every non-lab lesson, so a
        // strip that names it explains most of the cells above it at once.
        homeRoom: cs.homeRoom?.name ?? null,
        classTeacher: cs.classTeacher?.name ?? null,
      })),
      subjects,
      /** [classId, subjectId, periodsPerWeek] */
      cells: requirements.map((r) => [r.classId, r.subjectId, r.periodsPerWeek]),
      /**
       * This WING's week, and deliberately not `capacityForClass` — which is
       * year-wide across every pool the class sits in because it guards a
       * *write* (§30). Here it only labels a row total, and the honest
       * denominator for "does this class's week fit" is the week this
       * timetable actually offers.
       */
      weekCapacity: teaching.length * (config.workingDays as number[]).length,
      /**
       * §28.1 / §29.3 — the cap, and what this person carries in the OTHER
       * timetables of the pool.
       *
       * `elsewhere` is what makes the strip's "22 of 30" honest. A count taken
       * from the tuples on screen is one wing's, and CLAUDE.md records exactly
       * what that costs: "a line round one wing reads 67% where the truth is
       * 87%". So the strip states the wing's number, then names the other
       * timetables and their periods rather than quietly folding them in —
       * two limits with two fixes, never a single blended figure.
       */
      teachers: Object.fromEntries(
        snapshot.teachers.map((t) => {
          const cross = snapshot.crossConfigTeacherLoad[t.id];
          return [t.id, {
            cap: t.maxPeriodsPerWeek,
            elsewhere: cross?.periods ?? 0,
            elsewhereIn: cross?.otherConfigNames ?? [],
          }];
        }),
      ),
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
