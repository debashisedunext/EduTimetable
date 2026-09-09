/**
 * §31 — pivoting the compact slot payload four ways.
 *
 * `GET /timetable-configs/:id/slots` serves flat tuples rather than an ORM
 * graph (§14). The Master Grid renders four of its five tabs from exactly that
 * payload, differing only in **which field of the tuple names the row**:
 * class-section, teacher, room, subject.
 *
 * ## Why one function and not four
 *
 * The obvious build is four grouping functions, one per tab. The difference
 * between them really is a single array index, and four copies is how three of
 * them end up handling §4.9 correctly and the fourth does not — which is the
 * §10.6 lesson (`rowKey`/`cellKey` are exported there so the writer and every
 * reader cannot disagree) restated for a payload instead of a grid.
 *
 * ## Which rows fall out of which pivot IS invariant 9
 *
 * A §4.9 split elective is one slot and several lessons: **member** rows carry
 * a class-section and no subject or teacher; **option** rows carry
 * `classSectionId = NULL` plus their own teacher and room. So the skipping is
 * not defensive coding, it is the invariant expressing itself:
 *
 *  - `section` — an option row has no section, so it is not a cell in anybody's
 *    grid, and is skipped.
 *  - `teacher` — a member row carries no teacher and is skipped; the option
 *    rows are **kept**, which is what stops a school's third-language teachers
 *    reading as entirely unscheduled (nine of them on the reference school).
 *  - `subject` — a member row carries no subject either, because the point of
 *    the block is that the children are doing different ones.
 *  - `room` — both kinds carry a room when one was assigned (§19).
 *
 * ## A cell holds a LIST
 *
 * Not defensiveness. On the subject pivot, English at Monday P1 across five
 * sections is genuinely five lessons in one cell, and §10.6 already settled
 * that the honest rendering of that is a count rather than one arbitrary
 * section's teacher.
 */

/**
 * The tuple layout, named once.
 *
 * `[classSectionId, day, period, subjectId, teacherId, roomId, mergedGroupId,
 *   locked, substituted, electiveBlockId]` — the shape the controller builds
 * and three screens destructure positionally. Naming the indices here is what
 * lets `PIVOT_FIELD` below be read as a fact rather than as four magic numbers.
 */
export const SLOT = {
  classSectionId: 0,
  day: 1,
  period: 2,
  subjectId: 3,
  teacherId: 4,
  roomId: 5,
  mergedGroupId: 6,
  locked: 7,
  substituted: 8,
  electiveBlockId: 9,
} as const;

export type SlotTuple = Array<number | null>;

export type GridPivot = "section" | "teacher" | "room" | "subject";

/** Which field of the tuple names the row. The whole of "four kinds, one implementation". */
export const PIVOT_FIELD: Record<GridPivot, number> = {
  section: SLOT.classSectionId,
  teacher: SLOT.teacherId,
  room: SLOT.roomId,
  subject: SLOT.subjectId,
};

/**
 * The key a pivoted cell is stored under.
 *
 * Exported rather than inlined for §10.6's reason: the writer and every reader
 * must not be able to disagree about it. A row entity plus a day plus a period
 * — and unlike §10.6's wall, a period NUMBER is right here, because a Master
 * Grid shows exactly one wing and one wing keeps one clock (§28.5).
 */
export const pivotCellKey = (row: number, day: number | null, period: number | null) =>
  `${row}@${day}:${period}`;

/**
 * Group the tuples by row entity and cell.
 *
 * One pass. Rows whose pivot field is NULL are skipped — see the invariant 9
 * note above; that is the behaviour, not an edge case.
 */
/**
 * The events in one pivoted cell — §4.10 collapsed where §4.10 applies.
 *
 * A merged teaching group is one teacher taking several sections at once. Which
 * makes "how many things are in this cell?" a question with two correct answers
 * depending on whose row it is, and the whole reason this is a function rather
 * than `entries.length`:
 *
 *  - In the **teacher** row it is **one occupancy event**. Drawing "4" there
 *    would claim four lessons where the school ran one — and on the reference
 *    school every single teacher cell holding more than one row is a merged
 *    group, so this is not an edge case, it is what that tab shows.
 *  - In the **subject** row those same four rows are four sections doing the
 *    subject, and four is exactly what §10.6's subject card counts.
 *  - In a **class-section** or **room** row it cannot arise: `uq_class_slot`
 *    and `uq_room_slot` allow one row per cell.
 *
 * So the rule is per pivot, not per payload — the same distinction the
 * substitute engine and the §29.3 reassignment engine both have to make.
 */
export function cellEvents(entries: SlotTuple[], pivot: GridPivot): SlotTuple[][] {
  if (pivot !== "teacher") return entries.map((e) => [e]);
  const out: SlotTuple[][] = [];
  const byGroup = new Map<number, SlotTuple[]>();
  for (const s of entries) {
    const g = s[SLOT.mergedGroupId];
    if (g === null || g === undefined) {
      out.push([s]);
      continue;
    }
    const at = byGroup.get(g);
    if (at) {
      at.push(s);
    } else {
      // Pushed into `out` while still empty, so the events keep the order the
      // rows arrived in rather than being re-sorted by group.
      const list = [s];
      byGroup.set(g, list);
      out.push(list);
    }
  }
  return out;
}

export function pivotSlots(slots: SlotTuple[], pivot: GridPivot): Map<string, SlotTuple[]> {
  const field = PIVOT_FIELD[pivot];
  const by = new Map<string, SlotTuple[]>();
  for (const s of slots) {
    const row = s[field];
    if (row === null || row === undefined) continue;
    const key = pivotCellKey(row, s[SLOT.day], s[SLOT.period]);
    const at = by.get(key);
    if (at) at.push(s);
    else by.set(key, [s]);
  }
  return by;
}
