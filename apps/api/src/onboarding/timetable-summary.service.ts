/**
 * §38 — what this timetable actually IS, once it is published.
 *
 * Asked for as the guided setup's last step: *"there should be one more step
 * which should be visible after timetable publish, where it should show the
 * summary of current timetable — number of slots, how much generated, % of
 * generation, class-wise allocation and generated, teachers involved for this
 * timetable, their allocation and load."*
 *
 * ## It composes; it does not calculate
 *
 * Every figure here already has an owner, and this asks that owner rather than
 * working it out again. That is the rule this codebase has had to relearn
 * repeatedly — `weekPeriods`, `initialsOf`, `coverage.ts`, §29.3's borrowed
 * `cap` and `load` — because the failure is never a crash. It is two screens
 * quoting different numbers for the same week, with nothing to say which is
 * right.
 *
 * - **Required, per class-section** — Check 1's own arithmetic, surfaced on
 *   `stats.sections` (§38 added the field rather than the sum). Curriculum rows
 *   for the class plus the §4.9 blocks that section attends, against a week
 *   already reduced by §4.7b class time off.
 * - **Placed** — counted from the rows themselves, which is the only honest
 *   source for "what is on the wall".
 * - **Teacher capacity** — `teacherWeeklyCapacity`, the same function Check 2
 *   scores against, so this cannot contradict the Readiness warning beside it.
 * - **Teacher load** — `crossConfigTeacherLoad`, which is §30.11's ONE
 *   cross-timetable calculation. §29.3a's rule applies directly: a figure drawn
 *   round one wing reads 67% where the truth is 87%, so the other wings are
 *   NAMED rather than folded in or ignored.
 *
 * ## Which rows count as "the timetable"
 *
 * Published rows if there are any, otherwise the current draft — §29.6's
 * `weekScopeFor`, reused rather than re-decided. The step is meant for a
 * published timetable, but a school looking at it mid-build should see its
 * draft rather than an empty screen claiming nothing has been generated.
 *
 * **§18 extras are excluded throughout.** Next week's revision class is not
 * part of the week this summarises, and counting it would inflate both the
 * generation percentage and every teacher's load.
 */
import { Injectable, NotFoundException } from "@nestjs/common";
import { initialsOf, runFeasibility, teacherWeeklyCapacity } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { DraftsService } from "../drafts/drafts.service";
import { buildFeasibilitySnapshot } from "../solver/input";
import { slotsIn, weekScopeFor } from "../staffing/staffing-week";

export interface ClassLine {
  id: number;
  label: string;
  required: number;
  placed: number;
  /** Periods the section's week can hold, net of §4.7b time off. */
  available: number;
}

export interface TeacherLine {
  id: number;
  name: string;
  initials: string;
  /** Lessons this teacher holds IN THIS timetable. */
  periods: number;
  /** Their whole week, across every timetable in the §30 pool. */
  totalPeriods: number;
  /** The other timetables that total includes, named (§29.3a). */
  otherTimetables: string[];
  /** Check 2's capacity — `teacherWeeklyCapacity`, never a second figure. */
  capacity: number;
  /** Percent of capacity, on the TOTAL. Null when no capacity is stated. */
  loadPct: number | null;
  /** Over their stated weekly maximum. */
  over: boolean;
}

export interface TimetableSummary {
  id: number;
  name: string;
  academicYear: string | null;
  /** Which rows this describes, in words. */
  where: string;
  published: boolean;
  version: number | null;
  publishedAt: Date | null;
  frozenAt: Date | null;
  totals: {
    classSections: number;
    teachers: number;
    /** Lessons the curriculum asks for, across every section. */
    required: number;
    /** Lessons actually placed. */
    placed: number;
    /** Placed ÷ required, as a percentage. Null when nothing is required. */
    pct: number | null;
    /** Cells the week physically holds. */
    capacity: number;
    rooms: number;
  };
  classes: ClassLine[];
  teachers: TeacherLine[];
}

@Injectable()
export class TimetableSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
    private readonly drafts: DraftsService,
  ) {}

  async forConfig(configId: number): Promise<TimetableSummary> {
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId },
      select: {
        id: true,
        name: true,
        frozenAt: true,
        academicYear: { select: { name: true } },
      },
    });
    // §17.8 — another school's id is a 404, never an empty summary that reads
    // as "this timetable teaches nobody".
    if (!config) throw new NotFoundException(`Timetable ${configId} not found`);

    const [publication, scope] = await Promise.all([
      this.prisma.timetablePublication.findFirst({
        where: { timetableConfigId: configId, withdrawnAt: null },
        orderBy: { version: "desc" },
        select: { version: true, publishedAt: true },
      }),
      weekScopeFor(this.prisma as never, configId, (id) => this.drafts.currentId(id)),
    ]);

    const [result, snapshot, slots] = await Promise.all([
      this.readiness.getReadiness(configId),
      buildFeasibilitySnapshot(this.prisma as never, configId),
      this.prisma.timetableSlot.findMany({
        where: {
          timetableConfigId: configId,
          ...slotsIn(scope),
          // §18 — next week's revision class is not part of this week.
          source: { not: "extra" },
        },
        select: { classSectionId: true, teacherId: true, roomId: true },
      }),
    ]);

    /*
      §31 — the school's OWN initials, not a derivation.

      `initialsOf` returns the stored value untouched and derives three
      characters only for a teacher who has never been given any. The snapshot
      does not carry the column, so it is read here and handed to that one
      function rather than being shortened locally — two derivations is how the
      same person became `RKS` on one screen and `RK` on the next.
    */
    const stored = new Map(
      (await this.prisma.teacher.findMany({ select: { id: true, initials: true } }))
        .map((t) => [t.id, t.initials] as const),
    );

    /*
      Placed, per class-section.

      A §4.9 option row carries `class_section_id = NULL` by design (invariant
      9), so it lands in no section's count — which is right: the section's own
      MEMBER row is the cell it occupies, and counting the options as well would
      credit one language block as three lessons.
    */
    const placedBySection = new Map<number, number>();
    const periodsByTeacher = new Map<number, number>();
    const rooms = new Set<number>();
    for (const s of slots) {
      if (s.classSectionId !== null) {
        placedBySection.set(s.classSectionId, (placedBySection.get(s.classSectionId) ?? 0) + 1);
      }
      if (s.teacherId !== null) {
        periodsByTeacher.set(s.teacherId, (periodsByTeacher.get(s.teacherId) ?? 0) + 1);
      }
      if (s.roomId !== null) rooms.add(s.roomId);
    }

    /*
      A readiness payload written before §38 has no `stats.sections`.

      Readiness is cached for an hour, so for the hour after a deploy every
      school's summary would read the field as `undefined` — a crash at best,
      and at worst (with a bare `?? []`) a confident "0 class-sections" for a
      timetable full of them. Neither is acceptable for a screen whose whole job
      is to state what the timetable contains.

      So it is treated as a cache MISS rather than as data: recompute once from
      the snapshot in hand, using the same `runFeasibility` the service itself
      calls. Self-healing, and it costs nothing on any payload written since.
    */
    const sections = result.stats.sections ?? runFeasibility(snapshot).stats.sections ?? [];

    const classes: ClassLine[] = sections.map((sec) => ({
      id: sec.id,
      label: sec.label,
      required: sec.required,
      available: sec.available,
      placed: placedBySection.get(sec.id) ?? 0,
    }));

    /*
      §31 — the working week, for `teacherWeeklyCapacity`.

      Read off the snapshot rather than multiplied here: §34 lets a weekday run
      a shape of its own, so "periods a week" stopped being a product the moment
      a short Saturday became sayable. `periodsPerDay` is the longest day, which
      is what the capacity function expects.
    */
    const perDay = snapshot.config.periodsPerDay;
    const teachers: TeacherLine[] = snapshot.teachers
      .map((t) => {
        const mine = periodsByTeacher.get(t.id) ?? 0;
        const cross = snapshot.crossConfigTeacherLoad[t.id];
        /*
          §29.3a — the whole week, and the other wings NAMED.

          `crossConfigTeacherLoad` counts this teacher across every timetable in
          the §30 pool. A percentage drawn round one wing alone is CLAUDE.md's
          own "67% where the truth is 87%", so the total is what the bar
          measures and the other timetables are listed beside it.
        */
        const total = Math.max(mine, cross?.periods ?? mine);
        const capacity = teacherWeeklyCapacity(t, snapshot.config.workingDays, perDay, [], snapshot);
        return {
          id: t.id,
          name: t.name,
          initials: initialsOf(t.name, stored.get(t.id)),
          periods: mine,
          totalPeriods: total,
          otherTimetables: cross?.otherConfigNames ?? [],
          capacity,
          loadPct: capacity > 0 ? Math.round((total / capacity) * 100) : null,
          // Against the teacher's OWN stated maximum, not the derived capacity:
          // `maxPeriodsPerWeek` is what a school typed, and it is the number
          // they will argue with.
          over: t.maxPeriodsPerWeek != null && total > t.maxPeriodsPerWeek,
        };
      })
      // Only teachers this timetable actually uses. A school's whole staff list
      // on a one-wing summary buries the twelve people it is about.
      .filter((t) => t.periods > 0)
      .sort((a, b) => b.periods - a.periods || a.name.localeCompare(b.name));

    const required = classes.reduce((n, c) => n + c.required, 0);
    const placed = classes.reduce((n, c) => n + c.placed, 0);

    return {
      id: config.id,
      name: config.name,
      academicYear: config.academicYear?.name ?? null,
      where: scope.status === "published" ? "the published timetable" : "the current draft",
      published: publication !== null,
      version: publication?.version ?? null,
      publishedAt: publication?.publishedAt ?? null,
      frozenAt: config.frozenAt,
      totals: {
        classSections: classes.length,
        teachers: teachers.length,
        required,
        placed,
        /*
          Placed ÷ REQUIRED, never ÷ capacity.

          "How much of this timetable is generated?" is about the lessons the
          school asked for, not about how many cells the week physically holds —
          a school whose curriculum fills 80% of the week is fully generated at
          80% of capacity, and a percentage against capacity would report it as
          permanently unfinished.
        */
        pct: required > 0 ? Math.round((placed / required) * 100) : null,
        capacity: result.stats.totalAvailableSlots,
        rooms: rooms.size,
      },
      classes,
      teachers,
    };
  }
}
