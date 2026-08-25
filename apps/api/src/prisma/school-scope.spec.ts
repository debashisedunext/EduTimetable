/**
 * Phase 9.1 (§17) — unit cover for the school-scoping extension's logic.
 *
 * The end-to-end proof is `scripts/tenant-isolation.cjs`, which runs two real
 * schools against the live stack. These tests pin the reasoning underneath it,
 * so a regression is caught by `pnpm test` rather than only by the smoke suite.
 */
import { describe, expect, it } from "vitest";
import {
  REF_MAP,
  collectReferences,
  flattenUniqueWhere,
  scopeWhere,
  stampCreate,
} from "./school-scope";

describe("scopeWhere", () => {
  it("filters to the school when there is no other filter", () => {
    expect(scopeWhere(undefined, 7)).toEqual({ schoolId: 7 });
    expect(scopeWhere({}, 7)).toEqual({ schoolId: 7 });
  });

  it("ANDs rather than merges, so a caller's own filters survive", () => {
    expect(scopeWhere({ isActive: true }, 7)).toEqual({
      AND: [{ isActive: true }, { schoolId: 7 }],
    });
  });

  it("cannot be widened by a caller passing a different school", () => {
    // The two clauses are ANDed, so this matches nothing — which is the right
    // answer. A spread would have let the caller's value win.
    const where = scopeWhere({ schoolId: 999 }, 7);
    expect(where).toEqual({ AND: [{ schoolId: 999 }, { schoolId: 7 }] });
  });
});

describe("flattenUniqueWhere", () => {
  it("expands a compound unique into plain field equality", () => {
    expect(flattenUniqueWhere({ schoolId_name: { schoolId: 3, name: "Lab 1" } })).toEqual({
      schoolId: 3,
      name: "Lab 1",
    });
  });

  it("leaves a simple id alone", () => {
    expect(flattenUniqueWhere({ id: 12 })).toEqual({ id: 12 });
  });

  it("handles a compound key alongside a scalar", () => {
    expect(flattenUniqueWhere({ id: 12, roleId_permission: { roleId: 1, permission: "ai.chat" } }))
      .toEqual({ id: 12, roleId: 1, permission: "ai.chat" });
  });
});

describe("stampCreate", () => {
  it("stamps the school on a plain payload", () => {
    expect(stampCreate({ name: "Room 1" }, 5)).toEqual({ name: "Room 1", schoolId: 5 });
  });

  it("does not overwrite a school the caller supplied", () => {
    expect(stampCreate({ name: "Room 1", schoolId: 9 }, 5)).toEqual({ name: "Room 1", schoolId: 9 });
  });

  it("stamps every row of a createMany", () => {
    expect(stampCreate([{ a: 1 }, { a: 2 }], 5)).toEqual([
      { a: 1, schoolId: 5 },
      { a: 2, schoolId: 5 },
    ]);
  });

  it("follows nested relation writes — the merged-group case", () => {
    // mappings.controller.ts creates a group and its members in one call; the
    // members never reach the extension as their own operation, and
    // merged_teaching_group_members.school_id is NOT NULL like every other table.
    const out = stampCreate(
      {
        teacherId: 1,
        members: { create: [{ classSectionId: 10 }, { classSectionId: 11 }] },
      },
      5,
    );
    expect(out).toEqual({
      teacherId: 1,
      schoolId: 5,
      members: {
        create: [
          { classSectionId: 10, schoolId: 5 },
          { classSectionId: 11, schoolId: 5 },
        ],
      },
    });
  });

  it("leaves a plain `connect` untouched", () => {
    const out = stampCreate({ name: "x", role: { connect: { id: 2 } } }, 5) as Record<string, unknown>;
    expect(out.role).toEqual({ connect: { id: 2 } });
  });

  it("does not mistake a Date for a nested write", () => {
    const date = new Date("2026-04-01");
    expect(stampCreate({ startDate: date }, 5)).toEqual({ startDate: date, schoolId: 5 });
  });
});

describe("REF_MAP (built from Prisma's DMMF, so it cannot drift from the schema)", () => {
  it("knows a class-subject points at a class and a subject", () => {
    const refs = REF_MAP.get("ClassSubject");
    const byField = Object.fromEntries((refs?.scalar ?? []).map((r) => [r.field, r.target]));
    expect(byField.classId).toBe("SchoolClass");
    expect(byField.subjectId).toBe("Subject");
  });

  it("covers every model in the schema", () => {
    expect(REF_MAP.size).toBeGreaterThanOrEqual(30);
  });
});

describe("collectReferences", () => {
  it("gathers the ids a write points at, grouped by target model", () => {
    const acc = new Map<string, Set<number>>();
    collectReferences("ClassSubject", { classId: 4, subjectId: 9, periodsPerWeek: 5 }, acc);
    expect(acc.get("SchoolClass")).toEqual(new Set([4]));
    expect(acc.get("Subject")).toEqual(new Set([9]));
  });

  it("gathers ids from every row of a createMany", () => {
    const acc = new Map<string, Set<number>>();
    collectReferences(
      "TeacherSubjectClassSection",
      [
        { teacherId: 1, subjectId: 2, classSectionId: 10 },
        { teacherId: 1, subjectId: 2, classSectionId: 11 },
      ],
      acc,
    );
    expect(acc.get("ClassSection")).toEqual(new Set([10, 11]));
    expect(acc.get("Teacher")).toEqual(new Set([1]));
  });

  it("follows a nested write, so a reference cannot be laundered through one", () => {
    // This is the shape that let School B put School A's class-section into
    // its own merged group before the reference check existed.
    const acc = new Map<string, Set<number>>();
    collectReferences(
      "MergedTeachingGroup",
      { teacherId: 1, subjectId: 2, members: { create: [{ classSectionId: 77 }] } },
      acc,
    );
    expect(acc.get("ClassSection")).toEqual(new Set([77]));
  });

  it("ignores nulls, so an optional relation left unset is not checked", () => {
    const acc = new Map<string, Set<number>>();
    collectReferences("ClassSection", { classId: 1, homeRoomId: null, classTeacherId: null }, acc);
    expect(acc.has("Room")).toBe(false);
    expect(acc.has("Teacher")).toBe(false);
    expect(acc.get("SchoolClass")).toEqual(new Set([1]));
  });
});
