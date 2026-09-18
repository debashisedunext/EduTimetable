/**
 * §28.7 — the walk between wings.
 *
 * Every case here is one the arithmetic can get wrong while still producing a
 * number, which is why it is tested rather than inspected.
 */
import { describe, expect, it } from "vitest";
import { crossWingConflict, describeCrossWing, type WingLesson } from "./cross-wing";

/** Wing B, Monday 09:10–09:40, five minutes away. */
const other = (over: Partial<WingLesson> = {}): WingLesson => ({
  dayOfWeek: 1, start: 9 * 60 + 10, end: 9 * 60 + 40, configName: "Senior Wing", travelMins: 5, ...over,
});

describe("crossWingConflict", () => {
  it("refuses the period straight after one in another wing", () => {
    // 08:40–09:10 here, 09:10 there: no minutes at all for a five-minute walk.
    const v = crossWingConflict([other()], 1, 8 * 60 + 40, 9 * 60 + 10, 5);
    expect(v).toMatchObject({ configName: "Senior Wing", gapMins: 0, needMins: 5 });
  });

  it("allows it once there is enough time", () => {
    // 08:30–09:00, then ten minutes before the other wing starts.
    expect(crossWingConflict([other()], 1, 8 * 60 + 30, 9 * 60, 5)).toBeNull();
  });

  it("works in the other direction too — before as well as after", () => {
    // The other lesson ENDS at 09:40; this one starts at 09:42.
    const v = crossWingConflict([other()], 1, 9 * 60 + 42, 10 * 60 + 12, 5);
    expect(v).toMatchObject({ gapMins: 2, needMins: 5 });
  });

  it("catches a genuine OVERLAP as the same arithmetic, not a special case", () => {
    /*
      Timetabled in both wings at once. The gap is negative, which is just a
      walk with less than no time for it — and it must refuse even when nobody
      has measured the walk, which is what the zero-travel case below asserts.
    */
    const v = crossWingConflict([other()], 1, 9 * 60 + 20, 9 * 60 + 50, 5);
    expect(v!.gapMins).toBeLessThan(0);
  });

  it("refuses an overlap even at zero travel minutes", () => {
    // Useful to a school that has never measured the walk: "in two places at
    // once" is wrong however close the wings are.
    const v = crossWingConflict([other({ travelMins: 0 })], 1, 9 * 60 + 20, 9 * 60 + 50, 0);
    expect(v).not.toBeNull();
  });

  it("does not object to a back-to-back crossing at zero travel", () => {
    // Nothing has been measured, so nothing is claimed.
    expect(crossWingConflict([other({ travelMins: 0 })], 1, 8 * 60 + 40, 9 * 60 + 10, 0)).toBeNull();
  });

  it("uses the LARGER of the two wings' travel figures", () => {
    // This wing says 2 minutes, the other says 12. The walk is the same walk.
    const v = crossWingConflict([other({ travelMins: 12 })], 1, 8 * 60 + 45, 9 * 60 + 5, 2);
    expect(v).toMatchObject({ gapMins: 5, needMins: 12 });
  });

  it("ignores another day entirely", () => {
    expect(crossWingConflict([other({ dayOfWeek: 2 })], 1, 8 * 60 + 40, 9 * 60 + 10, 5)).toBeNull();
  });

  it("reports the WORST offender, not the first", () => {
    // A refusal that named the roomy wing would send somebody to fix the wrong
    // timetable.
    const v = crossWingConflict(
      [other({ configName: "Roomy", start: 10 * 60, end: 10 * 60 + 30 }),
       other({ configName: "Tight", start: 9 * 60 + 10, end: 9 * 60 + 40 })],
      1, 8 * 60 + 40, 9 * 60 + 10, 5,
    );
    expect(v?.configName).toBe("Tight");
  });

  it("says nothing when the teacher works in no other wing", () => {
    expect(crossWingConflict(undefined, 1, 540, 570, 10)).toBeNull();
    expect(crossWingConflict([], 1, 540, 570, 10)).toBeNull();
  });
});

describe("describeCrossWing", () => {
  it("tells an overlap and a tight walk apart", () => {
    expect(describeCrossWing({ configName: "Senior", gapMins: -10, needMins: 5 }))
      .toBe("already teaching in Senior at this time");
    expect(describeCrossWing({ configName: "Senior", gapMins: 2, needMins: 5 }))
      .toBe("only 2 min to reach Senior, and the walk needs 5");
  });
});
