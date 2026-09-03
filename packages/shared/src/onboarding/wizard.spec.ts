import { describe, expect, it } from "vitest";
import {
  CLASS_LADDER,
  CLASS_LADDER_SHORT,
  classSheets,
  planClasses,
  planSummary,
  sectionLetters,
  sessionSheets,
  weeklyCapacity,
} from "./wizard";
import { SHEETS } from "../import/contract";

/**
 * §15.3 Phase 25.3 — the wizard's expansion, away from any database.
 *
 * These are the rules that decide what a slider position MEANS. Getting them
 * wrong produces a school with the wrong classes in it, which is the kind of
 * thing nobody notices until the timetable comes out.
 */

const wing = (name: string, fromIndex: number, toIndex: number, sections = 2, overrides = {}) =>
  ({ name, fromIndex, toIndex, sections, overrides });

describe("§15.3 the class ladder", () => {
  it("has a short label for every rung — the slider cannot show 'Pre-Nursery'", () => {
    expect(CLASS_LADDER_SHORT).toHaveLength(CLASS_LADDER.length);
  });

  it("is in school order, which is what makes `sequence` meaningful", () => {
    // The whole reason for a fixed vocabulary: position becomes
    // `classes.sequence`, and that is what stops every later screen sorting
    // "Class 10" before "Class 2".
    expect(CLASS_LADDER.indexOf("Class 2")).toBeLessThan(CLASS_LADDER.indexOf("Class 10"));
    expect(CLASS_LADDER.indexOf("Nursery")).toBeLessThan(CLASS_LADDER.indexOf("Class 1"));
  });

  it("fits the importer's 20-character class name", () => {
    const max = SHEETS.find((s) => s.name === "Classes")!.columns.find((c) => c.key === "name")!.maxLength!;
    for (const c of CLASS_LADDER) expect(c.length, c).toBeLessThanOrEqual(max);
  });
});

describe("§15.3 section lettering", () => {
  it("gives A, B, C, D for four", () => {
    expect(sectionLetters(4)).toEqual(["A", "B", "C", "D"]);
  });

  it("does NOT run off the end of the alphabet into punctuation", () => {
    // `String.fromCharCode(65 + i)` alone produces "[", "\" and "]" for a 27th,
    // 28th and 29th section — nonsense that fits VarChar(10) and would land in
    // the database looking like data.
    const many = sectionLetters(29);
    expect(many[25]).toBe("Z");
    expect(many.slice(26)).toEqual(["AA", "AB", "AC"]);
    expect(many.every((s) => /^[A-Z]+$/.test(s))).toBe(true);
  });

  it("fits the importer's 10-character section name", () => {
    const max = SHEETS.find((s) => s.name === "Class Sections")!.columns
      .find((c) => c.key === "sectionName")!.maxLength!;
    for (const s of sectionLetters(60)) expect(s.length).toBeLessThanOrEqual(max);
  });

  it("handles nothing, one, and nonsense", () => {
    expect(sectionLetters(0)).toEqual([]);
    expect(sectionLetters(1)).toEqual(["A"]);
    expect(sectionLetters(-5)).toEqual([]);
    expect(sectionLetters(3.7)).toEqual(["A", "B", "C"]);
  });
});

describe("§15.3 expanding wings into classes", () => {
  it("covers the range inclusively, both ends", () => {
    const { classes } = planClasses([wing("Primary", 0, 3)]);
    expect(classes.map((c) => c.className)).toEqual(["Pre-Nursery", "Nursery", "LKG", "UKG"]);
  });

  it("lets a Secondary wing start where it actually starts", () => {
    // The reason for a two-handle range: with one handle, 9–12 means creating
    // Pre-Nursery through 12 and then deleting nine classes.
    const { classes } = planClasses([wing("Senior", 12, 15)]);
    expect(classes.map((c) => c.className)).toEqual(["Class 9", "Class 10", "Class 11", "Class 12"]);
  });

  it("sets sequence from the ladder position, not the order created", () => {
    const { classes } = planClasses([wing("Senior", 12, 13), wing("Primary", 4, 5)]);
    const seq = Object.fromEntries(classes.map((c) => [c.className, c.sequence]));
    expect(seq["Class 1"]).toBeLessThan(seq["Class 9"]);
  });

  it("refuses a class claimed by two wings rather than merging them", () => {
    // `classes.name` is unique per school, so both cannot exist. Which wing
    // teaches Class 6 is a decision, not something to guess.
    const { classes, issues } = planClasses([wing("Middle", 9, 11), wing("Senior", 11, 15)]);
    expect(issues).toHaveLength(1);
    // Middle 9–11 is Class 6–8; Senior 11–15 is Class 8–12. The overlap is
    // Class 8 — named in the message, and created exactly once.
    expect(issues[0].message).toContain("Class 8");
    expect(issues[0].message).toContain("Middle");
    expect(classes.filter((c) => c.className === "Class 8")).toHaveLength(1);
    expect(classes.find((c) => c.className === "Class 8")!.wing).toBe("Middle");
  });

  it("honours a per-class override from the grid", () => {
    const { classes } = planClasses([
      wing("Primary", 4, 6, 4, { "Class 2": { sections: 6 }, "Class 3": { removed: true } }),
    ]);
    expect(classes.map((c) => c.className)).toEqual(["Class 1", "Class 2"]);
    expect(classes.find((c) => c.className === "Class 1")!.sections).toHaveLength(4);
    expect(classes.find((c) => c.className === "Class 2")!.sections).toHaveLength(6);
  });

  it("survives a reversed range rather than producing nothing", () => {
    const { classes } = planClasses([wing("Odd", 6, 4)]);
    expect(classes.map((c) => c.className)).toEqual(["Class 3"]);
  });

  it("clamps a range that runs off the ladder", () => {
    const { classes } = planClasses([wing("Wide", -3, 99, 1)]);
    expect(classes).toHaveLength(CLASS_LADDER.length);
  });
});

describe("§15.3 the importer sheets it produces", () => {
  const answers = {
    session: { name: "2026-27", startDate: "2026-04-01", endDate: "2027-03-31" },
    wings: [wing("Primary Wing", 4, 6, 3), wing("Senior Wing", 12, 13, 2)],
  };

  it("names sheets exactly as the import contract does", () => {
    // A rename in the contract with no rename here would make the wizard's
    // rows silently undeliverable — the validator would not recognise the sheet.
    const names = [...sessionSheets(answers.session), ...classSheets(answers).sheets].map((s) => s.name);
    for (const n of names) expect(SHEETS.some((s) => s.name === n), n).toBe(true);
  });

  it("keys cells by HEADER text, which is what the validator reads", () => {
    const { sheets } = classSheets(answers);
    const classesSheet = sheets.find((s) => s.name === "Classes")!;
    const def = SHEETS.find((s) => s.name === "Classes")!;
    for (const header of Object.keys(classesSheet.rows[0].cells)) {
      expect(def.columns.some((c) => c.header === header), header).toBe(true);
    }
  });

  it("carries the wing in the Timetable column, so sections attach themselves", () => {
    const sections = classSheets(answers).sheets.find((s) => s.name === "Class Sections")!;
    const senior = sections.rows.find((r) => r.cells["Class Name"] === "Class 9")!;
    expect(senior.cells.Timetable).toBe("Senior Wing");
    expect(senior.cells["Academic Year"]).toBe("2026-27");
  });

  it("produces one section row per section, not one per class", () => {
    const sections = classSheets(answers).sheets.find((s) => s.name === "Class Sections")!;
    // 3 primary classes x 3 + 2 senior classes x 2
    expect(sections.rows).toHaveLength(3 * 3 + 2 * 2);
  });

  it("numbers rows from 2, so an issue reads like a spreadsheet reference", () => {
    const sheets = sessionSheets(answers.session);
    expect(sheets[0].rows[0].row).toBe(2);
  });

  it("produces nothing at all when there is nothing to produce", () => {
    expect(sessionSheets({ name: "", startDate: "", endDate: "" })).toEqual([]);
    expect(classSheets({ wings: [] }).sheets).toEqual([]);
  });
});

describe("§15.3 what the screen shows", () => {
  it("counts classes and sections per wing", () => {
    const s = planSummary({ wings: [wing("Primary", 4, 6, 3), wing("Senior", 12, 13, 2)] });
    expect(s.classes).toBe(5);
    expect(s.sections).toBe(13);
    expect(s.perWing).toEqual([
      { wing: "Primary", classes: 3, sections: 9 },
      { wing: "Senior", classes: 2, sections: 4 },
    ]);
  });

  it("computes the weekly capacity the server will enforce", () => {
    expect(weeklyCapacity(8, [1, 2, 3, 4, 5])).toBe(40);
    expect(weeklyCapacity(9, [1, 2, 3, 4, 5, 6])).toBe(54);
    expect(weeklyCapacity(8, [])).toBe(0);
  });
});
