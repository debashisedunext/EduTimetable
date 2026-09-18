/**
 * §37 — reading a timetable's staffing requirement out of the database.
 *
 * The arithmetic is in `packages/shared` (`analyseRequirement`), unit-tested
 * there, and nothing in this file re-derives any of it. What lives here is the
 * part that can only be done against real rows: which classes this timetable
 * teaches, what its curriculum says, who is declared able to teach what, and —
 * the two numbers worth arguing about — each teacher's capacity and load.
 *
 * ## Capacity and load are borrowed, never recomputed
 *
 * `cap` is §4.2/§4.7's `teacherWeeklyCapacity`, the same function Check 2 uses,
 * so this report cannot tell a school its teachers are freer than Readiness
 * does. `load` is summed across the whole §30 **pool**, not this timetable —
 * "how full is this person?" has one answer, and scoping it to one wing is
 * CLAUDE.md's own "67% where the truth is 87%".
 *
 * ## Nothing here writes
 *
 * A requirement is a case somebody takes to a decision. There is no apply, no
 * suggestion that gets committed, and no route that mutates a row.
 */
import { Injectable, NotFoundException } from "@nestjs/common";
import {
  analyseRequirement, teacherWeeklyCapacity,
  type RequirementReport, type RequirementSnapshot, type SnapshotTeacher,
} from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class TeacherRequirementService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `targetLoad` is the one policy input, and it is a QUERY PARAMETER.
   *
   * Periods ÷ load-per-teacher is the last step and the only judgement in the
   * report; a school that staffs at 22 a week and one that staffs at 36 get
   * different answers from identical data. A constant here would be this
   * codebase deciding something that belongs to a head teacher, so the default
   * is read from the staff the school actually employs — the mean of their own
   * weekly caps — and the screen can move it.
   */
  async forConfig(configId: number, targetLoad?: number): Promise<RequirementReport & {
    school: string;
    config: string;
    workingDays: number;
    periodsPerDay: number;
    classes: number;
    sections: number;
    teachers: Array<{ id: number; name: string; cap: number; load: number; subjects: string[] }>;
    defaultTargetLoad: number;
  }> {
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId },
      include: {
        school: { select: { name: true } },
        classSections: { select: { id: true, classId: true } },
      },
    });
    if (!config) throw new NotFoundException("Timetable not found");

    /*
      `workingDays` is a JSON column, and a config that predates a week having
      been set has none. Defaulted the same way `solver/input.ts` does, so a
      report on a half-built timetable answers rather than throwing.
    */
    const workingDays = Array.isArray(config.workingDays)
      ? (config.workingDays as number[])
      : [1, 2, 3, 4, 5];

    const sectionIds = config.classSections.map((s) => s.id);
    const classIds = [...new Set(config.classSections.map((s) => s.classId))];
    const sectionsPerClass: Record<number, number> = {};
    for (const s of config.classSections) {
      sectionsPerClass[s.classId] = (sectionsPerClass[s.classId] ?? 0) + 1;
    }

    const [subjects, classes, curriculum, mappings, teachers, declared, merged, blocks, narrowing, unavailable] =
      await Promise.all([
        this.prisma.subject.findMany({ select: { id: true, name: true, category: true } }),
        this.prisma.schoolClass.findMany({ select: { id: true, name: true } }),
        // §3.11 — the curriculum is year-scoped, and the year is this config's.
        this.prisma.classSubject.findMany({
          where: { academicYearId: config.academicYearId, classId: { in: classIds } },
          select: { classId: true, subjectId: true, periodsPerWeek: true },
        }),
        /*
          Every mapping in the school, not only this timetable's.

          `assigned` is narrowed to this timetable's sections inside the shared
          module, but a teacher's LOAD has to count the other wings (§30.11) or
          somebody at 87% across two timetables reads as having spare here.
        */
        this.prisma.teacherSubjectClassSection.findMany({
          select: { teacherId: true, subjectId: true, classSectionId: true, periodsPerWeek: true },
        }),
        this.prisma.teacher.findMany({ where: { isActive: true } }),
        this.prisma.teacherSubject.findMany({ select: { teacherId: true, subjectId: true } }),
        this.prisma.mergedTeachingGroup.findMany({ include: { members: true } }),
        this.prisma.electiveBlock.findMany({ include: { members: true, options: true } }),
        this.prisma.timetableSubject.findMany({
          where: { timetableConfigId: configId },
          select: { subjectId: true },
        }),
        this.prisma.teacherUnavailability.findMany({
          select: { teacherId: true, dayOfWeek: true, periodNumber: true },
        }),
      ]);

    const mine = new Set(sectionIds);
    const classNames: Record<number, string> = {};
    for (const c of classes) classNames[c.id] = c.name;

    /*
      §4.7a — a whole day off is `period_number = NULL`, and that is the form
      `teacherWeeklyCapacity` wants. A blocked single period is not a full day
      and must not be read as one; one row of that mistake takes a teacher's
      capacity down by a whole day.
    */
    const fullDays = new Map<number, number[]>();
    const singlePeriods = new Map<number, number>();
    for (const u of unavailable) {
      if (u.periodNumber === null) {
        fullDays.set(u.teacherId, [...(fullDays.get(u.teacherId) ?? []), u.dayOfWeek]);
      } else {
        singlePeriods.set(u.teacherId, (singlePeriods.get(u.teacherId) ?? 0) + 1);
      }
    }

    const load = new Map<number, number>();
    const teaches = new Map<number, Set<string>>();
    const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
    for (const m of mappings) {
      load.set(m.teacherId, (load.get(m.teacherId) ?? 0) + m.periodsPerWeek);
      const set = teaches.get(m.teacherId) ?? new Set<string>();
      set.add(subjectName.get(m.subjectId) ?? "—");
      teaches.set(m.teacherId, set);
    }

    /*
      A REAL `SnapshotTeacher`, with no cast.

      The first version of this built the object shape by eye and silenced tsc
      with `as never` — and `unavailablePeriodCount` was missing, so the last
      line of `teacherWeeklyCapacity` computed `pattern - undefined`, every
      capacity came back `NaN`, every spare was `NaN`, and the max-flow found no
      edge with `c > 0`. The report said a school with idle teachers needed to
      hire. Exactly the failure CLAUDE.md records about `sync.service.ts` typing
      its transaction client as `any`: the one place tsc was not the safety net
      is the one place the bug was.
    */
    const people = teachers.map((t) => {
      const snapshotTeacher: SnapshotTeacher = {
        id: t.id,
        name: t.name,
        maxPeriodsPerDay: t.maxPeriodsPerDay,
        minPeriodsPerDay: t.minPeriodsPerDay,
        maxConsecutivePeriodsPerDay: t.maxConsecutivePeriodsPerDay,
        canSubstitute: t.canSubstitute,
        maxPeriodsPerWeek: t.maxPeriodsPerWeek,
        classTeacherPeriodRule: t.classTeacherPeriodRule,
        periodPattern: t.periodPattern,
        alternateDaySet: Array.isArray(t.alternateDaySet) ? (t.alternateDaySet as number[]) : null,
        eligibleClassIds: [],
        employmentType: t.employmentType,
        unavailableFullDays: fullDays.get(t.id) ?? [],
        unavailablePeriodCount: singlePeriods.get(t.id) ?? 0,
      };
      return {
        id: t.id,
        name: t.name,
        cap: teacherWeeklyCapacity(snapshotTeacher, workingDays, config.periodsPerDay),
        load: load.get(t.id) ?? 0,
      };
    });

    const snapshot: RequirementSnapshot = {
      workingDays: workingDays.length,
      periodsPerDay: config.periodsPerDay,
      subjects: subjects.map((s) => ({ id: s.id, name: s.name, category: s.category })),
      classNames,
      sectionsPerClass,
      sectionIds,
      curriculum,
      mappings,
      mergedGroups: merged
        .map((g) => ({
          subjectId: g.subjectId,
          memberSectionIds: g.members.map((m) => m.classSectionId).filter((id) => mine.has(id)),
          /*
            The group's OWN `periods_per_week`, not a mapping's.

            The first version looked the number up on whichever mapping happened
            to teach that subject in this timetable — which is `0` for a merged
            group whose sections have no separate mapping, the normal case. The
            subtraction then silently did not happen, and a school teaching
            three sections together read as needing three teachers' worth.
          */
          periodsPerWeek: g.periodsPerWeek,
        }))
        .filter((g) => g.memberSectionIds.length > 1),
      electives: blocks
        .filter((b) => b.members.some((m) => mine.has(m.classSectionId)))
        .map((b) => ({
          name: b.name,
          periodsPerWeek: b.periodsPerWeek,
          optionSubjectIds: b.options.map((o) => o.subjectId),
        })),
      declaredSubjects: declared,
      teachers: people,
      // §32 — absent means "not stated", which is every subject (invariant 7).
      narrowedTo: narrowing.length === 0 ? null : narrowing.map((r) => r.subjectId),
    };

    /*
      The default divisor comes from the school's own contracts, not from a
      number in this file: the mean of the caps its teachers are actually on.
      A school of part-timers and a school of full-timers should not be handed
      the same assumption about what one hire buys.
    */
    const defaultTargetLoad = people.length
      ? Math.max(1, Math.round(people.reduce((a, t) => a + t.cap, 0) / people.length))
      : 30;
    const target = targetLoad && targetLoad > 0 ? Math.min(60, Math.round(targetLoad)) : defaultTargetLoad;

    return {
      ...analyseRequirement(snapshot, target),
      school: config.school.name,
      config: config.name,
      workingDays: workingDays.length,
      periodsPerDay: config.periodsPerDay,
      classes: classIds.length,
      sections: sectionIds.length,
      teachers: people.map((t) => ({ ...t, subjects: [...(teaches.get(t.id) ?? [])].sort() })),
      defaultTargetLoad,
    };
  }
}
