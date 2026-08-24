import { describe, expect, it, vi } from "vitest";
import type { ViewScope } from "@edutimetable/shared";
import { AiToolsService, TOOL_DEFS, type ToolContext } from "./tools";

/**
 * Task 7.7 — adversarial safety. The model's arguments are attacker-controlled
 * (a prompt-injected question can make it call anything with any arguments);
 * the scope is NOT, because the gateway supplies it out of band. These tests
 * assert that no argument can widen access.
 */

const reports = {
  classSectionTimetable: vi.fn(async (scope: ViewScope, id: number) => {
    // the real service throws on out-of-scope ids; mirror that contract
    if (scope.level === "class" && !scope.classSectionIds.includes(id)) throw new Error("outside your view scope");
    if (scope.level === "own" || scope.level === "none") throw new Error("outside your view scope");
    return { label: `section-${id}` };
  }),
  teacherTimetable: vi.fn(async (scope: ViewScope, id: number) => {
    if (scope.level !== "all" && (scope as any).teacherId !== id) throw new Error("outside your view scope");
    return { label: `teacher-${id}` };
  }),
  roomUtilization: vi.fn(async (scope: ViewScope) => {
    if (scope.level !== "all") throw new Error("needs view.all");
    return { rows: [] };
  }),
  teacherLoadSummary: vi.fn(async (scope: ViewScope) => {
    if (scope.level !== "all") throw new Error("needs view.all");
    return { rows: [] };
  }),
};

const prisma = {
  teacher: { findMany: vi.fn(async ({ where }: any) => [{ id: where?.id ?? 1, name: "T", employeeCode: "E", maxPeriodsPerDay: 6, maxPeriodsPerWeek: 30, classTeacherPeriodRule: "none", periodPattern: "every_period" }]) },
  classSection: { findMany: vi.fn(async () => []) },
  timetableConfig: { findMany: vi.fn(async () => []) },
  timetableSlot: { findMany: vi.fn(async () => []) },
  teacherUnavailability: { findMany: vi.fn(async () => []) },
  teacherAbsence: { findMany: vi.fn(async () => []) },
  substitutionLog: { findMany: vi.fn(async () => []) },
};
const readiness = { getReadiness: vi.fn(async () => ({ score: 100, ready: true, blockers: [], warnings: [] })) };

const svc = new AiToolsService(prisma as never, reports as never, readiness as never);

const ctxFor = (scope: ViewScope, canReport = true): ToolContext => ({ schoolId: 1, scope, canReport });
const TEACHER_SCOPE: ViewScope = { level: "class", teacherId: 7, classSectionIds: [11, 12] };
const OWN_SCOPE: ViewScope = { level: "own", teacherId: 7 };

describe("tool whitelist (§13.1)", () => {
  it("exposes only read-only tools — nothing that could place or publish a slot", () => {
    const names = TOOL_DEFS.map((t) => t.name);
    expect(names).toContain("getTeacherLoadSummary");
    for (const forbidden of ["placeSlot", "moveSlot", "publish", "runSql", "query", "deleteSlot", "updateMapping"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("no tool accepts a school_id argument — scope is never model-supplied", () => {
    for (const t of TOOL_DEFS) {
      const props = Object.keys(t.input_schema.properties ?? {});
      expect(props).not.toContain("school_id");
      expect(props).not.toContain("schoolId");
      expect(props).not.toContain("scope");
    }
  });

  it("rejects an unknown tool name outright", async () => {
    await expect(svc.execute("dropTables", {}, ctxFor({ level: "all" }), 1)).rejects.toThrow(/Unknown tool/);
  });
});

describe("scope cannot be widened by tool arguments (task 7.7)", () => {
  it("a class-scope user cannot read an unlinked class-section", async () => {
    await expect(
      svc.execute("getClassSectionTimetable", { class_section_id: 99 }, ctxFor(TEACHER_SCOPE), 1),
    ).rejects.toThrow(/view scope/);
    // and the one they ARE linked to still works
    await expect(
      svc.execute("getClassSectionTimetable", { class_section_id: 11 }, ctxFor(TEACHER_SCOPE), 1),
    ).resolves.toBeTruthy();
  });

  it("a teacher cannot read another teacher's grid", async () => {
    await expect(
      svc.execute("getTeacherTimetable", { teacher_id: 42 }, ctxFor(OWN_SCOPE), 1),
    ).rejects.toThrow(/view scope/);
  });

  it("listTeachers returns only the caller for a scoped user, whatever the search says", async () => {
    await svc.execute("listTeachers", { search: "' OR 1=1 --" }, ctxFor(OWN_SCOPE), 1);
    const where = (prisma.teacher.findMany.mock.calls.at(-1) as any[])[0].where;
    expect(where.id).toBe(7); // pinned to the caller, regardless of the search term
    expect(where.schoolId).toBe(1);
  });

  it("cross-teacher availability and readiness need full view access", async () => {
    await expect(svc.execute("getFreeTeachers", { day_of_week: 5, period_number: 6 }, ctxFor(TEACHER_SCOPE), 1))
      .rejects.toThrow(/full timetable view access/);
    await expect(svc.execute("getReadinessStatus", {}, ctxFor(TEACHER_SCOPE), 1))
      .rejects.toThrow(/full timetable view access/);
    await expect(svc.execute("getRoomUtilization", {}, ctxFor(TEACHER_SCOPE), 1)).rejects.toThrow();
    await expect(svc.execute("getTeacherLoadSummary", {}, ctxFor(TEACHER_SCOPE), 1)).rejects.toThrow();
  });

  it("a 'none' scope user gets nothing from the listing tools", async () => {
    await expect(svc.execute("listTeachers", {}, ctxFor({ level: "none" }), 1)).resolves.toEqual([]);
    await expect(svc.execute("listClassSections", {}, ctxFor({ level: "none" }), 1)).resolves.toEqual([]);
  });

  it("substitution history is pinned to the caller for a scoped user", async () => {
    await svc.execute(
      "getSubstitutionHistory",
      { date_from: "2026-01-01", date_to: "2026-12-31", teacher_id: 999 },
      ctxFor(TEACHER_SCOPE),
      1,
    );
    const where = (prisma.teacherAbsence.findMany.mock.calls.at(-1) as any[])[0].where;
    expect(where.teacherId).toBe(7); // NOT 999
    expect(where.teacher.schoolId).toBe(1);
  });
});

describe("generateReport is gated on ai.reports (§13.3)", () => {
  it("refuses when the user lacks the permission", async () => {
    await expect(
      svc.execute("generateReport", { report_type: "rooms" }, ctxFor({ level: "all" }, false), 1),
    ).rejects.toThrow(/ai\.reports/);
  });

  it("still enforces view scope when the permission is held", async () => {
    await expect(
      svc.execute("generateReport", { report_type: "class-section", class_section_id: 99 }, ctxFor(TEACHER_SCOPE, true), 1),
    ).rejects.toThrow(/view scope/);
  });
});
