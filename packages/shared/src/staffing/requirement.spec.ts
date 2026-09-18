/**
 * §37 — the five ways this arithmetic can be wrong, each of them quietly.
 *
 * Every case below produces a plausible number when it is wrong, which is why
 * it is here rather than left to a screen: nobody notices "hire 4" instead of
 * "hire 3" by looking at it.
 */
import { describe, expect, it } from "vitest";
import {
  allocateSpare, analyseRequirement, buildDemand, type RequirementSnapshot,
} from "./requirement";

const base = (over: Partial<RequirementSnapshot> = {}): RequirementSnapshot => ({
  workingDays: 5,
  periodsPerDay: 8,
  subjects: [{ id: 1, name: "Maths" }, { id: 2, name: "French" }, { id: 3, name: "German" }],
  classNames: { 10: "Class 5" },
  sectionsPerClass: { 10: 3 },
  sectionIds: [100, 101, 102],
  curriculum: [{ classId: 10, subjectId: 1, periodsPerWeek: 6 }],
  mappings: [],
  mergedGroups: [],
  electives: [],
  declaredSubjects: [],
  teachers: [],
  narrowedTo: null,
  ...over,
});

describe("buildDemand", () => {
  it("multiplies a class's periods by its SECTIONS, not by one", () => {
    // The single most damaging mistake available: `periods_per_week` is a class
    // fact (§27), so reading the column as the answer reports a third of the
    // truth on a three-section class.
    const d = buildDemand(base());
    expect(d.get(1)?.total).toBe(18);
    expect(d.get(1)?.lines[0]).toMatchObject({ kind: "curriculum", per: 6, sections: 3, periods: 18 });
  });

  it("ignores a class this timetable does not teach — and prints no line for it", () => {
    const d = buildDemand(base({
      curriculum: [
        { classId: 10, subjectId: 1, periodsPerWeek: 6 },
        { classId: 99, subjectId: 1, periodsPerWeek: 6 },
      ],
    }));
    expect(d.get(1)?.total).toBe(18);
    expect(d.get(1)?.lines).toHaveLength(1);
  });

  it("subtracts a merged group: one teacher, three sections, ONE lesson (§4.10)", () => {
    const d = buildDemand(base({
      mergedGroups: [{ subjectId: 1, memberSectionIds: [100, 101, 102], periodsPerWeek: 6 }],
    }));
    // 18 for the children, 6 for the teacher.
    expect(d.get(1)?.total).toBe(6);
    expect(d.get(1)?.lines.at(-1)).toMatchObject({ kind: "merged", periods: -12 });
  });

  it("does not treat a group of one as a group", () => {
    const d = buildDemand(base({
      mergedGroups: [{ subjectId: 1, memberSectionIds: [100], periodsPerWeek: 6 }],
    }));
    expect(d.get(1)?.total).toBe(18);
    expect(d.get(1)?.lines.some((l) => l.kind === "merged")).toBe(false);
  });

  it("adds an elective option's periods, which belong to no class-section (§4.9)", () => {
    const d = buildDemand(base({
      electives: [{ name: "Third Language", periodsPerWeek: 5, optionSubjectIds: [2, 3] }],
    }));
    // Both options run at once inside the block, and both need a teacher.
    expect(d.get(2)?.total).toBe(5);
    expect(d.get(3)?.total).toBe(5);
  });

  it("an empty §32 selection means EVERY subject, never none", () => {
    // Invariant 7 read backwards would report a fully staffed school as needing
    // its whole faculty replaced.
    expect(buildDemand(base({ narrowedTo: null })).get(1)?.total).toBe(18);
    expect(buildDemand(base({ narrowedTo: [2] })).get(1)).toBeUndefined();
  });
});

describe("allocateSpare", () => {
  it("spends a shared teacher's free periods ONCE, not once per subject", () => {
    /*
      The whole reason this is a flow. One teacher with 10 free periods,
      qualified for two subjects each 10 short: a per-subject sum reports 20
      covered and no hire needed; the truth is 10 covered and 10 short.
    */
    const covered = allocateSpare(
      [{ gap: 10, qualified: [1] }, { gap: 10, qualified: [1] }],
      [{ id: 1, spare: 10 }],
    );
    expect(covered.reduce((a, b) => a + b, 0)).toBe(10);
  });

  it("finds the assignment a greedy pass would miss", () => {
    /*
      Greedy takes the first subject first and spends the generalist on it,
      leaving the specialist-only subject uncovered. A max-flow gives the
      generalist to the subject the specialist cannot reach.
    */
    const covered = allocateSpare(
      [{ gap: 5, qualified: [1, 2] }, { gap: 5, qualified: [2] }],
      [{ id: 1, spare: 5 }, { id: 2, spare: 5 }],
    );
    expect(covered).toEqual([5, 5]);
  });

  it("covers nothing when nobody is qualified", () => {
    expect(allocateSpare([{ gap: 40, qualified: [] }], [{ id: 1, spare: 99 }])).toEqual([0]);
  });

  it("never covers more than the gap, however much spare there is", () => {
    expect(allocateSpare([{ gap: 3, qualified: [1] }], [{ id: 1, spare: 500 }])).toEqual([3]);
  });

  it("treats a teacher already over their cap as having nothing to give", () => {
    expect(allocateSpare([{ gap: 8, qualified: [1] }], [{ id: 1, spare: -12 }])).toEqual([0]);
  });
});

describe("analyseRequirement", () => {
  it("reports the shortfall and turns it into teachers at the stated load", () => {
    const r = analyseRequirement(base({
      teachers: [{ id: 1, name: "A", cap: 30, load: 30 }],
      declaredSubjects: [{ teacherId: 1, subjectId: 1 }],
    }), 30);
    const maths = r.subjects.find((s) => s.name === "Maths");
    expect(maths).toMatchObject({ demand: 18, assigned: 0, gap: 18, covered: 0, short: 18 });
    expect(r.totals.teachersNeeded).toBeCloseTo(0.6);
  });

  it("counts a teacher as qualified when they are MAPPED, not only when declared", () => {
    // §27.13 arrived late; a school that predates it declares nothing at all,
    // and reading declarations alone would report every one of them as having
    // no qualified staff for anything.
    const r = analyseRequirement(base({
      teachers: [{ id: 1, name: "A", cap: 30, load: 6 }],
      mappings: [{ teacherId: 1, subjectId: 1, classSectionId: 100, periodsPerWeek: 6 }],
    }), 30);
    const maths = r.subjects[0];
    expect(maths.qualified).toEqual([1]);
    expect(maths.assigned).toBe(6);
    expect(maths.gap).toBe(12);
    expect(maths.covered).toBe(12);   // 24 spare, and only this subject to spend it on
    expect(maths.short).toBe(0);
  });

  it("counts assigned only within THIS timetable's sections", () => {
    const r = analyseRequirement(base({
      teachers: [{ id: 1, name: "A", cap: 30, load: 12 }],
      mappings: [
        { teacherId: 1, subjectId: 1, classSectionId: 100, periodsPerWeek: 6 },
        // another wing's section — real teaching, but not this week's demand
        { teacherId: 1, subjectId: 1, classSectionId: 900, periodsPerWeek: 6 },
      ],
    }), 30);
    expect(r.subjects[0].assigned).toBe(6);
  });

  it("REPORTS over-assignment rather than netting it off against a shortage", () => {
    /*
      600 bad mapping rows must not read as a comfortably staffed school. The
      surplus is a fault to fix, and it is kept out of `assigned` in the totals
      so coverage cannot be flattered by it.
    */
    const r = analyseRequirement(base({
      teachers: [{ id: 1, name: "A", cap: 40, load: 30 }],
      mappings: [{ teacherId: 1, subjectId: 1, classSectionId: 100, periodsPerWeek: 30 }],
    }), 30);
    expect(r.subjects[0]).toMatchObject({ demand: 18, assigned: 30, over: 12, gap: 0, short: 0 });
    expect(r.totals.assigned).toBe(18);
    expect(r.totals.over).toBe(12);
  });

  it("names a subject nobody can teach as fully short, not as coverable", () => {
    const r = analyseRequirement(base({
      curriculum: [{ classId: 10, subjectId: 2, periodsPerWeek: 4 }],
      teachers: [{ id: 1, name: "A", cap: 30, load: 0 }],
      declaredSubjects: [{ teacherId: 1, subjectId: 1 }],
    }), 30);
    const french = r.subjects.find((s) => s.name === "French");
    expect(french).toMatchObject({ demand: 12, qualified: [], covered: 0, short: 12 });
    // …and the 30 free periods are still reported, because "spare exists" and
    // "spare is reachable" are different facts and the report says both.
    expect(r.totals.spare).toBe(30);
  });

  it("orders worst-first, which is the order somebody acts in", () => {
    const r = analyseRequirement(base({
      curriculum: [
        { classId: 10, subjectId: 1, periodsPerWeek: 2 },
        { classId: 10, subjectId: 2, periodsPerWeek: 9 },
      ],
      teachers: [],
    }), 30);
    expect(r.subjects.map((s) => s.name)).toEqual(["French", "Maths"]);
  });

  it("a target of zero is a caller that passed nothing, not infinite need", () => {
    const r = analyseRequirement(base({ teachers: [] }), 0);
    expect(r.totals.teachersNeeded).toBe(0);
  });

  it("drops a subject with no demand rather than printing a zero row", () => {
    const r = analyseRequirement(base({ teachers: [] }), 30);
    expect(r.subjects.map((s) => s.name)).toEqual(["Maths"]);
  });
});
