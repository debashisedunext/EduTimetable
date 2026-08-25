/**
 * The single slot-writer (§4.9 note in the schema): expands solver placements
 * into timetable_slots rows in one transaction. Merged placements produce one
 * PRIMARY row per cell (carries teacher_occupancy_key + room) and echo rows
 * for the other member sections (occupancy/room NULL). Locked rows survive.
 */
import type { PrismaClient } from "@prisma/client";
import type { Placement } from "@edutimetable/shared";

export async function writeDraftSlots(
  prisma: PrismaClient,
  configId: number,
  placements: Placement[],
  /** Stamped onto every row: school_id is NOT NULL on timetable_slots (9.1 / §17). */
  schoolId: number,
): Promise<{ rows: number }> {
  const rows: Array<{
    schoolId: number;
    timetableConfigId: number;
    status: "draft";
    classSectionId: number;
    dayOfWeek: number;
    periodNumber: number;
    subjectId: number;
    teacherId: number;
    roomId: number | null;
    mergedGroupId: number | null;
    teacherOccupancyKey: string | null;
    source: "auto";
  }> = [];

  for (const p of placements) {
    for (let s = 0; s < p.span; s++) {
      p.classSectionIds.forEach((classSectionId, idx) => {
        const primary = idx === 0;
        rows.push({
          schoolId,
          timetableConfigId: configId,
          status: "draft",
          classSectionId,
          dayOfWeek: p.day,
          periodNumber: p.period + s,
          subjectId: p.subjectId,
          teacherId: p.teacherId,
          roomId: primary ? p.roomId : null,
          mergedGroupId: p.mergedGroupId,
          teacherOccupancyKey: primary
            ? p.mergedGroupId !== null
              ? `MG-${p.mergedGroupId}`
              : `T-${p.teacherId}`
            : null,
          source: "auto",
        });
      });
    }
  }

  await prisma.$transaction([
    prisma.timetableSlot.deleteMany({
      where: { timetableConfigId: configId, status: "draft", isLocked: false },
    }),
    prisma.timetableSlot.createMany({ data: rows }),
  ]);
  return { rows: rows.length };
}
