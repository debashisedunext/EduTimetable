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

  it("...but not when the row is ALLOWED to cross a break (§31.10)", () => {
    /*
      The same fragmented day, the same 3-period block, and the school has said
      the block may run through a break. "No block can ever fit" is then simply
      false, and refusing before Generate would be refusing a school for doing
      what it just asked for — and offering it a fix that undoes the request.
    */
    const snap = cleanSchool();
    snap.config.daySegments = [2, 2, 2];
    snap.subjectRequirements[0].consecutiveBlockSize = 3;
    snap.subjectRequirements[0].maxPeriodsPerDay = 3;
    snap.subjectRequirements[0].blockMayCrossBreak = true;
    const r = runFeasibility(snap);
    expect(r.blockers.some((i) => i.code === "BLOCK_FRAGMENTED")).toBe(false);
  });

  it("crossing a break does not excuse a block longer than the DAY (§31.10)", () => {
    // The one limit that survives: breaks stop dividing the day, but the day is
    // still only so long. That branch belongs to BLOCK_EXCEEDS_DAILY_MAX and
    // must keep firing, or "may cross a break" would read as "may be any size".
    const snap = cleanSchool();
    snap.config.daySegments = [2, 2, 2];
    snap.subjectRequirements[0].consecutiveBlockSize = 3;
    snap.subjectRequirements[0].maxPeriodsPerDay = 2;
    snap.subjectRequirements[0].blockMayCrossBreak = true;
    const r = runFeasibility(snap);
    expect(r.blockers.some((i) => i.code === "BLOCK_EXCEEDS_DAILY_MAX")).toBe(true);
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

  // ---- Check 5b — a subject taught in its own room (§19.1) ----
  //
  // The failure this exists for looks like the solver's fault: every section
  // wants Music, Music may only happen in the Music Room, and one room holds
  // 40 periods a week. Phase A has to say so before Generate, not after.
  it("a subject's own room that cannot hold its week → blocker naming the room", () => {
    const snap = cleanSchool();
    snap.ownRoomSubjectIds = [302];
    snap.ownRoomsBySubject = { 302: [905] };
    snap.roomNames = { ...snap.roomNames, 905: "Music Room" };
    // 6 periods × 2 sections = 12, against one room's 8 slots (2 days × 4).
    snap.config.workingDays = [1, 2];
    snap.config.periodsPerDay = 4;
    const r = runFeasibility(snap);
    const issue = r.blockers.find((i) => i.code === "SUBJECT_ROOM_OVERFLOW");
    expect(issue).toBeDefined();
    // Named, not just counted — §4's whole "tell me what to fix" requirement.
    expect(issue!.message).toContain("Music Room");
    expect(issue!.fix).toMatch(/untick/i);
  });

  it("ticked with no room named is a WARNING, never a blocker", () => {
    // The school has half-said something. The lesson takes the home room
    // exactly as before, so the timetable generates — but the tick is doing
    // nothing, and silence would leave the screen contradicting the result.
    const snap = cleanSchool();
    snap.ownRoomSubjectIds = [302];
    snap.ownRoomsBySubject = { 302: [] };
    const r = runFeasibility(snap);
    expect(r.warnings.some((i) => i.code === "SUBJECT_ROOM_UNSET")).toBe(true);
    expect(r.blockers.some((i) => i.code.startsWith("SUBJECT_ROOM"))).toBe(false);
  });

  it("a room that comfortably holds the subject says nothing at all", () => {
    const snap = cleanSchool();
    snap.ownRoomSubjectIds = [302];
    snap.ownRoomsBySubject = { 302: [905] };
    const r = runFeasibility(snap);
    expect([...r.blockers, ...r.warnings].some((i) => i.code.startsWith("SUBJECT_ROOM"))).toBe(false);
  });

  it("says nothing about a school that never ticked the box", () => {
    // The default for every existing school: the field is absent from the
    // snapshot entirely, and the check must not invent an opinion.
    const r = runFeasibility(cleanSchool());
    expect([...r.blockers, ...r.warnings].some((i) => i.code.startsWith("SUBJECT_ROOM"))).toBe(false);
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

describe("Check 9 — fixed room assignment (§19)", () => {
  it("two sections sharing a home room is a blocker naming both", () => {
    const snap = cleanSchool();
    snap.homeRoomBySection = { 11: 701, 12: 701 };
    const r = runFeasibility(snap);
    expect(codes(r)).toContain("HOME_ROOM_SHARED");
    const b = r.blockers.find((x) => x.code === "HOME_ROOM_SHARED")!;
    expect(b.message).toContain("5-A");
    expect(b.message).toContain("5-B");
    expect(b.message).toContain("Room 1");
  });

  it("sections without a home room are one warning, not a blocker", () => {
    const snap = cleanSchool();
    snap.homeRoomBySection = {};
    const r = runFeasibility(snap);
    const w = r.warnings.filter((x) => x.code === "HOME_ROOM_UNSET");
    expect(w).toHaveLength(1);
    expect(w[0].message).toContain("2 class-sections");
    expect(r.ready).toBe(true); // a missing room does not stop a timetable existing
  });

  it("a lab subject with no lab that teaches it is a blocker", () => {
    const snap = cleanSchool();
    snap.labSubjectIds = [302]; // Science
    snap.labRoomsBySubject = {}; // nothing serves it
    const r = runFeasibility(snap);
    expect(codes(r)).toContain("LAB_SUBJECT_UNSERVED");
    expect(r.blockers.find((x) => x.code === "LAB_SUBJECT_UNSERVED")!.message).toContain("Science");
  });

  it("and one whose own labs cannot hold its periods is a blocker with the arithmetic", () => {
    const snap = cleanSchool();
    snap.labSubjectIds = [302];
    // 2 sections x 6 periods = 12 Science lab periods, against one lab that is
    // only free... well, 30 slots — so widen the demand instead.
    snap.subjectRequirements.find((r) => r.subjectId === 302)!.periodsPerWeek = 6;
    snap.labRoomsBySubject = { 302: [901] };
    snap.roomNames = { ...snap.roomNames, 901: "Science Lab" };
    expect(runFeasibility(snap).blockers.filter((b) => b.code === "LAB_SUBJECT_OVERFLOW")).toHaveLength(0);

    // now make it genuinely impossible: 40 periods against one 30-slot lab
    snap.subjectRequirements.find((r) => r.subjectId === 302)!.periodsPerWeek = 20;
    const r = runFeasibility(snap);
    const b = r.blockers.find((x) => x.code === "LAB_SUBJECT_OVERFLOW");
    expect(b?.message).toContain("Science Lab");
    expect(b?.message).toContain("supply only 30");
  });

  it("a general lab — one with no subjects listed — still serves everything", () => {
    const snap = cleanSchool();
    snap.labSubjectIds = [302];
    // This is what every school had before §19 existed, and it must keep working.
    snap.labRoomsBySubject = { 302: [901] };
    expect(runFeasibility(snap).blockers.filter((b) => b.code.startsWith("LAB_SUBJECT"))).toEqual([]);
  });
});

describe("Check 10 — minimum periods per day (§20)", () => {

  it("a minimum that no whole number of days can reach is a blocker naming the fix", () => {
    const snap = cleanSchool();
    // T.English keeps 12 periods but may take only 5 a day, and must take at
    // least 5 — 12 is neither 5 nor 10 nor 15.
    const t = snap.teachers.find((x) => x.name === "T.English")!;
    t.minPeriodsPerDay = 5;
    t.maxPeriodsPerDay = 5;
    for (const r of snap.subjectRequirements) if (r.subjectId === 300) r.maxPeriodsPerDay = 6;

    const b = runFeasibility(snap).blockers.find((x) => x.code === "MIN_DAY_IMPOSSIBLE");
    expect(b?.message).toContain("T.English");
    expect(b?.message).toContain("12 periods/week");
    expect(b?.fix).toContain("minimum periods/day to 4");
  });

  it("a load too small for the minimum is a warning, not a blocker — it is still solvable", () => {
    const snap = cleanSchool();
    // Split Art in two and cut it to 2 periods, so T.Art holds a single
    // 2-period mapping: a minimum of 3 is simply more work than they have.
    const art = snap.subjectRequirements.find((r) => r.subjectName === "Art")!;
    art.periodsPerWeek = 2;
    snap.teachers.push(teacher(106, "T.Art2", { eligibleClassIds: [5], minPeriodsPerDay: 3 }));
    for (const m of snap.mappings) {
      if (m.subjectName !== "Art") continue;
      m.periodsPerWeek = 2;
      if (m.classSectionId === 12) { m.teacherId = 106; m.teacherName = "T.Art2"; }
    }
    for (const t of snap.teachers) t.minPeriodsPerDay = 3;

    const r = runFeasibility(snap);
    expect(r.blockers.filter((b) => b.code === "MIN_DAY_IMPOSSIBLE")).toEqual([]);
    const w = r.warnings.find((x) => x.code === "MIN_DAY_RELAXED");
    expect(w?.message).toContain("T.Art");
    expect(w?.message).toContain("3 → 2");
    expect(w?.message).toContain("only 2 periods/week in total");
  });

  it("a teacher whose subjects cap them below their minimum is told which bound binds", () => {
    const snap = schoolWithElective();
    // The French option runs once a day at most, so three-period days are not
    // a thing this teacher could ever have — the cap binds, not the load.
    snap.teachers.find((t) => t.id === 201)!.minPeriodsPerDay = 3;
    const w = runFeasibility(snap).warnings.find((x) => x.code === "MIN_DAY_RELAXED");
    expect(w?.message).toContain("Mme Dubois");
    expect(w?.message).toContain("at most 1 period(s) of their own subjects in a day");
  });

  it("the default minimum leaves a normally-staffed school clean", () => {
    const snap = cleanSchool();
    for (const t of snap.teachers) t.minPeriodsPerDay = 3; // the app default
    const r = runFeasibility(snap);
    expect(r.blockers).toEqual([]);
    expect(r.warnings.filter((w) => w.code.startsWith("MIN_DAY"))).toEqual([]);
  });
});

/**
 * §27.16 — the curriculum against what the subject says about itself.
 *
 * The backstop, not the gate: the Subjects screen and the Allocation grid stop
 * a new contradiction being written, and this names the ones written before the
 * declaration existed or through a workbook. Every test here is about the two
 * ways it must stay quiet.
 */
describe("Check 13 — curriculum vs a subject's declared classes (§27.16)", () => {
  it("says nothing at all when no subject has been narrowed", () => {
    // Every school that predates the table. `subjectClasses` is absent, which
    // is "not stated" — not "taught to nobody" (invariant 7).
    const r = runFeasibility(cleanSchool());
    expect(r.warnings.filter((w) => w.code === "SUBJECT_CLASS_MISMATCH")).toEqual([]);
  });

  it("says nothing when the declaration and the curriculum agree", () => {
    const snap = cleanSchool();
    snap.subjectClasses = Object.fromEntries(
      snap.subjectRequirements.map((r) => [r.subjectId, [r.classId]]),
    );
    const r = runFeasibility(snap);
    expect(r.warnings.filter((w) => w.code === "SUBJECT_CLASS_MISMATCH")).toEqual([]);
  });

  it("warns — never blocks — when they disagree, and names the row", () => {
    const snap = cleanSchool();
    const row = snap.subjectRequirements[0];
    // Declared for a class that is not this one.
    snap.subjectClasses = { [row.subjectId]: [row.classId + 9999] };
    const r = runFeasibility(snap);
    const w = r.warnings.find((x) => x.code === "SUBJECT_CLASS_MISMATCH");
    expect(w).toBeDefined();
    expect(w!.message).toContain(row.subjectName);
    /*
      The load-bearing assertion, and the reason this is not Check 8.

      A teacher outside their scope BLOCKS because generating would put them in
      front of a class they may not take. This one would generate a lesson
      somebody typed on a screen that let them; what is wrong is that two
      statements disagree, and refusing the whole school over that turns a
      convenience into a trap.
    */
    expect(r.blockers.filter((b) => b.code === "SUBJECT_CLASS_MISMATCH")).toEqual([]);
  });

  it("carries no remedy — neither way out is safe under a standing consent", () => {
    const snap = cleanSchool();
    const row = snap.subjectRequirements[0];
    snap.subjectClasses = { [row.subjectId]: [row.classId + 9999] };
    const w = runFeasibility(snap).warnings.find((x) => x.code === "SUBJECT_CLASS_MISMATCH");
    // One is deleting teaching the school may genuinely do; the other is
    // widening an answer somebody gave on purpose (§21).
    expect(w!.remedy).toBeUndefined();
  });
});

/**
 * §28.1 — the school's own "getting full" line.
 *
 * The point of every test here is that this must NOT behave like the other
 * checks. It is the one thing in the engine that reports a school which is
 * completely fine.
 */
describe("Check 12 — teacher load alert (§28.1)", () => {
  /** cleanSchool's teachers sit at 12 of 30 — 40%, comfortably under any line. */
  const quiet = () => cleanSchool();

  it("says nothing while everybody is under the line", () => {
    const r = runFeasibility(quiet());
    expect(r.warnings.filter((w) => w.code === "TEACHER_LOAD_ALERT")).toEqual([]);
  });

  it("warns — never blocks — once somebody crosses it", () => {
    const snap = quiet();
    // 12 of 30 is 40%. Drop the cap to 15 and they are at 80%.
    for (const t of snap.teachers) t.maxPeriodsPerWeek = 15;
    const r = runFeasibility(snap);
    const w = r.warnings.find((x) => x.code === "TEACHER_LOAD_ALERT");
    expect(w).toBeDefined();
    // The load-bearing assertion. A teacher at 80% of their limit is a
    // normally employed teacher; refusing to generate would make most real
    // schools ungenerable, and the school asked for an alert, not a refusal.
    expect(r.blockers.filter((b) => b.code === "TEACHER_LOAD_ALERT")).toEqual([]);
    expect(w!.message).toMatch(/at or above 75% of their weekly limit/);
  });

  it("is ONE row naming the worst, not one row per teacher", () => {
    // At 122 staff, a warning each buries every real blocker under thirty rows
    // of "this is fine, but".
    const snap = quiet();
    for (const t of snap.teachers) t.maxPeriodsPerWeek = 15;
    const rows = runFeasibility(snap).warnings.filter((w) => w.code === "TEACHER_LOAD_ALERT");
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toMatch(/teacher\(s\) are at or above/);
  });

  it("follows the school's own number, not ours", () => {
    const snap = quiet();
    for (const t of snap.teachers) t.maxPeriodsPerWeek = 15;   // everybody at 80%
    snap.config.loadAlertPct = 90;
    expect(runFeasibility(snap).warnings.filter((w) => w.code === "TEACHER_LOAD_ALERT")).toEqual([]);
    snap.config.loadAlertPct = 60;
    expect(runFeasibility(snap).warnings.filter((w) => w.code === "TEACHER_LOAD_ALERT")).toHaveLength(1);
  });

  it("carries no remedy", () => {
    // Every way to lower the percentage is either a `redistribute` the
    // Allocation advisor already offers where the work is done, or a `relax`
    // that raises the very cap the percentage is measured against — a fix
    // whose only effect is to move the goalposts.
    const snap = quiet();
    for (const t of snap.teachers) t.maxPeriodsPerWeek = 15;
    const w = runFeasibility(snap).warnings.find((x) => x.code === "TEACHER_LOAD_ALERT");
    expect(w?.remedy).toBeUndefined();
  });
});

describe("Check 12 — the alert does not move the readiness score (§28.1)", () => {
  it("a generable school still reads 100 after somebody asks to be warned", () => {
    // The product promise: 100% means it will generate. A school that says
    // "tell me when a teacher passes 60%" has not become less ready by saying
    // so, and watching its own dashboard drop for answering a question would
    // read as the setting having broken something.
    const snap = cleanSchool();
    const before = runFeasibility(snap);
    expect(before.score).toBe(100);

    snap.config.loadAlertPct = 30;               // everybody at 12/30 = 40%
    const after = runFeasibility(snap);
    expect(after.warnings.some((w) => w.code === "TEACHER_LOAD_ALERT")).toBe(true);
    expect(after.score).toBe(100);
    expect(after.ready).toBe(true);
  });

  it("but a real warning still costs what it always did", () => {
    // The exemption is for this code alone, not a general softening.
    const snap = cleanSchool();
    snap.teachers[0].minPeriodsPerDay = 9;       // §20: load too small — a warning
    const r = runFeasibility(snap);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(100);
  });
});
