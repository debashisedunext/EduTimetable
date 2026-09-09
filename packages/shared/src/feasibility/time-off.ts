/**
 * §4.7a/§4.7b — time off, expanded into cells.
 *
 * Four masters can be unavailable — a teacher, a class-section, a subject, a
 * room — and all four store it the same way: one row per blocked cell, with
 * **`periodNumber === null` meaning the whole day**. That one rule is the thing
 * worth having in a single place. Stored as a row per cell instead, a school
 * that blocked all of Friday and later added a seventh period would find the
 * new period unblocked; expanded here against the timetable's own period count,
 * a blocked Friday stays a blocked Friday.
 *
 * It lives in `feasibility/` rather than `solver/` because both need it and the
 * solver already depends on this directory (`min-day.ts`), while the feasibility
 * engine deliberately depends on nothing. The alternative was a second copy of
 * the null-period rule in the engine, which is exactly how two answers to one
 * question get born.
 */

export interface TimeOffRow {
  /** the teacher / class-section / subject / room this row is about */
  id: number;
  dayOfWeek: number;
  /** null = the whole day */
  periodNumber: number | null;
}

/** `${day}:${period}` — the same key the solver's occupancy maps use. */
export const timeOffCell = (day: number, period: number): string => `${day}:${period}`;

/** Blocked cells per entity id. */
export function blockedCells(rows: TimeOffRow[], perDay: number): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const r of rows) {
    let set = out.get(r.id);
    if (!set) { set = new Set<string>(); out.set(r.id, set); }
    if (r.periodNumber === null) {
      for (let p = 1; p <= perDay; p++) set.add(timeOffCell(r.dayOfWeek, p));
    } else {
      set.add(timeOffCell(r.dayOfWeek, r.periodNumber));
    }
  }
  return out;
}

/**
 * How many of a week's teaching slots these rows remove.
 *
 * Days outside the working week cost nothing — they were never slots — and a
 * row naming one is not an error: a school that blocks Saturday and then drops
 * Saturday from its week has said the same thing twice, and the second saying
 * must not shrink the week again.
 */
export function blockedSlotCount(rows: TimeOffRow[], perDay: number, workingDays: number[]): number {
  const days = new Set(workingDays);
  let n = 0;
  for (const r of rows) {
    if (!days.has(r.dayOfWeek)) continue;
    n += r.periodNumber === null ? perDay : 1;
  }
  return n;
}
