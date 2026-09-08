import { describe, expect, it } from "vitest";
import { migrateStep, TOTAL_STEPS } from "./onboarding.service";

/**
 * §28 — reading a stored step number under whichever numbering wrote it.
 *
 * The guided setup went from eleven steps to ten when Curriculum and Mapping
 * merged, and the collision is exact: **old step 10 was Mapping, new step 10 is
 * Settings.** A stored `10` alone cannot say which is meant, so the draft
 * records the scheme it was written under.
 *
 * The failure this prevents is quiet and expensive: somebody halfway through
 * setting up their own school, resuming, and landing on the last screen with
 * every allocation unset — which reads as the wizard having lost their work.
 */
describe("§28 the step-number migration", () => {
  const OLD = {};                               // a draft written before the merge
  const NEW = { __stepScheme: 2 };              // one written after it

  it("leaves steps 1–9 exactly where they were", () => {
    // Steps 1–8 are untouched by the merge, and old step 9 (Curriculum) is new
    // step 9 (Allocation) — the same screen, doing more. Somebody resuming at 9
    // is already where they should be.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(migrateStep(n, OLD)).toBe(n);
      expect(migrateStep(n, NEW)).toBe(n);
    }
  });

  it("shifts the two steps that moved, and ONLY for an old draft", () => {
    expect(migrateStep(10, OLD)).toBe(9);       // Mapping   → Allocation
    expect(migrateStep(11, OLD)).toBe(10);      // Settings  → Settings
    // The collision. Same number, two meanings, and the marker is what tells
    // them apart — a heuristic on the answers could not.
    expect(migrateStep(10, NEW)).toBe(10);      // Settings  → Settings
  });

  it("clamps anything outside the range rather than trusting it", () => {
    expect(migrateStep(0, NEW)).toBe(1);
    expect(migrateStep(99, NEW)).toBe(TOTAL_STEPS);
    expect(migrateStep(99, OLD)).toBe(TOTAL_STEPS);
  });

  it("treats a missing or malformed answers blob as an old draft", () => {
    // The safe direction: an unrecognisable draft is more likely to be an old
    // one than a new one, and being sent back a step costs a click where being
    // sent forward costs the allocation screen entirely.
    expect(migrateStep(11, null)).toBe(10);
    expect(migrateStep(11, undefined)).toBe(10);
    expect(migrateStep(11, { __stepScheme: "2" })).toBe(10);
  });
});
