import { describe, expect, it } from "vitest";
import { runFeasibility } from "../feasibility/engine";
import { effectiveMinByTeacher, minDayPlan } from "../feasibility/min-day";
import { cleanSchool, schoolWithElective, teacher } from "../feasibility/fixtures";
import type { FeasibilitySnapshot } from "../feasibility/types";
import { solveTimetable } from "./engine";
import { SolverState } from "./state";
import { buildVariables } from "./variables";

/** Every teacher a variable occupies — one for a plain lesson, several for an elective. */
const teachersOfVar = (v: { teacherId?: number; options?: Array<{ teacherId: number }> }): number[] =>
  v.options?.length ? v.options.map((o) => o.teacherId) : v.teacherId !== undefined ? [v.teacherId] : [];
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
      // A §4.9 elective occupies every option's teacher and room at once, so
      // the check has to cover all of them — the interesting failure is
      // exactly the one where only the first option is verified.
      const teachers = p.options.length > 0 ? p.options.map((o) => o.teacherId) : [p.teacherId];
      for (const t of teachers) {
        const tk = `${t}@${cell}`;
        expect(teacherCells.has(tk), `teacher double-booked at ${tk}`).toBe(false);
        teacherCells.add(tk);
      }
      for (const r of [...p.options.map((o) => o.roomId), ...(p.roomId !== null ? [p.roomId] : [])]) {
        const rk = `${r}@${cell}`;
        expect(roomCells.has(rk), `room double-booked at ${rk}`).toBe(false);
        roomCells.add(rk);
      }
    }
    for (const cs of p.classSectionIds) {
      const k = `${cs}:${p.electiveBlockId !== null ? `B${p.electiveBlockId}` : p.subjectId}@${p.day}`;
      subjDay.set(k, (subjDay.get(k) ?? 0) + p.span);
    }
    for (const t of p.options.length > 0 ? p.options.map((o) => o.teacherId) : [p.teacherId]) {
      const tdk = `${t}@${p.day}`;
      teacherDay.set(tdk, (teacherDay.get(tdk) ?? 0) + p.span);
    }
  }

  const minByTeacher = effectiveMinByTeacher(input.snapshot);
  for (const [k, n] of teacherDay) {
    const tid = Number(k.split("@")[0]);
    const t = teacherByIdx.get(tid)!;
    expect(n, `teacher ${t.name} daily max on ${k}`).toBeLessThanOrEqual(t.maxPeriodsPerDay);
    // §20: a day is free or it is a proper day. `n` only exists for days that
    // got something, so every entry here has to clear the minimum. A no-op for
    // fixtures that leave the minimum at 1, which is most of them.
    expect(n, `teacher ${t.name} daily minimum on ${k}`).toBeGreaterThanOrEqual(minByTeacher.get(tid) ?? 1);
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

  // alternate-period teachers: no adjacent cells (every option's teacher, §4.9)
  for (const p of result.placements) {
    for (const tid of p.options.length > 0 ? p.options.map((o) => o.teacherId) : [p.teacherId]) {
      const t = tid === null ? undefined : teacherByIdx.get(tid);
      if (t?.periodPattern === "alternate_period") {
        expect(teacherCells.has(`${tid}@${p.day}:${p.period - 1}`)).toBe(false);
        expect(teacherCells.has(`${tid}@${p.day}:${p.period + p.span}`)).toBe(false);
      }
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

  it("never gives a teacher a longer back-to-back run than they allow (§15.3)", () => {
    // The check that makes `max_consecutive_periods_per_day` a rule rather than
    // a stored preference. Without enforcement this column reads as a promise
    // the solver quietly breaks.
    const snap = cleanSchool();
    for (const t of snap.teachers) t.maxConsecutivePeriodsPerDay = 2;
    const input = inputFor(snap);
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    assertValid(input, result);

    // Re-derived from the RESULT, not read back off the solver's own state.
    const byTeacherDay = new Map<string, number[]>();
    for (const p of result.placements) {
      for (let s = 0; s < p.span; s++) {
        const k = `${p.teacherId}@${p.day}`;
        byTeacherDay.set(k, [...(byTeacherDay.get(k) ?? []), p.period + s]);
      }
    }
    for (const [k, periods] of byTeacherDay) {
      const sorted = [...periods].sort((a, b) => a - b);
      let run = 1;
      for (let i = 1; i < sorted.length; i++) {
        run = sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
        expect(run, `${k} ran ${run} periods back to back`).toBeLessThanOrEqual(2);
      }
    }
  });

  it("joining two runs is counted as one run, not as two neighbours (§15.3)", () => {
    // The subtle half. Checking only the cells either side of a placement calls
    // P1,P2 _ P4,P5 + P3 legal — it sees one neighbour on each side. It is a
    // run of five, and that is what a teacher would actually teach.
    const snap = cleanSchool();
    for (const t of snap.teachers) t.maxConsecutivePeriodsPerDay = 4;
    const input = inputFor(snap);
    const state = new SolverState(input);
    const vars = buildVariables(input, state.teacherCtx);

    // Four occurrences of one teacher's lessons, placed through the real API.
    const mine = vars.filter((v) => v.span === 1 && teachersOfVar(v).includes(101));
    expect(mine.length).toBeGreaterThanOrEqual(5);
    const at = [1, 2, 4, 5];
    at.forEach((period, i) => state.place(mine[i], 1, period, null));

    // P3 would join a run of 2 and a run of 2 into a run of 5.
    const res = state.check(mine[4], 1, 3);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("teacher consecutive limit");

    // ...while a cell that touches nothing is fine.
    expect(state.check(mine[4], 3, 1).ok).toBe(true);
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
    /*
      An explicit timeout, like the two other real generations in this file.

      This does ~3.2s of search when it runs alone and had only vitest's 5s
      default, so it failed intermittently inside the full suite — always with
      "Test timed out in 5000ms", never with a wrong placement. A test that
      fails for being on a busy machine teaches people to re-run the suite
      instead of reading it, which costs more than the minutes it saves.
    */
  }, 40_000);

  it("a block may cross the break when the row says so, and only then (§31.10)", () => {
    /*
      The proof this feature needs, and it has to be a PLACEMENT rather than a
      form: a real generation, and where the two periods actually landed.

      `cleanSchool` is [3,3] — a break between P3 and P4 — so a 2-period block
      that starts at P3 straddles it. With the flag off no block may do that,
      and with it on the domain merely GAINS that start; blocks that fit inside
      a run still land there, which is what makes turning it on safe.
    */
    const startsAtTheBreak = (blockMayCrossBreak: boolean) => {
      const snap = cleanSchool();
      snap.subjectRequirements[0].consecutiveBlockSize = 2;
      snap.subjectRequirements[0].consecutiveBlocksPerWeek = 3;
      snap.subjectRequirements[0].blockMayCrossBreak = blockMayCrossBreak;
      const input = inputFor(snap);
      const vars = buildVariables(input, new SolverState(input).teacherCtx);
      const block = vars.find((v) => v.span === 2 && v.subjectId === 300)!;
      return block.domain.filter((d) => d.period === 3).length;
    };

    // Off: P3 is not even in the domain — pruned before search, never scored
    // down (invariant 2), so the solver cannot consider it at all.
    expect(startsAtTheBreak(false)).toBe(0);
    // On: it is, once per working day.
    expect(startsAtTheBreak(true)).toBe(5);
  });

  it("a crossing block still places, and still places contiguously (§31.10)", () => {
    // Widening a domain must not break the search: every lesson still lands,
    // and a block is still two adjacent periods — crossing a break changes
    // which pairs are legal, never that a block is a pair.
    const snap = cleanSchool();
    snap.subjectRequirements[0].consecutiveBlockSize = 2;
    snap.subjectRequirements[0].consecutiveBlocksPerWeek = 3;
    snap.subjectRequirements[0].blockMayCrossBreak = true;
    const input = inputFor(snap);
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    const blocks = result.placements.filter((p) => p.span === 2 && p.subjectId === 300);
    expect(blocks.length).toBe(6);
    for (const b of blocks) expect(b.period + 1).toBeLessThanOrEqual(6);
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
      mergedGroups: [], electiveBlocks: [], crossConfigTeacherLoad: {}, labRoomCount: 0, labSubjectIds: [],
      homeRoomBySection: {}, labRoomsBySubject: {}, roomNames: {}, rooms: [],
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

describe("split electives (§4.9)", () => {
  it("places every option of a block in one shared slot, across every member section", () => {
    const snap = schoolWithElective();
    expect(runFeasibility(snap).ready, "fixture must be feasible before solving").toBe(true);

    const input = inputFor(snap);
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    assertValid(input, result);

    const blockPlacements = result.placements.filter((p) => p.electiveBlockId === 7);
    expect(blockPlacements).toHaveLength(2); // periodsPerWeek

    for (const p of blockPlacements) {
      // one slot, held open by BOTH member sections
      expect([...p.classSectionIds].sort()).toEqual([11, 12]);
      // all three languages run in it, each with its own teacher and room
      expect(p.options.map((o) => o.subjectName).sort()).toEqual(["French", "German", "Sanskrit"]);
      expect(new Set(p.options.map((o) => o.teacherId)).size).toBe(3);
      expect(new Set(p.options.map((o) => o.roomId)).size).toBe(3);
      // the member cell itself carries no subject or teacher — the lessons do
      expect(p.subjectId).toBeNull();
      expect(p.teacherId).toBeNull();
    }

    // maxPeriodsPerDay 1: the two occurrences cannot share a day
    expect(blockPlacements[0].day).not.toBe(blockPlacements[1].day);
  });

  it("keeps a language teacher's other lessons out of the block's slot", () => {
    const snap = schoolWithElective();
    // Mme Dubois also teaches 2 periods of Art to 5-A, so the solver has to
    // keep her free for the block: the failure this catches is the block being
    // placed on top of a teacher who is already busy in an ordinary lesson.
    snap.subjectRequirements.find((r) => r.subjectName === "Art")!.periodsPerWeek = 4;
    const artB = snap.mappings.find((m) => m.subjectName === "Art" && m.classSectionId === 12)!;
    artB.teacherId = 201;
    artB.teacherName = "Mme Dubois";

    const input = inputFor(snap);
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    assertValid(input, result);

    const blockCells = new Set(
      result.placements.filter((p) => p.electiveBlockId !== null).map((p) => `${p.day}:${p.period}`),
    );
    const dubois = result.placements.filter((p) => p.teacherId === 201);
    for (const p of dubois) {
      expect(blockCells.has(`${p.day}:${p.period}`), "Mme Dubois teaching Art during her own block").toBe(false);
    }
  });

  it("is never handed a block that cannot fit — Phase A refuses it first", () => {
    const snap = schoolWithElective();
    // Give 5-A back its full curriculum so it has no spare slot. The block needs
    // the same cell free in every member section, so this school is impossible —
    // and the contract (§1) is that the *feasibility engine* says so, rather
    // than the solver discovering it after burning its budget.
    snap.subjectRequirements.find((r) => r.subjectName === "Art")!.periodsPerWeek = 6;
    for (const m of snap.mappings) if (m.subjectName === "Art") m.periodsPerWeek = 6;

    const result = runFeasibility(snap);
    expect(result.ready).toBe(false);
    const overflow = result.blockers.filter((b) => b.code === "SLOT_OVERFLOW");
    expect(overflow.length).toBeGreaterThan(0);
    // and it names the real cause: the block's periods, on top of the curriculum
    expect(overflow[0].message).toMatch(/needs 32 periods\/week but only 30 slots exist/);
  });

});

/**
 * §4.9 Phase 15 — placement. Every assertion here is about a cell the solver
 * was NOT allowed to consider, which is why it is checked against the result
 * rather than against the variable list: pruning that quietly failed to prune
 * would still produce a plausible timetable.
 */
describe("split elective placement (§4.9, Phase 15)", () => {
  it("a fixed block lands on exactly the cells the school named", () => {
    const snap = schoolWithElective();
    const block = snap.electiveBlocks[0];
    block.placement = "fixed";
    block.fixedSlots = [
      { day: 2, period: 3 },
      { day: 4, period: 3 },
    ];
    expect(runFeasibility(snap).ready, "a well-formed pin must not make the school infeasible").toBe(true);

    const input = inputFor(snap);
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    assertValid(input, result);

    const placed = result.placements
      .filter((p) => p.electiveBlockId === 7)
      .map((p) => `${p.day}:${p.period}`)
      .sort();
    expect(placed).toEqual(["2:3", "4:3"]);
  });

  it("same_period holds every occurrence to one period number, on different days", () => {
    const snap = schoolWithElective();
    snap.electiveBlocks[0].placement = "same_period";
    expect(runFeasibility(snap).ready).toBe(true);

    const input = inputFor(snap);
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    assertValid(input, result);

    const block = result.placements.filter((p) => p.electiveBlockId === 7);
    expect(block).toHaveLength(2);
    expect(new Set(block.map((p) => p.period)).size, "one period number").toBe(1);
    expect(new Set(block.map((p) => p.day)).size, "different days").toBe(2);
  });

  it("a pin on a day an option teacher cannot work is refused by Phase A, not discovered by the solver", () => {
    const snap = schoolWithElective();
    const block = snap.electiveBlocks[0];
    block.placement = "fixed";
    block.fixedSlots = [
      { day: 2, period: 3 },
      { day: 4, period: 3 },
    ];
    // Hr. Bauer is out on Thursday. Every option runs at once, so the whole
    // block comes off Thursday with him.
    snap.teachers.find((t) => t.id === 203)!.unavailableFullDays = [4];

    const result = runFeasibility(snap);
    expect(result.ready).toBe(false);
    const issue = result.blockers.find((b) => b.code === "ELECTIVE_PIN_UNAVAILABLE");
    expect(issue?.message).toMatch(/Hr\. Bauer .* does not work Thu/);
    // §21: the remedy hands the block back to the solver — it never moves the
    // block to a day nobody chose, and never touches who teaches it.
    expect(issue?.remedy?.kind).toBe("relax");
    expect(issue?.remedy?.changes).toEqual([
      { op: "set", entity: "electiveBlock", id: 7, field: "placement", from: "fixed", to: "solver" },
    ]);
  });

  it("counts the pins: too few is a blocker naming how many are missing", () => {
    const snap = schoolWithElective();
    snap.electiveBlocks[0].placement = "fixed";
    snap.electiveBlocks[0].fixedSlots = [{ day: 2, period: 3 }];

    const issue = runFeasibility(snap).blockers.find((b) => b.code === "ELECTIVE_PIN_COUNT");
    expect(issue?.message).toMatch(/needs 2 periods\/week but 1 slot\(s\) have been fixed/);
    expect(issue?.fix).toMatch(/Choose 1 more slot/);
  });

  it("a cell outside the timetable is named, not silently dropped", () => {
    const snap = schoolWithElective();
    snap.electiveBlocks[0].placement = "fixed";
    snap.electiveBlocks[0].fixedSlots = [
      { day: 6, period: 3 }, // Saturday — not a working day here
      { day: 2, period: 99 }, // beyond the day
    ];

    const codes = runFeasibility(snap).blockers.filter((b) => b.code === "ELECTIVE_PIN_INVALID");
    expect(codes).toHaveLength(2);
    expect(codes[0].message).toMatch(/Sat period 3, which is not a teaching slot/);
  });

  it("two blocks pinned to one cell only clash when they actually share something", () => {
    const base = () => {
      const snap = schoolWithElective();
      const a = snap.electiveBlocks[0];
      a.placement = "fixed";
      a.fixedSlots = [
        { day: 2, period: 3 },
        { day: 4, period: 3 },
      ];
      return snap;
    };

    // A second block for the same sections, pinned to the same cell: 5-A
    // cannot be in two places, so this is a clash.
    const clashing = base();
    clashing.electiveBlocks.push({
      ...clashing.electiveBlocks[0],
      id: 8,
      name: "Class 5 Activity",
      fixedSlots: [{ day: 2, period: 3 }],
      periodsPerWeek: 1,
    });
    const clash = runFeasibility(clashing).blockers.find((b) => b.code === "ELECTIVE_PIN_CLASH");
    expect(clash?.message).toMatch(/5-A attends both/);

    // The same cell for a block sharing no section, teacher or room is fine —
    // two grades running their languages at once is normal, and a check that
    // flagged it would make pinning unusable.
    const fine = base();
    fine.electiveBlocks.push({
      ...fine.electiveBlocks[0],
      id: 9,
      name: "Class 6 Third Language",
      memberClassSectionIds: [],
      memberLabels: [],
      periodsPerWeek: 1,
      fixedSlots: [{ day: 2, period: 3 }],
      options: fine.electiveBlocks[0].options.map((o, i) => ({
        ...o,
        id: 900 + i,
        teacherId: 900 + i,
        roomId: 910 + i,
      })),
    });
    expect(runFeasibility(fine).blockers.some((b) => b.code === "ELECTIVE_PIN_CLASH")).toBe(false);
  });
});

describe("fixed rooms (§19)", () => {
  it("every ordinary lesson is placed in its own class-section's room", () => {
    const snap = cleanSchool();
    const input = inputFor(snap);
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    assertValid(input, result);

    // Before Phase 12 every one of these carried roomId null: the home room was
    // recorded and never used.
    const withoutRoom = result.placements.filter((p) => p.roomId === null);
    expect(withoutRoom).toEqual([]);
    for (const p of result.placements) {
      const expected = snap.homeRoomBySection[p.classSectionIds[0]];
      expect(p.roomId, `${p.classSectionIds[0]} should be in its own room`).toBe(expected);
    }
  });

  it("a lab subject goes to a lab that teaches it, never to another subject's", () => {
    const snap = cleanSchool();
    snap.labSubjectIds = [302]; // Science
    snap.labRoomsBySubject = { 302: [902] }; // only the science lab
    snap.roomNames = { ...snap.roomNames, 901: "Physics Lab", 902: "Science Lab" };
    // 901 is free all week and would have been chosen by the old findFreeLab.
    const input = inputFor(snap, { labRoomIds: [901, 902] });
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    assertValid(input, result);

    const science = result.placements.filter((p) => p.subjectId === 302);
    expect(science.length).toBeGreaterThan(0);
    expect(science.every((p) => p.roomId === 902), "science must not sit in the physics lab").toBe(true);
  });

  it("a section in the lab leaves its own room free rather than claiming both", () => {
    const snap = cleanSchool();
    snap.labSubjectIds = [302];
    snap.labRoomsBySubject = { 302: [902] };
    const input = inputFor(snap, { labRoomIds: [902] });
    const result = solveTimetable(input);
    assertValid(input, result);
    for (const p of result.placements.filter((x) => x.subjectId === 302)) {
      expect(p.roomId).toBe(902);
    }
  });

  /**
   * §19.1 — a subject taught in its own room, which is the ordinary middle case
   * §19 had no words for: Music happens in the Music Room, for everybody, and
   * it is not a lab.
   */
  it("a subject with its own room is taught THERE, not in the class's home room", () => {
    const snap = cleanSchool();
    snap.ownRoomSubjectIds = [302];
    snap.ownRoomsBySubject = { 302: [905] };
    snap.roomNames = { ...snap.roomNames, 905: "Music Room" };
    const input = inputFor(snap);
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    assertValid(input, result);

    const own = result.placements.filter((p) => p.subjectId === 302);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((p) => p.roomId === 905), "every lesson of it belongs in its room").toBe(true);
    // …and nothing else moved: every other lesson still sits at home.
    for (const p of result.placements.filter((x) => x.subjectId !== 302)) {
      expect(p.roomId).toBe(snap.homeRoomBySection[p.classSectionIds[0]]);
    }
  });

  it("never puts two sections in that room at once — one room, one lesson", () => {
    const snap = cleanSchool();
    snap.ownRoomSubjectIds = [302];
    snap.ownRoomsBySubject = { 302: [905] };
    const result = solveTimetable(inputFor(snap));
    const seen = new Set<string>();
    for (const p of result.placements.filter((x) => x.roomId === 905)) {
      const cell = `${p.day}:${p.period}`;
      expect(seen.has(cell), `two lessons in the music room at ${cell}`).toBe(false);
      seen.add(cell);
    }
  });

  /**
   * The half that keeps the flag safe: ticked with no room named is UNSTATED,
   * not "anywhere". Treating an empty pool as every room in the school would
   * scatter the subject through whichever classrooms happened to be free, which
   * is the opposite of what ticking the box asked for — and a school that has
   * half-said something must still generate.
   */
  it("falls back to the home room when the flag is set but no room is named", () => {
    const snap = cleanSchool();
    snap.ownRoomSubjectIds = [302];
    snap.ownRoomsBySubject = { 302: [] };
    const input = inputFor(snap);
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    assertValid(input, result);
    for (const p of result.placements) {
      expect(p.roomId).toBe(snap.homeRoomBySection[p.classSectionIds[0]]);
    }
  });

  it("prefers the subject's own room over the general lab pool when it is both", () => {
    // A school that ticks "own room" on a lab subject AND names the room is
    // being more specific, so the lab fallback must not widen it again.
    const snap = cleanSchool();
    snap.labSubjectIds = [302];
    snap.labRoomsBySubject = { 302: [901, 902] };
    snap.ownRoomSubjectIds = [302];
    snap.ownRoomsBySubject = { 302: [902] };
    const input = inputFor(snap, { labRoomIds: [901, 902] });
    const result = solveTimetable(input);
    assertValid(input, result);
    const own = result.placements.filter((p) => p.subjectId === 302);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((p) => p.roomId === 902)).toBe(true);
  });
});

describe("minimum periods per day (§20)", () => {
  /** Days each teacher actually works, from a finished result. */
  const daysWorkedBy = (result: SolverResult) => {
    const out = new Map<number, Map<number, number>>();
    for (const p of result.placements) {
      for (const t of p.options.length > 0 ? p.options.map((o) => o.teacherId) : [p.teacherId!]) {
        const days = out.get(t) ?? new Map<number, number>();
        days.set(p.day, (days.get(p.day) ?? 0) + p.span);
        out.set(t, days);
      }
    }
    return out;
  };

  it("no teacher gets a one- or two-period day when their minimum is 3 (§20)", () => {
    const snap = cleanSchool();
    // 12 periods each, cap 6/day, but two sections x max 2/day means at most 4
    // a day — so the week has to land as 3+3+3+3 or 4+4+4, never 3+3+2+2+2.
    for (const t of snap.teachers) t.minPeriodsPerDay = 3;
    const input = inputFor(snap);
    expect(runFeasibility(snap).ready).toBe(true);

    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    assertValid(input, result); // asserts the minimum on every teacher-day
    expect(result.stats.shortTeacherDays).toBe(0);

    for (const [teacherId, days] of daysWorkedBy(result)) {
      for (const [day, n] of days) {
        expect(n, `teacher ${teacherId} on day ${day}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("the same school without the rule is free to fragment — the rule is what fixes it", () => {
    // Guards against the test above passing for an unrelated reason: with the
    // minimum off, this fixture really does produce short days.
    const snap = cleanSchool();
    for (const t of snap.teachers) t.minPeriodsPerDay = 1;
    const result = solveTimetable(inputFor(snap));
    const short = [...daysWorkedBy(result).values()].flatMap((d) => [...d.values()]).filter((n) => n < 3);
    expect(short.length).toBeGreaterThan(0);
  });

  it("a light load is concentrated into whole days rather than spread thin (§20)", () => {
    const snap = cleanSchool();
    // Hand 5-B's Art to a second pair of hands: 6 periods, max 2/day, so the
    // only shapes that clear a minimum of 3 are 3+3 or 4+2... and 4 is over the
    // subject's own daily cap, leaving exactly two days of 3.
    const art = snap.mappings.find((m) => m.subjectName === "Art" && m.classSectionId === 12)!;
    snap.teachers.push(teacher(106, "T.Art2", { eligibleClassIds: [5], minPeriodsPerDay: 3 }));
    art.teacherId = 106;
    art.teacherName = "T.Art2";
    for (const t of snap.teachers) t.minPeriodsPerDay = 3;

    const input = inputFor(snap);
    expect(runFeasibility(snap).blockers).toEqual([]);
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    assertValid(input, result);
    expect(daysWorkedBy(result).get(106)!.size).toBe(3); // 6 periods, 2/day cap
  });

  it("a teacher whose subjects cap them at one period a day is left alone (§20)", () => {
    // The elective option teachers take 2 block periods a week, one a day at
    // most — so three-period days are arithmetically impossible and the rule
    // must relax rather than make the timetable unsolvable.
    const snap = schoolWithElective();
    for (const t of snap.teachers) if (t.id >= 201) t.minPeriodsPerDay = 3;
    const mins = effectiveMinByTeacher(snap);
    expect(mins.get(201)).toBe(1);

    const input = inputFor(snap);
    expect(runFeasibility(snap).blockers).toEqual([]);
    const result = solveTimetable(input);
    expect(result.unplaced).toEqual([]);
    assertValid(input, result);
  });

  it("a complete timetable beats a well-shaped one when both are not available (§20)", () => {
    // Every section 100% full, every subject capped at 2/day, AND every teacher
    // needing whole days is over-determined. The solver must not answer with a
    // timetable that is missing lessons — it drops the minimum and says so.
    const snap = schoolWithElective();
    for (const t of snap.teachers) t.minPeriodsPerDay = 3;
    const input = inputFor(snap);
    const result = solveTimetable(input, { budgetMs: 12_000 });
    expect(result.unplaced, "completeness comes first").toEqual([]);
    // The shape it could not reach is reported rather than silently dropped.
    expect(result.stats.shortTeacherDays).toBeGreaterThan(0);
  }, 40_000);

  it("minDayPlan: the arithmetic of whole days", () => {
    // 12 periods, min 3, cap 4 -> 3 or 4 days, both fine
    expect(minDayPlan(3, 12, 4, 5)).toMatchObject({ effectiveMin: 3, minDays: 3, maxDays: 4, feasible: true });
    // 2 periods in the whole week: one 2-period day, not two 1-period days
    expect(minDayPlan(3, 2, 6, 5)).toMatchObject({ effectiveMin: 2, relaxedBy: "weekly-load", feasible: true });
    // 5 periods with a cap of 3 cannot be cut into days of 3..3
    expect(minDayPlan(3, 5, 3, 5)).toMatchObject({ feasible: false });
    // and the load simply does not fit the days available
    expect(minDayPlan(3, 30, 4, 5)).toMatchObject({ feasible: false });
  });
});
