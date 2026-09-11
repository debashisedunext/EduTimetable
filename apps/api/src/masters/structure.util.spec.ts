import { describe, expect, it } from "vitest";
import { breaksFromRows, buildPeriodRows, clockForDay, daySegmentsFromRows } from "./structure.util";

describe("buildPeriodRows (§3.10 computed times)", () => {
  it("computes start/end times through breaks and zero period", () => {
    const { rows, endTime } = buildPeriodRows({
      startTime: "08:00",
      periodsPerDay: 4,
      periodDurationMins: 40,
      hasZeroPeriod: true,
      zeroPeriodDurationMins: 20,
      breaks: [{ afterPeriod: 2, name: "Short Break", durationMins: 15 }],
    });
    expect(rows.map((r) => [r.periodNumber, r.startTime, r.endTime, r.isBreak])).toEqual([
      [0, "08:00", "08:20", false],
      [1, "08:20", "09:00", false],
      [2, "09:00", "09:40", false],
      [null, "09:40", "09:55", true],
      [3, "09:55", "10:35", false],
      [4, "10:35", "11:15", false],
    ]);
    expect(endTime).toBe("11:15");
  });

  it("rejects a break outside the period range", () => {
    expect(() =>
      buildPeriodRows({
        startTime: "08:00",
        periodsPerDay: 4,
        periodDurationMins: 40,
        hasZeroPeriod: false,
        breaks: [{ afterPeriod: 4, name: "X", durationMins: 10 }],
      }),
    ).toThrow(/outside the period range/);
  });

  it("daySegments: breaks split teaching runs, zero period excluded", () => {
    const { rows } = buildPeriodRows({
      startTime: "08:00",
      periodsPerDay: 7,
      periodDurationMins: 40,
      hasZeroPeriod: true,
      breaks: [
        { afterPeriod: 3, name: "Break", durationMins: 20 },
        { afterPeriod: 5, name: "Lunch", durationMins: 30 },
      ],
    });
    expect(daySegmentsFromRows(rows)).toEqual([3, 2, 2]);
  });
});

/**
 * §28.3/28.4 — the bands at either end of the day.
 *
 * Every test here is about a number that, if wrong, is wrong *quietly*: a
 * printed timetable off by twenty minutes, or a solver told the day has a
 * longer unbroken run than it has.
 */
describe("§28 daily activities", () => {
  const day = (activities: Parameters<typeof buildPeriodRows>[0]["activities"]) =>
    buildPeriodRows({
      startTime: "08:00",
      periodsPerDay: 4,
      periodDurationMins: 40,
      hasZeroPeriod: false,
      breaks: [{ afterPeriod: 2, name: "Lunch", durationMins: 15 }],
      activities,
    });

  it("puts an assembly BEFORE the day starts, without moving period 1", () => {
    // The decision this whole feature turns on. `startTime` is what a school
    // means by "when does teaching begin", and it is printed on the wall. An
    // assembly recorded for the first time is a fact that was already true —
    // nobody had written it down — so recording it must not make every
    // published period time twenty minutes late.
    const { rows, endTime } = day([
      { name: "Assembly", placement: "before_first", durationMins: 20 },
    ]);
    expect(rows[0]).toMatchObject({
      periodNumber: null, startTime: "07:40", endTime: "08:00",
      isActivity: true, isBreak: false, isExtra: false, breakName: "Assembly",
    });
    expect(rows[1]).toMatchObject({ periodNumber: 1, startTime: "08:00" });
    expect(endTime).toBe("10:55");
  });

  it("stacks two before-first activities in order, back from the start", () => {
    const { rows } = day([
      { name: "Attendance", placement: "before_first", durationMins: 10, sortOrder: 2 },
      { name: "Assembly", placement: "before_first", durationMins: 20, sortOrder: 1 },
    ]);
    expect(rows.slice(0, 2).map((r) => [r.breakName, r.startTime, r.endTime])).toEqual([
      ["Assembly", "07:30", "07:50"],
      ["Attendance", "07:50", "08:00"],
    ]);
    expect(rows[2]).toMatchObject({ periodNumber: 1, startTime: "08:00" });
  });

  it("puts a dispersal after everything, including the §18 extra window", () => {
    // A school running revision classes disperses after those. Putting the
    // dispersal before them would print a bus departure in the middle of a
    // lesson.
    const { rows, endTime, extraEndTime } = buildPeriodRows({
      startTime: "08:00", periodsPerDay: 2, periodDurationMins: 40,
      hasZeroPeriod: false, breaks: [],
      extraPeriodsPerDay: 1, extraPeriodDurationMins: 30, extraGapMins: 10,
      activities: [{ name: "Bus Dispersal", placement: "after_last", durationMins: 15 }],
    });
    const last = rows[rows.length - 1];
    expect(last).toMatchObject({ breakName: "Bus Dispersal", isActivity: true, startTime: "10:00" });
    // The teaching day and the extra window keep their own ends — a dispersal
    // is not part of either.
    expect(endTime).toBe("09:20");
    expect(extraEndTime).toBe("10:00");
  });

  it("never gives an activity a period number — which is what hides it from the solver", () => {
    const { rows } = day([
      { name: "Assembly", placement: "before_first", durationMins: 20 },
      { name: "Dispersal", placement: "after_last", durationMins: 15 },
    ]);
    // `domainFor` only builds cells for 1..periodsPerDay. A numbered activity
    // would become a placeable slot with a teacher already on duty in it, and
    // `uq_teacher_slot` could not see the clash because it compares numbers.
    expect(rows.filter((r) => r.isActivity).every((r) => r.periodNumber === null)).toBe(true);
  });

  it("does NOT count an activity as a teaching period in daySegments", () => {
    // The quiet one. An activity row is not a break, so without the filter the
    // run counter reads the assembly as teaching — telling the solver the first
    // run is 3 long when it is 2, and letting a double period straddle a
    // boundary that does not exist.
    const { rows } = day([{ name: "Assembly", placement: "before_first", durationMins: 20 }]);
    expect(daySegmentsFromRows(rows)).toEqual([2, 2]);
  });

  it("refuses a duration that is not a duration", () => {
    expect(() => day([{ name: "Assembly", placement: "before_first", durationMins: 0 }]))
      .toThrow(/Assembly must be between/);
  });
});

describe("§34.5 the clock on a day with its own shape", () => {
  const spec = {
    startTime: "08:00",
    periodsPerDay: 8,
    periodDurationMins: 40,
    hasZeroPeriod: false,
    breaks: [{ afterPeriod: 4, name: "Lunch", durationMins: 30 }],
  };
  const stored = buildPeriodRows(spec).rows;
  const teaching = (rows: ReturnType<typeof buildPeriodRows>["rows"]) =>
    rows.filter((r) => !r.isBreak && r.periodNumber !== null);

  it("returns the stored rows untouched for a day with no shape", () => {
    // Every day of every school that has not said otherwise — same objects,
    // no arithmetic repeated.
    expect(clockForDay(stored, spec, undefined)).toBe(stored);
  });

  it("returns them untouched for a shape that matches the week", () => {
    expect(clockForDay(stored, spec, { periodsPerDay: 8, periodDurationMins: 40 })).toBe(stored);
  });

  it("gives a short Saturday its OWN times, not Monday's", () => {
    // The bug this exists for: §30.7 compares two live timetables by wall
    // clock, so a Saturday described with Monday's minutes can both miss a
    // real overlap and invent one.
    const sat = teaching(clockForDay(stored, spec, { periodsPerDay: 4, periodDurationMins: 30 }));
    expect(sat).toHaveLength(4);
    expect(sat[0]).toMatchObject({ periodNumber: 1, startTime: "08:00", endTime: "08:30" });
    expect(sat[1]).toMatchObject({ periodNumber: 2, startTime: "08:30", endTime: "09:00" });
    // Monday's period 2 is 08:40–09:20 on the same grid.
    expect(teaching(stored)[1]).toMatchObject({ startTime: "08:40", endTime: "09:20" });
  });

  it("drops a break the short day never reaches", () => {
    // A lunch after period 6 on a four-period Saturday is not a late lunch,
    // it is a break at the end of the day — printing one nobody takes is
    // worse than printing none.
    const late = { ...spec, breaks: [{ afterPeriod: 6, name: "Lunch", durationMins: 30 }] };
    const rows = clockForDay(buildPeriodRows(late).rows, late, { periodsPerDay: 4, periodDurationMins: 30 });
    expect(rows.some((r) => r.isBreak)).toBe(false);
    expect(teaching(rows)).toHaveLength(4);
  });

  it("keeps a break the short day does reach, and shifts what follows", () => {
    const early = { ...spec, breaks: [{ afterPeriod: 2, name: "Snack", durationMins: 15 }] };
    const rows = clockForDay(buildPeriodRows(early).rows, early, { periodsPerDay: 4, periodDurationMins: 30 });
    expect(rows.find((r) => r.isBreak)).toMatchObject({ startTime: "09:00", endTime: "09:15" });
    expect(teaching(rows)[2]).toMatchObject({ periodNumber: 3, startTime: "09:15" });
  });

  it("falls back to the stored rows rather than throwing on a shape it cannot build", () => {
    // A wrong clock on one day is a smaller failure than a report that will
    // not render at all.
    expect(clockForDay(stored, spec, { periodsPerDay: 99, periodDurationMins: 40 })).toBe(stored);
  });

  it("recovers the breaks from stored rows, which is how the rebuild knows them", () => {
    expect(breaksFromRows(stored)).toEqual([{ afterPeriod: 4, name: "Lunch", durationMins: 30 }]);
  });
});
