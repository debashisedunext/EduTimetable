/**
 * Snapshot/input builders shared by the Nest API (ReadinessService) and the
 * BullMQ worker process — one query layer, one truth (CLAUDE.md invariant).
 * Plain functions over PrismaClient so the worker needs no Nest context.
 */
import type { PrismaClient } from "@prisma/client";
import type { FeasibilitySnapshot, SolverInput } from "@edutimetable/shared";
import { daySegmentsFromRows } from "../masters/structure.util";

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

  const [classSubjects, mappings, teachers, mergedGroups, electiveBlocks, labRooms, labSubjects] =
    await Promise.all([
      prisma.classSubject.findMany({
        where: { classId: { in: classIds } },
        include: { subject: true },
      }),
      prisma.teacherSubjectClassSection.findMany({
        where: { classSectionId: { in: sectionIds } },
        include: { teacher: true, subject: true, classSection: { include: { class: true, section: true } } },
      }),
      prisma.teacher.findMany({
        where: { schoolId: config.schoolId, isActive: true },
        include: { unavailability: true },
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
    ]);

  // §3.10: a teacher's load in OTHER configs counts toward their capacity here.
  const crossRows = await prisma.teacherSubjectClassSection.findMany({
    where: {
      teacherId: { in: teachers.map((t) => t.id) },
      classSection: { timetableConfigId: { not: configId } },
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

  return {
    config: {
      id: config.id,
      name: config.name,
      workingDays: (config.workingDays as number[]) ?? [1, 2, 3, 4, 5],
      periodsPerDay: config.periodsPerDay,
      daySegments: daySegmentsFromRows(
        config.periods.map((p) => ({
          sortOrder: p.sortOrder,
          periodNumber: p.periodNumber,
          startTime: p.startTime,
          endTime: p.endTime,
          isBreak: p.isBreak,
          breakName: p.breakName,
        })),
      ),
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
      maxPeriodsPerWeek: t.maxPeriodsPerWeek,
      classTeacherPeriodRule: t.classTeacherPeriodRule,
      periodPattern: t.periodPattern,
      alternateDaySet: (t.alternateDaySet as number[] | null) ?? null,
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
  };
}

export async function buildSolverInput(prisma: PrismaClient, configId: number): Promise<SolverInput> {
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
    prisma.timetableSlot.findMany({
      where: { timetableConfigId: configId, status: "draft", isLocked: true },
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
