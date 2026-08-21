import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type Redis from "ioredis";
import {
  runFeasibility,
  type FeasibilityResult,
  type FeasibilitySnapshot,
} from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { REDIS } from "../redis/redis.module";
import { EventsGateway } from "../events/events.gateway";
import { daySegmentsFromRows } from "../masters/structure.util";

/**
 * Task 1.12 — live readiness: snapshot the DB, run the pure engine, cache in
 * Redis. Every master-data mutation calls invalidate(), which clears the cache
 * and pushes `readiness:invalidated` so open dashboards refetch instantly.
 */
@Injectable()
export class ReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async getReadiness(configId: number): Promise<FeasibilityResult> {
    const cached = await this.redis.get(`readiness:${configId}`);
    if (cached) return JSON.parse(cached);
    const snapshot = await this.buildSnapshot(configId);
    const result = runFeasibility(snapshot);
    await this.redis.set(`readiness:${configId}`, JSON.stringify(result), "EX", 3600);
    return result;
  }

  /** Called by the Config Service after every master-data mutation. */
  async invalidate(schoolId: number) {
    const keys = await this.redis.keys("readiness:*");
    if (keys.length > 0) await this.redis.del(...keys);
    this.events.server?.emit("readiness:invalidated", { schoolId });
  }

  async buildSnapshot(configId: number): Promise<FeasibilitySnapshot> {
    const config = await this.prisma.timetableConfig.findUnique({
      where: { id: configId },
      include: { periods: { orderBy: { sortOrder: "asc" } } },
    });
    if (!config) throw new NotFoundException("Timetable config not found");

    const classSections = await this.prisma.classSection.findMany({
      where: { timetableConfigId: configId },
      include: { class: true, section: true },
    });
    const classIds = [...new Set(classSections.map((c) => c.classId))];
    const sectionIds = classSections.map((c) => c.id);

    const [classSubjects, mappings, teachers, mergedGroups, labRooms, labSubjects] =
      await Promise.all([
        this.prisma.classSubject.findMany({
          where: { classId: { in: classIds } },
          include: { subject: true },
        }),
        this.prisma.teacherSubjectClassSection.findMany({
          where: { classSectionId: { in: sectionIds } },
          include: { teacher: true, subject: true, classSection: { include: { class: true, section: true } } },
        }),
        this.prisma.teacher.findMany({
          where: { schoolId: config.schoolId, isActive: true },
          include: { unavailability: true },
        }),
        this.prisma.mergedTeachingGroup.findMany({
          where: { members: { some: { classSectionId: { in: sectionIds } } } },
          include: { members: true, subject: true },
        }),
        this.prisma.room.count({ where: { schoolId: config.schoolId, roomType: "lab" } }),
        this.prisma.subject.findMany({ where: { schoolId: config.schoolId, isLab: true } }),
      ]);

    // §3.10: a teacher's load in OTHER configs counts toward their capacity here.
    const crossRows = await this.prisma.teacherSubjectClassSection.findMany({
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
      crossConfigTeacherLoad,
      labRoomCount: labRooms,
      labSubjectIds: labSubjects.map((s) => s.id),
    };
  }
}
