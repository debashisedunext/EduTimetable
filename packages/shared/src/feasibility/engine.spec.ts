import { describe, expect, it } from "vitest";
import { runFeasibility, teacherWeeklyCapacity } from "./engine";
import { cleanSchool, teacher } from "./fixtures";
import type { IssueCode } from "./types";

const codes = (r: ReturnType<typeof runFeasibility>): IssueCode[] =>
  [...r.blockers, ...r.warnings].map((i) => i.code);

describe("Feasibility Engine — golden fixtures (§4, task 1.14)", () => {
  it("clean school: ready, score 100, zero issues", () => {
    const r = runFeasibility(cleanSchool());
    expect(r.blockers).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.score).toBe(100);
    expect(r.ready).toBe(true);
    expect(r.stats.totalRequiredSlots).toBe(60);
  });

  it("empty timetable → score 0, NO_DATA, not ready", () => {
    const snap = cleanSchool();
    snap.classSections = [];
    const r = runFeasibility(snap);
    expect(r.score).toBe(0);
    expect(r.ready).toBe(false);
    expect(codes(r)).toContain("NO_DATA");
  });

  // ---- Check 1 ----
  it("slot overflow: 34 required > 30 available → blocker with exact numbers", () => {
    const snap = cleanSchool();
    snap.subjectRequirements[0].periodsPerWeek = 10; // 34 total
    snap.mappings.filter((m) => m.subjectId === 300).forEach((m) => (m.periodsPerWeek = 10));
    const r = runFeasibility(snap);
    const issue = r.blockers.find((i) => i.code === "SLOT_OVERFLOW");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("needs 34 periods/week but only 30 slots");
  });

  it("slot underflow: free slots → warning, still ready", () => {
    const snap = cleanSchool();
    snap.subjectRequirements[4].periodsPerWeek = 3; // 27 of 30
    snap.mappings.filter((m) => m.subjectId === 304).forEach((m) => (m.periodsPerWeek = 3));
    const r = runFeasibility(snap);
    expect(r.ready).toBe(true);
    const w = r.warnings.filter((i) => i.code === "SLOT_UNDERFLOW");
    expect(w).toHaveLength(2); // both sections
    expect(w[0].message).toContain("3 free slots/week");
  });

  // ---- Check 2 ----
  it("teacher overload: demand 34 > capacity 30 → blocker naming reassignment fix", () => {
    const snap = cleanSchool();
    // T.English also takes 10 more periods in 5-B for another subject? simplest: raise both mappings
    snap.mappings
      .filter((m) => m.teacherId === 101)
      .forEach((m) => (m.periodsPerWeek = 17)); // 34 demand
    snap.subjectRequirements[0].periodsPerWeek = 17;
    const r = runFeasibility(snap);
    const issue = r.blockers.find((i) => i.code === "TEACHER_OVERLOAD");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("34 periods/week");
    expect(issue!.message).toContain("Over by 4");
    expect(issue!.fix).toContain("Reassign");
  });

  it("cross-config load counts toward overload and names the other wing (§3.10)", () => {
    const snap = cleanSchool();
    snap.crossConfigTeacherLoad[101] = { periods: 20, otherConfigNames: ["Senior Wing"] };
    const r = runFeasibility(snap); // 12 local + 20 cross = 32 > 30
    const issue = r.blockers.find((i) => i.code === "TEACHER_OVERLOAD");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("Senior Wing");
  });

  // ---- Check 2 pattern-aware capacity (§4.7) ----
  it("alternate_period halves daily capacity: floor((6+1)/2)=3 → 15/week", () => {
    const t = teacher(1, "Mr. Iyer", { periodPattern: "alternate_period" });
    expect(teacherWeeklyCapacity(t, [1, 2, 3, 4, 5], 6)).toBe(15);
  });

  it("alternate_period teacher overloaded at 16 even though flat capacity allows it", () => {
    const snap = cleanSchool();
    snap.teachers[0] = teacher(101, "T.English", { periodPattern: "alternate_period" });
    snap.mappings.filter((m) => m.teacherId === 101).forEach((m) => (m.periodsPerWeek = 8));
    snap.subjectRequirements[0].periodsPerWeek = 8;
    const r = runFeasibility(snap); // demand 16 > 15
    expect(r.blockers.some((i) => i.code === "TEACHER_OVERLOAD")).toBe(true);
  });

  it("alternate_day with explicit day-set: capacity = 3 days × 6 periods", () => {
    const t = teacher(1, "Mrs. Rao", {
      periodPattern: "alternate_day",
      alternateDaySet: [1, 3, 5],
      maxPeriodsPerWeek: 40,
    });
    expect(teacherWeeklyCapacity(t, [1, 2, 3, 4, 5], 6)).toBe(18);
  });

  it("alternate_day with no day-set → ALT_DAY_UNSET warning asking to confirm", () => {
    const snap = cleanSchool();
    snap.teachers[0] = teacher(101, "T.English", { periodPattern: "alternate_day" });
    const r = runFeasibility(snap);
    const w = r.warnings.find((i) => i.code === "ALT_DAY_UNSET");
    expect(w).toBeDefined();
    expect(w!.message).toContain("Confirm or pick the days");
  });

  it("full-day unavailability reduces capacity", () => {
    const t = teacher(1, "T", { unavailableFullDays: [5], maxPeriodsPerWeek: 40 });
    expect(teacherWeeklyCapacity(t, [1, 2, 3, 4, 5], 6)).toBe(24);
  });

  // ---- Check 3 ----
  it("impossible daily spread: 6/week at max 1/day in a 5-day week → blocker", () => {
    const snap = cleanSchool();
    snap.subjectRequirements[0].maxPeriodsPerDay = 1;
    const r = runFeasibility(snap);
    const issue = r.blockers.find((i) => i.code === "DAILY_DISTRIBUTION");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("requires 6 days; the week has only 5");
  });

  it("block bigger than subject daily max → blocker (§4.8)", () => {
    const snap = cleanSchool();
    snap.subjectRequirements[0].consecutiveBlockSize = 3;
    snap.subjectRequirements[0].maxPeriodsPerDay = 2;
    const r = runFeasibility(snap);
    expect(r.blockers.some((i) => i.code === "BLOCK_EXCEEDS_DAILY_MAX")).toBe(true);
  });

  it("block cannot fit any contiguous run (fragmented day) → blocker (§4.8)", () => {
    const snap = cleanSchool();
    snap.config.daySegments = [2, 2, 2];
    snap.subjectRequirements[0].consecutiveBlockSize = 3;
    snap.subjectRequirements[0].maxPeriodsPerDay = 3;
    const r = runFeasibility(snap);
    const issue = r.blockers.find((i) => i.code === "BLOCK_FRAGMENTED");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("runs of at most 2");
  });

  it("block math invalid: 4 blocks × 2 > 6 periods/week → blocker", () => {
    const snap = cleanSchool();
    snap.subjectRequirements[0].consecutiveBlockSize = 2;
    snap.subjectRequirements[0].consecutiveBlocksPerWeek = 4;
    const r = runFeasibility(snap);
    expect(r.blockers.some((i) => i.code === "BLOCK_MATH_INVALID")).toBe(true);
  });

  it("valid double-periods pass: 6/week as 3 blocks of 2 needs only 3 days", () => {
    const snap = cleanSchool();
    snap.subjectRequirements[0].consecutiveBlockSize = 2;
    snap.subjectRequirements[0].consecutiveBlocksPerWeek = 3;
    const r = runFeasibility(snap);
    expect(r.blockers).toEqual([]);
  });

  // ---- Check 4 ----
  it("daily pigeonhole: 8 sections × ceil(6/5) > 6/day cap → blocker", () => {
    const snap = cleanSchool();
    // give T.English 8 mappings of 6/week (min 2/day each → 16 > 6)
    snap.mappings = snap.mappings.filter((m) => m.teacherId !== 101);
    for (let i = 0; i < 8; i++) {
      snap.mappings.push({
        id: 900 + i,
        teacherId: 101,
        teacherName: "T.English",
        subjectId: 300,
        subjectName: "English",
        classSectionId: 11,
        classSectionLabel: `x-${i}`,
        periodsPerWeek: 6,
      });
    }
    snap.teachers[0].maxPeriodsPerWeek = 60;
    const r = runFeasibility(snap);
    expect(r.blockers.some((i) => i.code === "DAILY_PIGEONHOLE")).toBe(true);
  });

  it("tightness ≥ 90% → warning naming the utilization", () => {
    const snap = cleanSchool();
    snap.teachers[0].maxPeriodsPerWeek = 13; // demand 12/13 ≈ 92%
    const r = runFeasibility(snap);
    const w = r.warnings.find((i) => i.code === "TEACHER_TIGHT");
    expect(w).toBeDefined();
    expect(w!.message).toContain("92%");
  });

  // ---- Check 5 ----
  it("lab subject but zero lab rooms → blocker", () => {
    const snap = cleanSchool();
    snap.labSubjectIds = [302]; // Science
    snap.labRoomCount = 0;
    const r = runFeasibility(snap);
    expect(r.blockers.some((i) => i.code === "LAB_NONE")).toBe(true);
  });

  it("lab demand above 80% of supply → warning", () => {
    const snap = cleanSchool();
    snap.labSubjectIds = [300, 301, 302, 303]; // 4 subjects × 6 × 2 sections = 48
    snap.labRoomCount = 2; // supply 60 → 80%
    const r = runFeasibility(snap);
    expect(r.warnings.some((i) => i.code === "LAB_TIGHT")).toBe(true);
  });

  // ---- Check 6 ----
  it("class-teacher P1 deadlock: one teacher CT of two sections with always_first → blocker", () => {
    const snap = cleanSchool();
    snap.teachers[0] = teacher(101, "R. Sharma", {
      classTeacherPeriodRule: "always_first_period",
    });
    snap.classSections[0].classTeacherId = 101;
    snap.classSections[1].classTeacherId = 101;
    const r = runFeasibility(snap);
    const issue = r.blockers.find((i) => i.code === "CT_P1_DEADLOCK");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("5-A and 5-B");
  });

  it("always_first rule set but not class teacher anywhere → inert-rule warning", () => {
    const snap = cleanSchool();
    snap.teachers[2] = teacher(103, "T.Science", {
      classTeacherPeriodRule: "always_first_period",
    });
    const r = runFeasibility(snap);
    expect(r.warnings.some((i) => i.code === "CT_RULE_INERT")).toBe(true);
  });

  it("section without class teacher → warning with fix pointing at Teacher Mapping", () => {
    const snap = cleanSchool();
    snap.classSections[1].classTeacherId = null;
    const r = runFeasibility(snap);
    const w = r.warnings.find((i) => i.code === "CT_UNASSIGNED");
    expect(w).toBeDefined();
    expect(w!.fix).toContain("Teacher Mapping");
  });

  it("same-period-across-week impossible (6/week in 5 days) → blocker; fewer days → pick-days warning", () => {
    const snap = cleanSchool();
    snap.subjectRequirements[0].samePeriodAcrossWeek = true; // 6 > 5 days
    snap.subjectRequirements[1].samePeriodAcrossWeek = true;
    snap.subjectRequirements[1].periodsPerWeek = 3;
    snap.mappings.filter((m) => m.subjectId === 301).forEach((m) => (m.periodsPerWeek = 3));
    const r = runFeasibility(snap);
    expect(r.blockers.some((i) => i.code === "SAME_PERIOD_IMPOSSIBLE")).toBe(true);
    expect(r.warnings.some((i) => i.code === "SAME_PERIOD_PICK_DAYS")).toBe(true);
  });

  it("under-mapped subject: no teacher for Science in 5-B → blocker naming section & subject", () => {
    const snap = cleanSchool();
    snap.mappings = snap.mappings.filter(
      (m) => !(m.subjectId === 302 && m.classSectionId === 12),
    );
    const r = runFeasibility(snap);
    const issue = r.blockers.find((i) => i.code === "UNDER_MAPPED");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("Science in 5-B");
  });

  it("merged group coverage satisfies a member section's requirement (§4.9)", () => {
    const snap = cleanSchool();
    snap.mappings = snap.mappings.filter(
      (m) => !(m.subjectId === 302), // remove direct Science mappings for both sections
    );
    snap.mergedGroups = [
      {
        id: 700,
        teacherId: 103,
        subjectId: 302,
        subjectName: "Science",
        periodsPerWeek: 6,
        memberClassSectionIds: [11, 12],
      },
    ];
    const r = runFeasibility(snap);
    expect(r.blockers.filter((i) => i.code === "UNDER_MAPPED")).toEqual([]);
  });

  it("over-mapped subject → blocker", () => {
    const snap = cleanSchool();
    snap.mappings.push({
      id: 999,
      teacherId: 102,
      teacherName: "T.Maths",
      subjectId: 300,
      subjectName: "English",
      classSectionId: 11,
      classSectionLabel: "5-A",
      periodsPerWeek: 2,
    });
    snap.teachers[1].maxPeriodsPerWeek = 30;
    const r = runFeasibility(snap);
    expect(r.blockers.some((i) => i.code === "OVER_MAPPED")).toBe(true);
  });

  it("score arithmetic: each blocker −10, each warning −2, floor 0", () => {
    const snap = cleanSchool();
    snap.classSections[1].classTeacherId = null; // 1 warning
    const r = runFeasibility(snap);
    expect(r.score).toBe(98);
  });
});
