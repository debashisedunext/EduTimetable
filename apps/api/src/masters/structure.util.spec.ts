import { describe, expect, it } from "vitest";
import { buildPeriodRows, daySegmentsFromRows } from "./structure.util";

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
