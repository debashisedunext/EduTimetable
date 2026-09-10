import { describe, expect, it } from "vitest";
import {
  CLASS_LADDER,
  CLASS_LADDER_SHORT,
  GROUPED_SCOPE,
  ladderSequence,
  wingScope,
  classSheets,
  planClasses,
  planSummary,
  sectionLetters,
  sessionSheets,
  weeklyCapacity,
  WING_SUGGESTIONS,
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

  it("puts every ordinary wing in one pool and each individual one in its own (§30.9)", () => {
    expect(wingScope({ name: "Primary Wing" })).toBe(GROUPED_SCOPE);
    expect(wingScope({ name: "Primary Wing", individual: false })).toBe(GROUPED_SCOPE);
    expect(wingScope({ name: "Senior Wing" })).toBe(wingScope({ name: "Primary Wing" }));
    // Two individual timetables share nothing — not even with each other.
    expect(wingScope({ name: "Weekly", individual: true }))
      .not.toBe(wingScope({ name: "Saturday", individual: true }));
    expect(wingScope({ name: "Weekly", individual: true })).not.toBe(GROUPED_SCOPE);
    // The name is the key, so it is compared the way every other name in this
    // wizard is: trimmed and case-insensitively.
    expect(wingScope({ name: " weekly ", individual: true }))
      .toBe(wingScope({ name: "Weekly", individual: true }));
  });

  it("does NOT report a class claimed by two wings in different pools (§30.9)", () => {
    // The exact shape that was wrong on screen: a main timetable and an
    // individual one both running Class 1 to Class 6.
    const { classes, issues } = planClasses([
      { name: "Main Timetable 2026-27", fromIndex: 4, toIndex: 9, sections: 4 },
      { name: "Weekly Timetable", fromIndex: 4, toIndex: 9, sections: 1, individual: true },
    ]);
    expect(issues).toEqual([]);
    // Both wings keep every class — an individual timetable exists precisely so
    // it can teach Class 1 while the main wings also teach Class 1.
    const byWing = new Map<string, number>();
    for (const c of classes) byWing.set(c.wing, (byWing.get(c.wing) ?? 0) + 1);
    expect(byWing.get("Main Timetable 2026-27")).toBe(6);
    expect(byWing.get("Weekly Timetable")).toBe(6);
  });

  it("still reports a class claimed by two wings in the SAME pool", () => {
    const { issues } = planClasses([
      { name: "Middle", fromIndex: 4, toIndex: 9, sections: 2 },
      { name: "Senior", fromIndex: 9, toIndex: 12, sections: 2 },
    ]);
    // Class 6 is index 9 in both ranges — one pool, so this is still an error.
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("Class 6");
  });

  it("keeps two individual timetables out of each other's way", () => {
    const { issues } = planClasses([
      { name: "Weekly", fromIndex: 4, toIndex: 6, sections: 1, individual: true },
      { name: "Saturday", fromIndex: 4, toIndex: 6, sections: 1, individual: true },
    ]);
    expect(issues).toEqual([]);
  });

  it("gives every ladder name its 1-based position, and an unknown name 0", () => {
    expect(ladderSequence("Pre-Nursery")).toBe(1);
    expect(ladderSequence("LKG")).toBe(3);
    expect(ladderSequence("Class 1")).toBe(5);
    expect(ladderSequence("Class 12")).toBe(CLASS_LADDER.length);
    // Every ladder name round-trips — this is what `classes.sequence` holds.
    for (const [i, name] of CLASS_LADDER.entries()) {
      expect(ladderSequence(name), name).toBe(i + 1);
    }
    // 0, not "the next number": we know where Class 7 belongs and we do not
    // know where Playgroup belongs. Guessing is how two vocabularies for one
    // column started, and how LKG ended up sharing sequence 3 with Class 1.
    expect(ladderSequence("Playgroup")).toBe(0);
    expect(ladderSequence("Grade 5R")).toBe(0);
    // Whitespace is not a different class.
    expect(ladderSequence("  Class 9  ")).toBe(ladderSequence("Class 9"));
  });

  it("is what `planClasses` writes, so the two cannot drift", () => {
    const { classes } = planClasses([
      { name: "Junior", fromIndex: 0, toIndex: 5, sections: 1 },
    ]);
    for (const c of classes) {
      expect(c.sequence, c.className).toBe(ladderSequence(c.className));
    }
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

describe("§15.3 the suggested wings", () => {
  /**
   * The suggestions are ladder INDICES, so they are only as correct as the
   * ladder they were written against. Add "Class 13" at the top and nothing
   * breaks; insert a rung in the middle and "Primary Wing" quietly starts
   * meaning Class 2–6 — a wrong school, created by tapping a button that says
   * the right thing. These assert the meaning, not the numbers.
   */
  it("name the classes a reader of the label would expect", () => {
    const range = (name: string) => {
      const s = WING_SUGGESTIONS.find((w) => w.name === name)!;
      return [CLASS_LADDER[s.fromIndex], CLASS_LADDER[s.toIndex]];
    };
    expect(range("Primary Wing")).toEqual(["Class 1", "Class 5"]);
    expect(range("Secondary Wing")).toEqual(["Class 6", "Class 10"]);
    expect(range("Higher Secondary")).toEqual(["Class 11", "Class 12"]);
  });

  it("tile Class 1 to Class 12 without overlapping — tapping all three is a whole school, not a conflict", () => {
    // planClasses reports a class claimed by two wings as an error, so an
    // overlap here would make the fastest path through the screen the one that
    // produces an error message.
    const { classes, issues } = planClasses(WING_SUGGESTIONS.map((s) => ({ ...s, sections: 2 })));
    expect(issues).toEqual([]);
    expect(classes.map((c) => c.className)).toEqual(
      CLASS_LADDER.slice(CLASS_LADDER.indexOf("Class 1")),
    );
  });

  it("fit the VarChar(50) a wing's name is stored in as `timetable_configs.name`", () => {
    for (const s of WING_SUGGESTIONS) expect(s.name.length, s.name).toBeLessThanOrEqual(50);
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
