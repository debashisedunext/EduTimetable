/**
 * §27.17 — merging a stored plan with a fresh proposal, one wing at a time.
 *
 * ## The rule
 *
 * The Allocation grid arrives full: periods, teachers and class teachers are
 * all proposed from the school's own masters. Once somebody edits it, the
 * stored plan wins — otherwise the proposal would keep overwriting their work.
 *
 * §27.15 made that judgement **per wing** rather than all-or-nothing, and the
 * reason still holds: a school that has planned one wing and then adds a second
 * must not have the new wing arrive empty, and a class somebody deliberately
 * emptied must not be filled back in.
 *
 * ## Why this is a module, and why it takes `wingsOf`
 *
 * There was one gate, computed from the stored CURRICULUM and applied to the
 * curriculum, the mappings and the class teachers alike. On a school whose
 * stored plan did not yet cover the wing on screen — every school that has just
 * narrowed a wing — that gate was open, so the grid filled in completely. Then
 * one digit was typed. The write puts the whole cell list back, so the wing's
 * own classes entered the stored curriculum, the gate shut — and shut for the
 * MAPPINGS too, which nobody had touched. Fifty-seven cells went from staffed
 * to "nobody" on a single keystroke, and every class-teacher badge with them.
 *
 * "Has this wing got a curriculum?" and "has this wing got any staffing?" are
 * different questions that a school answers at different moments, so each fact
 * brings its own accessor and gets its own answer.
 *
 * It lives here rather than in `apps/web` for the reason `mergeShownWings`
 * does: that app has no test harness, and a function which can silently
 * un-staff a school's entire week should not be the one thing nobody can run.
 *
 * ## `wingsOf` returns a LIST
 *
 * A curriculum cell belongs to one class and therefore one wing, but a §4.10
 * merged group spans several class-sections and may span wings. A proposal is
 * kept only when **every** wing it touches is still unplanned — the same
 * `every` the grid used, preserved here rather than reinvented at the call
 * site.
 *
 * An `undefined` wing means "this row names a class the plan does not know",
 * which is not a reason to suppress anything: it never marks a wing as planned,
 * and it never blocks a proposal.
 */
export function mergeByWing<T>(
  /** The school's own edits. `null` means it has never edited this fact. */
  stored: T[] | null,
  /** What the suggester would propose from scratch. */
  proposed: T[],
  /** Which wings one row belongs to. */
  wingsOf: (row: T) => Array<string | undefined>,
): T[] {
  if (!stored) return proposed;

  const planned = new Set<string>();
  for (const row of stored) {
    for (const wing of wingsOf(row)) if (wing) planned.add(wing);
  }

  return [
    ...stored,
    ...proposed.filter((row) => wingsOf(row).every((wing) => !wing || !planned.has(wing))),
  ];
}
