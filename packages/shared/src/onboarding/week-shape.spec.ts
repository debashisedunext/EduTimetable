import { describe, expect, it } from "vitest";
import { durationOn, halfDayPeriods, longestDay, periodsOn, weekPeriods } from "./week-shape";

describe("§34 a weekday with a shape of its own", () => {
  const plain = { periodsPerDay: 8, periodDurationMins: 40 };
  const shortSat = {
    ...plain,
    dayShapes: [{ day: 6, periodsPerDay: 4, periodDurationMins: 30 }],
  };
  const MON_SAT = [1, 2, 3, 4, 5, 6];

  it("falls back to the whole week's shape for a day nobody has changed", () => {
    // "Not stated" is the week's shape (invariant 7), never zero.
    expect(periodsOn(plain, 6)).toBe(8);
    expect(durationOn(plain, 6)).toBe(40);
    expect(periodsOn(shortSat, 1)).toBe(8);
  });

  it("uses the day's own shape where there is one", () => {
    expect(periodsOn(shortSat, 6)).toBe(4);
    expect(durationOn(shortSat, 6)).toBe(30);
  });

  it("SUMS the week rather than multiplying it", () => {
    // The number every periods-per-week entry is checked against. A product
    // would say 48 and the school would be told a curriculum fits that cannot.
    expect(weekPeriods(plain, MON_SAT)).toBe(48);
    expect(weekPeriods(shortSat, MON_SAT)).toBe(44);
  });

  it("counts only the days the school actually works", () => {
    expect(weekPeriods(shortSat, [1, 2, 3, 4, 5])).toBe(40);
  });

  it("reads a per-day cap against the LONGEST day", () => {
    // "At most 2 a day" is satisfiable on a full day even when a short
    // Saturday could not hold it; reading it against the short day would
    // refuse a school that is perfectly feasible.
    expect(longestDay(shortSat, MON_SAT)).toBe(8);
    expect(longestDay(shortSat, [6])).toBe(4);
  });

  it("defaults a half day to half the periods, rounded UP", () => {
    // The extra period is easier to remove than to discover is missing.
    expect(halfDayPeriods(8)).toBe(4);
    expect(halfDayPeriods(7)).toBe(4);
    expect(halfDayPeriods(1)).toBe(1);
  });

  it("never returns zero periods for a day, however it is asked", () => {
    // A day with no periods is a day the school does not work, and that is
    // what `workingDays` is for — a 0 here would silently empty a domain.
    expect(periodsOn({ periodsPerDay: 0 }, 1)).toBe(1);
    expect(periodsOn({ periodsPerDay: 8, dayShapes: [{ day: 6, periodsPerDay: 0, periodDurationMins: 0 }] }, 6)).toBe(8);
    expect(halfDayPeriods(0)).toBe(1);
  });
});
