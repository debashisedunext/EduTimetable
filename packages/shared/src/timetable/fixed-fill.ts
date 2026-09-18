/**
 * §36.6 — filling one period across every working day.
 *
 * "Mathematics, period 1, every day" is what a school actually wants far more
 * often than five separate decisions, and the alternative is clicking the same
 * three controls once per day.
 *
 * ## Why this is here rather than in the component
 *
 * `apps/web` has no test harness, and this decides what gets written: an
 * off-by-one on the cap produces a set the server refuses, and a mistake in
 * which cells it may take produces a bulk action that destroys a pin somebody
 * placed on purpose. Same rule as `mergeShownWings` and `mergeByWing`.
 *
 * ## Three things it will not do
 *
 * Each of them would make the button dangerous rather than quick:
 *
 *  - **Overwrite another pin.** A cell already holding a different lesson is a
 *    decision somebody made. Skipped and counted, never replaced.
 *  - **Exceed the curriculum.** Five days of a subject taught three periods a
 *    week is a set the save would refuse, so the button would be a button that
 *    creates an error. It fills up to the cap and reports that it stopped.
 *  - **Put one teacher in two places.** The same teacher already pinned at that
 *    period in another section is a clash the caller can see in its own set,
 *    and the server would refuse it by name. Skipped here instead.
 *
 * It returns the rows to add AND the reasons it did not add the others, because
 * "3 of 5" with no explanation is the empty-dropdown mistake in another shape.
 */

/** Just enough of a pin for this to reason about. */
export interface FillPin {
  classSectionId: number;
  subjectId: number;
  teacherId: number;
  dayOfWeek: number;
  periodNumber: number;
}

export interface FillResult<T extends FillPin> {
  /** The new pins, ready to append. Empty when nothing could be added. */
  add: T[];
  /** Days skipped because the class-section already had something pinned there. */
  taken: number;
  /** Days skipped because that teacher was already pinned at that period. */
  clash: number;
  /** Days skipped because the class's weekly periods for the subject ran out. */
  capped: number;
}

export function fillAcrossDays<T extends FillPin>(
  /** The pin being repeated — its own day is skipped, never counted twice. */
  source: T,
  /** Every pin currently in the editing set, including `source`. */
  pins: T[],
  /** The timetable's working days, in the order they should be filled. */
  days: number[],
  /** How many periods a week the class is taught this subject (§27). */
  cap: number,
): FillResult<T> {
  const cellKey = (p: FillPin) => `${p.classSectionId}:${p.dayOfWeek}:${p.periodNumber}`;
  const occupied = new Set(pins.map(cellKey));

  /*
    Counted over the WHOLE set, not over this period's column: the cap is the
    class's weekly periods for the subject, and a lesson already pinned on
    another period spends one of them just as surely.
  */
  let used = pins.filter(
    (p) => p.classSectionId === source.classSectionId && p.subjectId === source.subjectId,
  ).length;

  const add: T[] = [];
  let taken = 0;
  let clash = 0;
  let capped = 0;

  for (const day of days) {
    if (day === source.dayOfWeek) continue;
    const here: FillPin = { ...source, dayOfWeek: day };
    if (occupied.has(cellKey(here))) { taken += 1; continue; }
    /*
      The teacher check reads `pins` AND what this call has already decided to
      add — a five-day fill can otherwise collide with itself the moment two
      sections of the same class share a teacher at one period.
    */
    const busy = [...pins, ...add].some(
      (p) => p.teacherId === source.teacherId
        && p.dayOfWeek === day
        && p.periodNumber === source.periodNumber
        && p.classSectionId !== source.classSectionId,
    );
    if (busy) { clash += 1; continue; }
    if (used >= cap) { capped += 1; continue; }
    add.push({ ...source, dayOfWeek: day });
    used += 1;
  }

  return { add, taken, clash, capped };
}

/** What the fill did, in the words the bar prints. */
export function describeFill(result: FillResult<FillPin>, cap: number): string {
  const why = [
    result.taken > 0 ? `${result.taken} day(s) already had a lesson fixed` : null,
    result.clash > 0 ? `${result.clash} clashed with that teacher elsewhere` : null,
    result.capped > 0 ? `${result.capped} would pass the ${cap} a week this class is taught` : null,
  ].filter(Boolean);
  if (result.add.length === 0) {
    return why.length > 0
      ? `Nothing added — ${why.join(", ")}.`
      : "It is already fixed on every working day.";
  }
  return `Fixed on ${result.add.length} more day(s)`
    + (why.length > 0 ? ` — ${why.join(", ")}.` : ".");
}
