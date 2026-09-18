/**
 * §28.7 — a teacher cannot be in two wings at once, or walk between them in
 * no time at all.
 *
 * ## Why this is not `uq_teacher_slot`'s job
 *
 * It cannot be. All three unique keys on `timetable_slots` are scoped by
 * `timetable_config_id` (§30.11), so **the database has no cross-timetable
 * occupancy constraint** — two wings may place the same teacher in the same
 * minute and nothing anywhere notices. §30.7 reports that afterwards as a
 * warning between two *published* timetables; this stops the second wing
 * creating it in the first place.
 *
 * ## It is a WALL-CLOCK question, never a period-number one
 *
 * §30.7 had to learn this and it is the same lesson: Junior's P3 and Senior's
 * P2 can both start at 09:14, so comparing period numbers across wings is
 * wrong in both directions — it misses real overlaps and invents false ones.
 * Everything here is minutes from midnight.
 *
 * ## One number per wing, not a distance matrix
 *
 * A pair of wings uses the LARGER of their two travel figures. A matrix would
 * be more expressive and nobody would fill it in; one number per wing composes,
 * and "how far is this wing from the rest of the school?" is a question a
 * school can actually answer.
 */

export interface WingLesson {
  dayOfWeek: number;
  start: number;
  end: number;
  configName: string;
  travelMins: number;
}

export interface CrossWingVerdict {
  /** The wing that makes this impossible, when one does. */
  configName: string;
  /** Minutes actually available between the two lessons. Negative = overlap. */
  gapMins: number;
  /** Minutes the walk needs. */
  needMins: number;
}

/**
 * Is this teacher already somewhere they could not get back from in time?
 *
 * `null` when the cell is fine. Returns the WORST offender rather than the
 * first, so a refusal names the wing that is actually the problem.
 */
export function crossWingConflict(
  busy: WingLesson[] | undefined,
  day: number,
  start: number,
  end: number,
  /** This wing's own travel minutes. The pair uses whichever is larger. */
  travelMins: number,
): CrossWingVerdict | null {
  if (!busy || busy.length === 0) return null;
  let worst: CrossWingVerdict | null = null;
  for (const other of busy) {
    if (other.dayOfWeek !== day) continue;
    const need = Math.max(travelMins, other.travelMins);
    /*
      The gap between the two lessons, whichever way round they fall.

      A negative gap is a genuine overlap — the teacher is timetabled in both
      wings at once — and it is caught by the same arithmetic rather than by a
      separate branch, because an overlap is just a walk with less than no time
      for it. A zero-minute need still refuses an overlap for that reason, which
      is what makes this rule useful to a school that has never measured the
      walk.
    */
    const gap = other.start >= end ? other.start - end : start - other.end;
    if (gap >= need && gap >= 0) continue;
    if (!worst || gap < worst.gapMins) {
      worst = { configName: other.configName, gapMins: gap, needMins: need };
    }
  }
  return worst;
}

/** What to say about it, in the words the solver and the board both use. */
export function describeCrossWing(v: CrossWingVerdict): string {
  return v.gapMins < 0
    ? `already teaching in ${v.configName} at this time`
    : `only ${v.gapMins} min to reach ${v.configName}, and the walk needs ${v.needMins}`;
}
