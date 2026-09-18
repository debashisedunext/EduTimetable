/**
 * §29.8 — the predicate, tested for the cases that would be wrong silently.
 *
 * Every case here produces an answer either way; none of them throws. That is
 * why they are tested rather than read: a permissive mistake here opens a
 * published week and nothing reports it.
 */
import { describe, expect, it } from "vitest";
import { NO_GRANT, opensRow, shutEntities, type GrantSets } from "./grant";

const grant = (teachers: number[], sections: number[]): GrantSets => ({
  teacherIds: new Set(teachers),
  classSectionIds: new Set(sections),
});

describe("opensRow", () => {
  it("opens a slot by its teacher", () => {
    expect(opensRow(grant([7], []), { teacherIds: [7], classSectionIds: [1] })).toBe(true);
  });

  it("opens the same slot by its class-section instead", () => {
    expect(opensRow(grant([], [1]), { teacherIds: [7], classSectionIds: [1] })).toBe(true);
  });

  it("refuses when neither owner is unlocked", () => {
    expect(opensRow(grant([8], [2]), { teacherIds: [7], classSectionIds: [1] })).toBe(false);
  });

  it("takes EVERY section of a merged group, not any one of them", () => {
    // One mapping teaching 1-A, 1-B and 1-C. Unlocking 1-A and changing the row
    // would change 1-B and 1-C too, which are locked.
    const row = { teacherIds: [7], classSectionIds: [1, 2, 3] };
    expect(opensRow(grant([], [1]), row)).toBe(false);
    expect(opensRow(grant([], [1, 2]), row)).toBe(false);
    expect(opensRow(grant([], [1, 2, 3]), row)).toBe(true);
  });

  it("opens that same merged group by its single teacher", () => {
    // The point of a teacher unlock: re-staffing one person must not require
    // unlocking every class they teach.
    expect(opensRow(grant([7], []), { teacherIds: [7], classSectionIds: [1, 2, 3] })).toBe(true);
  });

  it("takes every OPTION teacher of a §4.9 block", () => {
    const row = { teacherIds: [7, 8, 9], classSectionIds: [1, 2] };
    expect(opensRow(grant([7, 8], []), row)).toBe(false);
    expect(opensRow(grant([7, 8, 9], []), row)).toBe(true);
    expect(opensRow(grant([], [1, 2]), row)).toBe(true);
  });

  it("never lets an EMPTY list satisfy its clause vacuously", () => {
    /*
      The dangerous case. `[].every(…)` is true, so without the length guard a
      curriculum row — which names a class and no teacher at all (§27) — would
      open itself against any grant, including an empty one.
    */
    const curriculum = { teacherIds: [], classSectionIds: [4, 5] };
    expect(opensRow(NO_GRANT, curriculum)).toBe(false);
    expect(opensRow(grant([7], []), curriculum)).toBe(false);
    expect(opensRow(grant([], [4, 5]), curriculum)).toBe(true);
  });

  it("never opens a row that names nothing", () => {
    // A caller that cannot say what it touches belongs in the `whole`
    // classification. Opening it here would be a grant admitting a write it
    // cannot describe.
    expect(opensRow(grant([7], [1]), { teacherIds: [], classSectionIds: [] })).toBe(false);
  });

  it("refuses everything under an empty grant", () => {
    expect(opensRow(NO_GRANT, { teacherIds: [7], classSectionIds: [1] })).toBe(false);
  });
});

describe("shutEntities", () => {
  it("names only what is actually shut", () => {
    // Telling somebody to unlock a teacher who already is unlocked sends them
    // to the wrong screen to fix the wrong thing.
    const out = shutEntities(grant([7], [1]), { teacherIds: [7, 8], classSectionIds: [1, 2] });
    expect(out).toEqual({ teacherIds: [8], classSectionIds: [2] });
  });

  it("names everything under an empty grant", () => {
    const out = shutEntities(NO_GRANT, { teacherIds: [7], classSectionIds: [1] });
    expect(out).toEqual({ teacherIds: [7], classSectionIds: [1] });
  });
});
