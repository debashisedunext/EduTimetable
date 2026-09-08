/**
 * Snapshot/input builders shared by the Nest API (ReadinessService) and the
 * BullMQ worker process — one query layer, one truth (CLAUDE.md invariant).
 * Plain functions over PrismaClient so the worker needs no Nest context.
 */
import type { PrismaClient } from "@prisma/client";
import type { FeasibilitySnapshot, SolverInput } from "@edutimetable/shared";
import { parsePins } from "@edutimetable/shared";
import { daySegmentsFromRows, lunchAfterPeriodFromRows } from "../masters/structure.util";

export async function buildFeasibilitySnapshot(
  prisma: PrismaClient,
  configId: number,
): Promise<FeasibilitySnapshot> {
  const config = await prisma.timetableConfig.findUnique({
    where: { id: configId },
    include: { periods: { orderBy: { sortOrder: "asc" } } },
  });
  if (!config) throw new Error("Timetable config not found");

  const classSections = await prisma.classSection.findMany({
    where: { timetableConfigId: configId },
    include: { class: true, section: true },
  });
  const classIds = [...new Set(classSections.map((c) => c.classId))];
  const sectionIds = classSections.map((c) => c.id);

  const [classSubjects, mappings, teachers, mergedGroups, electiveBlocks, labRooms, labSubjects, allSubjects] =
    await Promise.all([
      // Phase 19: the curriculum is year-scoped, and this filter is what keeps
      // it so. `variables.ts` keys requirements by `classId:subjectId` in a
      // plain Map — two years' rows reaching the snapshot would collapse to
      // whichever loaded last, silently timetabling the wrong syllabus.
      prisma.classSubject.findMany({
        where: { classId: { in: classIds }, academicYearId: config.academicYearId },
        include: { subject: true },
      }),
      prisma.teacherSubjectClassSection.findMany({
        where: { classSectionId: { in: sectionIds } },
        include: { teacher: true, subject: true, classSection: { include: { class: true, section: true } } },
      }),
      prisma.teacher.findMany({
        where: { schoolId: config.schoolId, isActive: true },
        include: { unavailability: true, eligibility: true },
      }),
      prisma.mergedTeachingGroup.findMany({
        where: { members: { some: { classSectionId: { in: sectionIds } } } },
        include: { members: true, subject: true },
      }),
      // §4.9 split electives: any block one of this config's sections attends.
      prisma.electiveBlock.findMany({
        where: { members: { some: { classSectionId: { in: sectionIds } } } },
        include: {
          members: { include: { classSection: { include: { class: true, section: true } } } },
          options: { include: { subject: true, teacher: true, room: true } },
        },
      }),
      prisma.room.count({ where: { schoolId: config.schoolId, roomType: "lab" } }),
      prisma.subject.findMany({ where: { schoolId: config.schoolId, isLab: true } }),
      // §26 — every subject's placement rules. The whole school's, not just the
      // ones on this config's curriculum: an elective option's subject is not a
      // `class_subjects` row, and its rules apply just the same.
      prisma.subject.findMany({
        where: { schoolId: config.schoolId },
        select: {
          id: true, name: true, category: true, priority: true,
          lunchRule: true, gapAfterLunch: true,
        },
      }),
    ]);

    // §19 rooms. `homeRoomBySection` is what makes a recorded home room
    // actually appear on the timetable; `labRoomsBySubject` is what stops a
    // biology period being sent to the physics lab because it was free.
    const allRooms = await prisma.room.findMany({
      where: { schoolId: config.schoolId },
      include: { subjects: true },
    });
    const labRoomsBySubject: Record<number, number[]> = {};
    const generalLabs = allRooms.filter((r) => r.roomType === "lab" && r.subjects.length === 0).map((r) => r.id);
    for (const s of labSubjects) {
      const dedicated = allRooms.filter((r) => r.subjects.some((x) => x.subjectId === s.id)).map((r) => r.id);
      // A lab with no subjects listed is a general lab and serves everything,
      // which is exactly what every school had before this existed.
      labRoomsBySubject[s.id] = [...dedicated, ...generalLabs];
    }

  // §3.10: a teacher's load in OTHER configs counts toward their capacity here.
  //
  // Phase 19: other configs *in the same academic year*. Next year's teaching
  // does not consume this year's capacity, and without the year filter rolling
  // a school into a new session double-counted every teacher — Check 2 then
  // failed across the board and a freshly cloned timetable read as hopelessly
  // overloaded before anyone had touched it.
  const crossRows = await prisma.teacherSubjectClassSection.findMany({
    where: {
      teacherId: { in: teachers.map((t) => t.id) },
      classSection: {
        timetableConfigId: { not: configId },
        academicYearId: config.academicYearId,
      },
    },
    include: { classSection: { include: { timetableConfig: true } } },
  });
  const crossConfigTeacherLoad: FeasibilitySnapshot["crossConfigTeacherLoad"] = {};
  for (const row of crossRows) {
    if (row.classSection.timetableConfigId === configId) continue;
    const entry = (crossConfigTeacherLoad[row.teacherId] ??= { periods: 0, otherConfigNames: [] });
    entry.periods += row.periodsPerWeek;
    const name = row.classSection.timetableConfig?.name ?? "another timetable";
    if (!entry.otherConfigNames.includes(name)) entry.otherConfigNames.push(name);
  }

  const label = (cs: (typeof classSections)[number]) => `${cs.class.name}-${cs.section.name}`;

  // Built once: both `daySegments` and the lunch boundary read the same rows,
  // and mapping them twice is how the two answers come to disagree.
  const periodRows = config.periods.map((p) => ({
    sortOrder: p.sortOrder,
    periodNumber: p.periodNumber,
    startTime: p.startTime,
    endTime: p.endTime,
    isBreak: p.isBreak,
    isExtra: p.isExtra,
    // §28.3 — carried so `daySegmentsFromRows` can EXCLUDE it. An activity row
    // is not a break, so without the flag the run counter would read an
    // assembly as a teaching period and tell the solver the day has a longer
    // unbroken run than it has.
    isActivity: p.isActivity,
    activityId: p.activityId,
    breakName: p.breakName,
  }));

  return {
    config: {
      id: config.id,
      name: config.name,
      workingDays: (config.workingDays as number[]) ?? [1, 2, 3, 4, 5],
      periodsPerDay: config.periodsPerDay,
      daySegments: daySegmentsFromRows(periodRows),
      // §26.3 — which break was lunch. Null when the day has no break, which
      // switches the lunch rules off rather than attaching them to a guess.
      lunchAfterPeriod: lunchAfterPeriodFromRows(periodRows),
      // §28.1 — the school's own "getting full" line, for Check 12.
      loadAlertPct: config.loadAlertPct,
    },
    classSections: classSections.map((cs) => ({
      id: cs.id,
      label: label(cs),
      classId: cs.classId,
      classTeacherId: cs.classTeacherId,
    })),
    subjectRequirements: classSubjects.map((r) => ({
      id: r.id,
      classId: r.classId,
      subjectId: r.subjectId,
      subjectName: r.subject.name,
      periodsPerWeek: r.periodsPerWeek,
      maxPeriodsPerDay: r.maxPeriodsPerDay,
      samePeriodAcrossWeek: r.samePeriodAcrossWeek,
      consecutiveBlockSize: r.consecutiveBlockSize,
      consecutiveBlocksPerWeek: r.consecutiveBlocksPerWeek,
    })),
    teachers: teachers.map((t) => ({
      id: t.id,
      name: t.name,
      maxPeriodsPerDay: t.maxPeriodsPerDay,
      minPeriodsPerDay: t.minPeriodsPerDay,
      maxConsecutivePeriodsPerDay: t.maxConsecutivePeriodsPerDay,
      canSubstitute: t.canSubstitute,
      maxPeriodsPerWeek: t.maxPeriodsPerWeek,
      classTeacherPeriodRule: t.classTeacherPeriodRule,
      periodPattern: t.periodPattern,
      alternateDaySet: (t.alternateDaySet as number[] | null) ?? null,
      eligibleClassIds: t.eligibility.map((e) => e.classId),
      employmentType: t.employmentType,
      unavailableFullDays: t.unavailability
        .filter((u) => u.periodNumber === null)
        .map((u) => u.dayOfWeek),
      unavailablePeriodCount: t.unavailability.filter((u) => u.periodNumber !== null).length,
    })),
    mappings: mappings.map((m) => ({
      id: m.id,
      teacherId: m.teacherId,
      teacherName: m.teacher.name,
      subjectId: m.subjectId,
      subjectName: m.subject.name,
      classSectionId: m.classSectionId,
      classSectionLabel: `${m.classSection.class.name}-${m.classSection.section.name}`,
      periodsPerWeek: m.periodsPerWeek,
    })),
    mergedGroups: mergedGroups.map((g) => ({
      id: g.id,
      teacherId: g.teacherId,
      subjectId: g.subjectId,
      subjectName: g.subject.name,
      periodsPerWeek: g.periodsPerWeek,
      memberClassSectionIds: g.members.map((m) => m.classSectionId),
    })),
    electiveBlocks: electiveBlocks.map((b) => ({
      id: b.id,
      name: b.name,
      periodsPerWeek: b.periodsPerWeek,
      maxPeriodsPerDay: b.maxPeriodsPerDay,
      placement: b.placement,
      // Only meaningful under `fixed`; carrying it regardless would let a
      // stale pin quietly narrow a block the school has since set free.
      fixedSlots: b.placement === "fixed" ? parsePins(b.fixedSlots) : [],
      memberClassSectionIds: b.members.map((m) => m.classSectionId),
      memberLabels: b.members.map(
        (m) => `${m.classSection.class.name}-${m.classSection.section.name}`,
      ),
      options: b.options.map((o) => ({
        id: o.id,
        subjectId: o.subjectId,
        subjectName: o.subject.name,
        teacherId: o.teacherId,
        teacherName: o.teacher.name,
        roomId: o.roomId,
        roomName: o.room.name,
      })),
    })),
    crossConfigTeacherLoad,
    labRoomCount: labRooms,
    labSubjectIds: labSubjects.map((s) => s.id),
    subjectPlacement: Object.fromEntries(allSubjects.map((s) => [s.id, {
      subjectName: s.name,
      category: s.category,
      priority: s.priority,
      lunchRule: s.lunchRule,
      gapAfterLunch: s.gapAfterLunch,
    }])),
    homeRoomBySection: Object.fromEntries(classSections.map((cs) => [cs.id, cs.homeRoomId])),
    labRoomsBySubject,
    roomNames: Object.fromEntries(allRooms.map((r) => [r.id, r.name])),
    // §21: a remedy that hands a class-section a free room has to be able to
    // tell a classroom from a lab, which `roomNames` cannot.
    rooms: allRooms.map((r) => ({
      id: r.id,
      name: r.name,
      roomType: r.roomType,
      capacity: r.capacity,
      isShared: r.isShared,
      subjectIds: r.subjects.map((x) => x.subjectId),
    })),
  };
}

export async function buildSolverInput(
  prisma: PrismaClient,
  configId: number,
  /**
   * §22 — which draft's locked cells count as fixed. Omitted means every one,
   * which is only correct for a config that has no named drafts at all.
   */
  draftId?: number | null,
): Promise<SolverInput> {
  const snapshot = await buildFeasibilitySnapshot(prisma, configId);
  const sectionIds = snapshot.classSections.map((c) => c.id);
  const [unavail, labRooms, mappingsWithRooms, groups, locked] = await Promise.all([
    prisma.teacherUnavailability.findMany({
      where: { teacher: { isActive: true } },
    }),
    prisma.room.findMany({ where: { roomType: "lab" }, select: { id: true } }),
    prisma.teacherSubjectClassSection.findMany({
      where: { classSectionId: { in: sectionIds }, preferredRoomId: { not: null } },
      select: { id: true, preferredRoomId: true },
    }),
    prisma.mergedTeachingGroup.findMany({
      where: { members: { some: { classSectionId: { in: sectionIds } } } },
      select: { id: true, roomId: true },
    }),
    // §22: locked cells belong to ONE draft. Unscoped, generating Draft #4
    // would treat Draft #2's pinned cells as fixed — invariant 13 applied
    // across a boundary it was never meant to cross.
    prisma.timetableSlot.findMany({
      where: {
        timetableConfigId: configId,
        status: "draft",
        isLocked: true,
        ...(draftId !== undefined && draftId !== null ? { draftId } : {}),
      },
    }),
  ]);
  return {
    snapshot,
    teacherUnavailability: unavail.map((u) => ({
      teacherId: u.teacherId,
      dayOfWeek: u.dayOfWeek,
      periodNumber: u.periodNumber,
    })),
    labRoomIds: labRooms.map((r) => r.id),
    preferredRoomByMapping: Object.fromEntries(
      mappingsWithRooms.map((m) => [m.id, m.preferredRoomId as number]),
    ),
    mergedGroupRooms: Object.fromEntries(groups.map((g) => [g.id, g.roomId])),
    lockedSlots: locked
      // A locked cell is something a person pinned in a section's grid, so it
      // always has a section. An elective *option* row has none (§4.9) — it is
      // the lesson under a block, not a cell — and the block's own member rows
      // carry the lock.
      .filter((l) => l.classSectionId !== null && l.subjectId !== null && l.teacherId !== null)
      .map((l) => ({
        classSectionId: l.classSectionId as number,
        dayOfWeek: l.dayOfWeek,
        periodNumber: l.periodNumber,
        subjectId: l.subjectId as number,
        teacherId: l.teacherId as number,
        roomId: l.roomId,
      })),
    seed: configId,
  };
}
