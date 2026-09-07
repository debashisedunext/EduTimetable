import { describe, expect, it } from "vitest";
import { compile, describe as readback, type Context } from "./instruction.compile";

/**
 * §26.5 — the boundary between a language model and a teacher's rules.
 *
 * These tests are the safety argument written down. The claim the feature makes
 * is not "the AI understands instructions" — it is "**anything ticked green
 * compiled to a constraint the solver already enforces, and anything else was
 * refused by name**". Every test below is one half of that sentence.
 */

const ctx: Context = {
  workingDays: [1, 2, 3, 4, 5],
  periodsPerDay: 8,
  classNames: ["Class 5", "Class 6", "Class 7"],
  maxPeriodsPerWeek: 30,
};

const ok = (constraints: unknown[]) => compile({ understood: true, constraints }, ctx);

describe("§26.5 what the model is allowed to say", () => {
  it("compiles an unavailability, which is the commonest instruction there is", () => {
    const r = ok([{ kind: "unavailable", days: [5], periods: [7, 8], reason: "Leaves at 1pm" }]);
    expect(r.status).toBe("accepted");
    expect(r.constraints[0]).toEqual({ kind: "unavailable", days: [5], periods: [7, 8], reason: "Leaves at 1pm" });
    expect(r.note).toContain("Friday");
  });

  it("treats a missing period list as the WHOLE day, not as an error", () => {
    // §4.7a stores a blocked day as one row with a null period, which is what
    // keeps it correct when the day later gains a period.
    const r = ok([{ kind: "unavailable", days: [3] }]);
    expect(r.status).toBe("accepted");
    expect(r.constraints[0]).toMatchObject({ periods: null });
    expect(readback(r.constraints[0])).toBe("not available on Wednesday");
  });

  it("compiles the numeric limits the engine already enforces", () => {
    for (const [kind, value] of [["maxPerDay", 4], ["maxPerWeek", 20], ["minPerDay", 0], ["maxConsecutive", 2]] as const) {
      const r = ok([{ kind, value }]);
      expect(r.status, kind).toBe("accepted");
      expect(r.constraints[0]).toEqual({ kind, value });
    }
  });

  it("resolves class names, case and spacing forgiven", () => {
    const r = ok([{ kind: "onlyClasses", classNames: ["  class 5 ", "CLASS 7"] }]);
    expect(r.status).toBe("accepted");
    expect(r.constraints[0]).toEqual({ kind: "onlyClasses", classNames: ["Class 5", "Class 7"] });
  });

  it("reads every accepted rule back in plain English, so a tick can be checked", () => {
    const r = ok([
      { kind: "unavailable", days: [1], periods: [1] },
      { kind: "maxConsecutive", value: 2 },
    ]);
    expect(r.note).toContain("not available on Monday, period 1");
    expect(r.note).toContain("at most 2 periods back to back");
  });
});

describe("§26.5 what it is refused", () => {
  it("refuses a rule of a kind the timetable does not have — the whole safety claim", () => {
    // "Put her with the nicer classes" has no term in the vocabulary, so there
    // is no way for the model to smuggle it in as something else.
    const r = ok([{ kind: "preferNiceClasses", value: true }]);
    expect(r.status).toBe("denied");
    expect(r.note).toContain("preferNiceClasses");
  });

  it("refuses a day the school does not teach on", () => {
    // A Sunday rule in a Mon-Fri school is a constraint that never binds, which
    // on screen reads as a rule being honoured.
    const r = ok([{ kind: "unavailable", days: [7] }]);
    expect(r.status).toBe("denied");
    expect(r.note).toContain("Monday, Tuesday");
  });

  it("refuses a period outside the day, and a limit outside its range", () => {
    expect(ok([{ kind: "unavailable", days: [1], periods: [99] }]).status).toBe("denied");
    expect(ok([{ kind: "maxPerDay", value: 99 }]).status).toBe("denied");
    expect(ok([{ kind: "maxConsecutive", value: 0 }]).status).toBe("denied");
  });

  it("refuses classes the school does not have, rather than widening the scope", () => {
    // §18: an empty eligibility scope means "not stated", never "no classes" —
    // so a list resolving to nothing must be refused, or an instruction meant to
    // NARROW a teacher's classes would silently widen them to everything.
    const r = ok([{ kind: "onlyClasses", classNames: ["Class 11", "Class 12"] }]);
    expect(r.status).toBe("denied");
    expect(r.note).toContain("Class 11");
  });

  it("refuses an alternate-day pattern with no days to alternate on", () => {
    expect(ok([{ kind: "pattern", value: "alternate_day" }]).status).toBe("denied");
    expect(ok([{ kind: "pattern", value: "alternate_day", days: [1, 3, 5] }]).status).toBe("accepted");
  });

  /**
   * The most important refusal in the file. Accepting the half it understood
   * and showing a green tick would tell the school the WHOLE sentence is being
   * honoured — the one lie this feature must not tell.
   */
  it("refuses the whole instruction when it only understood part of it", () => {
    const r = ok([
      { kind: "unavailable", days: [5], periods: [8] },
      { kind: "putHerWithNiceClasses" },
    ]);
    expect(r.status).toBe("denied");
    expect(r.constraints).toEqual([]);
    expect(r.note).toContain("Part of this could not be applied");
  });

  it("honours the model saying it could not express something", () => {
    const r = compile({ understood: false, note: "That is about who she gets on with, not when she teaches." }, ctx);
    expect(r.status).toBe("denied");
    expect(r.note).toContain("who she gets on with");
  });

  it("refuses an empty or malformed report rather than ticking nothing green", () => {
    expect(compile({ understood: true, constraints: [] }, ctx).status).toBe("denied");
    expect(compile({}, ctx).status).toBe("denied");
    expect(ok(["not an object"]).status).toBe("denied");
    expect(ok([{ }]).status).toBe("denied");
  });

  it("bounds how much one instruction may produce", () => {
    // A model that returns two hundred unavailability rows is not translating.
    const many = Array.from({ length: 40 }, () => ({ kind: "unavailable", days: [1], periods: [1] }));
    expect(compile({ understood: true, constraints: many }, ctx).constraints.length).toBeLessThanOrEqual(12);
  });
});
