import { describe, expect, it } from "vitest";
import { findClashes, groupClashes, minutesOf, type Occupancy } from "./clash";

const o = (key: string, day: number, start: string, end: string, label = ""): Occupancy => ({
  key, day, startMin: minutesOf(start)!, endMin: minutesOf(end)!, label,
});

describe("§30.7 cross-timetable clashes", () => {
  it("reads a time, and refuses anything that is not one", () => {
    expect(minutesOf("09:14")).toBe(554);
    expect(minutesOf("9:05")).toBe(545);
    expect(minutesOf("00:00")).toBe(0);
    // A malformed period row is skipped, never treated as midnight — which
    // would put it in the way of the first lesson of every day.
    expect(minutesOf("")).toBeNull();
    expect(minutesOf(null)).toBeNull();
    expect(minutesOf("nine")).toBeNull();
    expect(minutesOf("25:00")).toBeNull();
    expect(minutesOf("09:73")).toBeNull();
  });

  it("finds the overlap the period NUMBER would have missed", () => {
    // Junior P3 09:14–09:54 against Senior P2 09:14–09:49: different period
    // numbers, same teacher, same minutes. This is the pair the unique keys
    // cannot see, and the whole reason this file exists.
    const junior = [o("t:7", 1, "09:14", "09:54", "Junior P3")];
    const senior = [o("t:7", 1, "09:14", "09:49", "Senior P2")];
    const hits = findClashes(junior, senior);
    expect(hits).toHaveLength(1);
    expect(hits[0].a.label).toBe("Junior P3");
    expect(hits[0].b.label).toBe("Senior P2");
  });

  it("does not report the same period NUMBER when the clocks differ", () => {
    // Both are "P3", and they do not overlap. The naive comparison — same
    // period number, therefore a clash — would be wrong here in the other
    // direction, which is the half that is easy to forget.
    const junior = [o("t:7", 1, "09:14", "09:54", "Junior P3")];
    const senior = [o("t:7", 1, "11:00", "11:35", "Senior P3")];
    expect(findClashes(junior, senior)).toHaveLength(0);
  });

  it("treats touching as not overlapping", () => {
    // Otherwise every back-to-back pair in the school is a clash.
    const a = [o("r:2", 3, "09:00", "09:40")];
    const b = [o("r:2", 3, "09:40", "10:20")];
    expect(findClashes(a, b)).toHaveLength(0);
  });

  it("separates by day and by what is occupied", () => {
    const a = [o("t:1", 1, "09:00", "09:40"), o("t:1", 2, "09:00", "09:40")];
    const b = [
      o("t:1", 2, "09:10", "09:50"),   // same teacher, same day  → clash
      o("t:2", 1, "09:10", "09:50"),   // different teacher       → not
      o("t:1", 5, "09:10", "09:50"),   // different day           → not
    ];
    const hits = findClashes(a, b);
    expect(hits).toHaveLength(1);
    expect(hits[0].day).toBe(2);
  });

  it("groups by the thing occupied, counts, and keeps a few in order", () => {
    const a = [
      o("t:1", 3, "11:00", "11:40", "c"),
      o("t:1", 1, "09:00", "09:40", "a"),
      o("t:1", 1, "10:00", "10:40", "b"),
      o("t:1", 4, "12:00", "12:40", "d"),
      o("r:9", 1, "09:00", "09:40", "room"),
    ];
    const b = a.map((x) => ({ ...x, label: `other ${x.label}` }));
    const groups = groupClashes(findClashes(a, b));
    expect(groups.map((g) => g.key)).toEqual(["t:1", "r:9"]);   // busiest first
    expect(groups[0].count).toBe(4);
    expect(groups[0].samples).toHaveLength(3);                   // at most three
    expect(groups[0].samples.map((s) => s.a.label)).toEqual(["a", "b", "c"]);
  });

  it("reports nothing when one side is empty", () => {
    expect(findClashes([], [o("t:1", 1, "09:00", "09:40")])).toEqual([]);
    expect(findClashes([o("t:1", 1, "09:00", "09:40")], [])).toEqual([]);
  });
});
