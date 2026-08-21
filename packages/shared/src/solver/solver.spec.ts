import { describe, expect, it } from "vitest";
import { runFeasibility } from "../feasibility/engine";
import { cleanSchool, teacher } from "../feasibility/fixtures";
import type { FeasibilitySnapshot } from "../feasibility/types";
import { solveTimetable } from "./engine";
import type { Placement, SolverInput, SolverResult } from "./types";

function inputFor(snapshot: FeasibilitySnapshot, over: Partial<SolverInput> = {}): SolverInput {
  return {
    snapshot,
    teacherUnavailability: [],
    labRoomIds: [901],
    preferredRoomByMapping: {},
    mergedGroupRooms: {},
    lockedSlots: [],
    seed: 42,
    ...over,
  };
}

/** Independent re-verification of every §5.1 invariant on the result — the
 *  solver must never be trusted to grade its own homework. */
function assertValid(input: SolverInput, result: SolverResult) {
  const sectionCells = new Set<string>();
  const teacherCells = new Set<string>();
  const roomCells = new Set<string>();
  const subjDay = new Map<string, number>();
  const teacherDay = new Map<string, number>();
  const samePeriod = new Map<string, number>();
  const teacherByIdx = new Map(input.snapshot.teachers.map((t) => [t.id, t]));

  for (const p of result.placements) {
    for (let s = 0; s < p.span; s++) {
      const cell = `${p.day}:${p.period + s}`;
      for (const cs of p.classSectionIds) {
        const k = `${cs}@${cell}`;
        expect(sectionCells.has(k), `section double-booked at ${k}`).toBe(false);
        sectionCells.add(k);
      }
      const tk = `${p.teacherId}@${cell}`;
      expect(teacherCells.has(tk), `teacher double-booked at ${tk}`).toBe(false);
      teacherCells.add(tk);
      if (p.roomId !== null) {
        const rk = `${p.roomId}@${cell}`;
        expect(roomCells.has(rk), `room double-booked at ${rk}`).toBe(false);
        roomCells.add(rk);
      }
    }
    for (const cs of p.classSectionIds) {
      const k = `${cs}:${p.subjectId}@${p.day}`;
      subjDay.set(k, (subjDay.get(k) ?? 0) + p.span);
    }
    const tdk = `${p.teacherId}@${p.day}`;
    teacherDay.set(tdk, (teacherDay.get(tdk) ?? 0) + p.span);
  }

  for (const [k, n] of teacherDay) {
    const tid = Number(k.split("@")[0]);
    const t = teacherByIdx.get(tid)!;
    expect(n, `teacher ${t.name} daily max on ${k}`).toBeLessThanOrEqual(t.maxPeriodsPerDay);
  }
  const reqBy = new Map(
    input.snapshot.subjectRequirements.map((r) => [`${r.classId}:${r.subjectId}`, r]),
  );
  const sectionById = new Map(input.snapshot.classSections.map((c) => [c.id, c]));
  for (const [k, n] of subjDay) {
    const [cs, rest] = k.split(":");
    const subjectId = Number(rest.split("@")[0]);
    const classId = sectionById.get(Number(cs))!.classId;
    const req = reqBy.get(`${classId}:${subjectId}`);
    if (req) expect(n, `subject max/day at ${k}`).toBeLessThanOrEqual(req.maxPeriodsPerDay);
  }

  // alternate-period teachers: no adjacent cells
  for (const p of result.placements) {
    const t = teacherByIdx.get(p.teacherId)!;
    if (t.periodPattern === "alternate_period") {
      expect(teacherCells.has(`${p.teacherId}@${p.day}:${p.period - 1}`)).toBe(false);
      expect(teacherCells.has(`${p.teacherId}@${p.day}:${p.period + p.span}`)).toBe(false);
    }
  }
  // same-period rule
  for (const p of result.placements) {
    const cs = sectionById.get(p.classSectionIds[0])!;
    const req = reqBy.get(`${cs.classId}:${p.subjectId}`);
    if (req?.samePeriodAcrossWeek) {
      const key = `${p.classSectionIds[0]}:${p.subjectId}`;
      const fixed = samePeriod.get(key);
      if (fixed !== undefined) expect(p.period).toBe(fixed);
      else samePeriod.set(key, p.period);
    }
  }
}

describe("CSP Solver (§5, tasks 2.2-2.6, 2.10)", () => {
  it("solves the clean school to 100% with zero constraint violations", () => {
    const input = inputFor(cleanSchool());
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    expect(result.placements.reduce((s, p) => s + p.span * 1, 0)).toBe(60); // 30 per section × 2
    assertValid(input, result);
  });

  it("is deterministic for a given seed", () => {
    const a = solveTimetable(inputFor(cleanSchool(), { seed: 7 }));
    const b = solveTimetable(inputFor(cleanSchool(), { seed: 7 }));
    const key = (p: Placement) => `${p.variableId}@${p.day}:${p.period}:${p.roomId}`;
    expect(a.placements.map(key).sort()).toEqual(b.placements.map(key).sort());
  });

  it("alternate-period teacher gets no adjacent periods (§4.7 hard)", () => {
    const snap = cleanSchool();
    snap.teachers[0] = teacher(101, "T.English", { periodPattern: "alternate_period", maxPeriodsPerWeek: 15 });
    // 12/week demand fits the 15 alt-period capacity
    const input = inputFor(snap);
    expect(runFeasibility(snap).ready).toBe(true);
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    assertValid(input, result);
  });

  it("consecutive blocks land contiguously inside one break segment (§4.8)", () => {
    const snap = cleanSchool(); // daySegments [3,3]
    snap.subjectRequirements[0].consecutiveBlockSize = 2;
    snap.subjectRequirements[0].consecutiveBlocksPerWeek = 3;
    const input = inputFor(snap);
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    const blocks = result.placements.filter((p) => p.span === 2 && p.subjectId === 300);
    expect(blocks.length).toBe(6); // 3 blocks × 2 sections
    for (const b of blocks) {
      const segOf = (p: number) => (p <= 3 ? 0 : 1);
      expect(segOf(b.period)).toBe(segOf(b.period + 1));
    }
    assertValid(input, result);
  });

  it("merged group occupies the same slot in every member section, teacher once (§4.9)", () => {
    const snap = cleanSchool();
    snap.mappings = snap.mappings.filter((m) => m.subjectId !== 302);
    snap.mergedGroups = [
      { id: 700, teacherId: 103, subjectId: 302, subjectName: "Science", periodsPerWeek: 6, memberClassSectionIds: [11, 12] },
    ];
    const input = inputFor(snap);
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    const merged = result.placements.filter((p) => p.mergedGroupId === 700);
    expect(merged.length).toBe(6);
    for (const m of merged) expect(m.classSectionIds).toEqual([11, 12]);
    assertValid(input, result);
  });

  it("same-period-across-week keeps every occurrence on one period (§4.6)", () => {
    const snap = cleanSchool();
    snap.subjectRequirements[1].samePeriodAcrossWeek = true;
    snap.subjectRequirements[1].periodsPerWeek = 5;
    snap.mappings.filter((m) => m.subjectId === 301).forEach((m) => (m.periodsPerWeek = 5));
    // fill the freed slot: Art 6→7
    snap.subjectRequirements[4].periodsPerWeek = 7;
    snap.subjectRequirements[4].maxPeriodsPerDay = 2;
    snap.mappings.filter((m) => m.subjectId === 304).forEach((m) => (m.periodsPerWeek = 7));
    const input = inputFor(snap);
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    const maths = result.placements.filter((p) => p.subjectId === 301 && p.classSectionIds[0] === 11);
    expect(new Set(maths.map((p) => p.period)).size).toBe(1);
    assertValid(input, result);
  });

  it("lab subject always gets a lab room; two lab sections never share it (§4.5)", () => {
    const snap = cleanSchool();
    snap.labSubjectIds = [302]; // Science ×6/wk ×2 sections
    const input = inputFor(snap, { labRoomIds: [901] });
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    for (const p of result.placements.filter((x) => x.subjectId === 302)) {
      expect(p.roomId).toBe(901);
    }
    assertValid(input, result);
  });

  it("locked slots are honored: the pinned cell is never reassigned (§7.4)", () => {
    const snap = cleanSchool();
    const input = inputFor(snap, {
      lockedSlots: [{ classSectionId: 11, dayOfWeek: 1, periodNumber: 1, subjectId: 300, teacherId: 101, roomId: null }],
    });
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    // one English occurrence consumed by the lock → only 5 solver placements for it
    const eng = result.placements.filter((p) => p.subjectId === 300 && p.classSectionIds[0] === 11);
    expect(eng.length).toBe(5);
    for (const p of result.placements) {
      const cells = Array.from({ length: p.span }, (_, s) => `${p.day}:${p.period + s}`);
      if (p.classSectionIds.includes(11)) expect(cells).not.toContain("1:1");
      if (p.teacherId === 101) expect(cells).not.toContain("1:1");
    }
    assertValid(input, result);
  });

  it("class teacher with always_first_period never appears at P1 of other sections (§4.7)", () => {
    const snap = cleanSchool();
    snap.teachers[0] = teacher(101, "R. Sharma", { classTeacherPeriodRule: "always_first_period" });
    snap.classSections[0].classTeacherId = 101; // CT of 5-A only
    const input = inputFor(snap);
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    for (const p of result.placements.filter((x) => x.teacherId === 101)) {
      if (!p.classSectionIds.includes(11)) expect(p.period).not.toBe(1);
    }
    assertValid(input, result);
  });

  it("PROPERTY (task 2.10): any fixture passing feasibility solves to 100%", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const snap = cleanSchool();
      // seeded variations: shuffle periods/week while keeping the 30-slot total
      const shifts = [0, 1, -1, 2, -2][seed % 5];
      snap.subjectRequirements[0].periodsPerWeek = 6 + shifts;
      snap.subjectRequirements[1].periodsPerWeek = 6 - shifts;
      snap.mappings.filter((m) => m.subjectId === 300).forEach((m) => (m.periodsPerWeek = 6 + shifts));
      snap.mappings.filter((m) => m.subjectId === 301).forEach((m) => (m.periodsPerWeek = 6 - shifts));
      if (seed % 3 === 0) snap.teachers[2] = teacher(103, "T.Science", { periodPattern: "alternate_period" });
      const feas = runFeasibility(snap);
      if (!feas.ready) continue; // property only claims: feasible ⇒ solvable
      const input = inputFor(snap, { seed });
      const result = solveTimetable(input);
      expect(result.unplaced, `seed ${seed} left ${result.unplaced.length} unplaced`).toEqual([]);
      assertValid(input, result);
    }
  });

  it("BENCHMARK (task 2.10): 50 sections × 40 slots solves fully within 30s", () => {
    const classes = 10, sectionsPerClass = 5, perDay = 8, subjectsN = 8;
    const snap: FeasibilitySnapshot = {
      config: { id: 1, name: "Big School", workingDays: [1, 2, 3, 4, 5], periodsPerDay: perDay, daySegments: [4, 4] },
      classSections: [], subjectRequirements: [], teachers: [], mappings: [],
      mergedGroups: [], crossConfigTeacherLoad: {}, labRoomCount: 0, labSubjectIds: [],
    };
    let csId = 1, mapId = 1, tId = 1;
    for (let c = 1; c <= classes; c++) {
      for (let sj = 0; sj < subjectsN; sj++) {
        snap.subjectRequirements.push({
          id: c * 100 + sj, classId: c, subjectId: 1000 + sj, subjectName: `Subj${sj}`,
          periodsPerWeek: 5, maxPeriodsPerDay: 1, samePeriodAcrossWeek: false,
          consecutiveBlockSize: 1, consecutiveBlocksPerWeek: null,
        });
      }
      const classTeachers: number[] = [];
      for (let sj = 0; sj < subjectsN; sj++) {
        snap.teachers.push(teacher(tId, `T${tId}`, { maxPeriodsPerWeek: 25, maxPeriodsPerDay: 6 }));
        classTeachers.push(tId++);
      }
      for (let s = 0; s < sectionsPerClass; s++) {
        const id = csId++;
        snap.classSections.push({ id, label: `${c}-${s}`, classId: c, classTeacherId: classTeachers[0] });
        for (let sj = 0; sj < subjectsN; sj++) {
          snap.mappings.push({
            id: mapId++, teacherId: classTeachers[sj], teacherName: `T${classTeachers[sj]}`,
            subjectId: 1000 + sj, subjectName: `Subj${sj}`, classSectionId: id,
            classSectionLabel: `${c}-${s}`, periodsPerWeek: 5,
          });
        }
      }
    }
    expect(runFeasibility(snap).ready).toBe(true);
    expect(snap.classSections.length).toBe(50);
    const started = Date.now();
    const result = solveTimetable(inputFor(snap), { budgetMs: 30_000 });
    const ms = Date.now() - started;
    expect(result.totalVariables).toBe(2000);
    expect(result.unplaced).toEqual([]);
    expect(ms, `solved in ${ms}ms`).toBeLessThan(30_000);
    assertValid(inputFor(snap), result);
  }, 40_000);
});
