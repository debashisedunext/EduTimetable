import { CLASS_LADDER, ladderSequence } from "@edutimetable/shared";

/**
 * What `sequence` a class being created should get.
 *
 * ## Why this exists
 *
 * Three doors create a class — `POST /classes`, the §16 importer and the §23
 * ERP sync — and all three defaulted to **`0`**. The guided setup, meanwhile,
 * writes the ladder position (`planClasses`). So a school seeded with its own
 * numbering and later given an LKG through the guided setup ended up with two
 * classes holding sequence 3, and MySQL ordered the tie however it liked: the
 * Master Grid drew LKG-A, Class 1-A, Class 1-B, LKG-B, Class 1-C, LKG-C.
 *
 * `0` is the worst possible default and not merely a lazy one. It is not "at
 * the end", it is *first* — so every class created without a sequence sorts
 * above the whole school, tied with every other one, in an order nothing
 * defines. A school that adds five classes through the master screen gets five
 * rows at the top in an arbitrary order that changes when rows are edited.
 *
 * ## The rule
 *
 * A name the ladder knows gets its ladder position, because that is what
 * `classes.sequence` means everywhere else — `bandOf` and `subjectSuitsClass`
 * compare it against absolute positions to decide which subjects a class is
 * offered, so "Class 9" must be 13 rather than merely *after* Class 8.
 *
 * A name the ladder does not know gets a number **after** the ladder,
 * deliberately rather than interleaved: we know where Class 7 belongs and we do
 * not know where Playgroup belongs, and guessing is how two vocabularies for
 * one column started. It goes last, visibly, where a human can move it.
 *
 * An explicit sequence always wins. That is the whole point of the column being
 * editable, and `0` is read as "not stated" (invariant 7) rather than as the
 * number zero.
 *
 * @param after the first free number past the ladder — normally
 *   `max(CLASS_LADDER.length, highest existing sequence) + 1`, which the caller
 *   has to read from the school it is writing into.
 */
export function classSequence(name: string, supplied: unknown, after: number): number {
  const asked = supplied == null ? 0 : Number(supplied);
  if (Number.isFinite(asked) && asked > 0) return Math.trunc(asked);
  const ladder = ladderSequence(String(name));
  return ladder > 0 ? ladder : Math.max(after, CLASS_LADDER.length + 1);
}
