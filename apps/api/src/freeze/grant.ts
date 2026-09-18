/**
 * §29.8 — the predicate, and nothing else.
 *
 * Pure, so it can be unit-tested and so there is exactly ONE statement of the
 * rule in the codebase. Everything the feature does is this function applied to
 * a set of rows:
 *
 *     open(row) = every teacher named on it is unlocked
 *              OR every class-section named on it is unlocked
 *
 * A write is admitted when every row it touches is open, and refused — by name
 * — the moment one is not.
 *
 * ## Why "every", and why two clauses
 *
 * For a `timetable_slots` row this collapses to *"its teacher, or its
 * class-section"*, which is the whole enforcement model and the only case most
 * call sites have. The two-clause form matters for the rows that name several
 * entities at once:
 *
 * - a §4.10 merged group is ONE mapping teaching three sections. Unlocking one
 *   of the three and changing the row would change the other two weeks as well,
 *   so it takes all three — or the teacher, who is a single entity and whose
 *   unlock means "re-staff this person".
 * - a §4.9 elective block is one card over several sections with several option
 *   teachers. Same shape.
 * - a `class_subjects` row names a CLASS and no teacher at all (§27: periods are
 *   a class fact), so it reaches every section of that class and the teacher
 *   clause simply never fires.
 *
 * ## An empty list is not a free pass
 *
 * `teacherIds: []` must not satisfy "every teacher is unlocked" vacuously — that
 * is exactly how a curriculum row with no teacher would open itself. Each clause
 * requires at least one id before it can succeed, which is why the length checks
 * are here rather than left to `Array.every`.
 *
 * A row naming NOTHING is therefore never open. That is the right default: if a
 * caller cannot say which entities its write touches, no entity grant should be
 * able to admit it — it belongs in the `whole` classification instead.
 */

/** The live grant, flattened to the two sets the predicate needs. */
export interface GrantSets {
  teacherIds: Set<number>;
  classSectionIds: Set<number>;
}

/**
 * One row a write is about to change, described by whom it belongs to.
 *
 * `label` is only ever used to build a refusal, so it may be a cheap
 * approximation — the service resolves proper names on the failure path.
 */
export interface TouchedRow {
  teacherIds: number[];
  classSectionIds: number[];
}

/** Is this row inside the grant? */
export function opensRow(grant: GrantSets, row: TouchedRow): boolean {
  const byTeacher =
    row.teacherIds.length > 0 && row.teacherIds.every((id) => grant.teacherIds.has(id));
  const bySection =
    row.classSectionIds.length > 0 &&
    row.classSectionIds.every((id) => grant.classSectionIds.has(id));
  return byTeacher || bySection;
}

/**
 * The entities to NAME when a row is refused.
 *
 * Not "everything the row touches" — that would tell somebody to unlock a
 * teacher who already is unlocked. Only what is actually shut, and the
 * class-sections first, because a class is the thing a school thinks in.
 */
export function shutEntities(
  grant: GrantSets,
  row: TouchedRow,
): { teacherIds: number[]; classSectionIds: number[] } {
  return {
    classSectionIds: row.classSectionIds.filter((id) => !grant.classSectionIds.has(id)),
    teacherIds: row.teacherIds.filter((id) => !grant.teacherIds.has(id)),
  };
}

/** An empty grant — a locked timetable with nothing unlocked. */
export const NO_GRANT: GrantSets = {
  teacherIds: new Set<number>(),
  classSectionIds: new Set<number>(),
};
