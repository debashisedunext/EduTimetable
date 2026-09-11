import { describe, expect, it } from "vitest";
import { collapseToLessons, rowKey, type GridRow } from "./reports.service";

/**
 * §33.7 — a spanned class's week prints in lessons, not base periods.
 */
describe("collapseToLessons", () => {
  const p = (n: number, start: string, end: string): GridRow => ({
    key: rowKey(1, n), configId: 1, wing: "Main", periodNumber: n,
    startTime: start, endTime: end, isBreak: false, breakName: null,
  });
  const brk = (start: string, end: string): GridRow => ({
    key: rowKey(1, null), configId: 1, wing: "Main", periodNumber: null,
    startTime: start, endTime: end, isBreak: true, breakName: "Lunch",
  });

  const four = [
    p(1, "08:00", "08:30"), p(2, "08:30", "09:00"),
    p(3, "09:00", "09:30"), p(4, "09:30", "10:00"),
  ];

  it("returns the rows untouched at span 1, by identity", () => {
    // Every class of every school that has not set a §33 span.
    expect(collapseToLessons(four, 1)).toBe(four);
  });

  it("folds pairs into one lesson that runs from the first to the last", () => {
    const out = collapseToLessons(four, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ periodNumber: 1, startTime: "08:00", endTime: "09:00" });
    expect(out[1]).toMatchObject({ periodNumber: 3, startTime: "09:00", endTime: "10:00" });
  });

  it("KEEPS the first period's key, so the grid still finds its cell", () => {
    // §10.6 — re-keying here would be that collision all over again. The cells
    // for the folded-away periods are simply never looked up.
    const out = collapseToLessons(four, 2);
    expect(out[0].key).toBe(rowKey(1, 1));
    expect(out[1].key).toBe(rowKey(1, 3));
  });

  it("keeps a break, and resets the grouping across it", () => {
    const rows = [p(1, "08:00", "08:30"), p(2, "08:30", "09:00"), brk("09:00", "09:20"),
      p(3, "09:20", "09:50"), p(4, "09:50", "10:20")];
    const out = collapseToLessons(rows, 2);
    expect(out.map((r) => r.isBreak)).toEqual([false, true, false]);
    expect(out[0]).toMatchObject({ startTime: "08:00", endTime: "09:00" });
    expect(out[2]).toMatchObject({ startTime: "09:20", endTime: "10:20" });
  });

  it("emits a run a break cut short rather than merging across it", () => {
    // A lesson cannot cross a break unless its curriculum row says so (§4.8),
    // so a break mid-run means the run was never one lesson. Printing an hour
    // that does not exist is worse than printing two halves that do.
    const rows = [p(1, "08:00", "08:30"), brk("08:30", "08:45"),
      p(2, "08:45", "09:15"), p(3, "09:15", "09:45")];
    const out = collapseToLessons(rows, 2);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ periodNumber: 1, endTime: "08:30" });
    expect(out[2]).toMatchObject({ periodNumber: 2, endTime: "09:45" });
  });

  it("handles a trailing group shorter than the span", () => {
    const out = collapseToLessons([...four, p(5, "10:00", "10:30")], 2);
    expect(out).toHaveLength(3);
    expect(out[2]).toMatchObject({ periodNumber: 5, endTime: "10:30" });
  });
});
