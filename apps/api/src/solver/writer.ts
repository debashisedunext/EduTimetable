/**
 * The single slot-writer (§4.9 note in the schema): expands solver placements
 * into timetable_slots rows in one transaction.
 *
 * Three shapes go through here, and the difference is entirely in which unique
 * key is doing the work:
 *
 *   - **ordinary** — one row, carrying `T-{teacherId}` and its room.
 *   - **merged** (one teacher, several sections) — one PRIMARY row per cell
 *     carrying `teacher_occupancy_key` + room, and echo rows for the other
 *     member sections with both NULL. `uq_class_slot` still fires per section;
 *     the teacher's occupancy collapses into a single event.
 *   - **split elective** (several teachers, one shared slot, §4.9) — the mirror
 *     of merged: one member row per attending section carrying *no* subject,
 *     teacher or room, plus one option row per parallel lesson carrying
 *     `class_section_id = NULL`. The NULL takes option rows out of
 *     `uq_class_slot` (they belong to a block, not a section) while
 *     `uq_teacher_slot` and `uq_room_slot` still refuse a double-booked
 *     language teacher or room.
 *
 * Locked rows survive.
 */
import type { PrismaClient } from "@prisma/client";
import type { Placement } from "@edutimetable/shared";

interface SlotRow {
  schoolId: number;
  timetableConfigId: number;
  status: "draft";
  classSectionId: number | null;
  dayOfWeek: number;
  periodNumber: number;
  subjectId: number | null;
  teacherId: number | null;
  roomId: number | null;
  mergedGroupId: number | null;
  draftId: number | null;
  electiveBlockId: number | null;
  electiveOptionId: number | null;
  teacherOccupancyKey: string | null;
  source: "auto";
}

export async function writeDraftSlots(
  prisma: PrismaClient,
  configId: number,
  placements: Placement[],
  /** Stamped onto every row: school_id is NOT NULL on timetable_slots (9.1 / §17). */
  schoolId: number,
  /**
   * §22 Phase 17 — which named draft this generation writes into. Every delete
   * and every insert below is scoped to it, so generating Draft #4 cannot
   * touch a word of Draft #2. Null only for a config that predates the
   * registry, which the migration should have made impossible.
   */
  draftId: number | null = null,
): Promise<{ rows: number }> {
  const rows: SlotRow[] = [];
  const base = { schoolId, timetableConfigId: configId, status: "draft" as const, source: "auto" as const, draftId };

  for (const p of placements) {
    for (let s = 0; s < p.span; s++) {
      const periodNumber = p.period + s;

      if (p.electiveBlockId !== null) {
        // Member rows: what each attending section shows in its own grid. They
        // deliberately carry no teacher or room — the lessons are the option
        // rows below, and giving a member row one option's teacher would claim
        // that section is doing that language.
        for (const classSectionId of p.classSectionIds) {
          rows.push({
            ...base,
            classSectionId,
            dayOfWeek: p.day,
            periodNumber,
            subjectId: null,
            teacherId: null,
            roomId: null,
            mergedGroupId: null,
            electiveBlockId: p.electiveBlockId,
            electiveOptionId: null,
            teacherOccupancyKey: null,
          });
        }
        // Option rows: the parallel lessons. `class_section_id` is NULL because
        // the students come from every member section, and that is also what
        // lets several of them share this slot.
        for (const o of p.options) {
          rows.push({
            ...base,
            classSectionId: null,
            dayOfWeek: p.day,
            periodNumber,
            subjectId: o.subjectId,
            teacherId: o.teacherId,
            roomId: o.roomId,
            mergedGroupId: null,
            electiveBlockId: p.electiveBlockId,
            electiveOptionId: o.optionId,
            teacherOccupancyKey: `T-${o.teacherId}`,
          });
        }
        continue;
      }

      p.classSectionIds.forEach((classSectionId, idx) => {
        const primary = idx === 0;
        rows.push({
          ...base,
          classSectionId,
          dayOfWeek: p.day,
          periodNumber,
          subjectId: p.subjectId,
          teacherId: p.teacherId,
          roomId: primary ? p.roomId : null,
          mergedGroupId: p.mergedGroupId,
          electiveBlockId: null,
          electiveOptionId: null,
          teacherOccupancyKey: primary
            ? p.mergedGroupId !== null
              ? `MG-${p.mergedGroupId}`
              : `T-${p.teacherId}`
            : null,
        });
      });
    }
  }

  await prisma.$transaction([
    prisma.timetableSlot.deleteMany({
      where: {
        timetableConfigId: configId,
        status: "draft",
        // §22: only THIS draft's rows. Generating Draft #4 must not touch a
        // word of Draft #2 — that is the whole point of having both.
        ...(draftId !== null ? { draftId } : {}),
        isLocked: false,
        // §18 extra classes survive a re-generation. They are not part of what
        // the solver produced, they sit outside the teaching day it works in,
        // and a school that re-runs generation has not thereby cancelled next
        // week's revision class.
        source: { not: "extra" },
      },
    }),
    prisma.timetableSlot.createMany({ data: rows }),
  ]);
  return { rows: rows.length };
}
