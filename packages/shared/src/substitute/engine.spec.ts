import { describe, expect, it } from "vitest";
import {
  planSubstitutes,
  type AffectedSlot,
  type SubstituteInput,
  type SubstituteTeacher,
} from "./engine";

const ENGLISH = 300;
const MATHS = 301;

const slot = (over: Partial<AffectedSlot> & Pick<AffectedSlot, "slotId" | "period">): AffectedSlot => ({
  classSectionId: 11,
  classSectionLabel: "5-A",
  subjectId: ENGLISH,
  subjectName: "English",
  absentTeacherId: 1,
  ...over,
});

const teacher = (id: number, name: string, over: Partial<SubstituteTeacher> = {}): SubstituteTeacher => ({
  id,
  name,
  maxPeriodsPerDay: 6,
  subjectIds: [ENGLISH],
  classSectionIds: [],
  classIds: [5],
  busyPeriods: [],
  unavailablePeriods: [],
  substitutionsToday: 0,
  ...over,
});

const inputFor = (
  affectedSlots: AffectedSlot[],
  teachers: SubstituteTeacher[],
  over: Partial<SubstituteInput> = {},
): SubstituteInput => ({
  dayOfWeek: 1,
  periodsPerDay: 6,
  absentTeacherIds: [1],
  affectedSlots,
  teachers,
  classIdBySection: { 11: 5, 12: 5, 21: 9 },
  ...over,
});

describe("eligibility (§6.1 step 2)", () => {
  it("excludes teachers busy at that period, unavailable, or over daily max", () => {
    const plan = planSubstitutes(
      inputFor(
        [slot({ slotId: "s1", period: 3 })],
        [
          teacher(2, "Busy", { busyPeriods: [3] }),
          teacher(3, "Unavail", { unavailablePeriods: [3] }),
          teacher(4, "Maxed", { busyPeriods: [1, 2, 4, 5, 6, 7].slice(0, 6), maxPeriodsPerDay: 6 }),
          teacher(5, "Free"),
        ],
      ),
    );
    expect(plan.slots[0].assigned).toBe(5);
    expect(plan.slots[0].candidates.map((c) => c.teacherId)).toEqual([5]);
  });

  it("excludes teachers with neither the subject nor the grade band", () => {
    const plan = planSubstitutes(
      inputFor(
        [slot({ slotId: "s1", period: 1 })],
        [
          teacher(2, "WrongEverything", { subjectIds: [MATHS], classIds: [9] }),
          teacher(3, "GradeBandOnly", { subjectIds: [MATHS], classIds: [5] }),
        ],
      ),
    );
    expect(plan.slots[0].candidates.map((c) => c.teacherId)).toEqual([3]);
  });

  it("an absent teacher is never a candidate — even for another absentee's slot", () => {
    // multi-teacher same-day absence (§4.6 edge): 1 and 2 both out
    const plan = planSubstitutes(
      inputFor(
        [
          slot({ slotId: "s1", period: 1, absentTeacherId: 1 }),
          slot({ slotId: "s2", period: 2, absentTeacherId: 2, classSectionId: 12, classSectionLabel: "5-B" }),
        ],
        [teacher(2, "AlsoAbsent"), teacher(3, "Present")],
        { absentTeacherIds: [1, 2] },
      ),
    );
    for (const s of plan.slots) {
      expect(s.candidates.every((c) => c.teacherId === 3)).toBe(true);
      expect(s.assigned).toBe(3);
    }
  });
});

describe("scoring (§6.1 step 3)", () => {
  it("prefers subject specialist > grade-band, and continuity adds +2", () => {
    const plan = planSubstitutes(
      inputFor(
        [slot({ slotId: "s1", period: 2 })],
        [
          teacher(2, "GradeBand", { subjectIds: [MATHS] }),
          teacher(3, "Specialist"),
          teacher(4, "SpecialistContinuity", { classSectionIds: [11] }),
        ],
      ),
    );
    expect(plan.slots[0].candidates.map((c) => c.teacherId)).toEqual([4, 3, 2]);
    const top = plan.slots[0].candidates[0];
    expect(top.score).toBe(5);
    expect(top.reasons.join(" ")).toContain("continuity");
  });

  it("adjacent own period earns +1", () => {
    const plan = planSubstitutes(
      inputFor(
        [slot({ slotId: "s1", period: 3 })],
        [teacher(2, "Adjacent", { busyPeriods: [2] }), teacher(3, "Elsewhere", { busyPeriods: [6] })],
      ),
    );
    expect(plan.slots[0].candidates[0].teacherId).toBe(2);
    expect(plan.slots[0].candidates[0].reasons.join(" ")).toContain("adjacent");
  });
});

describe("fairness (−1 after 2 covers) and load spread", () => {
  it("spreads a 4-period absence across substitutes instead of stacking one", () => {
    // two equal specialists — after A takes 2, the malus tips slots 3-4 to B
    const slots = [1, 2, 3, 4].map((p) => slot({ slotId: `s${p}`, period: p }));
    const plan = planSubstitutes(
      inputFor(slots, [teacher(2, "Alpha"), teacher(3, "Beta")]),
    );
    const byTeacher = new Map<number, number>();
    for (const s of plan.slots) byTeacher.set(s.assigned!, (byTeacher.get(s.assigned!) ?? 0) + 1);
    expect(plan.unmatchedCount).toBe(0);
    expect([...byTeacher.values()].sort()).toEqual([2, 2]); // 2 each, not 4-0
  });

  it("counts substitutions already confirmed today (other absences) in the malus", () => {
    const plan = planSubstitutes(
      inputFor(
        [slot({ slotId: "s1", period: 1 })],
        [teacher(2, "Loaded", { substitutionsToday: 2 }), teacher(3, "Fresh")],
      ),
    );
    expect(plan.slots[0].assigned).toBe(3);
    const loaded = plan.slots[0].candidates.find((c) => c.teacherId === 2)!;
    expect(loaded.reasons.join(" ")).toContain("2 substitution(s) today");
  });
});

describe("matching (§6.1 step 4) — coverage via augmenting", () => {
  it("ejects a greedy choice so both same-period slots get covered", () => {
    // Two absentees clash at P3: 5-A English and 9-A Maths. Flex covers both
    // grades; Rigid's §18 teaching scope is class 5 only, so 9-A is closed to
    // them however free they are. Greedy gives 5-A to Flex and strands 9-A —
    // the augmenting pass must swap.
    const plan = planSubstitutes(
      inputFor(
        [
          slot({ slotId: "s1", period: 3, absentTeacherId: 1 }),
          slot({ slotId: "s2", period: 3, absentTeacherId: 2, classSectionId: 21, classSectionLabel: "9-A", subjectId: MATHS, subjectName: "Maths" }),
        ],
        [
          teacher(4, "Flex", { subjectIds: [ENGLISH, MATHS], classIds: [5, 9] }),
          teacher(5, "Rigid", { subjectIds: [ENGLISH], classIds: [5] }), // scoped to primary
        ],
        { absentTeacherIds: [1, 2] },
      ),
    );
    expect(plan.unmatchedCount).toBe(0);
    const byId = new Map(plan.slots.map((s) => [s.slot.slotId, s.assigned]));
    expect(byId.get("s1")).toBe(5); // Rigid keeps English 5-A
    expect(byId.get("s2")).toBe(4); // Flex freed up for Maths 9-A
  });

  it("flags an uncoverable slot with the three §6.1 fallback options", () => {
    const plan = planSubstitutes(
      inputFor([slot({ slotId: "s1", period: 4 })], [teacher(2, "Busy", { busyPeriods: [4] })]),
    );
    expect(plan.unmatchedCount).toBe(1);
    expect(plan.slots[0].assigned).toBeNull();
    expect(plan.slots[0].fallback).toMatch(/merge.*duty teacher.*cancel/s);
  });

  it("never assigns one substitute two slots in the same period (two absentees)", () => {
    const plan = planSubstitutes(
      inputFor(
        [
          slot({ slotId: "s1", period: 3, absentTeacherId: 1 }),
          slot({ slotId: "s2", period: 3, absentTeacherId: 2, classSectionId: 12, classSectionLabel: "5-B" }),
        ],
        [teacher(3, "Only")],
        { absentTeacherIds: [1, 2] },
      ),
    );
    const assignedIds = plan.slots.map((s) => s.assigned);
    expect(assignedIds.filter((a) => a === 3)).toHaveLength(1);
    expect(plan.unmatchedCount).toBe(1);
  });
});

describe("absent teacher who is themselves a substitute today (§4.6 edge)", () => {
  it("their substitution duty appears as an affected slot and gets re-covered", () => {
    const plan = planSubstitutes(
      inputFor(
        [
          slot({ slotId: "s1", period: 1 }),
          slot({ slotId: "sub-duty", period: 5, viaSubstitution: true, classSectionId: 12, classSectionLabel: "5-B" }),
        ],
        [teacher(2, "Cover")],
      ),
    );
    expect(plan.unmatchedCount).toBe(0);
    expect(plan.slots.find((s) => s.slot.viaSubstitution)?.assigned).toBe(2);
  });
});

describe("§18 teaching scope and engagement", () => {
  it("a teacher outside their scope is not offered, however free they are", () => {
    const plan = planSubstitutes(
      inputFor(
        [slot({ slotId: "s1", period: 3, classSectionId: 21, classSectionLabel: "9-A" })],
        [teacher(4, "Primary Only", { subjectIds: [ENGLISH], classIds: [5] })],
      ),
    );
    expect(plan.slots[0].assigned).toBeNull();
    expect(plan.unmatchedCount).toBe(1);
  });

  it("a guest teacher is never offered as cover", () => {
    const plan = planSubstitutes(
      inputFor(
        [slot({ slotId: "s1", period: 3 })],
        [teacher(4, "Visiting Lecturer", { employmentType: "guest" })],
      ),
    );
    expect(plan.slots[0].assigned).toBeNull();
  });

  it("an unstated scope still allows cover — it means 'not filled in', not 'nothing'", () => {
    const plan = planSubstitutes(
      inputFor(
        [slot({ slotId: "s1", period: 3 })],
        [teacher(4, "No Scope Recorded", { classIds: [] })],
      ),
    );
    expect(plan.slots[0].assigned).toBe(4);
  });

  it("permanent staff edge out adhoc when everything else is equal", () => {
    const plan = planSubstitutes(
      inputFor(
        [slot({ slotId: "s1", period: 3 })],
        [
          teacher(4, "Adhoc Cover", { employmentType: "adhoc" }),
          teacher(5, "Permanent Cover", { employmentType: "permanent" }),
        ],
      ),
    );
    expect(plan.slots[0].assigned).toBe(5);
  });
});
