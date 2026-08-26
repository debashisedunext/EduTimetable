import { describe, expect, it } from "vitest";
import { runFeasibility, teacherWeeklyCapacity } from "./engine";
import { cleanSchool, schoolWithElective, teacher } from "./fixtures";
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

describe("Check 7 — split electives (§4.9)", () => {
  it("a well-formed block is feasible, and its periods count against every member section", () => {
    const snap = schoolWithElective();
    const r = runFeasibility(snap);
    expect(r.blockers).toEqual([]);
    expect(r.ready).toBe(true);
    // 4 subjects x 6 + Art 4 = 28 curriculum periods, + 2 block periods = 30,
    // which is exactly the 30 available. Under-counting the block would leave
    // 2 free slots and a SLOT_UNDERFLOW warning instead.
    expect(r.warnings).toEqual([]);
  });

  it("each option's teacher carries the block's full weekly load, once", () => {
    const snap = schoolWithElective();
    // Mme Dubois teaches nothing else; her only demand is the 2-period block.
    // 3 members would make it 6 if the block were counted per section.
    snap.teachers.find((t) => t.id === 201)!.maxPeriodsPerWeek = 2;
    expect(runFeasibility(snap).blockers).toEqual([]);

    snap.teachers.find((t) => t.id === 201)!.maxPeriodsPerWeek = 1;
    const r = runFeasibility(snap);
    expect(codes(r)).toContain("TEACHER_OVERLOAD");
    expect(r.blockers.find((b) => b.code === "TEACHER_OVERLOAD")!.message).toContain("2 periods/week");
  });

  it("one option is not a choice → blocker", () => {
    const snap = schoolWithElective();
    snap.electiveBlocks[0].options = [snap.electiveBlocks[0].options[0]];
    expect(codes(runFeasibility(snap))).toContain("ELECTIVE_TOO_FEW_OPTIONS");
  });

  it("the same teacher on two options cannot be in both at once → blocker naming them", () => {
    const snap = schoolWithElective();
    snap.electiveBlocks[0].options[1].teacherId = 201;
    snap.electiveBlocks[0].options[1].teacherName = "Mme Dubois";
    const r = runFeasibility(snap);
    expect(codes(r)).toContain("ELECTIVE_TEACHER_CLASH");
    expect(r.blockers.find((b) => b.code === "ELECTIVE_TEACHER_CLASH")!.message).toContain("Sanskrit");
  });

  it("two options in one room → blocker", () => {
    const snap = schoolWithElective();
    snap.electiveBlocks[0].options[2].roomId = 801;
    snap.electiveBlocks[0].options[2].roomName = "Lang 1";
    expect(codes(runFeasibility(snap))).toContain("ELECTIVE_ROOM_CLASH");
  });

  it("more weekly periods than days x max/day → blocker with the arithmetic", () => {
    const snap = schoolWithElective();
    snap.electiveBlocks[0].periodsPerWeek = 6; // 5 days x 1/day = 5
    const r = runFeasibility(snap);
    expect(codes(r)).toContain("ELECTIVE_DAILY_PIGEONHOLE");
    expect(r.blockers.find((b) => b.code === "ELECTIVE_DAILY_PIGEONHOLE")!.message).toContain("at most 5");
  });

  it("an alternate-day option teacher narrows the WHOLE block, because the options run together", () => {
    const snap = schoolWithElective();
    // German only on Monday: every option must meet then too, so the block can
    // run at most once a week — the check that is hardest to see by eye.
    const bauer = snap.teachers.find((t) => t.id === 203)!;
    bauer.periodPattern = "alternate_day";
    bauer.alternateDaySet = [1];
    const r = runFeasibility(snap);
    expect(codes(r)).toContain("ELECTIVE_DAY_INTERSECTION");
    const msg = r.blockers.find((b) => b.code === "ELECTIVE_DAY_INTERSECTION")!.message;
    expect(msg).toContain("Hr. Bauer");
    expect(msg).toContain("Mon");
  });

  it("an option subject that is ALSO in the curriculum would be taught twice → blocker", () => {
    const snap = schoolWithElective();
    snap.subjectRequirements.push({
      id: 999,
      classId: 5,
      subjectId: 501, // French, already an option
      subjectName: "French",
      periodsPerWeek: 2,
      maxPeriodsPerDay: 1,
      samePeriodAcrossWeek: false,
      consecutiveBlockSize: 1,
      consecutiveBlocksPerWeek: null,
    });
    const r = runFeasibility(snap);
    expect(codes(r)).toContain("ELECTIVE_SUBJECT_DOUBLE_COUNTED");
    expect(r.blockers.find((b) => b.code === "ELECTIVE_SUBJECT_DOUBLE_COUNTED")!.fix).toContain(
      "Remove French from the curriculum",
    );
  });
});

describe("Check 8 — teaching scope and engagement (§18)", () => {
  it("a teacher mapped outside their scope is a blocker naming the class and the fix", () => {
    const snap = cleanSchool();
    // T.English covers class 5 only; give them a section of a class 9 they do
    // not teach — the case a scope *narrowed after the fact* produces.
    snap.classSections.push({ id: 21, label: "9-A", classId: 9, classTeacherId: null });
    snap.subjectRequirements.push({
      id: 900, classId: 9, subjectId: 300, subjectName: "English", periodsPerWeek: 30,
      maxPeriodsPerDay: 6, samePeriodAcrossWeek: false, consecutiveBlockSize: 1, consecutiveBlocksPerWeek: null,
    });
    snap.mappings.push({
      id: 900, teacherId: 101, teacherName: "T.English", subjectId: 300, subjectName: "English",
      classSectionId: 21, classSectionLabel: "9-A", periodsPerWeek: 30,
    });
    const r = runFeasibility(snap);
    expect(codes(r)).toContain("TEACHER_NOT_ELIGIBLE");
    const b = r.blockers.find((x) => x.code === "TEACHER_NOT_ELIGIBLE")!;
    expect(b.message).toContain("T.English");
    expect(b.message).toContain("9-A");
    expect(b.fix).toContain("teaching scope");
  });

  it("reports a teacher once per class, not once per section", () => {
    const snap = cleanSchool();
    // Same teacher, same out-of-scope class, four sections of it.
    for (let i = 0; i < 4; i++) {
      snap.classSections.push({ id: 30 + i, label: `9-${"ABCD"[i]}`, classId: 9, classTeacherId: null });
      snap.mappings.push({
        id: 930 + i, teacherId: 101, teacherName: "T.English", subjectId: 300, subjectName: "English",
        classSectionId: 30 + i, classSectionLabel: `9-${"ABCD"[i]}`, periodsPerWeek: 1,
      });
    }
    const r = runFeasibility(snap);
    expect(r.blockers.filter((b) => b.code === "TEACHER_NOT_ELIGIBLE")).toHaveLength(1);
  });

  it("a guest teacher in the regular curriculum is a blocker", () => {
    const snap = cleanSchool();
    snap.teachers.find((t) => t.id === 101)!.employmentType = "guest";
    const r = runFeasibility(snap);
    expect(codes(r)).toContain("GUEST_IN_CURRICULUM");
    expect(r.blockers.find((b) => b.code === "GUEST_IN_CURRICULUM")!.fix).toContain("Extra Classes");
  });

  it("an unstated scope is one warning for the whole school, not one per teacher", () => {
    const snap = cleanSchool();
    for (const t of snap.teachers) t.eligibleClassIds = [];
    const r = runFeasibility(snap);
    const warns = r.warnings.filter((w) => w.code === "TEACHER_SCOPE_UNSET");
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain("5 teachers");
    // and it stays a warning: an unfilled field must not block generation
    expect(r.ready).toBe(true);
  });

  it("scope is checked through merged groups and elective options too", () => {
    const snap = schoolWithElective();
    snap.teachers.find((t) => t.id === 201)!.eligibleClassIds = [11]; // not class 5
    const r = runFeasibility(snap);
    const b = r.blockers.find((x) => x.code === "TEACHER_NOT_ELIGIBLE");
    expect(b?.message).toContain("Mme Dubois");
    expect(b?.message).toContain("French in Class 5 Third Language");
  });
});
