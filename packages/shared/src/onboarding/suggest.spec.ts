import { describe, expect, it } from "vitest";
import {
  assignInitials,
  curriculumSheets,
  dedupeCurriculumCells,
  defaultsFor,
  NEUTRAL_SUBJECT,
  mappingSheets,
  subjectSheets,
  suggestMappings,
  teacherSheets,
  proposeInitials,
  roomSheets,
  subjectAppliesTo,
  subjectStartsAt,
  subjectSuitsClass,
  suggestCurriculum,
  suggestRooms,
  withCurriculumPeriods,
} from "./suggest";
import { SHEETS } from "../import/contract";
import type { TeacherAnswer } from "./suggest";
import type { WingAnswer } from "./wizard";

/**
 * §15.3 Phase 25.4 — the two things the wizard PROPOSES.
 *
 * A suggestion that has to be corrected is far cheaper than a form that has to
 * be filled, but only while the suggestion is right often enough to be worth
 * reading — and never quietly wrong in a way that breaks the school later.
 * These tests are about the "quietly wrong" half.
 */

const wing = (name: string, fromIndex: number, toIndex: number, sections = 2): WingAnswer =>
  ({ name, fromIndex, toIndex, sections });

const SUBJECTS = [
  { name: "English" }, { name: "Hindi" }, { name: "Mathematics" },
  { name: "Science", isLab: true }, { name: "Social Science" },
  { name: "Computer Science", isLab: true }, { name: "Art & Craft" },
  { name: "Physical Education" }, { name: "Library" },
];

describe("§15.3 the room suggester", () => {
  it("gives every class-section a home room", () => {
    // The solver claims a section's home room for every non-lab lesson (§19),
    // so this is not decoration — without it, ordinary lessons have nowhere.
    const rooms = suggestRooms([wing("Primary", 4, 6, 3)], SUBJECTS);
    const homes = rooms.filter((r) => r.homeRoomFor);
    expect(homes).toHaveLength(9);
    expect(homes.map((r) => r.name)).toContain("Class 1-A");
  });

  it("ATTACHES its subject to every lab it proposes", () => {
    // The trap this suggester exists to avoid. A lab with no subjects listed is
    // GENERAL and serves everything (§19) — that is what keeps pre-§19 schools
    // working. So proposing "Science Lab" without attaching Science does not
    // create a science lab; it creates a second general-purpose room with a
    // misleading name, and the solver will put Hindi in it.
    const rooms = suggestRooms([wing("Primary", 4, 5)], SUBJECTS);
    const labs = rooms.filter((r) => r.type === "lab");
    expect(labs.length).toBeGreaterThan(0);
    for (const lab of labs) {
      expect(lab.subjects.length, `${lab.name} has no subjects — it would be a general room`).toBeGreaterThan(0);
    }
    expect(labs.find((l) => l.name === "Science Lab")!.subjects).toEqual(["Science"]);
  });

  it("proposes one lab per lab subject, and none for the others", () => {
    const rooms = suggestRooms([wing("P", 4, 4)], SUBJECTS);
    expect(rooms.filter((r) => r.type === "lab").map((r) => r.name).sort())
      .toEqual(["Computer Science Lab", "Science Lab"]);
  });

  it("recognises activity subjects and marks the genuinely shared ones", () => {
    const rooms = suggestRooms([wing("P", 4, 4)], SUBJECTS);
    const byName = Object.fromEntries(rooms.map((r) => [r.name, r]));
    expect(byName["Art Room"]).toBeTruthy();
    expect(byName["Sports Ground"]).toBeTruthy();
    // Check 5 needs to know which rooms several wings compete for.
    expect(byName["Sports Ground"].isShared).toBe(true);
    expect(byName["Library"].isShared).toBe(true);
    expect(byName["Art Room"].isShared).toBe(false);
  });

  it("proposes nothing rather than guessing for an unrecognised subject", () => {
    // A missing proposal is corrected in one click. A wrong one is corrected
    // only if somebody notices.
    const rooms = suggestRooms([wing("P", 4, 4)], [{ name: "Vedic Studies" }]);
    expect(rooms.every((r) => r.homeRoomFor)).toBe(true);
  });

  it("never proposes the same activity room twice", () => {
    const rooms = suggestRooms([wing("P", 4, 4)], [
      { name: "Art & Craft" }, { name: "Art Appreciation" },
    ]);
    expect(rooms.filter((r) => r.name === "Art Room")).toHaveLength(1);
  });

  it("produces a Rooms sheet the importer recognises", () => {
    const sheets = roomSheets(suggestRooms([wing("P", 4, 4)], SUBJECTS));
    const def = SHEETS.find((s) => s.name === "Rooms")!;
    expect(sheets[0].name).toBe("Rooms");
    for (const header of Object.keys(sheets[0].rows[0].cells)) {
      expect(def.columns.some((c) => c.header === header), header).toBe(true);
    }
  });

  it("SAYS which class-section each home room is for (§19, invariant 5)", () => {
    // Rooms are assigned, not left blank. The suggester knew perfectly well
    // which section each home room was for and the sheet dropped the fact on
    // the floor, so every room was created and linked to nothing — Readiness
    // reported "10 class-sections have no home room" on a school that had just
    // had ten home rooms made for it, and every ordinary lesson would have
    // shown no room at all.
    const rooms = suggestRooms([wing("P", 4, 5, 2)], SUBJECTS);
    const rows = roomSheets(rooms)[0].rows;
    for (const r of rooms.filter((x) => x.homeRoomFor)) {
      const row = rows.find((x) => x.cells["Room Name"] === r.name)!;
      expect(row.cells["Home Room For"], r.name).toBe(r.homeRoomFor);
    }
    // …and a lab is nobody's home room, or the section would be locked out of
    // its own room every time the lab is in use.
    for (const r of rooms.filter((x) => x.type === "lab")) {
      expect(rows.find((x) => x.cells["Room Name"] === r.name)!.cells["Home Room For"]).toBe("");
    }
  });

  /**
   * §19.1 — and it dropped the SUBJECTS on the floor too, one column along.
   *
   * `suggestRooms` computes them with some care, and its own note explains why:
   * a lab proposed without its subjects is not a science lab, it is a second
   * general-purpose room with a misleading name that the solver will happily
   * put Hindi in. The sheet never carried them, so every lab the guided setup
   * has ever proposed arrived general — invisible while only labs used the
   * table, and load-bearing now that "taught in its own room" reads it.
   */
  it("SAYS which subjects each proposed room serves (§19, §19.1)", () => {
    const rooms = suggestRooms([wing("P", 4, 5, 2)], SUBJECTS);
    const rows = roomSheets(rooms)[0].rows;
    const cellFor = (name: string) => rows.find((x) => x.cells["Room Name"] === name)!.cells["Lab For Subjects"];

    for (const r of rooms.filter((x) => x.subjects.length > 0)) {
      expect(cellFor(r.name), r.name).toBe(r.subjects.join(", "));
    }
    // A lab names its own subject…
    const scienceLab = rooms.find((r) => r.type === "lab" && r.subjects.includes("Science"))!;
    expect(cellFor(scienceLab.name)).toContain("Science");
    // …and a home room names none, which is what keeps it general.
    for (const r of rooms.filter((x) => x.homeRoomFor)) expect(cellFor(r.name)).toBe("");
  });
});

describe("§15.3 the curriculum suggester", () => {
  it("never proposes more than the week holds", () => {
    const wings = [wing("Primary", 4, 8), wing("Senior", 12, 15)];
    const plan = suggestCurriculum(wings, SUBJECTS, { Primary: 40, Senior: 45 });
    for (const t of plan.totals) {
      expect(t.over, `${t.className}: ${t.total} of ${t.capacity}`).toBe(false);
    }
  });

  it("fits an EIGHT-period week, which a fixed table would blow apart", () => {
    // The case the plan called out. Weights totalling ~33 scaled naively into a
    // week of 8 produces a school that can never generate — and it looks like
    // an answer, which is worse than an empty screen.
    const plan = suggestCurriculum([wing("Tiny", 4, 5)], SUBJECTS, { Tiny: 8 });
    for (const t of plan.totals) {
      expect(t.total, `${t.className}: ${t.total} of 8`).toBeLessThanOrEqual(8);
      expect(t.over).toBe(false);
    }
    // ...and it still teaches something.
    expect(plan.cells.length).toBeGreaterThan(0);
    // Nine subjects cannot each have a period in a week of eight — arithmetic,
    // not tuning. What matters is that the ones that did not fit are NAMED,
    // rather than a nine-period curriculum being proposed for an eight-period
    // week, or a subject quietly vanishing from the school.
    expect(plan.dropped.length).toBeGreaterThan(0);
    expect(plan.dropped[0].reason).toContain("8 periods");
    const kept = new Set(plan.cells.filter((c) => c.className === "Class 1").map((c) => c.subjectName));
    // The heaviest subjects survive the cut; the lightest are the ones named.
    expect(kept.has("Mathematics")).toBe(true);
    expect(kept.has("Library")).toBe(false);
  });

  /**
   * §27.15 — a subject belongs to a rung of the ladder, not only to a weight.
   *
   * The bug this describes was reported as "Biology in Pre-Nursery": the
   * classifier knew Biology is a 4-6 period laboratory science and had no
   * opinion at all about who is old enough to take it, so every subject the
   * school listed was proposed to every class in it.
   */
  describe("§27.15 the ladder", () => {
    const LIST = [
      { name: "English" }, { name: "Mathematics" }, { name: "Art & Craft" },
      { name: "Biology", isLab: true }, { name: "Accountancy" }, { name: "French" },
    ];
    const preNursery = suggestCurriculum([wing("Pre-Primary", 0, 3)], LIST, { "Pre-Primary": 30 });
    const senior = suggestCurriculum([wing("Senior", 14, 15)], LIST, { Senior: 40 });
    const has = (plan: { cells: Array<{ className: string; subjectName: string }> }, cls: string, subject: string) =>
      plan.cells.some((c) => c.className === cls && c.subjectName === subject);

    it("does not offer Biology, Accountancy or French to Pre-Nursery", () => {
      expect(has(preNursery, "Pre-Nursery", "Biology")).toBe(false);
      expect(has(preNursery, "Pre-Nursery", "Accountancy")).toBe(false);
      expect(has(preNursery, "Pre-Nursery", "French")).toBe(false);
    });

    it("still teaches Pre-Nursery the things it does take", () => {
      expect(has(preNursery, "Pre-Nursery", "English")).toBe(true);
      expect(has(preNursery, "Pre-Nursery", "Mathematics")).toBe(true);
      expect(has(preNursery, "Pre-Nursery", "Art & Craft")).toBe(true);
    });

    it("offers all of them where they belong", () => {
      expect(has(senior, "Class 11", "Biology")).toBe(true);
      expect(has(senior, "Class 11", "Accountancy")).toBe(true);
    });

    it("still fills the week it proposes for", () => {
      // The narrowing must not leave the class short: the scaling runs over
      // whatever survives, so four subjects fill 30 periods as nine would.
      for (const t of preNursery.totals) expect(t.total).toBe(t.capacity);
    });

    it("stands aside rather than leaving a class with NOTHING", () => {
      // A pre-primary wing whose school listed only senior subjects: the
      // school's own list is better evidence than the ladder, and an empty week
      // is a Readiness score complaining about 40 free slots per class.
      const odd = suggestCurriculum(
        [wing("Pre-Primary", 0, 3)], [{ name: "Physics" }, { name: "Accountancy" }], { "Pre-Primary": 30 },
      );
      expect(odd.cells.filter((c) => c.className === "Pre-Nursery").length).toBeGreaterThan(0);
    });

    it("has no opinion about a name it does not recognise", () => {
      // Invariant 7's shape: not stated is never "no". A missing proposal costs
      // one click to correct; a wrong one is corrected only if somebody notices.
      expect(subjectSuitsClass("Rhymes & Storytelling", 1)).toBe(true);
      expect(subjectSuitsClass("Biology", 1)).toBe(false);
      expect(subjectSuitsClass("Biology", 13)).toBe(true);
    });

    it("names the rung, so an empty cell can explain itself", () => {
      expect(subjectStartsAt("Biology")).toBe("Class 9");
      expect(subjectStartsAt("French")).toBe("Class 5");
      expect(subjectStartsAt("English")).toBe(null);
    });

    it("keeps 'Science' general — it is Physics that separates at Class 9", () => {
      expect(subjectSuitsClass("Science", 5)).toBe(true);
      expect(subjectSuitsClass("Physics", 5)).toBe(false);
      // …and the compound-name rule still holds (the row order test above).
      expect(subjectSuitsClass("Computer Science", 5)).toBe(true);
    });
  });

  /**
   * §27.16 — the school's own answer, and where it outranks the guess above.
   *
   * The tests worth having are the three that separate a DECLARATION from the
   * ladder: it refuses where the ladder only suggests, it survives the fallback
   * that lets the ladder stand aside, and its absence changes nothing at all.
   */
  describe("§27.16 declared classes", () => {
    it("treats an empty declaration as not stated, never as no classes", () => {
      expect(subjectAppliesTo({}, "Class 5")).toBe(true);
      expect(subjectAppliesTo({ classes: [] }, "Class 5")).toBe(true);
      expect(subjectAppliesTo({ classes: ["Class 9", "Class 10"] }, "Class 5")).toBe(false);
      expect(subjectAppliesTo({ classes: ["Class 9"] }, "class 9")).toBe(true);
    });

    it("proposes a declared subject in its classes and nowhere else", () => {
      const plan = suggestCurriculum(
        [wing("W", 4, 13)],
        [
          { name: "English" }, { name: "Mathematics" },
          { name: "Music", classes: ["Class 1", "Class 2"] },
        ],
        { W: 40 },
      );
      const music = plan.cells.filter((c) => c.subjectName === "Music").map((c) => c.className);
      expect([...new Set(music)].sort()).toEqual(["Class 1", "Class 2"]);
    });

    it("beats the ladder, in both directions", () => {
      // Biology is off its rung at Class 1 and declared there anyway: the
      // school has answered the question the rung was estimating.
      const early = suggestCurriculum(
        [wing("W", 4, 5)], [{ name: "English" }, { name: "Biology", classes: ["Class 1"] }], { W: 30 },
      );
      expect(early.cells.some((c) => c.subjectName === "Biology" && c.className === "Class 1")).toBe(true);

      // …and on its rung but declared elsewhere, it stays out.
      const late = suggestCurriculum(
        [wing("W", 12, 13)], [{ name: "English" }, { name: "Biology", classes: ["Class 10"] }], { W: 30 },
      );
      expect(late.cells.some((c) => c.subjectName === "Biology" && c.className === "Class 9")).toBe(false);
    });

    it("does not hand an excluded subject back through the empty-class fallback", () => {
      /*
        The one mistake this design can make. The ladder is allowed to stand
        aside when it would leave a class with nothing — so a class whose ONLY
        candidate was excluded by declaration must not be caught by that
        fallback and handed the subject back. It is empty because the school
        said so, and Readiness reports the free slots.
      */
      const plan = suggestCurriculum(
        [wing("Pre-Primary", 0, 0)], [{ name: "Physics", classes: ["Class 11"] }], { "Pre-Primary": 30 },
      );
      expect(plan.cells.filter((c) => c.className === "Pre-Nursery")).toEqual([]);
    });

    it("changes nothing for a school that has declared nothing", () => {
      const before = suggestCurriculum([wing("W", 4, 8)], SUBJECTS, { W: 40 });
      const after = suggestCurriculum(
        [wing("W", 4, 8)], SUBJECTS.map((s) => ({ ...s, classes: [] })), { W: 40 },
      );
      expect(after.cells).toEqual(before.cells);
    });

    it("rides the workbook, so a declaration survives an export and re-import", () => {
      const [sheet] = subjectSheets([{ name: "Music", classes: ["Class 1", "Class 2"] }, { name: "English" }]);
      expect(sheet.rows[0].cells.Classes).toBe("Class 1, Class 2");
      // Blank, not "every class" — the importer reads blank as "not stated"
      // and therefore leaves any existing declaration alone.
      expect(sheet.rows[1].cells.Classes).toBe("");
    });
  });

  it("drops nothing at all when the week is long enough", () => {
    const plan = suggestCurriculum([wing("W", 4, 8)], SUBJECTS, { W: 40 });
    expect(plan.dropped).toEqual([]);
  });

  it("gives every subject it keeps at least one period", () => {
    const plan = suggestCurriculum([wing("Tiny", 4, 4)], SUBJECTS, { Tiny: 12 });
    for (const c of plan.cells) expect(c.periodsPerWeek).toBeGreaterThanOrEqual(1);
  });

  it("weights by band — a senior class is not a Class 1 timetable", () => {
    const wings = [wing("Lower", 4, 4), wing("Senior", 14, 14)];
    const plan = suggestCurriculum(wings, SUBJECTS, { Lower: 40, Senior: 40 });
    const pe = (cls: string) => plan.cells.find((c) => c.className === cls && c.subjectName === "Physical Education")!;
    // PE tapers off toward the board years; Maths does not.
    expect(pe("Class 1").periodsPerWeek).toBeGreaterThanOrEqual(pe("Class 11").periodsPerWeek);
  });

  it("scales to the capacity it is given, not to a constant", () => {
    const big = suggestCurriculum([wing("W", 4, 4)], SUBJECTS, { W: 48 });
    const small = suggestCurriculum([wing("W", 4, 4)], SUBJECTS, { W: 20 });
    expect(big.totals[0].total).toBeGreaterThan(small.totals[0].total);
  });

  it("fills the week rather than leaving periods unallocated", () => {
    // This assertion was the other way round, on the theory that a full week
    // gives the solver nowhere to move. The Feasibility Engine disagreed and
    // was right: a free period is not slack, it is unallocated teaching time,
    // and Readiness warns about every one — which is what kept a
    // fully-configured school below 100%.
    const plan = suggestCurriculum([wing("W", 4, 4)], SUBJECTS, { W: 40 }, { W: 5 });
    expect(plan.totals[0].total).toBe(40);
    expect(plan.totals[0].over).toBe(false);
  });

  it("fills it for EVERY band and every capacity, not just the one that rounds well", () => {
    // The version of this test above checked a single Class 1 in a 40-period
    // week — and passed, while Class 5, 9 and 10 were each two periods short.
    // Eight subjects rounded down by a fraction apiece is a systematic
    // shortfall, not bad luck, and it is invisible unless the sweep is wide:
    // the trim loop could only ever remove periods, so a week that came out
    // under stayed under.
    for (const capacity of [20, 30, 35, 40, 45, 48]) {
      const plan = suggestCurriculum(
        [wing("Lower", 4, 8), wing("Upper", 9, 12), wing("Senior", 13, 15)],
        SUBJECTS,
        { Lower: capacity, Upper: capacity, Senior: capacity },
        { Lower: 5, Upper: 5, Senior: 5 },
      );
      for (const t of plan.totals) {
        expect(t.total, `${t.className} at capacity ${capacity}`).toBe(capacity);
      }
    }
  });

  it("weights a compound name by its own family, not by the word it ends with", () => {
    // `WEIGHTS` is scanned with `find`, so a generic pattern placed above a
    // specific one swallows it. "Computer Science" and "Social Science" both
    // matched the laboratory-science row and were weighted as laboratory
    // science — a 3-period computing course proposed as a 6-period one, which
    // then consumed staff and rooms it had no claim on.
    const plan = suggestCurriculum([wing("Senior", 13, 13)], SUBJECTS, { Senior: 40 }, { Senior: 5 });
    const of = (name: string) => plan.cells.find((c) => c.subjectName === name)!.periodsPerWeek;
    expect(of("Computer Science")).toBeLessThan(of("Science"));
    expect(of("Computer Science")).toBeLessThan(of("Social Science"));
  });

  it("produces a Curriculum sheet the importer recognises", () => {
    const plan = suggestCurriculum([wing("W", 4, 4)], SUBJECTS, { W: 40 });
    const sheets = curriculumSheets(plan, "2026-27");
    const def = SHEETS.find((s) => s.name === "Curriculum")!;
    for (const header of Object.keys(sheets[0].rows[0].cells)) {
      expect(def.columns.some((c) => c.header === header), header).toBe(true);
    }
  });

  it("respects the importer's 1-20 bound on periods/week", () => {
    const plan = suggestCurriculum([wing("W", 4, 4)], [{ name: "Mathematics" }], { W: 60 });
    for (const c of plan.cells) expect(c.periodsPerWeek).toBeLessThanOrEqual(20);
  });
});

describe("§30.12 a class taught by two pools is still ONE curriculum", () => {
  /*
    Since §30.9, two wings in different §30 resource pools may both run Class 1
    — an individual timetable teaching the same grade as the main school. That
    is real, and step 4 needs both entries to create both pools' cohort rows.

    What is not real is two curricula. `class_subjects` is keyed
    `(class, subject, year)` with no pool column, so the second visit is the
    same row again — and the §16 importer refuses a sheet holding two rows on
    one natural key. On a real school that was 322 errors and "nothing was
    written" on every Save.
  */
  const shared = (): WingAnswer[] => [
    wing("Main", 4, 9, 4),             // Class 1 – Class 6
    { ...wing("Weekly", 4, 6, 2), individual: true }, // Class 1 – Class 3, own pool
  ];
  const caps = { Main: 40, Weekly: 30 };

  it("emits one curriculum row per class and subject, not one per wing", () => {
    const plan = suggestCurriculum(shared(), SUBJECTS, caps);
    const keys = plan.cells.map((c) => `${c.className}|${c.subjectName}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps the TIGHTER week's row, because the curriculum is shared", () => {
    // The row has to fit the narrowest wing that teaches the class — keeping
    // the larger one proposes a curriculum that cannot fit one of its own
    // wings, and Readiness reports it against a wing nobody was editing.
    const wide = { className: "Class 1", subjectName: "Maths", periodsPerWeek: 8, maxPerDay: 2 };
    const tight = { className: "Class 1", subjectName: "Maths", periodsPerWeek: 5, maxPerDay: 1 };
    expect(dedupeCurriculumCells([wide, tight])[0].periodsPerWeek).toBe(5);
    expect(dedupeCurriculumCells([tight, wide])[0].periodsPerWeek).toBe(5);
  });

  it("still reports a class only once in the totals", () => {
    const plan = suggestCurriculum(shared(), SUBJECTS, caps);
    const names = plan.totals.map((t) => t.className);
    expect(new Set(names).size).toBe(names.length);
  });

  it("deduplicates in the SHEET too, because an edited grid skips the suggester", () => {
    // `answers.curriculum` is committed verbatim when somebody has edited the
    // grid, so the sheet builder is the only gate that always runs.
    const dup = { className: "Class 1", subjectName: "Maths", periodsPerWeek: 5, maxPerDay: 1 };
    const sheet = curriculumSheets(
      { cells: [dup, { ...dup }], totals: [], dropped: [] }, "2026-27",
    )[0];
    expect(sheet.rows).toHaveLength(1);
  });

  it("emits one mapping per subject and class-section, and one class teacher per section", () => {
    const dup = (classSection: string) => ({ classSection, employeeCode: "T-001" });
    const m = (subjectName: string, cs: string) =>
      ({ employeeCode: "T-001", subjectName, classSections: [cs], periodsPerWeek: 5 });
    const sheets = mappingSheets({
      mappings: [m("Maths", "Class 1-A"), m("Maths", "Class 1-A"), m("Maths", "Class 1-B")],
      classTeachers: [dup("Class 1-A"), dup("Class 1-A")],
      uncovered: [], load: [],
    });
    expect(sheets.find((x) => x.name === "Subject Mapping")!.rows).toHaveLength(2);
    expect(sheets.find((x) => x.name === "Class Teachers")!.rows).toHaveLength(1);
  });

  it("does NOT collapse the two wings in planClasses — both pools still get cohorts", () => {
    // The fix belongs to the curriculum, not to the class plan: step 4 must
    // still create Class 1 in both pools (§30.9).
    const plan = suggestCurriculum(shared(), SUBJECTS, caps);
    expect(plan.cells.some((c) => c.className === "Class 1")).toBe(true);
    // …and the wings themselves are untouched, which `wizard.spec.ts` asserts
    // directly; here it is enough that deduplication did not empty the plan.
    expect(plan.cells.length).toBeGreaterThan(0);
  });
});

describe("§15.3 proposed initials", () => {
  it("takes first and last initial", () => {
    expect(proposeInitials("Anil Yadav", new Set())).toBe("AY");
    expect(proposeInitials("Rekha Devi Sharma", new Set())).toBe("RS");
  });

  it("makes a collision VISIBLE rather than letting the database refuse it", () => {
    // A school with an Anil Yadav and an Ajay Yadav is not unusual. Proposed in
    // the cell, where somebody can choose something better.
    const taken = new Set(["AY"]);
    expect(proposeInitials("Ajay Yadav", taken)).toBe("AY2");
    taken.add("AY2");
    expect(proposeInitials("Amit Yadav", taken)).toBe("AY3");
  });

  it("copes with one name, and with none", () => {
    expect(proposeInitials("Meera", new Set())).toBe("ME");
    expect(proposeInitials("", new Set())).toBe("?");
    expect(proposeInitials("   ", new Set())).toBe("?");
  });

  it("fits the column it exists for", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const v = proposeInitials("Anil Yadav", taken);
      expect(v.length).toBeLessThanOrEqual(6);
      taken.add(v);
    }
  });
});

describe("§15.3 the mapping suggester", () => {
  const wings = [wing("Primary", 4, 6, 2)]; // Class 1-3, 2 sections each
  const capacity = { Primary: 40 };
  const curriculum = suggestCurriculum(wings, SUBJECTS, capacity);

  /** Enough staff that every subject is covered with room to spare. */
  const staffFor = (perSubject: number, cap = 30) =>
    SUBJECTS.flatMap((s, i) =>
      Array.from({ length: perSubject }, (_, n) => ({
        name: `${s.name} Teacher ${n + 1}`,
        employeeCode: `T-${i}${n}`,
        subjects: [s.name],
        maxPeriodsPerWeek: cap,
      })),
    );

  it("covers every curriculum row when the staff list can", () => {
    const plan = suggestMappings(wings, curriculum, staffFor(3));
    expect(plan.uncovered).toEqual([]);
    // One mapping per (class-section, subject) — the DB's unique key.
    const expected = curriculum.cells.length * 2; // 2 sections per class
    expect(plan.mappings).toHaveLength(expected);
  });

  it("never gives anybody more than their weekly cap", () => {
    // Check 2's arithmetic. A proposal that overloads a teacher produces a
    // school that cannot generate, which is worse than one that says so.
    const plan = suggestMappings(wings, curriculum, staffFor(3));
    for (const l of plan.load) {
      expect(l.over, `${l.name}: ${l.periods} of ${l.cap}`).toBe(false);
    }
  });

  it("NAMES what it cannot cover instead of leaving it silently unmapped", () => {
    // Silently unmapped produces a Check 1 failure later with no explanation of
    // why — the opposite of this product's "tell me what to fix" contract.
    const plan = suggestMappings(wings, curriculum, [
      { name: "Only Maths", employeeCode: "T-1", subjects: ["Mathematics"], maxPeriodsPerWeek: 30 },
    ]);
    expect(plan.uncovered.length).toBeGreaterThan(0);
    expect(plan.uncovered.some((u) => /Nobody on the staff list teaches English/.test(u.reason))).toBe(true);
  });

  it("distinguishes 'nobody teaches it' from 'everybody is full'", () => {
    const tiny = suggestMappings(wings, curriculum, [
      { name: "Overloaded", employeeCode: "T-1", subjects: SUBJECTS.map((s) => s.name), maxPeriodsPerWeek: 4 },
    ]);
    // Three reasons with three different fixes: hire somebody, move somebody
    // into this wing, or lengthen the week. Telling an admin to hire when the
    // real problem is a five-day week is unhelpful.
    expect(tiny.uncovered.some((u) => /is at their limit/.test(u.reason))).toBe(true);
    expect(tiny.uncovered.some((u) => /weekly cap, or as much as \d+ days can hold/.test(u.reason))).toBe(true);
  });

  it("spreads one subject's work across the people who teach it", () => {
    // Compared WITHIN a subject, not across subjects: each fixture teacher
    // teaches exactly one, so a Library teacher (1 period x 6 sections) will
    // always carry less than a Maths teacher (7 x 6 shared three ways). That
    // spread is the curriculum's doing, not the assignment's, and comparing
    // across subjects measures the wrong thing entirely.
    const plan = suggestMappings(wings, curriculum, staffFor(3));
    const byCode = new Map(plan.load.map((l) => [l.employeeCode, l.periods]));
    for (const [i] of SUBJECTS.entries()) {
      const peers = ["0", "1", "2"].map((n) => byCode.get(`T-${i}${n}`) ?? 0);
      const working = peers.filter((p) => p > 0);
      if (working.length < 2) continue;
      // Least-loaded-first: the busiest and the quietest differ by at most one
      // section's worth of that subject.
      expect(Math.max(...working) - Math.min(...working),
        `${SUBJECTS[i].name}: ${peers.join("/")}`).toBeLessThanOrEqual(Math.max(...working));
    }
  });

  it("honours §18 teaching scope — a Primary teacher is not given Senior", () => {
    const twoWings = [wing("Primary", 4, 5, 1), wing("Senior", 12, 13, 1)];
    const cur = suggestCurriculum(twoWings, [{ name: "Mathematics" }], { Primary: 40, Senior: 40 });
    const plan = suggestMappings(twoWings, cur, [
      { name: "Primary Only", employeeCode: "P-1", subjects: ["Mathematics"], wing: "Primary", maxPeriodsPerWeek: 30 },
      { name: "Senior Only", employeeCode: "S-1", subjects: ["Mathematics"], wing: "Senior", maxPeriodsPerWeek: 30 },
    ]);
    for (const m of plan.mappings) {
      const senior = m.classSections[0].startsWith("Class 9") || m.classSections[0].startsWith("Class 10");
      expect(m.employeeCode).toBe(senior ? "S-1" : "P-1");
    }
  });

  it("never proposes a guest teacher for the regular curriculum (§18)", () => {
    const plan = suggestMappings(wings, curriculum, [
      ...staffFor(2),
      { name: "Visiting", employeeCode: "G-1", subjects: SUBJECTS.map((s) => s.name), employmentType: "guest" as const },
    ]);
    expect(plan.mappings.some((m) => m.employeeCode === "G-1")).toBe(false);
  });

  it("gives each section a class teacher who actually teaches it", () => {
    const plan = suggestMappings(wings, curriculum, staffFor(3));
    expect(plan.classTeachers.length).toBeGreaterThan(0);
    for (const ct of plan.classTeachers) {
      const teaches = plan.mappings.some(
        (m) => m.employeeCode === ct.employeeCode && m.classSections.includes(ct.classSection),
      );
      // The §4.7 first-period rule needs a real lesson to attach to.
      expect(teaches, `${ct.employeeCode} does not teach ${ct.classSection}`).toBe(true);
    }
  });

  it("quotes periods/week from the CURRICULUM, so a step-9 edit cannot go stale", () => {
    // Who teaches a class is step 10's decision; how many periods it runs for
    // is step 9's, and a mapping is only quoting it. Storing the quote and
    // never refreshing it means going back to give English an extra period
    // leaves the mapping saying seven — and Readiness reports "only 7 of 8
    // periods/week mapped to a teacher", a blocker whose cause is two screens
    // from where it is named.
    const before = suggestCurriculum(wings, SUBJECTS, capacity);
    const plan = suggestMappings(wings, before, staffFor(3));

    const after = {
      ...before,
      cells: before.cells.map((c) =>
        c.subjectName === "English" ? { ...c, periodsPerWeek: c.periodsPerWeek + 1 } : c),
    };
    const fresh = withCurriculumPeriods(after, plan.mappings);
    const want = after.cells.find((c) => c.subjectName === "English")!.periodsPerWeek;
    for (const m of fresh.filter((x) => x.subjectName === "English")) {
      expect(m.periodsPerWeek).toBe(want);
    }
    // …and it changes nothing else: the teacher is a decision, not a quote.
    expect(fresh.map((m) => m.employeeCode)).toEqual(plan.mappings.map((m) => m.employeeCode));
  });

  it("produces sheets the importer recognises", () => {
    const plan = suggestMappings(wings, curriculum, staffFor(3));
    for (const s of mappingSheets(plan)) {
      const def = SHEETS.find((d) => d.name === s.name)!;
      expect(def, s.name).toBeTruthy();
      for (const header of Object.keys(s.rows[0].cells)) {
        expect(def.columns.some((c) => c.header === header), `${s.name}!${header}`).toBe(true);
      }
    }
  });
});

describe("§15.3 subject and teacher sheets", () => {
  it("mint an employee code when the school has none — it is the identifier", () => {
    const sheets = teacherSheets([{ name: "Anil Yadav", subjects: ["Mathematics"] }], []);
    expect(sheets[0].rows[0].cells["Employee Code"]).toBe("T-001");
  });

  it("pin a wing-scoped teacher to that wing's classes (§18)", () => {
    const sheets = teacherSheets(
      [{ name: "P", subjects: ["Maths"], wing: "Primary" }],
      [wing("Primary", 4, 5, 1), wing("Senior", 12, 12, 1)],
    );
    const scope = String(sheets[0].rows[0].cells["Teaching Scope"]);
    expect(scope).toContain("Class 1");
    expect(scope).not.toContain("Class 9");
  });

  it("leave scope UNSTATED for an unpinned teacher — not 'no classes' (§18)", () => {
    const sheets = teacherSheets([{ name: "Any", subjects: ["Maths"] }], [wing("Primary", 4, 5, 1)]);
    expect(sheets[0].rows[0].cells["Teaching Scope"]).toBe("");
  });

  it("produce sheets the importer recognises", () => {
    for (const s of [...subjectSheets(SUBJECTS), ...teacherSheets([{ name: "A", subjects: [] }], [])]) {
      const def = SHEETS.find((d) => d.name === s.name)!;
      for (const header of Object.keys(s.rows[0].cells)) {
        expect(def.columns.some((c) => c.header === header), `${s.name}!${header}`).toBe(true);
      }
    }
  });
});

describe("§26.2 subject placement defaults", () => {
  /**
   * The classifier is the only thing in the product that guesses these, and
   * every door reads it — the guided setup, the Subjects master, the §16
   * importer, the ERP sync. A wrong answer here is a wrong answer everywhere,
   * and it is silent: it constrains the solver on behalf of a school that never
   * said so.
   */
  it("classifies the families a school recognises", () => {
    expect(defaultsFor("Mathematics").priority).toBe(5);
    expect(defaultsFor("English").priority).toBe(5);
    expect(defaultsFor("Science").category).toBe("scholastic");
    expect(defaultsFor("Art & Craft").category).toBe("co_scholastic");
    expect(defaultsFor("Library").category).toBe("co_scholastic");
    expect(defaultsFor("Library").priority).toBe(1);
  });

  it("gives games the two rules it exists for, and gives art neither", () => {
    // The one family with a physical reason behind it: children cannot run
    // straight after eating, and arriving at lunch filthy is the other half.
    const games = defaultsFor("Physical Education");
    expect(games.lunchRule).toBe("after");
    expect(games.gapAfterLunch).toBe(true);
    expect(defaultsFor("Games")).toEqual(games);
    expect(defaultsFor("Yoga")).toEqual(games);

    // Nothing about a painting lesson that a full stomach prevents.
    const art = defaultsFor("Music");
    expect(art.category).toBe("co_scholastic");
    expect(art.lunchRule).toBe("any");
    expect(art.gapAfterLunch).toBe(false);
  });

  it("keeps the specific-before-general order the weights depend on", () => {
    // The §15.3 bug, now with a second way to see it: "Computer Science" and
    // "Social Science" must not be classified as laboratory science.
    expect(defaultsFor("Computer Science").priority).toBe(3);
    expect(defaultsFor("Social Science").priority).toBe(4);
    expect(defaultsFor("Science").priority).toBe(4);
  });

  it("says NOTHING about a name it does not know, rather than guessing", () => {
    // A wrong guess is worse than no opinion: priority 3 is the neutral middle
    // and `any` restricts nothing, so an unrecognised subject behaves exactly
    // as every subject did before this phase.
    expect(defaultsFor("Astrophysics")).toEqual(NEUTRAL_SUBJECT);
    expect(defaultsFor("")).toEqual(NEUTRAL_SUBJECT);
    expect(defaultsFor("Zzz Made Up")).toEqual(NEUTRAL_SUBJECT);
  });

  it("never returns a priority outside 1..5, whatever the family", () => {
    // The column is a TINYINT with a 1-5 guard on the API; a table entry
    // outside it would be refused at the point of writing, far from here.
    for (const name of [
      "English", "Hindi", "Mathematics", "EVS", "Computer Science", "Social Science",
      "Science", "Art", "Games", "Library", "Nothing Familiar",
    ]) {
      const d = defaultsFor(name);
      expect(d.priority, name).toBeGreaterThanOrEqual(1);
      expect(d.priority, name).toBeLessThanOrEqual(5);
    }
  });

  it("puts the defaults on the sheet the importer reads", () => {
    const rows = subjectSheets([{ name: "Games" }, { name: "Mathematics" }])[0].rows;
    expect(rows[0].cells["Category"]).toBe("Co-scholastic");
    expect(rows[0].cells["Lunch Rule"]).toBe("After lunch");
    expect(rows[0].cells["Gap After Lunch"]).toBe("Yes");
    expect(rows[1].cells["Priority"]).toBe(5);
    expect(rows[1].cells["Gap After Lunch"]).toBe("No");
  });

  it("lets a school override the classifier, and keeps the override", () => {
    // Somebody who deliberately says Games is scholastic and may be taught at
    // any time gets exactly that — the defaults fill blanks, they do not win.
    const rows = subjectSheets([
      { name: "Games", category: "scholastic", priority: 5, lunchRule: "any", gapAfterLunch: false },
    ])[0].rows;
    expect(rows[0].cells["Category"]).toBe("Scholastic");
    expect(rows[0].cells["Priority"]).toBe(5);
    expect(rows[0].cells["Lunch Rule"]).toBe("Any time");
    expect(rows[0].cells["Gap After Lunch"]).toBe("No");
  });
});

describe("§27 the initials a cell shows", () => {
  const staff = (...names: string[]) => names.map((name) => ({ name, subjects: [] }));

  it("gives two people with the same initials different ones", () => {
    // `teachers.initials` is unique per school, so uniqueness is a property of
    // the LIST. Two Yadavs both propose AY; the second must not get it.
    expect(assignInitials(staff("Anil Yadav", "Asha Yadav"))).toEqual(["AY", "AY2"]);
  });

  it("keeps initials somebody already typed, and claims them first", () => {
    // A school that uses initials has them on cover lists and staff-room doors.
    // Theirs win, and nobody else may be handed the same.
    const out = assignInitials([
      { name: "Anil Yadav", subjects: [], initials: "ANY" },
      { name: "Asha Yadav", subjects: [] },
      { name: "Ajay Yadav", subjects: [], initials: "AY" },
    ]);
    expect(out).toEqual(["ANY", "AY2", "AY"]);
  });

  it("is the SAME answer the Teachers sheet writes", () => {
    // The property this shared function exists for. If the Allocation grid
    // derived its own, it would show `AY` for somebody the importer then stored
    // as `AY2` — a lie that only surfaces when a school looks for a teacher by
    // the initials it was shown.
    const teachers = staff("Anil Yadav", "Asha Yadav", "Bina Shah");
    const shown = assignInitials(teachers);
    const written = teacherSheets(teachers, []) [0].rows.map((r) => r.cells.Initials);
    expect(written).toEqual(shown);
  });
});

describe("§27.9 which classes a teacher takes", () => {
  const WINGS = [wing("Junior", 4, 6, 1), wing("Senior", 12, 13, 1)];  // Class 1-3, Class 9-10
  const curriculum = (classes: string[]) => ({
    cells: classes.map((className) => ({ className, subjectName: "Maths", periodsPerWeek: 4, maxPerDay: 1 })),
    totals: [], dropped: [],
  });
  const teacher = (name: string, extra: Partial<TeacherAnswer> = {}): TeacherAnswer =>
    ({ name, employeeCode: name, subjects: ["Maths"], maxPeriodsPerWeek: 40, ...extra });

  it("staffs only the classes a teacher was declared for", () => {
    // The whole point: what somebody ticks on the Teachers step is what the
    // Allocation grid arrives already filled in with.
    const plan = suggestMappings(
      WINGS,
      curriculum(["Class 1", "Class 2", "Class 3"]),
      [teacher("Narrow", { classes: ["Class 1", "Class 2"] }), teacher("Wide")],
    );
    const forNarrow = plan.mappings.filter((m) => m.employeeCode === "Narrow")
      .flatMap((m) => m.classSections);
    expect(forNarrow.every((cs) => cs.startsWith("Class 1") || cs.startsWith("Class 2"))).toBe(true);
    // And Class 3 still gets taught — by the teacher who did not narrow.
    expect(plan.mappings.some((m) => m.classSections[0].startsWith("Class 3"))).toBe(true);
    expect(plan.uncovered).toEqual([]);
  });

  it("treats an empty list as NOT STATED, never as no classes", () => {
    // Invariant 7, and the direction that matters: read the other way, every
    // teacher in every school that predates this field becomes eligible for
    // nothing and no school generates.
    const plan = suggestMappings(WINGS, curriculum(["Class 1"]), [teacher("Unstated", { classes: [] })]);
    expect(plan.uncovered).toEqual([]);
    expect(plan.mappings).toHaveLength(1);
  });

  it("lets named classes override the wing, and says so when nobody is scoped", () => {
    // Both say which classes; the more specific statement is the deliberate one.
    const plan = suggestMappings(
      WINGS,
      curriculum(["Class 3"]),
      [teacher("Junior only", { wing: "Junior", classes: ["Class 1"] })],
    );
    expect(plan.mappings).toEqual([]);
    // The reason has to name the real problem: being told to hire when the fix
    // is a tick box wastes a morning.
    expect(plan.uncovered[0].reason).toBe("Nobody who teaches Maths is scoped to Class 3.");
  });

  it("writes the declared classes as the Teaching Scope, not the wing's", () => {
    const rows = teacherSheets([teacher("Narrow", { wing: "Junior", classes: ["Class 1", "Class 2"] })], WINGS);
    expect(rows[0].rows[0].cells["Teaching Scope"]).toBe("Class 1, Class 2");
  });

  it("falls back to the wing's classes when none are named", () => {
    const rows = teacherSheets([teacher("Wing only", { wing: "Junior" })], WINGS);
    expect(rows[0].rows[0].cells["Teaching Scope"]).toBe("Class 1, Class 2, Class 3");
  });
});
