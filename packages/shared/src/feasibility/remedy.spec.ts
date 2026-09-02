/**
 * §21 auto-resolve remedies.
 *
 * Two kinds of test here, and the second is the one that matters.
 *
 *   1. Each remedy proposes the *right* change — that Room 3 goes to the
 *      section with no room, that the overloaded teacher's smallest class
 *      moves and not their biggest.
 *   2. **Round trip**: applying a remedy makes its own issue disappear when
 *      the engine is re-run. A remedy that sounds right and does not resolve
 *      anything is the failure mode this whole feature has to be protected
 *      from, and only the engine's own verdict settles it — the same
 *      discipline as "the solver never grades its own homework".
 */
import { describe, expect, it } from "vitest";
import { runFeasibility } from "./engine";
import { cleanSchool, schoolWithElective, teacher } from "./fixtures";
import { applyToSnapshot } from "./remedy";
import type { FeasibilityIssue, FeasibilitySnapshot, IssueCode } from "./types";

const allIssues = (snap: FeasibilitySnapshot): FeasibilityIssue[] => {
  const r = runFeasibility(snap);
  return [...r.blockers, ...r.warnings];
};
const find = (snap: FeasibilitySnapshot, code: IssueCode) => allIssues(snap).find((i) => i.code === code);

/**
 * Apply an issue's remedy and report whether the engine still sees *that*
 * issue. Matched by key, not by code: one fixture can raise the same code
 * twice — an alternate-period teacher holding block subjects in two sections
 * raises one per mapping — and fixing the first must not be judged a failure
 * because the second is still there.
 */
function roundTrip(snap: FeasibilitySnapshot, code: IssueCode) {
  const before = find(snap, code);
  expect(before, `fixture did not raise ${code}`).toBeDefined();
  expect(before!.remedy, `${code} has no remedy`).toBeDefined();
  const after = applyToSnapshot(snap, before!.remedy!.changes);
  return { before: before!, gone: !allIssues(after).some((i) => i.key === before!.key), after };
}

describe("§21 remedies — each proposes the right change", () => {
  it("CT_UNASSIGNED picks a teacher who already teaches the section", () => {
    const snap = cleanSchool();
    snap.classSections[0].classTeacherId = null;
    const { before } = roundTrip(snap, "CT_UNASSIGNED");
    // 5-A is taught by 101..105, each 6 periods; none is class teacher of 5-A
    // any more, and 102 already has 5-B — so the pick must avoid 102.
    const change = before.remedy!.changes[0];
    expect(change).toMatchObject({ op: "set", entity: "classSection", field: "classTeacherId", from: null });
    expect(change.op === "set" && change.to).not.toBe(102);
    expect(before.remedy!.kind).toBe("complete");
  });

  it("HOME_ROOM_UNSET hands out the spare room, biggest first", () => {
    const snap = cleanSchool();
    snap.homeRoomBySection = { 11: null, 12: 702 };
    const { before } = roundTrip(snap, "HOME_ROOM_UNSET");
    expect(before.remedy!.changes).toEqual([
      { op: "set", entity: "classSection", id: 11, field: "homeRoomId", from: null, to: 701 },
    ]);
  });

  it("HOME_ROOM_UNSET says so when the school runs out of rooms", () => {
    const snap = cleanSchool();
    snap.homeRoomBySection = { 11: null, 12: null };
    snap.rooms = snap.rooms.filter((r) => r.id === 701 || r.id === 901); // one classroom, one lab
    const issue = find(snap, "HOME_ROOM_UNSET")!;
    expect(issue.remedy!.changes).toHaveLength(1); // only one room to give
    expect(issue.remedy!.summary).toContain("run out of rooms");
  });

  it("HOME_ROOM_SHARED leaves the first section alone and re-homes the rest", () => {
    const snap = cleanSchool();
    snap.homeRoomBySection = { 11: 701, 12: 701 };
    const { before } = roundTrip(snap, "HOME_ROOM_SHARED");
    expect(before.remedy!.changes).toEqual([
      { op: "set", entity: "classSection", id: 12, field: "homeRoomId", from: 701, to: 702 },
    ]);
  });

  it("TEACHER_SCOPE_UNSET infers scope from what each teacher already holds", () => {
    const snap = cleanSchool();
    for (const t of snap.teachers) t.eligibleClassIds = [];
    const { before } = roundTrip(snap, "TEACHER_SCOPE_UNSET");
    // five teachers, all teaching class 5 and nothing else
    expect(before.remedy!.changes).toHaveLength(5);
    expect(before.remedy!.changes[0]).toEqual({ op: "link", entity: "teacherClass", id: 101, otherId: 5 });
  });

  it("TEACHER_NOT_ELIGIBLE widens the scope rather than moving the teaching", () => {
    const snap = cleanSchool();
    snap.teachers[0].eligibleClassIds = [9]; // teaches class 5, scoped to class 9
    const { before } = roundTrip(snap, "TEACHER_NOT_ELIGIBLE");
    expect(before.remedy!.changes).toEqual([{ op: "link", entity: "teacherClass", id: 101, otherId: 5 }]);
  });

  it("ALT_DAY_UNSET writes down the days the solver would have picked anyway", () => {
    const snap = cleanSchool();
    snap.teachers[0].periodPattern = "alternate_day";
    snap.teachers[0].maxPeriodsPerWeek = 40;
    const issue = find(snap, "ALT_DAY_UNSET")!;
    expect(issue.remedy!.changes).toEqual([
      { op: "set", entity: "teacher", id: 101, field: "alternateDaySet", from: null, to: [1, 3, 5] },
    ]);
  });

  it("CT_RULE_INERT clears a rule that does nothing", () => {
    const snap = cleanSchool();
    snap.teachers[4].classTeacherPeriodRule = "always_first_period"; // T.Art, class teacher of nothing
    const { gone, before } = roundTrip(snap, "CT_RULE_INERT");
    expect(before.remedy!.changes[0]).toMatchObject({ field: "classTeacherPeriodRule", to: "none" });
    expect(gone).toBe(true);
  });

  it("TEACHER_OVERLOAD moves the smallest classes, and only enough of them", () => {
    const snap = cleanSchool();
    // T.English: 12 periods over two sections, capped at 6.
    snap.teachers[0].maxPeriodsPerWeek = 6;
    const { before } = roundTrip(snap, "TEACHER_OVERLOAD");
    expect(before.remedy!.kind).toBe("redistribute");
    // Over by 6, and each mapping is 6 — so exactly one moves, not both.
    expect(before.remedy!.changes).toHaveLength(1);
    expect(before.remedy!.changes[0]).toMatchObject({ op: "set", entity: "mapping", field: "teacherId", from: 101 });
  });

  it("TEACHER_OVERLOAD offers nothing when nobody has room — it never raises the cap", () => {
    const snap = cleanSchool();
    for (const t of snap.teachers) t.maxPeriodsPerWeek = 12;
    snap.teachers[0].maxPeriodsPerWeek = 6; // over, and every colleague is full
    const issue = find(snap, "TEACHER_OVERLOAD")!;
    expect(issue.remedy, "raising the limit is a `relax`, not part of 14.1").toBeUndefined();
  });

  it("UNDER_MAPPED tops up an existing mapping rather than splitting the subject", () => {
    const snap = cleanSchool();
    snap.mappings.find((m) => m.classSectionId === 11 && m.subjectId === 300)!.periodsPerWeek = 4;
    const { before } = roundTrip(snap, "UNDER_MAPPED");
    expect(before.remedy!.changes).toEqual([
      { op: "set", entity: "mapping", id: 400, field: "periodsPerWeek", from: 4, to: 6 },
    ]);
  });

  it("UNDER_MAPPED creates a mapping when nobody is on the subject at all", () => {
    const snap = cleanSchool();
    snap.mappings = snap.mappings.filter((m) => !(m.classSectionId === 11 && m.subjectId === 300));
    const { before } = roundTrip(snap, "UNDER_MAPPED");
    expect(before.remedy!.changes[0]).toMatchObject({
      op: "create",
      entity: "mapping",
      data: { subjectId: 300, classSectionId: 11, periodsPerWeek: 6 },
    });
  });

  it("GUEST_IN_CURRICULUM moves the teaching, never promotes the guest", () => {
    const snap = cleanSchool();
    snap.teachers[4].employmentType = "guest"; // T.Art
    const { before } = roundTrip(snap, "GUEST_IN_CURRICULUM");
    expect(before.remedy!.kind).toBe("redistribute");
    for (const c of before.remedy!.changes) {
      expect(c).toMatchObject({ op: "set", entity: "mapping", field: "teacherId", from: 105 });
    }
    // Nothing touches the teacher record — the engagement is a fact about a
    // person, not a number to be edited until a warning stops.
    expect(before.remedy!.changes.some((c) => c.op === "set" && c.entity === "teacher")).toBe(false);
  });

  it("ELECTIVE_TEACHER_CLASH picks somebody outside the whole block", () => {
    const snap = schoolWithElective();
    snap.electiveBlocks[0].options[1].teacherId = 201; // Dubois now on two options
    snap.electiveBlocks[0].options[1].teacherName = "Mme Dubois";
    const issue = find(snap, "ELECTIVE_TEACHER_CLASH")!;
    const change = issue.remedy!.changes[0];
    expect(change).toMatchObject({ op: "set", entity: "electiveOption", field: "teacherId", from: 201 });
    // 203 is the block's third option — the replacement must not be in it.
    expect(change.op === "set" && change.to).not.toBe(203);
  });

  it("ELECTIVE_ROOM_CLASH moves one option to a room the block is not using", () => {
    const snap = schoolWithElective();
    snap.electiveBlocks[0].options[1].roomId = 801;
    snap.electiveBlocks[0].options[1].roomName = "Lang 1";
    const issue = find(snap, "ELECTIVE_ROOM_CLASH")!;
    expect(issue.remedy!.changes[0]).toMatchObject({ op: "set", entity: "electiveOption", field: "roomId", from: 801 });
  });

  it("BLOCK_TEACHER_PATTERN moves the teaching, not the teacher's working pattern", () => {
    const snap = cleanSchool();
    snap.subjectRequirements[0].consecutiveBlockSize = 2;
    snap.subjectRequirements[0].consecutiveBlocksPerWeek = 3;
    snap.teachers[0].periodPattern = "alternate_period";
    snap.teachers[0].maxPeriodsPerWeek = 40;
    const issue = find(snap, "BLOCK_TEACHER_PATTERN")!;
    expect(issue.remedy!.changes[0]).toMatchObject({ op: "set", entity: "mapping", field: "teacherId", from: 101 });
    expect(issue.remedy!.changes.some((c) => c.op === "set" && c.field === "periodPattern")).toBe(false);
  });

  it("LAB_SUBJECT_UNSERVED marks an existing lab, and offers nothing when there is none", () => {
    const snap = cleanSchool();
    snap.labSubjectIds = [302];
    snap.labRoomsBySubject = { 302: [] };
    snap.rooms = snap.rooms.map((r) => (r.id === 901 ? { ...r, subjectIds: [999] } : r));
    const withLab = find(snap, "LAB_SUBJECT_UNSERVED")!;
    expect(withLab.remedy!.changes).toEqual([{ op: "link", entity: "roomSubject", id: 901, otherId: 302 }]);

    snap.rooms = snap.rooms.filter((r) => r.roomType !== "lab");
    expect(find(snap, "LAB_SUBJECT_UNSERVED")!.remedy, "no lab exists to give it").toBeUndefined();
  });
});

describe("§21 remedies — round trip: applying one resolves its own issue", () => {
  const cases: Array<[IssueCode, () => FeasibilitySnapshot]> = [
    ["CT_UNASSIGNED", () => { const s = cleanSchool(); s.classSections[0].classTeacherId = null; return s; }],
    ["CT_RULE_INERT", () => { const s = cleanSchool(); s.teachers[4].classTeacherPeriodRule = "always_first_period"; return s; }],
    ["HOME_ROOM_UNSET", () => { const s = cleanSchool(); s.homeRoomBySection = { 11: null, 12: 702 }; return s; }],
    ["HOME_ROOM_SHARED", () => { const s = cleanSchool(); s.homeRoomBySection = { 11: 701, 12: 701 }; return s; }],
    ["TEACHER_SCOPE_UNSET", () => { const s = cleanSchool(); for (const t of s.teachers) t.eligibleClassIds = []; return s; }],
    ["TEACHER_NOT_ELIGIBLE", () => { const s = cleanSchool(); s.teachers[0].eligibleClassIds = [9]; return s; }],
    ["ALT_DAY_UNSET", () => { const s = cleanSchool(); s.teachers[0].periodPattern = "alternate_day"; s.teachers[0].maxPeriodsPerWeek = 40; return s; }],
    ["TEACHER_OVERLOAD", () => { const s = cleanSchool(); s.teachers[0].maxPeriodsPerWeek = 6; return s; }],
    ["UNDER_MAPPED", () => { const s = cleanSchool(); s.mappings[0].periodsPerWeek = 4; return s; }],
    ["GUEST_IN_CURRICULUM", () => { const s = cleanSchool(); s.teachers[4].employmentType = "guest"; return s; }],
    ["BLOCK_TEACHER_PATTERN", () => {
      const s = cleanSchool();
      s.subjectRequirements[0].consecutiveBlockSize = 2;
      s.subjectRequirements[0].consecutiveBlocksPerWeek = 3;
      s.teachers[0].periodPattern = "alternate_period";
      s.teachers[0].maxPeriodsPerWeek = 40;
      return s;
    }],
    ["LAB_SUBJECT_UNSERVED", () => {
      const s = cleanSchool();
      s.labSubjectIds = [302];
      s.labRoomsBySubject = { 302: [] };
      s.rooms = s.rooms.map((r) => (r.id === 901 ? { ...r, subjectIds: [999] } : r));
      return s;
    }],
    ["ELECTIVE_TEACHER_CLASH", () => {
      const s = schoolWithElective();
      s.electiveBlocks[0].options[1].teacherId = 201;
      s.electiveBlocks[0].options[1].teacherName = "Mme Dubois";
      return s;
    }],
    ["ELECTIVE_ROOM_CLASH", () => {
      const s = schoolWithElective();
      s.electiveBlocks[0].options[1].roomId = 801;
      s.electiveBlocks[0].options[1].roomName = "Lang 1";
      return s;
    }],
  ];

  for (const [code, build] of cases) {
    it(`${code} is gone after its own remedy is applied`, () => {
      expect(roundTrip(build(), code).gone).toBe(true);
    });
  }

  it("and the score never falls as a result", () => {
    for (const [, build] of cases) {
      const snap = build();
      const before = runFeasibility(snap);
      const issue = [...before.blockers, ...before.warnings].find((i) => i.remedy);
      if (!issue) continue;
      const after = runFeasibility(applyToSnapshot(snap, issue.remedy!.changes));
      expect(after.score, `${issue.code} made things worse`).toBeGreaterThanOrEqual(before.score);
    }
  });
});

describe("§21 issue keys", () => {
  it("every issue gets one, and duplicates are distinguished", () => {
    const snap = cleanSchool();
    snap.teachers[0].eligibleClassIds = [9];
    const issues = allIssues(snap);
    expect(issues.every((i) => typeof i.key === "string" && i.key.length > 0)).toBe(true);
    expect(new Set(issues.map((i) => i.key)).size).toBe(issues.length);
  });

  it("is stable across two runs of the same snapshot", () => {
    const a = allIssues(cleanSchool()).map((i) => i.key);
    const b = allIssues(cleanSchool()).map((i) => i.key);
    expect(a).toEqual(b);
  });
});

describe("§21 nothing is proposed for a clean school", () => {
  it("cleanSchool has no issues, so no remedies", () => {
    expect(allIssues(cleanSchool()).filter((i) => i.remedy)).toEqual([]);
  });

  it("a teacher fixture with no eligibility does not become a remedy for the wrong class", () => {
    const snap = cleanSchool();
    snap.teachers.push(teacher(199, "Spare", { eligibleClassIds: [] }));
    // A spare teacher teaches nothing, so TEACHER_SCOPE_UNSET must not name them.
    expect(find(snap, "TEACHER_SCOPE_UNSET")).toBeUndefined();
  });
});

describe("§21 relax remedies (14.2) — each shows a real cost", () => {
  it("DAILY_PIGEONHOLE raises the teacher's day to what their load forces", () => {
    const snap = cleanSchool();
    snap.teachers[0].maxPeriodsPerDay = 1; // 12 periods over 5 days needs 3
    const { before } = roundTrip(snap, "DAILY_PIGEONHOLE");
    expect(before.remedy!.kind).toBe("relax");
    expect(before.remedy!.changes).toEqual([
      { op: "set", entity: "teacher", id: 101, field: "maxPeriodsPerDay", from: 1, to: 3 },
    ]);
    expect(before.remedy!.summary).toContain("from 1 to 3");
  });

  it("DAILY_PIGEONHOLE offers nothing when the pattern, not the number, is the limit", () => {
    const snap = cleanSchool();
    // Alternate-period in a 6-period day means 3 a day at most, however high
    // the cap goes — so raising it would fix nothing and is not offered.
    snap.teachers[0].periodPattern = "alternate_period";
    snap.teachers[0].maxPeriodsPerDay = 1;
    for (const m of snap.mappings) if (m.teacherId === 101) m.periodsPerWeek = 10;
    snap.subjectRequirements[0].periodsPerWeek = 10;
    const issue = find(snap, "DAILY_PIGEONHOLE");
    if (issue) expect(issue.remedy).toBeUndefined();
  });

  it("MIN_DAY_IMPOSSIBLE finds the largest minimum the load can actually keep", () => {
    const snap = cleanSchool();
    // One section of English, 5 periods a week, at most 3 in a day. With a
    // minimum of 3 the week cannot be cut up at all: 5 needs two days, and two
    // days of 3 is 6. A minimum of 2 works — 3 + 2 — and that is what the
    // search has to find, not "one less than 3".
    snap.subjectRequirements[0].periodsPerWeek = 5;
    snap.subjectRequirements[0].maxPeriodsPerDay = 3;
    snap.mappings = snap.mappings.filter((m) => !(m.subjectId === 300 && m.classSectionId === 12));
    snap.mappings.find((m) => m.subjectId === 300)!.periodsPerWeek = 5;
    snap.teachers[0].minPeriodsPerDay = 3;

    const { before, gone } = roundTrip(snap, "MIN_DAY_IMPOSSIBLE");
    expect(before.remedy!.kind).toBe("relax");
    expect(before.remedy!.changes).toEqual([
      { op: "set", entity: "teacher", id: 101, field: "minPeriodsPerDay", from: 3, to: 2 },
    ]);
    expect(gone).toBe(true);
  });

  it("MIN_DAY_RELAXED lowers every named teacher to what their load allows", () => {
    const snap = schoolWithElective();
    for (const t of snap.teachers) if (t.id >= 201) t.minPeriodsPerDay = 3;
    const { before } = roundTrip(snap, "MIN_DAY_RELAXED");
    expect(before.remedy!.kind).toBe("relax");
    expect(before.remedy!.changes).toHaveLength(3); // the three language teachers
    for (const c of before.remedy!.changes) {
      expect(c).toMatchObject({ op: "set", entity: "teacher", field: "minPeriodsPerDay", from: 3, to: 1 });
    }
  });

  it("SAME_PERIOD_IMPOSSIBLE drops the rule, never the periods", () => {
    const snap = cleanSchool();
    snap.subjectRequirements[0].samePeriodAcrossWeek = true; // 6 periods, 5 days
    const { before, gone } = roundTrip(snap, "SAME_PERIOD_IMPOSSIBLE");
    expect(before.remedy!.changes).toEqual([
      { op: "set", entity: "classSubject", id: 200, field: "samePeriodAcrossWeek", from: true, to: false },
    ]);
    // The children still get their six English periods.
    expect(before.remedy!.changes.some((c) => c.op === "set" && c.field === "periodsPerWeek")).toBe(false);
    expect(gone).toBe(true);
  });

  it("CT_P1_DEADLOCK changes the scheduling rule, not who looks after a class", () => {
    const snap = cleanSchool();
    snap.classSections[1].classTeacherId = 101;
    snap.teachers[0].classTeacherPeriodRule = "always_first_period";
    const { before, gone } = roundTrip(snap, "CT_P1_DEADLOCK");
    expect(before.remedy!.changes).toEqual([
      { op: "set", entity: "teacher", id: 101, field: "classTeacherPeriodRule", from: "always_first_period", to: "random" },
    ]);
    expect(before.remedy!.changes.some((c) => c.op === "set" && c.field === "classTeacherId")).toBe(false);
    expect(gone).toBe(true);
  });

  it("OVER_MAPPED trims back to the curriculum, never to zero periods", () => {
    const snap = cleanSchool();
    snap.mappings.find((m) => m.classSectionId === 11 && m.subjectId === 300)!.periodsPerWeek = 9;
    const { before, gone } = roundTrip(snap, "OVER_MAPPED");
    expect(before.remedy!.changes).toEqual([
      { op: "set", entity: "mapping", id: 400, field: "periodsPerWeek", from: 9, to: 6 },
    ]);
    expect(gone).toBe(true);
  });

  it("OVER_MAPPED offers nothing when trimming would empty a mapping", () => {
    const snap = cleanSchool();
    // One mapping of 6 against a curriculum of 0 — reducing it to nothing is a
    // row saying a teacher teaches a class they do not, so it is left alone.
    snap.subjectRequirements[0].periodsPerWeek = 0;
    const issue = find(snap, "OVER_MAPPED");
    if (issue) expect(issue.remedy).toBeUndefined();
  });

  it("BLOCK_MATH_INVALID fits the blocks to the periods, not the other way round", () => {
    const snap = cleanSchool();
    snap.subjectRequirements[0].consecutiveBlockSize = 2;
    snap.subjectRequirements[0].consecutiveBlocksPerWeek = 5; // 10 > 6 periods
    const { before, gone } = roundTrip(snap, "BLOCK_MATH_INVALID");
    expect(before.remedy!.changes).toEqual([
      { op: "set", entity: "classSubject", id: 200, field: "consecutiveBlocksPerWeek", from: 5, to: 3 },
    ]);
    expect(gone).toBe(true);
  });

  it("BLOCK_EXCEEDS_DAILY_MAX makes room for the block it was given", () => {
    const snap = cleanSchool();
    snap.subjectRequirements[0].consecutiveBlockSize = 3; // max/day is 2
    snap.subjectRequirements[0].consecutiveBlocksPerWeek = 2;
    const { before, gone } = roundTrip(snap, "BLOCK_EXCEEDS_DAILY_MAX");
    expect(before.remedy!.changes).toEqual([
      { op: "set", entity: "classSubject", id: 200, field: "maxPeriodsPerDay", from: 2, to: 3 },
    ]);
    expect(gone).toBe(true);
  });

  it("BLOCK_FRAGMENTED shortens the block and never moves a break", () => {
    const snap = cleanSchool(); // daySegments [3,3]
    snap.subjectRequirements[0].consecutiveBlockSize = 4;
    snap.subjectRequirements[0].consecutiveBlocksPerWeek = 1;
    snap.subjectRequirements[0].maxPeriodsPerDay = 4;
    const { before, gone } = roundTrip(snap, "BLOCK_FRAGMENTED");
    expect(before.remedy!.changes).toEqual([
      { op: "set", entity: "classSubject", id: 200, field: "consecutiveBlockSize", from: 4, to: 3 },
    ]);
    expect(before.remedy!.summary).toContain("longest run the day has");
    expect(gone).toBe(true);
  });

  it("DAILY_DISTRIBUTION allows the periods/day the week arithmetic forces", () => {
    const snap = cleanSchool();
    snap.subjectRequirements[0].periodsPerWeek = 6;
    snap.subjectRequirements[0].maxPeriodsPerDay = 1; // 6 periods, 5 days
    for (const m of snap.mappings) if (m.subjectId === 300) m.periodsPerWeek = 6;
    const { before, gone } = roundTrip(snap, "DAILY_DISTRIBUTION");
    expect(before.remedy!.changes).toEqual([
      { op: "set", entity: "classSubject", id: 200, field: "maxPeriodsPerDay", from: 1, to: 2 },
    ]);
    expect(gone).toBe(true);
  });

  it("ELECTIVE_DAILY_PIGEONHOLE raises the block's day and says what it costs a student", () => {
    const snap = schoolWithElective();
    snap.electiveBlocks[0].periodsPerWeek = 8;
    snap.electiveBlocks[0].maxPeriodsPerDay = 1; // 8 > 5 days
    const { before } = roundTrip(snap, "ELECTIVE_DAILY_PIGEONHOLE");
    expect(before.remedy!.changes).toEqual([
      { op: "set", entity: "electiveBlock", id: 7, field: "maxPeriodsPerDay", from: 1, to: 2 },
    ]);
    expect(before.remedy!.summary).toContain("students may get 2 in one day");
  });

  it("every relax remedy is labelled `relax` — nothing loosens under another name", () => {
    const builders: Array<() => FeasibilitySnapshot> = [
      () => { const s = cleanSchool(); s.teachers[0].maxPeriodsPerDay = 1; return s; },
      () => { const s = cleanSchool(); s.subjectRequirements[0].samePeriodAcrossWeek = true; return s; },
      () => { const s = cleanSchool(); s.classSections[1].classTeacherId = 101; s.teachers[0].classTeacherPeriodRule = "always_first_period"; return s; },
      () => { const s = cleanSchool(); s.mappings[0].periodsPerWeek = 9; return s; },
    ];
    const loosening = new Set([
      "DAILY_PIGEONHOLE", "DAILY_DISTRIBUTION", "BLOCK_EXCEEDS_DAILY_MAX", "BLOCK_MATH_INVALID",
      "BLOCK_FRAGMENTED", "MIN_DAY_IMPOSSIBLE", "MIN_DAY_RELAXED", "ELECTIVE_DAILY_PIGEONHOLE",
      "SAME_PERIOD_IMPOSSIBLE", "CT_P1_DEADLOCK", "OVER_MAPPED",
    ]);
    for (const build of builders) {
      for (const i of allIssues(build())) {
        if (!i.remedy) continue;
        if (loosening.has(i.code)) expect(i.remedy.kind, `${i.code}`).toBe("relax");
        else expect(i.remedy.kind, `${i.code}`).not.toBe("relax");
      }
    }
  });
});
