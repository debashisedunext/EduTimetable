import { describe, expect, it } from "vitest";
import { cleanSchool } from "../feasibility/fixtures";
import { solveTimetable } from "../solver/engine";
import type { Placement, SolverInput, SolverVariable } from "../solver/types";
import { buildVariables, buildTeacherCtx } from "../solver/variables";
import { DEFAULT_WEIGHTS, describeImprovement, scoreTimetable } from "./objective";
import { buildCpSatModel, verifyAssignment } from "./model";

function inputFor(over: Partial<SolverInput> = {}): SolverInput {
  return {
    snapshot: cleanSchool(),
    teacherUnavailability: [],
    labRoomIds: [901, 902],
    preferredRoomByMapping: {},
    mergedGroupRooms: {},
    lockedSlots: [],
    seed: 7,
    ...over,
  };
}

const placement = (over: Partial<Placement> & Pick<Placement, "variableId" | "teacherId" | "day" | "period">): Placement => ({
  classSectionIds: [11],
  subjectId: 300,
  mergedGroupId: null,
  electiveBlockId: null,
  options: [],
  span: 1,
  roomId: null,
  ...over,
});

const fakeVar = (id: number, over: Partial<SolverVariable> = {}): SolverVariable => ({
  id,
  classSectionIds: [11],
  classSectionLabels: ["5-A"],
  subjectId: 300,
  subjectName: "English",
  teacherId: 101,
  mergedGroupId: null,
  electiveBlockId: null,
  options: [],
  dayKey: "S300",
  mappingId: null,
  span: 1,
  needsLabRoom: false,
  preferredRoomId: null,
  samePeriodKey: null,
  maxPerDay: 2,
  domain: [],
  ...over,
});

describe("scoreTimetable — teacher gaps (§5.6)", () => {
  it("counts free periods sandwiched between teaching periods", () => {
    const input = inputFor();
    // P1, P3, P6 on Monday → gaps at P2, P4, P5 = 3
    const placements = [
      placement({ variableId: 1, teacherId: 101, day: 1, period: 1 }),
      placement({ variableId: 2, teacherId: 101, day: 1, period: 3 }),
      placement({ variableId: 3, teacherId: 101, day: 1, period: 6 }),
    ];
    const vars = [fakeVar(1), fakeVar(2), fakeVar(3)];
    const score = scoreTimetable(input, placements, vars);
    expect(score.teacherGaps).toBe(3);
    expect(score.worstTeachers[0]).toEqual({ teacherId: 101, gaps: 3 });
  });

  it("a contiguous block has no gaps, and trailing free periods are not gaps", () => {
    const input = inputFor();
    const placements = [
      placement({ variableId: 1, teacherId: 101, day: 1, period: 1 }),
      placement({ variableId: 2, teacherId: 101, day: 1, period: 2 }),
      placement({ variableId: 3, teacherId: 101, day: 1, period: 3 }),
    ];
    const score = scoreTimetable(input, placements, [fakeVar(1), fakeVar(2), fakeVar(3)]);
    expect(score.teacherGaps).toBe(0);
  });

  it("counts each day separately", () => {
    const input = inputFor();
    const placements = [
      placement({ variableId: 1, teacherId: 101, day: 1, period: 1 }),
      placement({ variableId: 2, teacherId: 101, day: 1, period: 3 }),
      placement({ variableId: 3, teacherId: 101, day: 2, period: 2 }),
      placement({ variableId: 4, teacherId: 101, day: 2, period: 5 }),
    ];
    const score = scoreTimetable(input, placements, [1, 2, 3, 4].map((i) => fakeVar(i)));
    expect(score.teacherGaps).toBe(1 + 2);
  });

  it("a multi-period block occupies every cell it spans", () => {
    const input = inputFor();
    const placements = [
      placement({ variableId: 1, teacherId: 101, day: 1, period: 1, span: 2 }),
      placement({ variableId: 2, teacherId: 101, day: 1, period: 4 }),
    ];
    // P1,P2 busy, P3 gap, P4 busy → exactly 1
    const score = scoreTimetable(input, placements, [fakeVar(1, { span: 2 }), fakeVar(2)]);
    expect(score.teacherGaps).toBe(1);
  });
});

describe("scoreTimetable — peak daily load and room changes", () => {
  it("peak daily load sums each teacher's busiest day", () => {
    const input = inputFor();
    const placements = [
      placement({ variableId: 1, teacherId: 101, day: 1, period: 1 }),
      placement({ variableId: 2, teacherId: 101, day: 1, period: 2 }),
      placement({ variableId: 3, teacherId: 101, day: 2, period: 1 }),
      placement({ variableId: 4, teacherId: 102, day: 1, period: 3 }),
    ];
    const score = scoreTimetable(input, placements, [1, 2, 3, 4].map((i) => fakeVar(i)));
    expect(score.peakDailyLoad).toBe(2 + 1); // 101 peaks at 2, 102 at 1
  });

  it("counts lab↔classroom switches, so clustered labs score better", () => {
    const input = inputFor();
    const labVar = (id: number) => fakeVar(id, { needsLabRoom: true, subjectId: 302 });
    // scattered: lab at P1 and P4 → switches at 1/2, 3/4, 4/5 = 4
    const scattered = scoreTimetable(
      input,
      [
        placement({ variableId: 1, teacherId: 101, day: 1, period: 1, subjectId: 302 }),
        placement({ variableId: 2, teacherId: 102, day: 1, period: 4, subjectId: 302 }),
      ],
      [labVar(1), labVar(2)],
    );
    // clustered: labs at P1,P2 → single switch at 2/3
    const clustered = scoreTimetable(
      input,
      [
        placement({ variableId: 1, teacherId: 101, day: 1, period: 1, subjectId: 302 }),
        placement({ variableId: 2, teacherId: 102, day: 1, period: 2, subjectId: 302 }),
      ],
      [labVar(1), labVar(2)],
    );
    expect(clustered.roomChanges).toBeLessThan(scattered.roomChanges);
    expect(clustered.roomChanges).toBe(1);
  });

  it("weights combine into the total the optimizer minimizes", () => {
    const input = inputFor();
    const placements = [
      placement({ variableId: 1, teacherId: 101, day: 1, period: 1 }),
      placement({ variableId: 2, teacherId: 101, day: 1, period: 3 }),
    ];
    const vars = [fakeVar(1), fakeVar(2)];
    const score = scoreTimetable(input, placements, vars, { teacherGaps: 10, dailyLoadBalance: 1, roomChanges: 0 });
    // 1 gap × 10 + peak 2 × 1 + 0 = 12
    expect(score.weighted).toBe(12);
  });
});

describe("describeImprovement", () => {
  it("reports only the metrics that moved", () => {
    const base = { teacherGaps: 10, peakDailyLoad: 20, roomChanges: 4, weighted: 0, worstTeachers: [] };
    const better = { ...base, teacherGaps: 6, weighted: 0 };
    expect(describeImprovement(base, better)).toBe("teacher gaps 10 → 6 (−4)");
    expect(describeImprovement(base, base)).toBe("no measurable change");
  });
});

describe("CP-SAT model translation + parity gate (tasks 6.1/6.3)", () => {
  const input = inputFor();
  const variables = buildVariables(input, buildTeacherCtx(input));

  it("exports every variable with a non-empty pruned domain", () => {
    const model = buildCpSatModel(input, variables, DEFAULT_WEIGHTS, 10);
    expect(model.variables).toHaveLength(variables.length);
    expect(model.variables.every((v) => v.domain.length > 0)).toBe(true);
    expect(model.periodsPerDay).toBe(6);
    expect(model.workingDays).toEqual([1, 2, 3, 4, 5]);
  });

  it("carries the daily caps and same-period keys the hard rules need", () => {
    const model = buildCpSatModel(input, variables, DEFAULT_WEIGHTS, 10);
    expect(Object.keys(model.teacherDayCap).length).toBeGreaterThan(0);
    expect(Object.values(model.teacherDayCap).every((c) => c > 0)).toBe(true);
    expect(Object.keys(model.subjectDayCap).length).toBeGreaterThan(0);
  });

  it("accepts a valid assignment and assigns rooms like the fast engine", () => {
    const solved = solveTimetable(input, { budgetMs: 10_000 });
    expect(solved.unplaced).toHaveLength(0);
    const assignments = solved.placements.map((p) => ({
      variableId: p.variableId,
      day: p.day,
      period: p.period,
    }));
    const verified = verifyAssignment(input, variables, assignments);
    expect(verified.ok).toBe(true);
    expect(verified.placements).toHaveLength(solved.placements.length);
  });

  it("REJECTS an assignment that double-books a teacher", () => {
    const solved = solveTimetable(input, { budgetMs: 10_000 });
    const assignments = solved.placements.map((p) => ({ variableId: p.variableId, day: p.day, period: p.period }));
    // force two occurrences of the same teacher into one cell
    const victim = variables.find((v) => v.teacherId === variables[0].teacherId && v.id !== variables[0].id)!;
    const first = assignments.find((a) => a.variableId === variables[0].id)!;
    const bad = assignments.map((a) =>
      a.variableId === victim.id ? { ...a, day: first.day, period: first.period } : a,
    );
    const verified = verifyAssignment(input, variables, bad);
    expect(verified.ok).toBe(false);
    expect(verified.reason).toMatch(/occupied/);
  });

  it("REJECTS an assignment that leaves a variable's legal domain", () => {
    const solved = solveTimetable(input, { budgetMs: 10_000 });
    const assignments = solved.placements.map((p) => ({ variableId: p.variableId, day: p.day, period: p.period }));
    const bad = assignments.map((a, i) => (i === 0 ? { ...a, period: 99 } : a));
    const verified = verifyAssignment(input, variables, bad);
    expect(verified.ok).toBe(false);
    expect(verified.reason).toMatch(/outside its legal domain/);
  });

  it("REJECTS a duplicate assignment for one variable", () => {
    const solved = solveTimetable(input, { budgetMs: 10_000 });
    const assignments = solved.placements.map((p) => ({ variableId: p.variableId, day: p.day, period: p.period }));
    const verified = verifyAssignment(input, variables, [...assignments, assignments[0]]);
    expect(verified.ok).toBe(false);
    expect(verified.reason).toMatch(/assigned twice/);
  });
});
