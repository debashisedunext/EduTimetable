/**
 * §27.17 — the per-wing fallback, and the bug it was extracted to stop.
 *
 * The regression at the bottom is the one that matters: it is the exact shape a
 * school reported, and it fails against the old single-gate behaviour.
 */
import { describe, expect, it } from "vitest";
import { mergeByWing } from "./fallback";

interface Row { id: string; wings: Array<string | undefined> }
const wingsOf = (r: Row) => r.wings;
const row = (id: string, ...wings: Array<string | undefined>): Row => ({ id, wings });
const ids = (rows: Row[]) => rows.map((r) => r.id).sort();

describe("mergeByWing", () => {
  it("uses the proposal outright when nothing is stored", () => {
    // `null` is "never edited", which is not the same as "edited to nothing" —
    // an empty array means the school HAS answered, and answered with none.
    expect(ids(mergeByWing(null, [row("p", "Junior")], wingsOf))).toEqual(["p"]);
    expect(ids(mergeByWing([], [row("p", "Junior")], wingsOf))).toEqual(["p"]);
  });

  it("keeps a planned wing's own rows and refuses the proposal for it", () => {
    const out = mergeByWing([row("mine", "Junior")], [row("theirs", "Junior")], wingsOf);
    expect(ids(out)).toEqual(["mine"]);
  });

  it("still proposes for a wing nobody has touched", () => {
    // §27.15's whole point: a school that plans Junior and then adds Senior
    // must not find Senior empty.
    const out = mergeByWing([row("mine", "Junior")], [row("sen", "Senior")], wingsOf);
    expect(ids(out)).toEqual(["mine", "sen"]);
  });

  it("suppresses a multi-wing proposal if ANY of its wings is planned", () => {
    // A §4.10 merged group spanning two wings is one row; half-proposing it
    // would staff children in a wing whose plan is already settled.
    const out = mergeByWing([row("mine", "Junior")], [row("both", "Junior", "Senior")], wingsOf);
    expect(ids(out)).toEqual(["mine"]);
  });

  it("treats an unknown wing as no reason to suppress anything", () => {
    // A stored row naming a class the plan does not know must not mark any wing
    // as planned, and a proposal with no wing must not be filtered out.
    const out = mergeByWing([row("stale", undefined)], [row("p", "Junior"), row("q", undefined)], wingsOf);
    expect(ids(out)).toEqual(["p", "q", "stale"]);
  });

  /**
   * The reported bug, as an assertion.
   *
   * A school narrowed a wing to UKG–Class 2 while its stored curriculum still
   * covered Class 4–12. No stored cell belonged to the wing, so the grid filled
   * in from the proposal — periods AND teachers. One digit typed put the wing's
   * own classes into the stored CURRICULUM, and the single shared gate then cut
   * the MAPPING proposal off as well: 57 staffed cells became "nobody".
   *
   * Two gates, two answers: the curriculum is now planned for this wing, the
   * staffing is not.
   */
  it("does not let one fact's edits switch off another fact's proposal", () => {
    const WING = "Main";
    // What the school had stored: a curriculum for OTHER wings, no staffing.
    const storedCurriculum = [row("c-class9", "Senior")];
    const storedMappings: Row[] = [];

    const proposedCurriculum = [row("c-ukg", WING)];
    const proposedMappings = [row("m-ukg", WING)];

    // Before the edit — everything is proposed.
    expect(ids(mergeByWing(storedCurriculum, proposedCurriculum, wingsOf))).toEqual(["c-class9", "c-ukg"]);
    expect(ids(mergeByWing(storedMappings, proposedMappings, wingsOf))).toEqual(["m-ukg"]);

    // The keystroke: the grid writes its whole cell list back, so the wing's
    // own classes are now in the stored curriculum.
    const afterTyping = [...storedCurriculum, row("c-ukg-edited", WING)];

    // The curriculum is now the school's, which is correct and intended.
    expect(ids(mergeByWing(afterTyping, proposedCurriculum, wingsOf)))
      .toEqual(["c-class9", "c-ukg-edited"]);

    // …and the staffing is untouched by that, which is the fix. Gated on the
    // OLD shared rule this would be `[]` — 57 teachers gone on one keystroke.
    expect(ids(mergeByWing(storedMappings, proposedMappings, wingsOf))).toEqual(["m-ukg"]);
  });
});
