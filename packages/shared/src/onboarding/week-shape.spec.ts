import { describe, expect, it } from "vitest";
import {
  baseFromLessons, durationOn, halfDayPeriods, lessonsFromBase, longestDay, periodsOn, weekPeriods,
} from "./week-shape";

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

describe("§33.6 lessons and the base periods behind them", () => {
  it("reads six base periods at a span of two as three lessons", () => {
    expect(lessonsFromBase(6, 2)).toEqual({ lessons: 3, over: 0 });
  });

  it("is the identity for a class that has not set a span", () => {
    // Every class of every school today. The number typed is the number stored.
    expect(lessonsFromBase(6, 1)).toEqual({ lessons: 6, over: 0 });
    expect(baseFromLessons(6, 1)).toBe(6);
  });

  it("round-trips what somebody types", () => {
    expect(lessonsFromBase(baseFromLessons(3, 2), 2).lessons).toBe(3);
  });

  it("REPORTS a remainder rather than rounding it away", () => {
    // Five base periods at a span of two is two lessons and a stray half-lesson
    // — a correct timetable for the data given, and not what anybody meant.
    expect(lessonsFromBase(5, 2)).toEqual({ lessons: 2, over: 1 });
    expect(lessonsFromBase(7, 3)).toEqual({ lessons: 2, over: 1 });
  });

  it("treats a missing or nonsense span as one rather than dividing by zero", () => {
    expect(lessonsFromBase(6, 0)).toEqual({ lessons: 6, over: 0 });
    expect(baseFromLessons(3, 0)).toBe(3);
  });

  it("never returns a negative", () => {
    expect(lessonsFromBase(-4, 2)).toEqual({ lessons: 0, over: 0 });
    expect(baseFromLessons(-2, 2)).toBe(0);
  });
});
