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
 *  year happened to have the shortest week — including sessions long finished.
 *
 *  §30 does NOT narrow this to the resource pool, and the reason is worth
 *  stating because narrowing it is the obvious change and it is wrong. A
 *  curriculum row is keyed (class, subject, year) and is deliberately SHARED
 *  across pools — what Class 1 studies is a fact about the class and the
 *  session, not about a timetable. A shared row therefore has to fit in every
 *  pool that teaches that class, so the tightest week across the session is
 *  exactly the right cap. Scoping it to one pool would let somebody enter 40
 *  periods against an 8-period individual timetable and hand the 6-period
 *  grouped wing a Readiness blocker instead of a form error — a worse place to
 *  find out, and a rule the person who typed it never saw. */
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
