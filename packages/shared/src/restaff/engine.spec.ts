/**
 * §29.3 — who can take a class whose teacher has gone.
 *
 * The tests worth having are the ones that separate this engine from a
 * substitute lookup. A substitute covers one lesson on one day; this hands over
 * a teacher's week permanently, so the things it must get right are the ones
 * that only show up across a whole week:
 *
 *  - a candidate must be free at EVERY cell of a unit, not most of them;
 *  - two units given to the same teacher must be scored against each other,
 *    not each against the empty week;
 *  - a refusal must say what it was, because the screen has to explain a
 *    vacancy nobody can fill.
 */
import { describe, expect, it } from "vitest";
import { cleanSchool } from "../feasibility/fixtures";
import { planRedistribute, planReplace, type RestaffInput, type RestaffUnit } from "./engine";
import type { FeasibilitySnapshot } from "../feasibility/types";

/** Class 5-A Maths: 4 periods, Mon-Thu P1. Teacher 102 currently has it. */
const maths = (over: Partial<RestaffUnit> = {}): RestaffUnit => ({
  type: "mapping",
  id: 1,
  label: "5-A · Maths",
  fromTeacherId: 102,
  subjectId: 301,
  classIds: [5],
  classSectionIds: [11],
  periodsPerWeek: 4,
  cells: [1, 2, 3, 4].map((d) => ({ dayOfWeek: d, periodNumber: 2, classSectionId: 11 })),
  ...over,
});

function input(over: Partial<RestaffInput> = {}): RestaffInput {
  const snapshot: FeasibilitySnapshot = cleanSchool();
  return {
    snapshot,
    teacherUnavailability: [],
    units: [maths()],
    occupancy: [],
    candidateTeacherIds: [101, 103, 104, 105],
    subjectsByTeacher: {},
    sectionsByTeacher: {},
    classesByTeacher: {},
    ...over,
  };
}

const chosen = (plan: ReturnType<typeof planReplace>) => plan.assignments[0].toTeacherId;
const why = (plan: ReturnType<typeof planReplace>) => plan.assignments[0].candidates[0]?.reasons ?? [];

describe("§29.3 replace — one named teacher takes everything", () => {
  it("accepts a teacher who is free at every cell", () => {
    const plan = planReplace(input(), 101);
    expect(chosen(plan)).toBe(101);
    expect(plan.covered).toBe(1);
    expect(plan.uncovered).toBe(0);
  });

  it("refuses one who is busy at even a single cell, and names it", () => {
    // Free Mon-Wed, teaching on Thursday. Three of four is still a refusal:
    // this is a permanent handover, not a day's cover.
    const plan = planReplace(
      input({ occupancy: [{ teacherId: 101, dayOfWeek: 4, periodNumber: 2 }] }),
      101,
    );
    expect(chosen(plan)).toBeNull();
    expect(why(plan).join(" ")).toMatch(/already teaching at Thu P2/);
  });

  it("refuses on §4.7a unavailability, in the teacher's own words", () => {
    const plan = planReplace(
      input({ teacherUnavailability: [{ teacherId: 101, dayOfWeek: 3, periodNumber: null }] }),
      101,
    );
    expect(chosen(plan)).toBeNull();
    // A whole-day row is expanded by `buildTeacherCtx`, so the cell it names is
    // the one the unit actually wanted rather than "Wednesday".
    expect(why(plan).join(" ")).toMatch(/not available at Wed P2/);
  });

  it("refuses a §18 guest, whatever else fits", () => {
    const snap = cleanSchool();
    snap.teachers.find((t) => t.id === 101)!.employmentType = "guest";
    const plan = planReplace(input({ snapshot: snap }), 101);
    expect(chosen(plan)).toBeNull();
    expect(why(plan).join(" ")).toMatch(/guest teacher/);
  });

  it("refuses a class outside their §18 teaching scope, and treats empty as not stated", () => {
    const narrow = cleanSchool();
    narrow.teachers.find((t) => t.id === 101)!.eligibleClassIds = [9];
    expect(chosen(planReplace(input({ snapshot: narrow }), 101))).toBeNull();

    const unstated = cleanSchool();
    unstated.teachers.find((t) => t.id === 101)!.eligibleClassIds = [];
    expect(chosen(planReplace(input({ snapshot: unstated }), 101))).toBe(101);
  });

  it("refuses a subject they do not teach — and again, empty is not stated (§27.13)", () => {
    expect(chosen(planReplace(input({ subjectsByTeacher: { 101: [399] } }), 101))).toBeNull();
    expect(chosen(planReplace(input({ subjectsByTeacher: { 101: [301] } }), 101))).toBe(101);
    expect(chosen(planReplace(input({ subjectsByTeacher: { 101: [] } }), 101))).toBe(101);
  });

  it("refuses when the weekly cap would break, counting other timetables too (§3.10)", () => {
    const snap = cleanSchool();
    snap.teachers.find((t) => t.id === 101)!.maxPeriodsPerWeek = 10;
    // 8 already elsewhere + 4 here is 12, over 10 — and the message has to say
    // where the other 8 are, or the number looks wrong on this screen.
    snap.crossConfigTeacherLoad[101] = { periods: 8, otherConfigNames: ["Senior Wing"] };
    const plan = planReplace(input({ snapshot: snap }), 101);
    expect(chosen(plan)).toBeNull();
    expect(why(plan).join(" ")).toMatch(/in another timetable/);
  });

  it("refuses when the daily cap would break", () => {
    const snap = cleanSchool();
    snap.teachers.find((t) => t.id === 101)!.maxPeriodsPerDay = 2;
    const busyMonday = [1, 3].map((p) => ({ teacherId: 101, dayOfWeek: 1, periodNumber: p }));
    const plan = planReplace(input({ snapshot: snap, occupancy: busyMonday }), 101);
    expect(chosen(plan)).toBeNull();
    expect(why(plan).join(" ")).toMatch(/over their daily maximum/);
  });

  it("refuses when the back-to-back run would break (§15.3)", () => {
    const snap = cleanSchool();
    snap.teachers.find((t) => t.id === 101)!.maxConsecutivePeriodsPerDay = 2;
    // P1 and P3 already; the unit wants P2, which joins them into a run of 3.
    const plan = planReplace(
      input({
        snapshot: snap,
        occupancy: [1, 3].map((p) => ({ teacherId: 101, dayOfWeek: 1, periodNumber: p })),
      }),
      101,
    );
    expect(chosen(plan)).toBeNull();
    expect(why(plan).join(" ")).toMatch(/back to back/);
  });

  it("honours alternate_period as a HARD rule, not a preference (invariant 2)", () => {
    const snap = cleanSchool();
    snap.teachers.find((t) => t.id === 101)!.periodPattern = "alternate_period";
    const plan = planReplace(
      input({ snapshot: snap, occupancy: [{ teacherId: 101, dayOfWeek: 1, periodNumber: 1 }] }),
      101,
    );
    expect(chosen(plan)).toBeNull();
    expect(why(plan).join(" ")).toMatch(/two periods in a row/);
  });

  it("honours alternate_day", () => {
    const snap = cleanSchool();
    const t = snap.teachers.find((x) => x.id === 101)!;
    t.periodPattern = "alternate_day";
    t.alternateDaySet = [1, 3, 5];
    const plan = planReplace(input({ snapshot: snap }), 101);
    // The unit runs Mon-Thu; Tuesday and Thursday are not this teacher's days.
    expect(chosen(plan)).toBeNull();
    expect(why(plan).join(" ")).toMatch(/not available at/);
  });

  it("will not give a P1-rule teacher somebody else's first period (invariant 2)", () => {
    const snap = cleanSchool();
    // 101 is not 5-A's class teacher in the fixture (102 owns 5-B, 101 owns 5-A)
    // — so the case to build is a P1 rule holder taking P1 of the OTHER section.
    snap.teachers.find((t) => t.id === 103)!.classTeacherPeriodRule = "always_first_period";
    const plan = planReplace(
      input({ snapshot: snap, units: [maths({ cells: [{ dayOfWeek: 1, periodNumber: 1, classSectionId: 11 }] })] }),
      103,
    );
    expect(chosen(plan)).toBeNull();
    expect(why(plan).join(" ")).toMatch(/period 1 with their own class/);
  });

  it("reports EVERY reason, not just the first", () => {
    const snap = cleanSchool();
    const t = snap.teachers.find((x) => x.id === 101)!;
    t.eligibleClassIds = [9];
    t.maxPeriodsPerWeek = 2;
    const plan = planReplace(input({ snapshot: snap }), 101);
    // The screen has to explain a vacancy nobody can fill, and "does not teach
    // that class" alone would send somebody to fix the wrong thing.
    expect(why(plan).length).toBeGreaterThan(1);
  });

  it("validates unit by unit — four of five fitting is the useful answer", () => {
    const units = [1, 2, 3, 4, 5].map((n) =>
      maths({ id: n, label: `5-A · Subject ${n}`, cells: [{ dayOfWeek: n, periodNumber: 2, classSectionId: 11 }] }));
    const plan = planReplace(
      input({ units, occupancy: [{ teacherId: 101, dayOfWeek: 3, periodNumber: 2 }] }),
      101,
    );
    expect(plan.covered).toBe(4);
    expect(plan.uncovered).toBe(1);
    expect(plan.assignments.find((a) => a.toTeacherId === null)!.unit.id).toBe(3);
  });

  it("a class-teacher role has no cells, so only eligibility decides it", () => {
    const role = maths({
      type: "class_teacher", id: 11, label: "5-A · class teacher",
      subjectId: null, periodsPerWeek: 0, cells: [],
    });
    expect(chosen(planReplace(input({ units: [role] }), 101))).toBe(101);

    const narrow = cleanSchool();
    narrow.teachers.find((t) => t.id === 101)!.eligibleClassIds = [9];
    expect(chosen(planReplace(input({ snapshot: narrow, units: [role] }), 101))).toBeNull();
  });
});

describe("§29.3 redistribute — several teachers absorb it between them", () => {
  it("prefers the teacher the class already has, by a wide margin", () => {
    /*
      101 has an empty week and wins on spare capacity; 103 already teaches this
      section. Continuity is worth more than every tie-break put together, and
      that is deliberate — the class keeping a face it knows is the outcome.

      103's busy day is FRIDAY, deliberately away from the unit's Mon-Thu cells:
      a clash would refuse them outright and the test would pass for the wrong
      reason.
    */
    const plan = planRedistribute(input({
      occupancy: [1, 2, 3, 4, 5, 6].map((p) => ({ teacherId: 103, dayOfWeek: 5, periodNumber: p })),
      sectionsByTeacher: { 103: [11] },
    }));
    expect(chosen(plan)).toBe(103);
  });

  it("counts what it has already given somebody when scoring the next unit", () => {
    /*
      The bug this exists to catch: three units that each fit a teacher alone,
      and together break their weekly cap. Scored independently, all three would
      go to the same person and the plan would be wrong in a way nothing else
      here would notice.
    */
    const snap = cleanSchool();
    // Two periods each, a cap of two, two candidates: exactly enough for two of
    // the three units and no arithmetic left over to hide a mistake in.
    for (const t of snap.teachers) t.maxPeriodsPerWeek = 2;
    const units = [1, 2, 3].map((n) =>
      maths({ id: n, label: `unit ${n}`, cells: [1, 2].map((d) => ({ dayOfWeek: d, periodNumber: n, classSectionId: 11 })) }));
    const plan = planRedistribute(input({ snapshot: snap, units, candidateTeacherIds: [101, 103] }));
    const perTeacher = new Map<number, number>();
    for (const a of plan.assignments) {
      if (a.toTeacherId === null) continue;
      perTeacher.set(a.toTeacherId, (perTeacher.get(a.toTeacherId) ?? 0) + 2);
    }
    for (const [, periods] of perTeacher) expect(periods).toBeLessThanOrEqual(2);
    expect(plan.covered).toBe(2);
    expect(plan.uncovered).toBe(1);
  });

  it("reports each receiver's load before and after", () => {
    const plan = planRedistribute(input({ occupancy: [{ teacherId: 101, dayOfWeek: 5, periodNumber: 1 }] }));
    const load = plan.loads.find((l) => l.teacherId === chosen(plan));
    expect(load).toBeDefined();
    expect(load!.after).toBe(load!.before + 4);
    expect(load!.cap).toBeGreaterThan(0);
  });

  it("settles the hardest unit first, so its only candidate is not spent elsewhere", () => {
    /*
      Two units and two teachers. The elective can only go to 101 (nobody else
      teaches its subject); the mapping suits either. A naive pass in list order
      gives the mapping to 101 — the best-scoring candidate — and then has
      nobody for the elective.
    */
    const easy = maths({ id: 1, label: "easy", subjectId: 301, cells: [{ dayOfWeek: 1, periodNumber: 2, classSectionId: 11 }] });
    const hard = maths({
      id: 2, type: "elective_option", label: "hard", subjectId: 302,
      cells: [{ dayOfWeek: 2, periodNumber: 2, classSectionId: null }],
    });
    const plan = planRedistribute(input({
      units: [easy, hard],
      candidateTeacherIds: [101, 103],
      subjectsByTeacher: { 101: [301, 302], 103: [301] },
    }));
    expect(plan.uncovered).toBe(0);
    expect(plan.assignments.find((a) => a.unit.id === 2)!.toTeacherId).toBe(101);
    expect(plan.assignments.find((a) => a.unit.id === 1)!.toTeacherId).toBe(103);
  });

  it("returns the assignments in the order the vacancy was listed, not the queue's", () => {
    const units = [1, 2, 3].map((n) =>
      maths({ id: n, label: `unit ${n}`, cells: [{ dayOfWeek: n, periodNumber: 2, classSectionId: 11 }] }));
    const plan = planRedistribute(input({ units }));
    expect(plan.assignments.map((a) => a.unit.id)).toEqual([1, 2, 3]);
  });

  it("rescues an uncovered unit by moving something it had already given away", () => {
    /*
      §29.3's depth-1 ejection pass, and a case it really does rescue — found by
      random search over small instances rather than reasoned out, because the
      hand-built ones were all already handled by hardest-first ordering.

      Three units, all wanting Wed P3. Three teachers:
        101 teaches all three subjects · 103 teaches S1 and S3 · 104 only S2.

      Every unit has exactly two legal candidates, so hardest-first cannot
      separate them and falls back to "most cells first" — which puts U2 first
      and hands it to 101. U1 then takes 103, and U3 has nobody: 101 and 103 are
      both standing in Wed P3.

      The pass takes U2 back off 101, sees that 104 can hold it, and gives Wed P3
      to U3. This is exactly the staleness the ordering cannot see: the count of
      legal candidates is a prediction made before anything was assigned.
    */
    const at = (d: number, p: number) => ({ dayOfWeek: d, periodNumber: p, classSectionId: 11 });
    const u1 = maths({ id: 1, label: "U1", subjectId: 301, cells: [at(3, 3)] });
    const u2 = maths({ id: 2, label: "U2", subjectId: 302, cells: [at(1, 2), at(3, 3)] });
    const u3 = maths({ id: 3, label: "U3", subjectId: 303, cells: [at(3, 3)] });

    const plan = planRedistribute(input({
      units: [u1, u2, u3],
      candidateTeacherIds: [101, 103, 104],
      subjectsByTeacher: { 101: [301, 302, 303], 103: [301, 303], 104: [302] },
    }));

    expect(plan.uncovered).toBe(0);
    expect(plan.ejections).toBe(1);
    expect(plan.assignments.find((a) => a.unit.id === 2)!.toTeacherId).toBe(104);
    expect(plan.assignments.find((a) => a.unit.id === 3)!.toTeacherId).toBe(101);
  });

  it("reports no rescue when the ordering already got it right", () => {
    // The counter has to mean something. Most plans need no pass at all — this
    // is what stops it quietly measuring something else.
    expect(planRedistribute(input()).ejections).toBe(0);
  });

  it("never rearranges the school's standing week to make room", () => {
    /*
      The load-bearing limit on the pass. 101 is already teaching Monday P3 —
      not from this plan, from the published timetable — and the only way to
      place this unit would be to move that lesson. It is left uncovered, which
      is the §29.0 promise: no other teacher's week moves.
    */
    const plan = planRedistribute(input({
      units: [maths({ cells: [{ dayOfWeek: 1, periodNumber: 3, classSectionId: 11 }] })],
      candidateTeacherIds: [101],
      occupancy: [{ teacherId: 101, dayOfWeek: 1, periodNumber: 3 }],
    }));
    expect(plan.uncovered).toBe(1);
    expect(plan.ejections).toBe(0);
  });

  it("refuses a rescue that would only move the vacancy somewhere else", () => {
    /*
      Both halves have to succeed. 101 could be freed by taking `flexible` off
      them — but nobody else can hold it, so accepting would swap one uncovered
      unit for another and report progress.
    */
    const flexible = maths({ id: 1, label: "flexible", subjectId: 301, cells: [{ dayOfWeek: 1, periodNumber: 3, classSectionId: 11 }] });
    const narrow = maths({ id: 2, label: "narrow", subjectId: 302, cells: [{ dayOfWeek: 1, periodNumber: 3, classSectionId: 11 }] });
    const plan = planRedistribute(input({
      units: [flexible, narrow],
      candidateTeacherIds: [101],
      subjectsByTeacher: { 101: [301, 302] },
    }));
    expect(plan.covered).toBe(1);
    expect(plan.uncovered).toBe(1);
    expect(plan.ejections).toBe(0);
  });

  it("flags a receiver who crosses the school's load-alert line (§28.1)", () => {
    const snap = cleanSchool();
    for (const t of snap.teachers) t.maxPeriodsPerWeek = 10;
    snap.config.loadAlertPct = 75;
    const plan = planRedistribute(input({
      snapshot: snap,
      // 4 already + the unit's 4 is 8 of 10, which is 80%.
      occupancy: [1, 2, 3, 4].map((d) => ({ teacherId: 101, dayOfWeek: d, periodNumber: 5 })),
      candidateTeacherIds: [101],
    }));
    const load = plan.loads[0];
    expect(load.after).toBe(8);
    // A warning, never a refusal — the same rule Check 12 follows.
    expect(load.alert).toBe(true);
    expect(plan.uncovered).toBe(0);
  });

  it("measures that line against the whole week, not this timetable's share (§3.10)", () => {
    const snap = cleanSchool();
    for (const t of snap.teachers) t.maxPeriodsPerWeek = 30;
    snap.config.loadAlertPct = 75;
    // 4 here after the assignment, 20 in another wing: 24 of 30 is 80%.
    snap.crossConfigTeacherLoad[101] = { periods: 20, otherConfigNames: ["Senior Wing"] };
    const plan = planRedistribute(input({ snapshot: snap, candidateTeacherIds: [101] }));
    expect(plan.loads[0].after).toBe(4);
    expect(plan.loads[0].alert).toBe(true);
  });

  it("PROPERTY: over 500 random schools, no plan ever contradicts itself", () => {
    /*
      The ejection pass moves work between teachers after the greedy pass has
      finished, which is exactly the kind of code that produces a plan nobody
      reads carefully and that turns out to double-book somebody. Constructed
      cases cannot cover that; a sweep can.

      Three invariants, checked on every plan:
        1. no teacher is given two units in the same cell;
        2. no teacher ends over their weekly cap;
        3. every uncovered unit has candidates, all failing, all with reasons —
           an unexplained vacancy is the one outcome §4's "tell me what to fix"
           promise cannot survive.

      Deterministic PRNG, so a failure is reproducible from the seed printed
      with it rather than being a Heisenbug in CI.
    */
    let seed = 20260910;
    const rnd = (n: number) => {
      // xorshift32 — small, seeded, and good enough to shuffle a fixture.
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return Math.abs(seed) % n;
    };
    const ids = [101, 103, 104];

    for (let trial = 0; trial < 500; trial++) {
      const snap = cleanSchool();
      for (const t of snap.teachers) {
        t.maxPeriodsPerWeek = 4 + rnd(6);
        t.maxPeriodsPerDay = 6;
      }
      const subjectsByTeacher: Record<number, number[]> = { 101: [], 103: [], 104: [] };
      const units: RestaffUnit[] = [];
      for (let i = 0; i < 2 + rnd(4); i++) {
        const subjectId = 400 + i;
        /*
          Distinct cells, because a real unit has them.

          A mapping's cells are one per published slot, and `unitsFor` already
          deduplicates a merged group's rows down to one occupancy event per
          period (§4.10). A generator that emitted the same cell twice would be
          testing a unit the app cannot produce — and would fail the
          double-booking check below on the unit's argument with itself.
        */
        const seen = new Set<string>();
        const cells: RestaffUnit["cells"] = [];
        for (let c = 0; c < 1 + rnd(3); c++) {
          const dayOfWeek = 1 + rnd(3);
          const periodNumber = 1 + rnd(3);
          if (seen.has(`${dayOfWeek}:${periodNumber}`)) continue;
          seen.add(`${dayOfWeek}:${periodNumber}`);
          cells.push({ dayOfWeek, periodNumber, classSectionId: 11 });
        }
        if (cells.length === 0) cells.push({ dayOfWeek: 1, periodNumber: 1, classSectionId: 11 });
        let any = false;
        for (const id of ids) if (rnd(2) === 0) { subjectsByTeacher[id].push(subjectId); any = true; }
        if (!any) subjectsByTeacher[ids[rnd(3)]].push(subjectId);
        units.push({
          type: "mapping", id: i + 1, label: `u${i}`, fromTeacherId: 102,
          subjectId, classIds: [5], classSectionIds: [11],
          periodsPerWeek: cells.length, cells,
        });
      }

      const plan = planRedistribute(input({ units, candidateTeacherIds: ids, subjectsByTeacher }));
      const held = new Map<number, Set<string>>();
      const load = new Map<number, number>();
      for (const a of plan.assignments) {
        if (a.toTeacherId === null) {
          expect(a.candidates.length, `trial ${trial}: uncovered with no candidates`).toBeGreaterThan(0);
          expect(a.candidates.every((c) => !c.ok && c.reasons.length > 0),
            `trial ${trial}: an uncovered unit with an unexplained candidate`).toBe(true);
          continue;
        }
        const cells = held.get(a.toTeacherId) ?? new Set<string>();
        for (const c of a.unit.cells) {
          const key = `${c.dayOfWeek}:${c.periodNumber}`;
          expect(cells.has(key), `trial ${trial}: teacher ${a.toTeacherId} double-booked at ${key}`).toBe(false);
          cells.add(key);
          load.set(a.toTeacherId, (load.get(a.toTeacherId) ?? 0) + 1);
        }
        held.set(a.toTeacherId, cells);
      }
      for (const [teacherId, periods] of load) {
        const cap = plan.loads.find((l) => l.teacherId === teacherId)?.cap ?? 0;
        expect(periods, `trial ${trial}: teacher ${teacherId} over cap`).toBeLessThanOrEqual(cap);
      }
    }
  });

  it("leaves a unit uncovered rather than breaking a rule to place it", () => {
    const snap = cleanSchool();
    for (const t of snap.teachers) t.eligibleClassIds = [9];
    const plan = planRedistribute(input({ snapshot: snap }));
    expect(plan.uncovered).toBe(1);
    expect(plan.assignments[0].candidates.every((c) => !c.ok)).toBe(true);
    // …and every candidate says why, which is what makes an uncovered class
    // actionable rather than mysterious.
    expect(plan.assignments[0].candidates.every((c) => c.reasons.length > 0)).toBe(true);
  });
});
