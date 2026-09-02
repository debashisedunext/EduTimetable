import { describe, expect, it } from "vitest";
import {
  AI_ENTRY_SHEETS,
  COMMON_SUBJECTS,
  COMMON_SUBJECT_NAMES,
  allSheetGuides,
  isAiEntrySheet,
  sheetGuide,
  toRawSheets,
} from "./data-entry";
import { SHEETS } from "../import/contract";

describe("§13.5 what the assistant may draft", () => {
  it("covers the seven masters and nothing else", () => {
    // Phase C added `Class Teachers`: it writes one pointer on a class-section
    // the school already has, which is the same authority as the Class-Teacher
    // Assignment screen and the thing people ask for in the same breath as a
    // mapping. The list below is the whole of the assistant's reach.
    expect([...AI_ENTRY_SHEETS]).toEqual([
      "Classes", "Class Sections", "Subjects", "Teachers", "Curriculum", "Class Teachers", "Subject Mapping",
    ]);
  });

  it("refuses the sheets that are decisions rather than data entry", () => {
    // A session, a room's lab mappings and an elective block are all things
    // somebody decides on a screen — not things to dictate into a chat box.
    for (const s of ["Academic Years", "Rooms", "Electives", "Teacher Unavailability"]) {
      expect(isAiEntrySheet(s), s).toBe(false);
    }
  });

  it("names every allowed sheet the same way the importer does", () => {
    // The adapter looks sheets up in the import contract; a rename there with
    // no rename here would silently make the sheet undraftable.
    for (const s of AI_ENTRY_SHEETS) {
      expect(SHEETS.some((d) => d.name === s), s).toBe(true);
    }
  });
});

describe("§13.5 toRawSheets — model rows to validator rows", () => {
  it("accepts field keys, which is what a model reliably produces", () => {
    const { sheets, issues } = toRawSheets([
      { sheet: "Subjects", rows: [{ name: "Mathematics", code: "MAT" }] },
    ]);
    expect(issues).toEqual([]);
    // Keyed by HEADER, because that is what `validateWorkbook` reads.
    expect(sheets[0].rows[0].cells).toEqual({ "Subject Name": "Mathematics", Code: "MAT" });
  });

  it("accepts the header spelling too, in any casing or spacing", () => {
    const { sheets, issues } = toRawSheets([
      { sheet: "teachers", rows: [{ "employee code": "E-1", "  Name  ": "Rekha Sharma", max_periods_per_day: 5 }] },
    ]);
    expect(issues).toEqual([]);
    expect(sheets[0].name).toBe("Teachers");
    expect(sheets[0].rows[0].cells).toEqual({
      "Employee Code": "E-1", Name: "Rekha Sharma", "Max Periods/Day": 5,
    });
  });

  it("REPORTS a key it cannot place, and suggests the real column", () => {
    // The failure this exists to prevent: a value the model sent, quietly
    // dropped, so the row imports without the thing the admin actually asked
    // for. "I told it the code and it ignored me."
    const { sheets, issues } = toRawSheets([
      { sheet: "Subjects", rows: [{ name: "Physics", subjectCode: "PHY" }] },
    ]);
    expect(sheets[0].rows[0].cells).toEqual({ "Subject Name": "Physics" });
    expect(issues).toHaveLength(1);
    expect(issues[0].row).toBe(2);
    expect(issues[0].message).toContain('no column "subjectCode"');
    expect(issues[0].fix).toContain("Code");
  });

  it("numbers rows from 2, so issues read like a spreadsheet", () => {
    const { sheets } = toRawSheets([
      { sheet: "Classes", rows: [{ name: "Class 1" }, { name: "Class 2" }] },
    ]);
    expect(sheets[0].rows.map((r) => r.row)).toEqual([2, 3]);
  });

  it("refuses a sheet outside the allow-list, naming what is allowed", () => {
    const { sheets, issues } = toRawSheets([{ sheet: "Rooms", rows: [{ name: "Lab 1" }] }]);
    expect(sheets).toEqual([]);
    expect(issues[0].message).toContain("cannot be created from a conversation");
    expect(issues[0].fix).toContain("Subject Mapping");
  });

  it("refuses a sheet that does not exist at all", () => {
    const { sheets, issues } = toRawSheets([{ sheet: "Timetable Slots", rows: [{}] }]);
    expect(sheets).toEqual([]);
    expect(issues[0].message).toContain('no master called "Timetable Slots"');
  });

  it("carries several sheets in one draft, so cross-sheet references resolve", () => {
    // "Class 6 with sections A-D" is two sheets in one proposal; splitting it
    // would make the Class Sections rows reference a class that does not exist
    // yet, and the validator would be right to reject them.
    const { sheets, issues } = toRawSheets([
      { sheet: "Classes", rows: [{ name: "Class 6", sequence: 6 }] },
      { sheet: "Class Sections", rows: [
        { className: "Class 6", sectionName: "A", academicYear: "2026-27" },
        { className: "Class 6", sectionName: "B", academicYear: "2026-27" },
      ] },
    ]);
    expect(issues).toEqual([]);
    expect(sheets.map((s) => s.name)).toEqual(["Classes", "Class Sections"]);
    expect(sheets[1].rows).toHaveLength(2);
  });

  it("keeps a blank row rather than inventing values for it", () => {
    const { sheets } = toRawSheets([{ sheet: "Classes", rows: [{}] }]);
    expect(sheets[0].rows[0].cells).toEqual({});
  });

  it("survives a null row list", () => {
    const { sheets } = toRawSheets([{ sheet: "Classes", rows: undefined as never }]);
    expect(sheets[0].rows).toEqual([]);
  });
});

describe("§13.5 mentioned — what the draft actually said", () => {
  it("records only the fields the row carried, by field key", () => {
    const { mentioned } = toRawSheets([
      { sheet: "Teachers", rows: [{ employeeCode: "E-1", "Max Periods/Week": 24 }] },
    ]);
    expect(mentioned).toEqual([{ sheet: "Teachers", row: 2, fields: ["employeeCode", "maxPeriodsPerWeek"] }]);
  });

  it("is what stops an omitted field being written as null", () => {
    // The bug this exists for: `validateWorkbook` returns a FULL row, with
    // defaults filled in for every column nobody typed. Diffing an update
    // against that reports a change for each of them — nulling every optional
    // field the admin never mentioned. Only this list says what was asked for.
    const { sheets, mentioned } = toRawSheets([
      { sheet: "Teachers", rows: [{ employeeCode: "E-1", name: "Rekha" }] },
    ]);
    expect(Object.keys(sheets[0].rows[0].cells)).toHaveLength(2);
    expect(mentioned[0].fields).toEqual(["employeeCode", "name"]);
    expect(mentioned[0].fields).not.toContain("maxPeriodsPerDay");
  });

  it("numbers rows the same way the sheets do, so the two can be joined", () => {
    const { sheets, mentioned } = toRawSheets([
      { sheet: "Classes", rows: [{ name: "Class 1" }, { name: "Class 2", sequence: 2 }] },
    ]);
    expect(mentioned.map((m) => m.row)).toEqual(sheets[0].rows.map((r) => r.row));
    expect(mentioned[1].fields).toEqual(["name", "sequence"]);
  });

  it("records an empty list for a row that carried nothing", () => {
    const { mentioned } = toRawSheets([{ sheet: "Classes", rows: [{}] }]);
    expect(mentioned[0].fields).toEqual([]);
  });

  it("does not record a key it could not place", () => {
    const { mentioned } = toRawSheets([
      { sheet: "Subjects", rows: [{ name: "Physics", subjectCode: "PHY" }] },
    ]);
    expect(mentioned[0].fields).toEqual(["name"]);
  });
});

describe("§13.5 the guide the model is given", () => {
  it("is generated from the contract, so it cannot drift from the importer", () => {
    const guide = sheetGuide("Teachers");
    const def = SHEETS.find((s) => s.name === "Teachers")!;
    for (const col of def.columns) expect(guide, col.key).toContain(col.key);
  });

  it("marks the required columns, which is what the model most needs to know", () => {
    expect(sheetGuide("Subjects")).toContain("name — REQUIRED");
    expect(sheetGuide("Teachers")).toContain("employeeCode — REQUIRED");
  });

  it("spells out the allowed values of an enum rather than leaving it to guess", () => {
    expect(sheetGuide("Teachers")).toContain("alternate_day");
  });

  it("covers every draftable sheet", () => {
    const all = allSheetGuides();
    for (const s of AI_ENTRY_SHEETS) expect(all, s).toContain(s);
  });
});

describe("§13.5 the common-subject catalogue", () => {
  it("has no duplicate names — the picker and the model must agree on one spelling", () => {
    expect(new Set(COMMON_SUBJECT_NAMES).size).toBe(COMMON_SUBJECT_NAMES.length);
  });

  it("fits the importer's 50-character subject name and 10-character code", () => {
    const def = SHEETS.find((s) => s.name === "Subjects")!;
    const nameMax = def.columns.find((c) => c.key === "name")!.maxLength!;
    const codeMax = def.columns.find((c) => c.key === "code")!.maxLength!;
    for (const name of COMMON_SUBJECT_NAMES) expect(name.length, name).toBeLessThanOrEqual(nameMax);
    for (const g of COMMON_SUBJECTS) {
      for (const sub of g.subjects) expect(sub.code.length, sub.code).toBeLessThanOrEqual(codeMax);
    }
  });
});
