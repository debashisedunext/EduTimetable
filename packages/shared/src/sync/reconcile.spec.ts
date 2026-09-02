import { describe, expect, it } from "vitest";
import { ERP_OWNED, SYNC_SHEETS } from "./contract";
import { changedFields, keyOf, reconcileSheet, sameValue, updatePayload } from "./reconcile";

const label = (r: Record<string, unknown>) => String(r.name ?? r.employeeCode ?? r.subjectName ?? "?");

describe("§23 ownership — the fields the ERP may never touch", () => {
  // The single most important property of the whole feature. A sync that
  // overwrote a scheduling field would change the next Generate's output with
  // nothing on any screen saying why.
  it("ignores a difference in a field the ERP does not own", () => {
    const mine = { employeeCode: "T1", name: "Aditi Verma", maxPeriodsPerDay: 6, periodPattern: "every_period" };
    const erp = { employeeCode: "T1", name: "Aditi Verma", maxPeriodsPerDay: 2, periodPattern: "alternate_day" };
    expect(changedFields("Teachers", erp, mine)).toEqual([]);
  });

  it("reports a difference in a field it does own", () => {
    const mine = { employeeCode: "T1", name: "Aditi Verma", isActive: true };
    const erp = { employeeCode: "T1", name: "Aditi Sharma", isActive: false };
    const changes = changedFields("Teachers", erp, mine);
    expect(changes.map((c) => c.field).sort()).toEqual(["isActive", "name"]);
    expect(changes.find((c) => c.field === "name")).toEqual({ field: "name", from: "Aditi Verma", to: "Aditi Sharma" });
  });

  it("never lets a non-owned field into the write payload, even mixed with owned ones", () => {
    const mine = { employeeCode: "T1", name: "Old", maxPeriodsPerWeek: 30 };
    const erp = { employeeCode: "T1", name: "New", maxPeriodsPerWeek: 12 };
    const plan = reconcileSheet("Teachers", [erp], [mine], label).rows[0];
    expect(updatePayload(plan)).toEqual({ name: "New" });
  });

  it("keeps scheduling fields out of every sheet's ownership list", () => {
    // A regression guard on the table itself: adding one of these later would
    // be a one-word edit with no visible consequence until a timetable changed.
    const forbidden = [
      "maxPeriodsPerDay", "minPeriodsPerDay", "maxPeriodsPerWeek", "periodPattern",
      "alternateDaySet", "classTeacherPeriodRule", "employmentType",
      "isLab", "requiresDoublePeriod", "periodsPerWeek", "samePeriodAcrossWeek",
      "consecutiveBlockSize", "consecutiveBlocksPerWeek", "homeRoom", "timetable",
    ];
    for (const sheet of SYNC_SHEETS) {
      for (const f of ERP_OWNED[sheet]) {
        expect(forbidden, `${sheet}.${f}`).not.toContain(f);
      }
    }
  });
});

describe("§23 reconcile", () => {
  const mine = [
    { id: 1, employeeCode: "T1", name: "Aditi Verma", isActive: true },
    { id: 2, employeeCode: "T2", name: "Rahul Nair", isActive: true },
  ];

  it("sorts rows into new, update and unchanged", () => {
    const erp = [
      { employeeCode: "T1", name: "Aditi Verma", isActive: true },   // unchanged
      { employeeCode: "T2", name: "Rahul N.", isActive: true },      // update
      { employeeCode: "T3", name: "Meera Das", isActive: true },     // new
    ];
    const plan = reconcileSheet("Teachers", erp, mine, label);
    expect([plan.read, plan.create, plan.update, plan.unchanged]).toEqual([3, 1, 1, 1]);
  });

  it("treats a teacher the ERP marks INACTIVE as an update, not a removal", () => {
    // Inactive is not absent. The ERP still returns them, so they are still on
    // its list — the sync writes `isActive = false` and leaves the row, with
    // its mappings and its substitution history, exactly where it is.
    const plan = reconcileSheet("Teachers", [{ employeeCode: "T1", name: "Aditi Verma", isActive: false }], mine, label);
    expect(plan.rows[0].verdict).toBe("update");
    expect(plan.rows[0].changes).toEqual([{ field: "isActive", from: true, to: false }]);
  });

  it("leaves a field the source did not carry alone, rather than blanking it", () => {
    // A partial source must not be data loss.
    const plan = reconcileSheet("Teachers", [{ employeeCode: "T1" }], mine, label);
    expect(plan.rows[0].verdict).toBe("unchanged");
  });

  it("ignores a repeated row rather than writing it twice", () => {
    const erp = [
      { employeeCode: "T3", name: "Meera Das" },
      { employeeCode: "t3", name: "Somebody Else" },
    ];
    const plan = reconcileSheet("Teachers", erp, mine, label);
    expect(plan.read).toBe(1);
    expect(plan.rows[0].label).toBe("Meera Das");
  });

  it("reports a row the ERP no longer has as a REMOVAL, carrying our id", () => {
    // This reverses the original rule ("a sync adds and updates, it never
    // deletes"). The admin asks for the ERP's list; a teacher who is not on it
    // is not on it. What makes that safe is not refusing to delete — it is
    // counting the consequences first (`dependencies.ts`) and requiring a typed
    // confirmation, which the engine here deliberately knows nothing about.
    const plan = reconcileSheet("Teachers", [{ employeeCode: "T1", name: "Aditi Verma", isActive: true }], mine, label);
    expect(plan.read).toBe(1);
    const gone = plan.rows.find((r) => r.verdict === "remove");
    expect(gone?.label).toBe("Rahul Nair");
    expect(gone?.id).toBe(2);
    expect(plan.remove).toBe(1);
  });

  it("replace mode removes everything and re-adds everything — no matching at all", () => {
    // The property that makes `replace` dangerous, asserted rather than assumed:
    // a row present on BOTH sides is still a remove plus a create, so its id
    // changes, and every foreign key pointing at it is left behind.
    const erp = [{ employeeCode: "T1", name: "Aditi Verma", isActive: true }];
    const plan = reconcileSheet("Teachers", erp, mine, label, "replace");
    expect([plan.create, plan.update, plan.unchanged, plan.remove]).toEqual([1, 0, 0, 2]);
    expect(plan.rows.filter((r) => r.verdict === "remove").map((r) => r.id).sort()).toEqual([1, 2]);
  });

  it("refresh mode does not touch a row that matches", () => {
    const erp = [{ employeeCode: "T1", name: "Aditi Verma", isActive: true }, { employeeCode: "T2", name: "Rahul Nair", isActive: true }];
    const plan = reconcileSheet("Teachers", erp, mine, label, "refresh");
    expect([plan.create, plan.update, plan.unchanged, plan.remove]).toEqual([0, 0, 2, 0]);
  });
});

describe("§23 value comparison — how the two systems spell things", () => {
  it("does not report whitespace or case as a change", () => {
    // Otherwise a nightly sync reports the same hundred 'changes' forever.
    expect(sameValue("  Mathematics ", "mathematics")).toBe(true);
    expect(sameValue("Mathematics", "Mathematic")).toBe(false);
  });

  it("treats null and empty string as the same absence", () => {
    expect(sameValue(null, "")).toBe(true);
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue("", "x")).toBe(false);
  });

  it("compares dates by calendar day, not by timestamp", () => {
    expect(sameValue(new Date("2026-04-01T00:00:00Z"), "2026-04-01")).toBe(true);
    expect(sameValue(new Date("2026-04-01T18:30:00Z"), new Date("2026-04-01T00:00:00Z"))).toBe(true);
    expect(sameValue(new Date("2026-04-01"), "2026-04-02")).toBe(false);
  });

  it("reads the many shapes a boolean arrives in", () => {
    expect(sameValue(true, 1)).toBe(true);
    expect(sameValue(true, "Yes")).toBe(true);
    expect(sameValue(false, 0)).toBe(true);
    expect(sameValue(true, "N")).toBe(false);
  });

  it("compares numbers as numbers, so 30 and '30' are not a change", () => {
    expect(sameValue(30, "30")).toBe(true);
    expect(sameValue(30, 31)).toBe(false);
    expect(sameValue(null, 0)).toBe(false);
  });
});

describe("§23 keys", () => {
  it("keys a class-section on class + section + year", () => {
    const a = { className: "Class 5", sectionName: "A", academicYear: "2026-27" };
    const b = { className: "class 5", sectionName: " a ", academicYear: "2026-27" };
    expect(keyOf("Class Sections", a)).toBe(keyOf("Class Sections", b));
    expect(keyOf("Class Sections", { ...a, academicYear: "2027-28" })).not.toBe(keyOf("Class Sections", a));
  });
});
