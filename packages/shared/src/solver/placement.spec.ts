import { describe, expect, it } from "vitest";
import { lunchAllows } from "./variables";
import { runFeasibility } from "../feasibility/engine";
import { cleanSchool } from "../feasibility/fixtures";
import { scoreTimetable } from "../optimize/objective";
import type { Placement, SolverInput, SolverVariable } from "./types";

/**
 * §26.3 — the lunch rules, the priority term, and the check that refuses a
 * school which cannot satisfy them.
 *
 * These three are one feature seen from three sides, and they have to agree: a
 * rule the solver prunes on, a preference the objective scores, and a check
 * that counts the cells the pruning leaves. A disagreement between the first
 * and the third is the specific failure the two-phase split exists to prevent —
 * Readiness saying 100% and the generation coming back short.
 */

describe("§26.3 the lunch rules, as the solver prunes them", () => {
  // The fixture's day: P1-P3, lunch, P4-P6.
  const LUNCH = 3;
  const before = [{ lunchRule: "before" as const, gapAfterLunch: false }];
  const after = [{ lunchRule: "after" as const, gapAfterLunch: false }];
  const gap = [{ lunchRule: "any" as const, gapAfterLunch: true }];

  it("keeps a 'before lunch' subject in the morning", () => {
    expect([1, 2, 3].every((p) => lunchAllows(before, p, 1, LUNCH))).toBe(true);
    expect([4, 5, 6].some((p) => lunchAllows(before, p, 1, LUNCH))).toBe(false);
  });

  it("keeps an 'after lunch' subject in the afternoon", () => {
    expect([1, 2, 3].some((p) => lunchAllows(after, p, 1, LUNCH))).toBe(false);
    expect([4, 5, 6].every((p) => lunchAllows(after, p, 1, LUNCH))).toBe(true);
  });

  it("blocks exactly the period straight after lunch, and only that one", () => {
    expect(lunchAllows(gap, 4, 1, LUNCH)).toBe(false);
    for (const p of [1, 2, 3, 5, 6]) expect(lunchAllows(gap, p, 1, LUNCH), `P${p}`).toBe(true);
  });

  /**
   * The bug this exists for. A double period is checked at its START, so a
   * block beginning at P3 with `before lunch` would pass a start-only test
   * while its second period sat at P4 — in the afternoon, under a rule that
   * says mornings.
   */
  it("checks EVERY period of a block, not just where it starts", () => {
    // P3+P4 straddles the boundary: legal by its start, illegal as a whole.
    expect(lunchAllows(before, 3, 2, LUNCH)).toBe(false);
    expect(lunchAllows(before, 2, 2, LUNCH)).toBe(true);
    // A gap rule catches a block whose SECOND period lands in the blocked cell.
    expect(lunchAllows(gap, 3, 2, LUNCH)).toBe(false);
    expect(lunchAllows(gap, 4, 2, LUNCH)).toBe(false);
    expect(lunchAllows(gap, 5, 2, LUNCH)).toBe(true);
  });

  it("applies EVERY subject's rule when several share a slot (§4.9)", () => {
    // A split elective runs its options at once, so one Games option drags the
    // whole block after lunch — which is why Check 10 has to see it first.
    const block = [
      { lunchRule: "any" as const, gapAfterLunch: false },
      { lunchRule: "after" as const, gapAfterLunch: true },
    ];
    expect(lunchAllows(block, 2, 1, LUNCH)).toBe(false); // morning: the Games option refuses
    expect(lunchAllows(block, 4, 1, LUNCH)).toBe(false); // straight after lunch: the gap refuses
    expect(lunchAllows(block, 5, 1, LUNCH)).toBe(true);
  });

  it("does nothing at all when the day has no break", () => {
    // A real answer, not a fallback: with no lunch there is no side to be on,
    // so the rules switch off rather than attaching to a guessed boundary.
    for (const p of [1, 2, 3, 4, 5, 6]) {
      expect(lunchAllows(before, p, 1, null), `P${p}`).toBe(true);
      expect(lunchAllows(after, p, 1, null), `P${p}`).toBe(true);
      expect(lunchAllows(gap, p, 1, null), `P${p}`).toBe(true);
    }
  });
});

describe("§26.3 Check 10 — the lunch side has to hold what is confined to it", () => {
  /** The clean fixture, with one subject confined to one side of lunch. */
  const withRule = (rule: "before" | "after", gapAfterLunch = false, periods?: number) => {
    const snap = cleanSchool();
    const maths = snap.subjectRequirements.find((r) => r.subjectName === "Maths")!;
    if (periods !== undefined) maths.periodsPerWeek = periods;
    snap.subjectPlacement = {
      [maths.subjectId]: {
        subjectName: "Maths", category: "scholastic", priority: 3, lunchRule: rule, gapAfterLunch,
      },
    };
    return snap;
  };

  it("passes when the confined subject fits — 6 periods into 15 morning cells", () => {
    // 5 days × 3 morning periods = 15; Maths wants 6.
    const r = runFeasibility(withRule("before"));
    expect(r.blockers.filter((b) => b.code === "LUNCH_SIDE_CAPACITY")).toEqual([]);
  });

  it("REFUSES before the solver runs when it does not fit, with both numbers", () => {
    // 16 periods a week, all before lunch, into 15 cells.
    const r = runFeasibility(withRule("before", false, 16));
    const issue = r.blockers.find((b) => b.code === "LUNCH_SIDE_CAPACITY");
    expect(issue, "expected a blocker").toBeDefined();
    expect(issue!.message).toContain("16 periods");
    expect(issue!.message).toContain("only 15");
    expect(issue!.message).toContain("before lunch");
    // The fix names a real way out, not "reduce the load".
    expect(issue!.fix).toContain("any time");
  });

  it("counts the gap rule as the cell it takes away", () => {
    // Afternoon is P4-P6 = 15 cells; the gap removes P4, leaving 10. 12 > 10.
    const r = runFeasibility(withRule("after", true, 12));
    const issue = r.blockers.find((b) => b.code === "LUNCH_SIDE_CAPACITY");
    expect(issue, "expected a blocker").toBeDefined();
    expect(issue!.message).toContain("only 10");
    expect(issue!.message).toContain("straight after lunch is kept free");
  });

  it("adds up subjects sharing a side rather than checking each alone", () => {
    // Two subjects at 8 each fit individually into 15, and cannot together.
    const snap = cleanSchool();
    const [a, b] = snap.subjectRequirements;
    a.periodsPerWeek = 8;
    b.periodsPerWeek = 8;
    snap.subjectPlacement = {
      [a.subjectId]: { subjectName: a.subjectName, category: "scholastic", priority: 3, lunchRule: "before", gapAfterLunch: false },
      [b.subjectId]: { subjectName: b.subjectName, category: "scholastic", priority: 3, lunchRule: "before", gapAfterLunch: false },
    };
    const issue = runFeasibility(snap).blockers.find((x) => x.code === "LUNCH_SIDE_CAPACITY");
    expect(issue, "two subjects must compete for the same cells").toBeDefined();
    expect(issue!.message).toContain("16 periods");
  });

  it("says nothing about a school that sets no rules — which is every school today", () => {
    const r = runFeasibility(cleanSchool());
    expect(r.blockers.filter((b) => b.code === "LUNCH_SIDE_CAPACITY")).toEqual([]);
  });

  it("says nothing when the day has no break to have sides of", () => {
    const snap = withRule("before", false, 16);
    snap.config.lunchAfterPeriod = null;
    expect(runFeasibility(snap).blockers.filter((b) => b.code === "LUNCH_SIDE_CAPACITY")).toEqual([]);
  });
});

describe("§26.2 priority as a score, not a rule", () => {
  /** Two placements of one subject, so only the period differs. */
  const scoreAt = (priority: number, period: number) => {
    const snap = cleanSchool();
    snap.subjectPlacement = {
      300: { subjectName: "Maths", category: "scholastic", priority, lunchRule: "any", gapAfterLunch: false },
    };
    const input = { snapshot: snap, lockedSlots: [], preferredRoomByMapping: {} } as unknown as SolverInput;
    const vars = [{ id: 1, needsLabRoom: false } as unknown as SolverVariable];
    const placements = [{
      variableId: 1, day: 1, period, span: 1, subjectId: 300, teacherId: 101,
      classSectionIds: [11], roomId: null, options: [],
    } as unknown as Placement];
    return scoreTimetable(input, placements, vars).subjectPriority;
  };

  it("prefers a high-priority subject early — and the preference has a size", () => {
    // Lower is better. Priority 5 in P1 is the best case and scores 0.
    expect(scoreAt(5, 1)).toBe(0);
    expect(scoreAt(5, 6)).toBeGreaterThan(scoreAt(5, 1));
  });

  it("mirrors it for a low-priority subject — pushing Library late is a GAIN", () => {
    expect(scoreAt(1, 6)).toBeLessThan(scoreAt(1, 1));
  });

  it("is exactly zero at the neutral default, so a school that sets nothing is unaffected", () => {
    for (const period of [1, 2, 3, 4, 5, 6]) expect(scoreAt(3, period), `P${period}`).toBe(0);
  });
});
