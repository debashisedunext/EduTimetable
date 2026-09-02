import { describe, expect, it } from "vitest";
import { AI_ENTRY_SHEETS, SHEETS } from "@edutimetable/shared";
import {
  changedFields,
  isUpdatable,
  labelOf,
  MERGED_UPDATABLE,
  UPDATABLE,
} from "./data-entry.update";

/**
 * §13.5 Phases B & C — the diff rules, on their own.
 *
 * These are the rules that decide what a conversation may rewrite, so they are
 * tested away from Prisma, the model and the chat loop. Two of them are the
 * whole safety argument and both were got wrong once:
 *
 *  - a natural key is never writable, and
 *  - a field the draft did not mention is not a change.
 */

describe("§13.5 the allow-list is the whole write authority", () => {
  it("never lets a natural key be written, on any sheet", () => {
    // The importer's own contract says what identifies a row; nothing in that
    // list may appear in UPDATABLE, or a "rename" would silently become a
    // different row wearing the old row's id.
    for (const [sheet, fields] of Object.entries(UPDATABLE)) {
      const def = SHEETS.find((s) => s.name === sheet);
      expect(def, sheet).toBeTruthy();
      for (const key of def!.naturalKey) {
        expect(fields, `${sheet}.${key}`).not.toContain(key);
      }
    }
  });

  it("covers only sheets the assistant may draft at all", () => {
    for (const sheet of Object.keys(UPDATABLE)) {
      expect(AI_ENTRY_SHEETS as readonly string[], sheet).toContain(sheet);
    }
  });

  it("names only real columns", () => {
    for (const [sheet, fields] of Object.entries(UPDATABLE)) {
      const keys = SHEETS.find((s) => s.name === sheet)!.columns.map((c) => c.key);
      for (const f of fields) expect(keys, `${sheet}.${f}`).toContain(f);
    }
  });

  it("has no entry for sheets whose rows are not one database row each", () => {
    // Electives and Teacher Unavailability are undraftable; Subject Mapping IS
    // updatable but only through data-entry.mapping.ts, which expands it first.
    expect(isUpdatable("Electives")).toBe(false);
    expect(isUpdatable("Teacher Unavailability")).toBe(false);
    expect(isUpdatable("Academic Years")).toBe(false);
  });
});

describe("§13.5 Phase C — a merged group is keyed differently", () => {
  it("cannot move a merged group's teacher, though a plain mapping's can move", () => {
    // The two live on the same sheet and the answer is opposite, because the
    // tables are keyed differently: (subject, class-section) for a mapping,
    // (subject, teacher, members) for a group.
    expect(UPDATABLE["Subject Mapping"]).toContain("employeeCode");
    expect(MERGED_UPDATABLE).not.toContain("employeeCode");
  });

  it("cannot move a merged group's member sections either", () => {
    expect(MERGED_UPDATABLE).not.toContain("classSections");
  });

  it("still allows the two things that are values on both", () => {
    expect(MERGED_UPDATABLE).toEqual(["periodsPerWeek", "room"]);
  });
});

describe("§13.5 changedFields — only what was actually said", () => {
  const current = { name: "Original", maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6, isActive: true };

  it("reports a mentioned field that differs", () => {
    const out = changedFields("Teachers", { ...current, maxPeriodsPerWeek: 24 }, current, ["maxPeriodsPerWeek"]);
    expect(out).toEqual([{ field: "maxPeriodsPerWeek", from: 30, to: 24 }]);
  });

  it("ignores a field the draft never mentioned, even when the values differ", () => {
    // This is the Phase B bug in one line. `validateWorkbook` returns a fully
    // defaulted row, so maxPeriodsPerDay arrives as null on a draft that only
    // asked about the weekly cap — and writing that null would wipe it.
    const drafted = { name: "Original", maxPeriodsPerWeek: 24, maxPeriodsPerDay: null, isActive: true };
    const out = changedFields("Teachers", drafted, current, ["maxPeriodsPerWeek"]);
    expect(out.map((c) => c.field)).toEqual(["maxPeriodsPerWeek"]);
  });

  it("ignores a mentioned field that does not actually differ", () => {
    const out = changedFields("Teachers", current, current, ["name", "maxPeriodsPerWeek", "isActive"]);
    expect(out).toEqual([]);
  });

  it("refuses a mentioned field that is outside the allow-list", () => {
    const out = changedFields("Classes", { name: "Class 6", sequence: 6 }, { name: "Class 5", sequence: 6 }, ["name"]);
    expect(out).toEqual([]);
  });

  it("honours an override, which is how a merged group gets its narrower list", () => {
    const drafted = { employeeCode: "T-2", periodsPerWeek: 4, room: "Lab 1" };
    const stored = { periodsPerWeek: 6, room: "Lab 1" };
    const asMapping = changedFields("Subject Mapping", drafted, { employeeCode: "T-1", ...stored }, [
      "employeeCode", "periodsPerWeek", "room",
    ]);
    expect(asMapping.map((c) => c.field).sort()).toEqual(["employeeCode", "periodsPerWeek"]);

    const asMerged = changedFields("Subject Mapping", drafted, stored, [
      "employeeCode", "periodsPerWeek", "room",
    ], MERGED_UPDATABLE);
    expect(asMerged.map((c) => c.field)).toEqual(["periodsPerWeek"]);
  });

  it("treats blank, null and undefined as the same absence", () => {
    expect(changedFields("Subjects", { code: "" }, { code: null }, ["code"])).toEqual([]);
    expect(changedFields("Subjects", { code: null }, { code: "" }, ["code"])).toEqual([]);
  });

  it("compares numbers as numbers and yes/no as booleans", () => {
    expect(changedFields("Curriculum", { periodsPerWeek: "6" }, { periodsPerWeek: 6 }, ["periodsPerWeek"])).toEqual([]);
    expect(changedFields("Subjects", { isLab: "Yes" }, { isLab: true }, ["isLab"])).toEqual([]);
    expect(changedFields("Subjects", { isLab: "No" }, { isLab: true }, ["isLab"])).toHaveLength(1);
  });
});

describe("§13.5 labelOf — how a change reads to the person approving it", () => {
  it("names the row rather than dumping it", () => {
    expect(labelOf("Curriculum", { className: "Class 5", subjectName: "English", academicYear: "2026-27" }))
      .toBe("Class 5 · English (2026-27)");
    expect(labelOf("Class Teachers", { classSection: "Class 5-A" })).toBe("Class 5-A — class teacher");
    expect(labelOf("Teachers", { employeeCode: "T-1", name: "Rekha" })).toBe("T-1 — Rekha");
  });
});
