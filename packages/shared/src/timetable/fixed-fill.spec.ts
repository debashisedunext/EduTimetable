/**
 * §36.6 — the three things "every day" must not do.
 *
 * Each of them turns a convenience into a destructive or invalid action, and
 * each is an off-by-one away from happening.
 */
import { describe, expect, it } from "vitest";
import { describeFill, fillAcrossDays, type FillPin } from "./fixed-fill";

const WEEK = [1, 2, 3, 4, 5];
const pin = (over: Partial<FillPin> = {}): FillPin => ({
  classSectionId: 1, subjectId: 10, teacherId: 100, dayOfWeek: 1, periodNumber: 2, ...over,
});
const days = (r: { add: FillPin[] }) => r.add.map((p) => p.dayOfWeek).sort();

describe("fillAcrossDays", () => {
  it("fills the other working days and never the source day twice", () => {
    const src = pin();
    const r = fillAcrossDays(src, [src], WEEK, 10);
    expect(days(r)).toEqual([2, 3, 4, 5]);
    expect(r.add.every((p) => p.subjectId === 10 && p.teacherId === 100 && p.periodNumber === 2)).toBe(true);
  });

  it("stops at the curriculum cap, counting what is already pinned", () => {
    // Three a week, one already placed (the source) — two more may be added.
    const src = pin();
    const r = fillAcrossDays(src, [src], WEEK, 3);
    expect(days(r)).toEqual([2, 3]);
    expect(r.capped).toBe(2);
  });

  it("counts periods of the subject pinned ELSEWHERE against the cap", () => {
    /*
      The cap is the class's weekly periods for the subject, so a lesson pinned
      on another period spends one just as surely. Counting only this period's
      column would let a fill sail past the cap and hand the save a set it
      refuses — the exact thing this function exists to prevent.
    */
    const src = pin();
    const other = pin({ dayOfWeek: 1, periodNumber: 5 });
    const r = fillAcrossDays(src, [src, other], WEEK, 3);
    expect(days(r)).toEqual([2]);
    expect(r.capped).toBe(3);
  });

  it("never overwrites a cell that already holds a lesson", () => {
    const src = pin();
    const taken = pin({ dayOfWeek: 3, subjectId: 99, teacherId: 999 });
    const r = fillAcrossDays(src, [src, taken], WEEK, 10);
    expect(days(r)).toEqual([2, 4, 5]);
    expect(r.taken).toBe(1);
    // …and the row that was there is untouched: nothing is returned for day 3.
    expect(r.add.some((p) => p.dayOfWeek === 3)).toBe(false);
  });

  it("skips a day where that teacher is already pinned in another section", () => {
    const src = pin();
    const elsewhere = pin({ classSectionId: 2, dayOfWeek: 4 });
    const r = fillAcrossDays(src, [src, elsewhere], WEEK, 10);
    expect(days(r)).toEqual([2, 3, 5]);
    expect(r.clash).toBe(1);
  });

  it("does not treat the SAME section's own pin as a teacher clash", () => {
    // The cell check already covers it; counting it twice would report a clash
    // that does not exist and confuse the reason given to the reader.
    const src = pin();
    const mine = pin({ dayOfWeek: 4 });
    const r = fillAcrossDays(src, [src, mine], WEEK, 10);
    expect(r.clash).toBe(0);
    expect(r.taken).toBe(1);
  });

  it("does not collide with what the same call has already added", () => {
    /*
      Two sections of one class taught by one teacher at one period: filling
      section 1 across the week must not then be able to fill section 2 into
      the same cells. The check reads the pins it is building as well as the
      ones it was given.
    */
    const src = pin();
    const first = fillAcrossDays(src, [src], WEEK, 10);
    const all = [src, ...first.add];
    const src2 = pin({ classSectionId: 2, dayOfWeek: 1 });
    const second = fillAcrossDays(src2, [...all, src2], WEEK, 10);
    expect(second.add).toHaveLength(0);
    expect(second.clash).toBe(4);
  });

  it("a one-day week adds nothing and says so", () => {
    const src = pin();
    const r = fillAcrossDays(src, [src], [1], 10);
    expect(r.add).toHaveLength(0);
    expect(describeFill(r, 10)).toBe("It is already fixed on every working day.");
  });
});

describe("describeFill", () => {
  it("names every reason it did not fill a day", () => {
    const msg = describeFill({ add: [pin()], taken: 1, clash: 1, capped: 2 }, 3);
    expect(msg).toContain("Fixed on 1 more day");
    expect(msg).toContain("already had a lesson fixed");
    expect(msg).toContain("clashed with that teacher");
    expect(msg).toContain("pass the 3 a week");
  });

  it("says nothing about reasons that did not apply", () => {
    const msg = describeFill({ add: [pin(), pin()], taken: 0, clash: 0, capped: 0 }, 6);
    expect(msg).toBe("Fixed on 2 more day(s).");
  });
});
