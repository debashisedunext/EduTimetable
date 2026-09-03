import { describe, expect, it } from "vitest";
import { ladderIndex, mergeAnswers, sanitizeTurn, stepFrom } from "./interview.answers";

/**
 * §24.6 Phase 25.5 — what a language model is allowed to put in a draft.
 *
 * The claim under test is the phase's exit criterion: **a conversation produces
 * exactly the answers the wizard produces.** If the two paths can disagree about
 * what a school is, there are two setups rather than one — and the second one is
 * the one nobody maintains.
 *
 * The rest is the trust boundary. Nothing here is master data, so this is not
 * the safety net (the §16 importer is, at commit time); it is what keeps the
 * draft coherent, and what makes a refusal something the model is TOLD about
 * rather than something that silently did not happen.
 */

describe("§24.6 the interview's trust boundary", () => {
  it("records what a wizard would have recorded, from names rather than indices", () => {
    // The ladder position is an implementation detail of a slider. Asking a
    // model for `fromIndex: 4` is asking it to hallucinate an integer.
    const { answers, rejected } = sanitizeTurn({
      wings: [{ name: "Primary", fromClass: "Class 1", toClass: "Class 5", sections: 2 }],
    });
    expect(rejected).toEqual([]);
    expect(answers.wings).toEqual([{ name: "Primary", fromIndex: 4, toIndex: 8, sections: 2 }]);
  });

  it("understands the ways people say a class out loud", () => {
    expect(ladderIndex("Class 5")).toBe(8);
    expect(ladderIndex("class 5")).toBe(8);
    expect(ladderIndex("5")).toBe(8);
    expect(ladderIndex("Grade 5")).toBe(8);
    expect(ladderIndex("std 5")).toBe(8);
    expect(ladderIndex("LKG")).toBe(2);
    expect(ladderIndex("pre nursery")).toBe(0);
    expect(ladderIndex(8)).toBe(8);
  });

  it("refuses a class it does not know, WITH the vocabulary", () => {
    // A guess here is a wing quietly covering the wrong classes.
    const { answers, rejected } = sanitizeTurn({
      wings: [{ name: "Foundation", fromClass: "Reception", toClass: "Year 2", sections: 2 }],
    });
    expect(answers.wings).toBeUndefined();
    expect(rejected.join(" ")).toContain("Class 1");
  });

  it("puts a range the wrong way round the right way round", () => {
    const { answers } = sanitizeTurn({
      wings: [{ name: "Senior", fromClass: "Class 12", toClass: "Class 9", sections: 3 }],
    });
    expect(answers.wings).toEqual([{ name: "Senior", fromIndex: 12, toIndex: 15, sections: 3 }]);
  });

  it("NAMES an unknown field rather than dropping it silently", () => {
    // Silently ignoring a field the model believed it recorded produces a
    // conversation where the assistant confirms something that never happened.
    const { answers, rejected } = sanitizeTurn({ school: { name: "St Mary's" }, principal: "Mrs Rao" });
    expect(answers.school).toEqual({ name: "St Mary's" });
    expect(rejected.join(" ")).toContain("principal");
  });

  it("clamps numbers instead of trusting them", () => {
    const { answers, rejected } = sanitizeTurn({
      wings: [{ name: "Primary", fromClass: "Class 1", toClass: "Class 5", sections: 4000 }],
    });
    // A draft holding 4000 sections renders a screen nobody can use and an
    // error two steps later that names the wrong cause.
    expect(answers.wings).toBeUndefined();
    expect(rejected.join(" ")).toContain("1 to 26");
  });

  it("keeps a session's dates honest", () => {
    expect(sanitizeTurn({ session: { name: "2026-27", startDate: "2027-04-01", endDate: "2026-03-31" } }).rejected)
      .toEqual(["The session must end after it starts."]);
    expect(sanitizeTurn({ session: { name: "2026-27", startDate: "April 2026", endDate: "March 2027" } }).rejected)
      .toEqual(["The session needs a start and end date as YYYY-MM-DD."]);
  });

  it("refuses to invent an engagement — §18 makes it consequential", () => {
    // A `guest` teacher is refused the regular curriculum entirely and is never
    // offered as a substitute, so an unrecognised word must not become one of
    // the values that carry consequences.
    const { answers } = sanitizeTurn({ teachers: [{ name: "A Sharma", employmentType: "visiting" }] });
    expect((answers.teachers as any[])[0].employmentType).toBe("permanent");
    const guest = sanitizeTurn({ teachers: [{ name: "B Rao", employmentType: "guest" }] });
    expect((guest.answers.teachers as any[])[0].employmentType).toBe("guest");
  });

  it("refuses a second teacher with the same employee code — it is the identifier", () => {
    const { answers, rejected } = sanitizeTurn({
      teachers: [
        { name: "Anil Yadav", employeeCode: "T-1" },
        { name: "Ajay Yadav", employeeCode: "T-1" },
      ],
    });
    expect(answers.teachers).toHaveLength(1);
    expect(rejected.join(" ")).toContain("T-1");
  });

  it("leaves out a number nobody stated rather than defaulting it into the draft", () => {
    // The setup's own defaults are shown, in italics, on the teacher grid. A
    // number written into the draft here would look like something the school
    // said, and would stop being a default the moment it was stored.
    const { answers } = sanitizeTurn({ teachers: [{ name: "R Devi", subjects: ["Maths"] }] });
    expect(answers.teachers).toEqual([
      { name: "R Devi", subjects: ["Maths"], employmentType: "permanent" },
    ]);
  });

  it("accepts a plain list of subject names, which is how they will be dictated", () => {
    const { answers } = sanitizeTurn({ subjects: ["English", "Mathematics"] });
    expect(answers.subjects).toEqual([
      { name: "English", code: "", isLab: false, requiresDoublePeriod: false },
      { name: "Mathematics", code: "", isLab: false, requiresDoublePeriod: false },
    ]);
  });

  it("takes Yes/No as the booleans people actually say", () => {
    const { answers } = sanitizeTurn({ subjects: [{ name: "Science", isLab: "yes" }] });
    expect((answers.subjects as any[])[0].isLab).toBe(true);
  });

  it("records nothing at all from a report that is not an object", () => {
    expect(sanitizeTurn("the school is called St Mary's").answers).toEqual({});
    expect(sanitizeTurn(null).rejected).toHaveLength(1);
  });
});

describe("§24.6 progress is derived, never taken from the model", () => {
  it("reads the step off what is collected", () => {
    // A model will happily say "step 5" while three of step 3's answers are
    // missing. What is in the draft is the only thing that decides.
    expect(stepFrom({})).toBe(1);
    expect(stepFrom({ school: { name: "X" } })).toBe(2);
    expect(stepFrom({ school: { name: "X" }, session: { name: "26" } })).toBe(3);
  });

  it("does not advance past the week until EVERY wing has one", () => {
    const base = {
      school: { name: "X" }, session: { name: "26" },
      wings: [{ name: "Primary" }, { name: "Senior" }],
    };
    expect(stepFrom({ ...base, weeks: { Primary: {} } })).toBe(5);
    expect(stepFrom({ ...base, weeks: { Primary: {}, Senior: {} } })).toBe(6);
  });

  it("stops at the handover, because the rest is a matrix and not a conversation", () => {
    const done = {
      school: { name: "X" }, session: { name: "26" },
      wings: [{ name: "P" }], weeks: { P: {} },
      subjects: [{ name: "English" }], teachers: [{ name: "A" }],
    };
    expect(stepFrom(done)).toBe(8);
  });
});

describe("§24.6 the exit criterion — a conversation equals a wizard", () => {
  /**
   * Eight turns of a scripted interview, then the same school as the wizard
   * would have stored it.
   *
   * This is the whole claim of the phase in one test: the conversation is a
   * different way to answer the same questions, not a second setup. If these
   * two objects can differ, everything downstream — the suggesters, the §16
   * sheets, the commit — is being fed by two sources with two opinions.
   */
  const TURNS: unknown[] = [
    { school: { name: "St Mary's High School" } },
    { session: { name: "2026-27", startDate: "2026-04-01", endDate: "2027-03-31" } },
    {
      wings: [
        { name: "Primary", fromClass: "Class 1", toClass: "Class 5", sections: 2 },
        { name: "Senior", fromClass: "Class 9", toClass: "Class 10", sections: 2 },
      ],
    },
    {
      weeks: {
        Primary: { workingDays: [1, 2, 3, 4, 5], periodsPerDay: 8, startTime: "08:00", periodDurationMins: 40, breaks: [{ name: "Lunch", afterPeriod: 4, durationMins: 30 }] },
      },
    },
    {
      weeks: {
        Senior: { workingDays: [1, 2, 3, 4, 5, 6], periodsPerDay: 8, startTime: "07:45", periodDurationMins: 40, breaks: [] },
      },
    },
    { subjects: ["English", "Hindi", "Mathematics", { name: "Science", isLab: "yes" }] },
    {
      teachers: [
        { name: "Anil Yadav", employeeCode: "T-1", subjects: ["Mathematics"], wing: "Primary" },
        { name: "Rekha Devi", employeeCode: "T-2", subjects: ["English", "Hindi"], wing: "Primary" },
      ],
    },
    { teachers: [{ name: "S Iyer", employeeCode: "T-3", subjects: ["Science"], wing: "Senior", maxPeriodsPerWeek: 24 }] },
  ];

  /** Exactly what `applyLearned` does, minus the database. */
  function replay(turns: unknown[]): Record<string, unknown> {
    let answers: Record<string, unknown> = {};
    for (const t of turns) {
      const { answers: patch, rejected } = sanitizeTurn(t);
      expect(rejected, JSON.stringify(t)).toEqual([]);
      answers = mergeAnswers(answers, patch);
    }
    return answers;
  }

  it("produces exactly the answers a wizard would have stored", () => {
    expect(replay(TURNS)).toEqual({
      school: { name: "St Mary's High School" },
      session: { name: "2026-27", startDate: "2026-04-01", endDate: "2027-03-31" },
      wings: [
        { name: "Primary", fromIndex: 4, toIndex: 8, sections: 2 },
        { name: "Senior", fromIndex: 12, toIndex: 13, sections: 2 },
      ],
      // BOTH wings' weeks, from two separate turns. A per-key merge would have
      // let the Senior answer delete the Primary one, two questions later.
      weeks: {
        Primary: {
          workingDays: [1, 2, 3, 4, 5], periodsPerDay: 8, periodDurationMins: 40,
          startTime: "08:00", hasZeroPeriod: false,
          breaks: [{ name: "Lunch", afterPeriod: 4, durationMins: 30 }],
        },
        Senior: {
          workingDays: [1, 2, 3, 4, 5, 6], periodsPerDay: 8, periodDurationMins: 40,
          startTime: "07:45", hasZeroPeriod: false, breaks: [],
        },
      },
      subjects: [
        { name: "English", code: "", isLab: false, requiresDoublePeriod: false },
        { name: "Hindi", code: "", isLab: false, requiresDoublePeriod: false },
        { name: "Mathematics", code: "", isLab: false, requiresDoublePeriod: false },
        { name: "Science", code: "", isLab: true, requiresDoublePeriod: false },
      ],
      // All THREE, from two turns. "And we also have a science teacher" must
      // add one, not replace the staff list with one.
      teachers: [
        { name: "Anil Yadav", employeeCode: "T-1", subjects: ["Mathematics"], wing: "Primary", employmentType: "permanent" },
        { name: "Rekha Devi", employeeCode: "T-2", subjects: ["English", "Hindi"], wing: "Primary", employmentType: "permanent" },
        { name: "S Iyer", employeeCode: "T-3", subjects: ["Science"], wing: "Senior", maxPeriodsPerWeek: 24, employmentType: "permanent" },
      ],
    });
  });

  it("treats restating something as a CORRECTION, not a duplicate", () => {
    // "No — Primary has three sections, not two" is one wing, changed.
    const answers = replay([
      ...TURNS,
      { wings: [{ name: "Primary", fromClass: "Class 1", toClass: "Class 5", sections: 3 }] },
      { teachers: [{ name: "Anil Yadav", employeeCode: "T-1", subjects: ["Mathematics", "Science"], wing: "Primary" }] },
    ]);
    expect(answers.wings).toHaveLength(2);
    expect((answers.wings as any[])[0].sections).toBe(3);
    expect(answers.teachers).toHaveLength(3);
    expect((answers.teachers as any[])[0].subjects).toEqual(["Mathematics", "Science"]);
  });

  it("can REMOVE, but only by declaring the list complete", () => {
    // Merging can add and can change; it cannot subtract. Without an explicit
    // way to say "this list is now the whole list", a subject mentioned once by
    // mistake could never be taken out in conversation — and the admin would
    // find it in the curriculum three screens later.
    const answers = replay(TURNS);
    const { answers: patch } = sanitizeTurn({ subjects: ["English", "Mathematics"] });
    const trimmed = mergeAnswers(answers, patch, ["subjects"]);
    expect((trimmed.subjects as any[]).map((s) => s.name)).toEqual(["English", "Mathematics"]);
    // …and nothing else was disturbed by the removal.
    expect(trimmed.teachers).toHaveLength(3);
    expect(Object.keys(trimmed.weeks as object)).toEqual(["Primary", "Senior"]);
  });
});
