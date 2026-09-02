/**
 * Weekly-capacity validation for periods/week entry fields: no curriculum row,
 * subject mapping, or merged group may claim more periods per week than the
 * owning timetable config's week holds (periodsPerDay × workingDays). The
 * server is the authority; forms only mirror the cap as a hint.
 */
import { BadRequestException } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";

export interface WeeklyCapacity {
  cap: number;
  configName: string;
  periodsPerDay: number;
  days: number;
}

function capOf(config: { name: string; periodsPerDay: number; workingDays: unknown }): WeeklyCapacity {
  const days = Array.isArray(config.workingDays) ? config.workingDays.length : 5;
  return {
    cap: config.periodsPerDay * days,
    configName: config.name,
    periodsPerDay: config.periodsPerDay,
    days,
  };
}

/** Tightest capacity across the configs these class-sections belong to.
 *  null when none of them is assigned to a config yet (Readiness owns that). */
export async function capacityForClassSections(
  prisma: PrismaClient,
  classSectionIds: number[],
): Promise<WeeklyCapacity | null> {
  if (classSectionIds.length === 0) return null;
  const sections = await prisma.classSection.findMany({
    where: { id: { in: classSectionIds }, timetableConfigId: { not: null } },
    include: { timetableConfig: true },
  });
  let min: WeeklyCapacity | null = null;
  for (const cs of sections) {
    if (!cs.timetableConfig) continue;
    const c = capOf(cs.timetableConfig);
    if (!min || c.cap < min.cap) min = c;
  }
  return min;
}

/** Capacity for a class in one academic year = tightest across that year's
 *  class-sections' configs.
 *
 *  Phase 19: the year is required. A class has sections in every session it has
 *  ever run, so without it a 2026-27 curriculum row was capped by whichever
 *  year happened to have the shortest week — including sessions long finished. */
export async function capacityForClass(
  prisma: PrismaClient,
  classId: number,
  academicYearId: number,
): Promise<WeeklyCapacity | null> {
  const sections = await prisma.classSection.findMany({
    where: { classId, academicYearId },
    select: { id: true },
  });
  return capacityForClassSections(prisma, sections.map((s) => s.id));
}

/** Throws the specific 400 when periodsPerWeek exceeds the capacity. */
export function assertWithinWeek(periodsPerWeek: number, capacity: WeeklyCapacity | null) {
  if (capacity && periodsPerWeek > capacity.cap) {
    throw new BadRequestException(
      `${periodsPerWeek} periods/week exceeds ${capacity.configName}'s week of ${capacity.cap} periods ` +
        `(${capacity.periodsPerDay}/day × ${capacity.days} days) — reduce it or change the timetable structure`,
    );
  }
}
