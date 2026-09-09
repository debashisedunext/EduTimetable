import { describe, expect, it } from "vitest";
import {
  computeLoads, costOf, loadBand, relieveLoad, type LoadInput,
} from "./load";
import type { CurriculumCell, MappingSuggestion, SubjectAnswer, TeacherAnswer } from "./suggest";
import type { WingAnswer } from "./wizard";

/**
 * §15.3 Phase 28 — the arithmetic the Allocation screen and the server share.
 *
 * Every test here is about a number that, if wrong, would be wrong *quietly*:
 * a load rail that reads plausibly and lies, an advisor whose own suggestion
 * changes nothing, a merge proposed for a subject nobody should merge.
 */

const WING: WingAnswer = { name: "Primary", fromIndex: 4, toIndex: 5, sections: 2 };
//                          Class 1 – Class 2, sections A and B

const SUBJECTS: SubjectAnswer[] = [
  { name: "Mathematics", category: "scholastic" },
  { name: "Games", category: "co_scholastic" },
];

const cell = (className: string, subjectName: string, periodsPerWeek: number, maxPerDay = 1): CurriculumCell =>
  ({ className, subjectName, periodsPerWeek, maxPerDay });

const teacher = (
  employeeCode: string, name: string, maxPeriodsPerWeek: number, subjects: string[],
  extra: Partial<TeacherAnswer> = {},
): TeacherAnswer => ({ employeeCode, name, subjects, maxPeriodsPerWeek, ...extra });

const map = (
  employeeCode: string, subjectName: string, classSections: string[], periodsPerWeek: number,
  merged = false,
): MappingSuggestion => ({ employeeCode, subjectName, classSections, periodsPerWeek, merged });

const base = (over: Partial<LoadInput> = {}): LoadInput => ({
  wings: [WING],
  subjects: SUBJECTS,
  curriculum: [
    cell("Class 1", "Mathematics", 6), cell("Class 1", "Games", 3),
    cell("Class 2", "Mathematics", 6), cell("Class 2", "Games", 3),
  ],
  mappings: [],
  teachers: [],
  daysByWing: { Primary: 5 },
  ...over,
});

// ────────────────────────────────────────────────────────────────── bands

describe("§28 load bands", () => {
  it("keeps `full` and `over` apart", () => {
    // The load-bearing split. If a teacher at exactly their cap and one five
    // periods past it were the same colour, the rail could not tell anybody
    // which of the two they must act on — and "at your limit" is the outcome
    // the whole screen is steering towards, not a fault.
    expect(loadBand(30, 30)).toBe("full");
    expect(loadBand(31, 30)).toBe("over");
    expect(loadBand(29, 30)).toBe("warn");     // 96.6%
    expect(loadBand(22, 30)).toBe("ok");       // 73.3%
    expect(loadBand(23, 30)).toBe("warn");     // 76.6% — the 75% line
  });

  it("does not flip on a floating-point hair", () => {
    // 0.1 + 0.2 is 0.30000000000000004. A strictly-greater test would call
    // that "over" — a teacher reported past a limit they are exactly on, and a
    // bug nobody could reproduce because the numbers on screen both read 0.3.
    expect(loadBand(0.1 + 0.2, 0.3)).toBe("full");
  });

  it("treats somebody with no cap at all as over the moment they teach", () => {
    expect(loadBand(0, 0)).toBe("ok");
    expect(loadBand(1, 0)).toBe("over");
  });
});

// ───────────────────────────────────────────────────────────── merged cost

describe("§4.10 what a mapping costs its teacher", () => {
  it("charges an unmerged row once per section", () => {
    expect(costOf(map("T1", "Games", ["Class 1-A", "Class 1-B"], 3))).toBe(6);
  });

  it("charges a MERGED row once, however many sections attend", () => {
    // The rule the whole advisor rests on: several sections taught together
    // are one occupancy event (§4.10), which is why merging relieves a load
    // without taking a subject away from anybody. Multiplying regardless would
    // make the merge suggestion appear to change nothing.
    expect(costOf(map("T1", "Games", ["Class 1-A", "Class 1-B"], 3, true))).toBe(3);
  });

  it("counts a single-section row identically either way", () => {
    expect(costOf(map("T1", "Games", ["Class 1-A"], 3, true)))
      .toBe(costOf(map("T1", "Games", ["Class 1-A"], 3, false)));
  });
});

// ──────────────────────────────────────────────────────────────── loads

describe("§28 computeLoads", () => {
  it("sums a plan and orders it heaviest first", () => {
    const loads = computeLoads(base({
      teachers: [teacher("M1", "Maths One", 30, ["Mathematics"]),
                 teacher("G1", "Games One", 20, ["Games"])],
      mappings: [
        map("M1", "Mathematics", ["Class 1-A"], 6),
        map("M1", "Mathematics", ["Class 1-B"], 6),
        map("M1", "Mathematics", ["Class 2-A"], 6),
        map("G1", "Games", ["Class 1-A"], 3),
      ],
    }));
    // Heaviest first is by PERCENTAGE, not by periods: 18 of 30 is a fuller
    // week than 3 of 20, and the rail exists to answer "who should I worry
    // about", which raw period counts get wrong for a part-timer.
    expect(loads.map((l) => l.employeeCode)).toEqual(["M1", "G1"]);
    expect(loads.map((l) => l.used)).toEqual([18, 3]);
    expect(loads.map((l) => l.band)).toEqual(["ok", "ok"]);   // 60% and 15%
  });

  it("reports reach separately from the weekly cap", () => {
    // A teacher of one subject whose classes allow one period a day can teach
    // at most one period per section per day — so 5 sections × 1/day × 5 days
    // is 25, whatever their weekly cap says. Folding that into one percentage
    // would name neither limit; Check 2 and Check 3 have different fixes.
    const loads = computeLoads(base({
      teachers: [teacher("M1", "Maths One", 40, ["Mathematics"])],
      mappings: [map("M1", "Mathematics", ["Class 1-A"], 6)],
      curriculum: [cell("Class 1", "Mathematics", 6, 1)],
    }));
    expect(loads[0].cap).toBe(40);             // the denominator on screen
    expect(loads[0].reach).toBe(1);            // one section at one a day
    expect(loads[0].reachCap).toBe(5);         // five days can hold five
    expect(loads[0].dayBound).toBe(true);      // 6 periods will not fit in 5 days
  });

  it("does not invent a teacher for a mapping naming somebody unknown", () => {
    // That is a coverage problem, reported by `coverageGaps`. Adding a phantom
    // to the rail would answer a different question badly.
    const loads = computeLoads(base({
      teachers: [teacher("M1", "Maths One", 30, ["Mathematics"])],
      mappings: [map("GHOST", "Mathematics", ["Class 1-A"], 6)],
    }));
    expect(loads).toHaveLength(1);
    expect(loads[0].used).toBe(0);
  });

  it("counts a merged group once against its teacher", () => {
    const loads = computeLoads(base({
      teachers: [teacher("G1", "Games One", 20, ["Games"])],
      mappings: [map("G1", "Games", ["Class 1-A", "Class 1-B"], 3, true)],
    }));
    expect(loads[0].used).toBe(3);
    expect(loads[0].sections).toEqual(["Class 1-A", "Class 1-B"]);
  });
});

// ─────────────────────────────────────────────────────────────── relief

describe("§21 relieveLoad", () => {
  const overloaded = (): LoadInput => base({
    teachers: [
      teacher("M1", "Maths One", 12, ["Mathematics"]),
      teacher("M2", "Maths Two", 30, ["Mathematics"]),
      teacher("G1", "Games One", 20, ["Games"]),
    ],
    mappings: [
      map("M1", "Mathematics", ["Class 1-A"], 6),
      map("M1", "Mathematics", ["Class 1-B"], 6),
      map("M1", "Mathematics", ["Class 2-A"], 6),
      map("M2", "Mathematics", ["Class 2-B"], 6),
    ],
  });

  it("offers a move to somebody with room before it offers to raise a limit", () => {
    const out = relieveLoad(overloaded());
    expect(out[0].kind).toBe("redistribute");
    expect(out[0].change).toMatchObject({ type: "reassign", toCode: "M2" });
  });

  it("puts every relax LAST, whatever else is on the list", () => {
    // Invariant 19: a resolver free to loosen limits can take any school to a
    // clean board without changing one real thing. Ordering is the cheapest
    // enforcement of "shown, but not first".
    const kinds = relieveLoad(overloaded()).map((r) => r.kind);
    const firstRelax = kinds.indexOf("relax");
    expect(firstRelax).toBeGreaterThan(-1);
    expect(kinds.slice(firstRelax).every((k) => k === "relax")).toBe(true);
  });

  it("never proposes merging a core subject", () => {
    // Four sections of Maths in one room is a decision about children, not
    // about load, and this module must not make it on a school's behalf.
    const out = relieveLoad(overloaded());
    expect(out.some((r) => r.change.type === "merge")).toBe(false);
  });

  it("proposes merging a CO-SCHOLASTIC subject, and prices it honestly", () => {
    const out = relieveLoad(base({
      teachers: [teacher("G1", "Games One", 6, ["Games"])],
      mappings: [
        map("G1", "Games", ["Class 1-A"], 3),
        map("G1", "Games", ["Class 1-B"], 3),
        map("G1", "Games", ["Class 2-A"], 3),
      ],
    }));
    const merge = out.find((r) => r.change.type === "merge");
    expect(merge).toBeDefined();
    // The sentence a head teacher has to be able to trust: the children are
    // not losing the subject, they are being taught in one group.
    expect(merge!.detail).toContain("Every child still gets 3 periods a week");
  });

  it("names an unstaffed lesson even when nobody can take it", () => {
    // The most important row on the list. Dropping it because there is no
    // button would hide the one thing that stops the school generating.
    const out = relieveLoad(base({
      teachers: [teacher("M1", "Maths One", 6, ["Mathematics"])],
      mappings: [map("M1", "Mathematics", ["Class 1-A"], 6)],
    }));
    const gaps = out.filter((r) => r.kind === "complete");
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.some((g) => g.title.includes("Class 1-B Mathematics"))).toBe(true);
    expect(gaps[0].detail).toContain("Add a teacher");
  });

  it("never hands a class to a guest teacher", () => {
    // §18: a guest is refused the regular curriculum entirely.
    const out = relieveLoad(base({
      teachers: [
        teacher("M1", "Maths One", 12, ["Mathematics"]),
        teacher("GG", "Guest", 40, ["Mathematics"], { employmentType: "guest" }),
      ],
      mappings: [
        map("M1", "Mathematics", ["Class 1-A"], 6),
        map("M1", "Mathematics", ["Class 1-B"], 6),
        map("M1", "Mathematics", ["Class 2-A"], 6),
      ],
    }));
    expect(out.every((r) => (r.change as { toCode?: string }).toCode !== "GG")).toBe(true);
  });

  it("converges: applying only the non-relax remedies clears the school", () => {
    // The claim the three-verb split is FOR. If the redistribute/complete set
    // could not on its own fix an ordinary school, `relax` would be the real
    // answer wearing a warning label.
    const input = overloaded();
    for (let pass = 0; pass < 12; pass++) {
      const next = relieveLoad(input).filter((r) => r.kind !== "relax");
      if (next.length === 0) break;
      const r = next[0];
      if (r.change.type === "reassign") {
        input.mappings[r.change.rowIndex] =
          { ...input.mappings[r.change.rowIndex], employeeCode: r.change.toCode };
      } else if (r.change.type === "assign") {
        input.mappings.push({
          employeeCode: r.change.toCode, subjectName: r.change.subjectName,
          classSections: [r.change.classSection], periodsPerWeek: r.change.periodsPerWeek,
        });
      } else {
        throw new Error(`nothing applicable: ${r.change.type} — ${r.title}`);
      }
    }
    expect(computeLoads(input).filter((l) => l.band === "over")).toEqual([]);
    expect(relieveLoad(input).filter((r) => r.kind !== "relax")).toEqual([]);
  });
});
