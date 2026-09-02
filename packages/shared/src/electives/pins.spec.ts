/**
 * §4.9 Phase 15 — the one place that decides what "Mon P4" means.
 *
 * These tests exist because three surfaces write pins (the screen, the Excel
 * importer, the API) and two read them (the solver, the Feasibility Engine).
 * A disagreement between any pair moves a lesson to a day nobody chose, and
 * nothing downstream would notice.
 */
import { describe, expect, it } from "vitest";
import { placementFromLabel, placementToLabel } from "../import/contract";
import { formatPins, parsePins, parsePinText } from "./pins";

describe("parsePinText — what a person may type in a spreadsheet", () => {
  it("reads the documented form", () => {
    expect(parsePinText("Mon P4, Wed P4, Fri P4")).toEqual({
      pins: [
        { day: 1, period: 4 },
        { day: 3, period: 4 },
        { day: 5, period: 4 },
      ],
      bad: [],
    });
  });

  it("accepts the ways people actually write it", () => {
    for (const text of ["Monday 4", "mon-4", "MON P4", "1:4", "Mon  p 4"]) {
      expect(parsePinText(text).pins, text).toEqual([{ day: 1, period: 4 }]);
    }
  });

  it("reports what it could not read rather than guessing", () => {
    const { pins, bad } = parsePinText("Mon P4, Mondey P4, Funday P2");
    expect(pins).toEqual([{ day: 1, period: 4 }]);
    expect(bad).toEqual(["Mondey P4", "Funday P2"]);
  });

  it("ignores empty entries and stray separators", () => {
    expect(parsePinText(" Mon P4 ,, ; Wed P4 ").pins).toEqual([
      { day: 1, period: 4 },
      { day: 3, period: 4 },
    ]);
    expect(parsePinText("").pins).toEqual([]);
  });

  it("round-trips through formatPins", () => {
    const text = "Mon P4, Wed P4";
    expect(formatPins(parsePinText(text).pins)).toBe(text);
  });
});

describe("parsePins — reading what the database holds", () => {
  it("keeps well-formed pins", () => {
    expect(parsePins([{ day: 2, period: 3 }])).toEqual([{ day: 2, period: 3 }]);
  });

  it("drops anything malformed instead of inventing a slot", () => {
    // A dropped pin surfaces as ELECTIVE_PIN_COUNT on the Readiness Dashboard.
    // A guessed one silently moves a whole grade's language period.
    expect(parsePins([{ day: 9, period: 3 }, { day: 2 }, null, "Mon P4", { day: 2, period: 0 }])).toEqual([]);
  });

  it("treats a missing column as no pins, so a pre-Phase-15 row still loads", () => {
    expect(parsePins(null)).toEqual([]);
    expect(parsePins(undefined)).toEqual([]);
  });
});

describe("placement labels — the workbook's words", () => {
  it("maps both ways", () => {
    for (const v of ["solver", "same_period", "fixed"] as const) {
      expect(placementFromLabel(placementToLabel(v))).toBe(v);
    }
  });

  it("falls back to the default that changes nothing", () => {
    // Never to a stricter rule: a typo in the When column must not pin a block.
    for (const junk of ["", "  ", "Fixed slot", "whatever", null, undefined]) {
      expect(placementFromLabel(junk)).toBe("solver");
    }
  });

  it("is case- and space-insensitive, like every other enum in the workbook", () => {
    expect(placementFromLabel("  FIXED SLOTS ")).toBe("fixed");
    expect(placementFromLabel("same period every day")).toBe("same_period");
  });
});
