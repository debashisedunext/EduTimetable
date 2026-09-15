/**
 * §15.3 Phase 25.3 — turning a guided setup's answers into importer rows.
 *
 * The pure half of the wizard: no database, no HTTP, no React. It takes what
 * somebody typed and produces the same `RawSheet[]` an uploaded spreadsheet
 * produces, so the guided path commits through **exactly** the §16 pipeline the
 * Excel importer, the ERP sync and the AI assistant already share.
 *
 * That is not tidiness, it buys three things outright:
 *
 *  1. **The same validation.** Duplicate detection, cross-sheet references,
 *     VarChar limits, the capacity guard — all of it, without a line of it
 *     being written again for this path.
 *  2. **Idempotency for free.** The importer SKIPS rows that already exist by
 *     natural key. So pressing Next twice, resuming a draft, or re-running a
 *     step creates nothing extra. Without this the wizard would need its own
 *     "have I already made these?" bookkeeping, and that bookkeeping is where
 *     duplicate classes come from.
 *  3. **One committer.** A wizard with its own writer would be the fourth way
 *     rows enter this database, and it would drift from the other three exactly
 *     as documented for each of them.
 *
 * What is deliberately NOT here: the timetable config itself. §16 is masters
 * only — period and break structure stays in the wizard — so wings and the week
 * go through `POST /timetable-configs` and `PUT /:id/structure`, which already
 * exist and already own that shape.
 */
import type { RawSheet } from "../import/types";
import { weekPeriods, type DayShape } from "./week-shape";

/**
 * The class ladder: a fixed, ordered vocabulary.
 *
 * Ordered rather than free text because the position IS `classes.sequence`, and
 * that is what makes every later screen sort classes in school order instead of
 * alphabetically ("Class 10" before "Class 2" is the alternative). A school
 * whose classes are not on this ladder types them in the Setup Wizard instead —
 * the guided path is for the ordinary case, and it says so.
 */
export const CLASS_LADDER = [
  "Pre-Nursery", "Nursery", "LKG", "UKG",
  "Class 1", "Class 2", "Class 3", "Class 4", "Class 5", "Class 6",
  "Class 7", "Class 8", "Class 9", "Class 10", "Class 11", "Class 12",
] as const;

/** Short labels for the slider's tick marks, where "Pre-Nursery" will not fit. */
/**
 * Where a class sits on the ladder — 1 for Pre-Nursery, 16 for Class 12, and
 * **0** for a name the ladder does not know.
 *
 * This is the one definition of what `classes.sequence` means, and it had to
 * become one: the guided setup wrote the ladder position while `POST /classes`
 * and the §16 importer defaulted to `0` and `scripts/school2-model.cjs`
 * hand-numbered a school with no LKG or UKG from 1 to 14. Two vocabularies for
 * one column, and they met — adding LKG to that school gave it sequence 3,
 * which Class 1 already held, and MySQL then ordered the tie arbitrarily. The
 * Master Grid drew LKG-A, Class 1-A, Class 1-B, LKG-B, Class 1-C, LKG-C.
 *
 * It is not only an ordering. `bandOf` and `subjectSuitsClass` in `suggest.ts`
 * compare this number against ABSOLUTE ladder positions to decide which
 * subjects a class is offered — so a school numbered 1..14 with no LKG had
 * Class 9 reading as "upper" rather than "senior" long before anything looked
 * out of order on a screen. A renumbering that only closed the gaps would have
 * left that wrong, which is why 0 is the answer for an off-ladder name rather
 * than "the next number": we know where Class 7 belongs and we do not know
 * where Playgroup belongs, and pretending otherwise is how the two vocabularies
 * started.
 */
export function ladderSequence(className: string): number {
  return (CLASS_LADDER as readonly string[]).indexOf(className.trim()) + 1;
}

export const CLASS_LADDER_SHORT = [
  "Pre-Nur", "Nur", "LKG", "UKG",
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12",
] as const;

/**
 * Section letters: A…Z, then AA, AB…
 *
 * Not `String.fromCharCode(65 + i)` alone, which produces `[`, `\` and `]` for a
 * 27th, 28th and 29th section — nonsense that would sail past a VarChar(10) and
 * land in the database.
 */
export function sectionLetters(count: number): string[] {
  const n = Math.max(0, Math.min(200, Math.floor(count)));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      i < 26
        ? String.fromCharCode(65 + i)
        : String.fromCharCode(65 + Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)),
    );
  }
  return out;
}

/**
 * The three wings almost every school actually has, ready to be tapped.
 *
 * An empty box asking "which wings does the school timetable separately?" is a
 * question about *our* vocabulary, not theirs: a wing is a concept the admin
 * meets for the first time on that screen, and typing a name for something you
 * have just been introduced to is the slowest possible first step. Three named
 * suggestions turn it into recognition — and the names are the ordinary Indian
 * ones, so most schools are looking at their own structure already.
 *
 * They are *starting points*, not a menu: the name is editable before it is
 * added and the range is dragged on the next step. This lives here rather than
 * in the screen because the AI interviewer offers the same three, and two doors
 * into the same setup naming wings differently would be a small lie about how
 * the product thinks.
 */
export const WING_SUGGESTIONS: ReadonlyArray<{
  name: string;
  fromIndex: number;
  toIndex: number;
}> = [
  { name: "Primary Wing", fromIndex: 4, toIndex: 8 },       // Class 1 – Class 5
  { name: "Secondary Wing", fromIndex: 9, toIndex: 13 },    // Class 6 – Class 10
  { name: "Higher Secondary", fromIndex: 14, toIndex: 15 }, // Class 11 – Class 12
];

/**
 * What a wing looks like before anybody has touched the ladder.
 *
 * Class 1 – Class 6, two sections each: somewhere useful for the slider to open
 * rather than collapsed on Pre-Nursery. A name that matches one of the
 * suggestions above takes THAT range instead, so typing "Primary Wing" means
 * the same wing whichever door it was typed into.
 *
 * One definition because there are three doors that create a wing now — step
 * 3's "+ Add wing", `answersFromSchool` rebuilding a wing that has no classes
 * yet, and the Timetables screen's New Timetable (§3.10a) — and all three had
 * their own copy of `4`, `9` and `2`. Two doors defaulting the same thing
 * differently is a small lie about how the product thinks, and it is only ever
 * found by a school.
 */
export const DEFAULT_WING_SECTIONS = 2;

export function wingRangeFor(name: string): { fromIndex: number; toIndex: number } {
  const wanted = name.trim().toLowerCase();
  const match = WING_SUGGESTIONS.find((s) => s.name.toLowerCase() === wanted);
  return match
    ? { fromIndex: match.fromIndex, toIndex: match.toIndex }
    : { fromIndex: 4, toIndex: 9 };
}

/** One wing: a name, a class range on the ladder, and how many sections each. */
export interface WingAnswer {
  name: string;
  /** Inclusive indices into CLASS_LADDER. */
  fromIndex: number;
  toIndex: number;
  sections: number;
  /** Per-class overrides, by class name — the grid's edits. */
  overrides?: Record<string, { sections?: number; removed?: boolean }>;
  /**
   * §30.9 — this wing stands alone, in a §30 resource pool of its own.
   *
   * A boolean is enough to identify the pool, and that is not a shortcut: an
   * individual pool holds **exactly one** timetable — `assertAdmits` is the
   * rule, and CLAUDE.md states it as "an individual timetable cannot have more
   * than one wing" — so the wing IS the pool. Grouped wings all share the
   * session's one pool, so `false`/absent identifies that pool just as
   * completely.
   *
   * Absent means grouped, which is every wing that existed before §30.9 and
   * every wing the wizard creates itself.
   */
  individual?: boolean;
}

/**
 * §30.9 — which resource pool a wing competes in.
 *
 * The string is an identity, not a label: two wings share classes, rooms,
 * teachers and a timetable slot only when this matches. It exists because
 * "which pool?" was being answered in three places by three different pieces of
 * code, all of which had the same bug — none of them asked.
 *
 * `planClasses` uses it to decide whether two wings claiming Class 1 are in
 * conflict (§30 says they are not, if they are in different pools), and the
 * guided setup uses it to decide which wings to show at all.
 */
export const wingScope = (w: Pick<WingAnswer, "name" | "individual">): string =>
  w.individual ? `individual:${w.name.trim().toLowerCase()}` : "grouped";

/** The shared pool every ordinary wing belongs to. */
export const GROUPED_SCOPE = "grouped";

export interface SessionAnswer {
  name: string;
  startDate: string;
  endDate: string;
}

export interface WizardAnswers {
  session?: SessionAnswer;
  wings?: WingAnswer[];
}

/**
 * §30.13 — put a step's edited wing list back into the whole one, in place.
 *
 * The guided setup hands a step only the wings it may edit — since §30.13 that
 * is a single timetable, because the top bar is the one selector and editing is
 * one timetable at a time — and the stored draft must keep every wing. Losing
 * the others on a save would be a far worse bug than any this narrowing fixes.
 *
 * **Merged against what the step was SHOWN, by reference**, which is the whole
 * subtlety. The wizard's own version matched on the §30 pool instead, and that
 * was right only while a step saw every wing in its pool. Once it saw one, a
 * grouped pool holding Main and New matched BOTH rows, took the single
 * incoming wing for the first and `undefined` for the second — and dropped New
 * out of the draft entirely. A silent deletion of a timetable, on any save by
 * a school with two grouped wings.
 *
 * Positional rather than by name, because a rename is exactly what a step
 * comes back with and the name is the key everything else in this flow uses
 * (`answers.weeks`, `commitWings`, the §16 importer). Identity is therefore
 * the array position among the shown wings, and `shown` must hold the same
 * objects as `all` — which it does, being a `filter`/`find` over it.
 *
 * Fewer wings back than were shown means one was removed; more means one was
 * added, and it is appended rather than spliced so a new wing does not jump
 * into the middle of somebody's list.
 *
 * Lives here rather than in the wizard because `apps/web` has no test harness
 * and this one can lose a school's timetable.
 */
export function mergeShownWings<T>(all: T[], shown: readonly T[], next: T[]): T[] {
  const isShown = new Set<T>(shown);
  const incoming = [...next];
  const out: T[] = [];
  for (const w of all) {
    if (!isShown.has(w)) { out.push(w); continue; }
    const take = incoming.shift();
    if (take !== undefined) out.push(take);
  }
  out.push(...incoming);
  return out;
}

/** One row of the grid under the slider. */
export interface PlannedClass {
  className: string;
  /** Ladder position, which becomes `classes.sequence`. */
  sequence: number;
  wing: string;
  sections: string[];
  /**
   * The sections of this class that ALREADY exist in this wing's pool.
   *
   * Always a prefix of `sections` — the letters are assigned in order and the
   * importer never deletes, so what exists is `A..`. Carried so the grid can
   * say which rows are records and which are a plan, and so "Remove" can be
   * withheld from a class that has rows (see `floorFor`).
   */
  existing: string[];
  /** The fewest sections this class may have — see `SchoolShape`. */
  floor: number;
  /**
   * §3.10c — this class is outside the wing's range and is here anyway,
   * because the wing already teaches it.
   *
   * The grid says so on the row; without it the class springs back the moment
   * the slider passes it and the slider reads as broken.
   */
  outsideRange?: boolean;
}

/**
 * §3.10b — what the school ALREADY is, which step 4 must not contradict.
 *
 * The Classes step was a pure plan: slider range x "sections per class",
 * computed entirely from the draft, never asking the database anything. That is
 * wrong in a way that is hard to see, because the §16 importer skips by natural
 * key and has no delete path — so a screen showing 2 sections for a class that
 * has 4 creates nothing, deletes nothing, and reports success. The number is
 * simply believed, and it is wrong.
 *
 * Two facts, deliberately separate:
 *
 *  - **`floors` is school-wide.** A class's section count is a fact about the
 *    school — Class 1 runs four sections — so the floor is the most sections
 *    any pool runs for it. A new timetable may add sections to a class and may
 *    decline to teach it at all, but it may not run *fewer* than the school
 *    does. That is a rule about the school's own record, not a §30
 *    resource-sharing check: each pool still gets its own `class_sections`
 *    rows, and nothing is shared between them.
 *  - **`existing` is per pool**, keyed by wing name — which is the natural key
 *    this whole flow already uses (`commitWings` skips by name, the §16
 *    importer skips by name). It answers "is this row a record or a plan?",
 *    which `floors` cannot: Class 1 having four sections school-wide says
 *    nothing about whether *this* timetable has any.
 *
 * Optional throughout. Absent means "not stated" (invariant 7) and yields
 * exactly the pre-§3.10b behaviour, which is what keeps the unit tests, the AI
 * interviewer and any caller that has no database in reach working unchanged.
 */
export interface SchoolShape {
  /** Class name → the most sections the school runs for it, in any pool. */
  floors?: Record<string, number>;
  /** Wing name → class name → the section letters that exist in that pool. */
  existing?: Record<string, Record<string, string[]>>;
}

/** Case-insensitive lookup, because a wing's name is typed by a human. */
const shapeFor = (shape: SchoolShape | undefined, wing: string): Record<string, string[]> => {
  const want = wing.trim().toLowerCase();
  for (const [name, classes] of Object.entries(shape?.existing ?? {})) {
    if (name.trim().toLowerCase() === want) return classes;
  }
  return {};
};

/**
 * Expand the wings into the class rows they describe.
 *
 * A class named by two wings **in the same pool** is a data error rather than
 * something to merge: within a §30 resource group a class-section belongs to
 * exactly one timetable, so "Class 6 in Middle and Class 6 in Senior" cannot
 * both exist. Reported, not silently deduplicated — the admin has to decide
 * which wing teaches it.
 *
 * Across pools it is not an error at all, and §30.9 is where that was fixed.
 * `class_sections` is unique on `(class, section, academic_year,
 * resource_group_id)` precisely so an individual timetable can run Class 1
 * while the main wings also run Class 1 — the two rows are different children
 * in different weeks, sharing nothing.
 *
 * The `classes` row itself is still one per school, which is why the returned
 * list may name the same class twice: once per pool. The §16 importer skips the
 * second by natural key and files the SECTIONS in their own pools, which is the
 * behaviour `classSectionsInPool` exists for.
 */
export function planClasses(wings: WingAnswer[], shape?: SchoolShape): {
  classes: PlannedClass[];
  /**
   * §30.11 — every issue names the POOL it belongs to.
   *
   * A clash is always between two wings of one pool (there is no other kind
   * since §30.9), and the caller usually needs to know which: the commit
   * refuses pool by pool, so a clash in the main school cannot hold an
   * individual timetable's rows hostage.
   */
  issues: Array<{ message: string; fix: string; scope: string }>;
} {
  const classes: PlannedClass[] = [];
  const issues: Array<{ message: string; fix: string; scope: string }> = [];
  /*
    §30.9 — keyed by POOL and class, not by class alone.

    "A class belongs to one wing" was never the whole rule; §30 made it
    "**within a resource group**, a class-section belongs to exactly one
    timetable". This map was the last place still enforcing the old one, and
    the effect was a school being told Class 1 was in two timetables that
    cannot see each other — with the offered fixes ("narrow one of the two
    ranges", "remove Class 1 from one of them") both being changes it must not
    make. An individual timetable exists precisely so it can teach Class 1
    while the main wings also teach Class 1.
  */
  const claimedBy = new Map<string, string>();

  for (const wing of wings ?? []) {
    const scope = wingScope(wing);
    const here = shapeFor(shape, wing.name);
    const lo = Math.max(0, Math.min(CLASS_LADDER.length - 1, wing.fromIndex));
    const hi = Math.max(lo, Math.min(CLASS_LADDER.length - 1, wing.toIndex));
    for (let i = lo; i <= hi; i++) {
      const className = CLASS_LADDER[i];
      const over = wing.overrides?.[className];
      const existing = here[className] ?? [];
      /*
        §3.10b — a class this pool already teaches cannot be removed here.

        Removing it only drops it from the SHEET, and the §16 importer has no
        delete path, so the rows survive either way. That is precisely the
        problem: the grid would stop listing a class whose children are still
        timetabled, and the next person to read this screen would believe it.
        Deleting a cohort is the Classes master's job, where the count of what
        is about to go is shown first (§27.11's rule).
      */
      if (over?.removed && existing.length === 0) continue;

      const owner = claimedBy.get(`${scope}\u0000${className}`);
      if (owner && owner !== wing.name) {
        issues.push({
          message: `${className} is in both ${owner} and ${wing.name}.`,
          fix: `A class belongs to one wing — narrow one of the two ranges, or remove ${className} from one of them in the grid below.`,
          scope,
        });
        continue;
      }
      claimedBy.set(`${scope}\u0000${className}`, wing.name);

      /*
        §3.10b — the school's own record is the floor, and it is applied HERE.

        Not in the screen. `planClasses` is what the grid draws *and* what
        `classSheets` turns into importer rows, so a floor enforced only by an
        `<input min>` would be a number the commit did not honour — the §10.6
        lesson about never re-deriving at a call site, in its other form.

        `existing.length` is in the max as well as `floors`, and not
        redundantly: `floors` is what the caller could see across the school,
        while `existing` is this pool's own rows. A stale or partial shape must
        never produce a plan that is smaller than the rows already filed under
        it.
      */
      const floor = Math.max(1, shape?.floors?.[className] ?? 1, existing.length);
      const asked = Math.max(1, Math.min(60, over?.sections ?? wing.sections ?? 1));
      const count = Math.max(asked, floor);
      classes.push({
        className,
        // The 1-based ladder position, and the ABSOLUTE number matters — see
        // `ladderSequence`, which is now the one definition of it. `i` is the
        // ladder index here, so this is that function inlined by construction.
        sequence: i + 1,
        wing: wing.name,
        sections: sectionLetters(count),
        existing,
        floor,
      });
    }

    /*
      §3.10c — a class this wing ALREADY teaches is kept, even when the range
      has moved off it.

      §3.10b floored the *sections* and withheld Remove from a class that has
      rows, on the grounds that the §16 importer has no delete path so the
      screen must not describe a school it is not going to produce. The RANGE
      was the hole in that: dragging the slider from Class 3 back to Class 2
      simply dropped Class 3 out of this loop, the sheet went out with two
      classes, the importer skipped both because they exist, and the commit
      answered *"Everything here already exists — nothing to add."* — which is
      true, and reads as success to somebody who has just removed a class.
      Class 3 was still there, still timetabled, and no longer on the screen
      that claims to list the school's classes.

      Kept rather than refused, because the range is a control for describing
      what a wing teaches and narrowing it is a reasonable thing to try. What
      it cannot do is un-teach children who are already in a timetable — that
      is the Classes master's job, where the count of what is about to go is
      shown first (§27.11's rule). `outsideRange` is how the grid says so
      rather than silently springing the class back and looking broken.

      In `planClasses` and not in the screen, for §3.10b's own reason: this
      function is what the grid draws AND what `classSheets` turns into
      importer rows, so a rule enforced only in a slider is a rule the commit
      does not honour.
    */
    for (const [className, existing] of Object.entries(here)) {
      if (existing.length === 0) continue;
      const i = (CLASS_LADDER as readonly string[]).indexOf(className);
      if (i < 0 || (i >= lo && i <= hi)) continue;
      const owner = claimedBy.get(`${scope}\u0000${className}`);
      if (owner && owner !== wing.name) continue;
      claimedBy.set(`${scope}\u0000${className}`, wing.name);
      const over = wing.overrides?.[className];
      const floor = Math.max(1, shape?.floors?.[className] ?? 1, existing.length);
      classes.push({
        className,
        sequence: i + 1,
        wing: wing.name,
        sections: sectionLetters(Math.max(Math.max(1, Math.min(60, over?.sections ?? existing.length)), floor)),
        existing,
        floor,
        outsideRange: true,
      });
    }
  }
  /*
    Ladder order WITHIN each wing, because the loop above appends the kept
    classes after the range rather than in place — and the grid reads this list
    top to bottom, where a Class 3 printed under Class 8 is a list nobody
    trusts.

    Keyed on the wing's position rather than compared for equality: a
    comparator returning 0 for two different wings leans on sort stability to
    keep the groups together, which is true today and is not a thing to rely on
    in a function that decides what gets written to the database.
  */
  const wingOrder = new Map((wings ?? []).map((w, i) => [w.name, i]));
  classes.sort((a, b) =>
    (wingOrder.get(a.wing) ?? 0) - (wingOrder.get(b.wing) ?? 0) || a.sequence - b.sequence);
  return { classes, issues };
}

const headersOf = (rows: Array<Record<string, unknown>>): string[] =>
  rows.length === 0 ? [] : Object.keys(rows[0]);

/** Rows numbered from 2, so any issue reads like a spreadsheet reference. */
const asSheet = (name: string, rows: Array<Record<string, unknown>>): RawSheet => ({
  name,
  headers: headersOf(rows),
  rows: rows.map((cells, i) => ({ row: i + 2, cells })),
});

/**
 * The session, as an `Academic Years` sheet.
 *
 * Committed at step 2 rather than held to the end, because everything after it
 * references the year by name: a class-section cannot exist without one.
 */
export function sessionSheets(session: SessionAnswer): RawSheet[] {
  if (!session?.name) return [];
  return [
    asSheet("Academic Years", [
      {
        Name: session.name,
        "Start Date": session.startDate,
        "End Date": session.endDate,
        Active: "Yes",
      },
    ]),
  ];
}

/**
 * The classes and their sections, as importer sheets.
 *
 * `Timetable` carries the wing's name, which is how a section is attached to
 * the right week — the same column an uploaded workbook uses, so the wizard
 * needs no attach step of its own.
 */
export function classSheets(answers: WizardAnswers, shape?: SchoolShape): {
  sheets: RawSheet[];
  issues: Array<{ message: string; fix: string; scope: string }>;
} {
  const { classes, issues } = planClasses(answers.wings ?? [], shape);
  if (classes.length === 0) return { sheets: [], issues };
  const year = answers.session?.name ?? "";

  /*
    §3.10d — a class the range has moved off is NOT in the sheet.

    §3.10c kept it in the plan so the grid could show it rather than letting it
    vanish silently, and that is still right: the row is on screen, marked, and
    says what pressing Next will do to it. But the sheet is the thing that
    ATTACHES a class-section to this timetable (§16.1 — it is the only door that
    fills a NULL `timetable_config_id`), so leaving it here would re-attach
    exactly the sections the commit is about to detach. The two would fight,
    and the sheet would win because it runs first.

    So: shown in the grid, absent from the sheet, detached by the commit. One
    decision expressed in three places that agree, rather than three places
    each deciding for themselves (§10.6).
  */
  const teaching = classes.filter((c) => !c.outsideRange);
  if (teaching.length === 0) return { sheets: [], issues };

  const classRows = teaching.map((c) => ({ "Class Name": c.className, Sequence: c.sequence }));
  const sectionRows = teaching.flatMap((c) =>
    c.sections.map((s) => ({
      "Class Name": c.className,
      "Section Name": s,
      "Academic Year": year,
      Timetable: c.wing,
    })),
  );

  return { sheets: [asSheet("Classes", classRows), asSheet("Class Sections", sectionRows)], issues };
}

/**
 * §3.10d — the classes each wing has stopped teaching, by name.
 *
 * What `commit(4)` detaches. Read off the same `planClasses` the grid drew, so
 * the badge somebody saw and the rows the commit moves cannot disagree — the
 * whole reason `outsideRange` is a field on the plan rather than a comparison
 * redone on the server.
 */
export function classesLeavingWing(
  answers: WizardAnswers,
  shape?: SchoolShape,
): Array<{ wing: string; className: string }> {
  return planClasses(answers.wings ?? [], shape).classes
    .filter((c) => c.outsideRange)
    .map((c) => ({ wing: c.wing, className: c.className }));
}

/** What the grid and the summary line show, without touching the database. */
export function planSummary(answers: WizardAnswers, shape?: SchoolShape): {
  classes: number;
  sections: number;
  perWing: Array<{ wing: string; classes: number; sections: number }>;
} {
  const { classes } = planClasses(answers.wings ?? [], shape);
  const byWing = new Map<string, { classes: number; sections: number }>();
  /*
    §3.10d — the classes this wing is about to LET GO are not counted.

    They are in the plan so the grid can show them and say what Next will do
    (§3.10c), but "this wing runs N classes" is a statement about the week that
    is being built, and a class the commit is about to detach is not part of it.
  */
  for (const c of classes.filter((x) => !x.outsideRange)) {
    const e = byWing.get(c.wing) ?? { classes: 0, sections: 0 };
    e.classes += 1;
    e.sections += c.sections.length;
    byWing.set(c.wing, e);
  }
  const teaching = classes.filter((c) => !c.outsideRange);
  return {
    classes: teaching.length,
    sections: teaching.reduce((n, c) => n + c.sections.length, 0),
    perWing: [...byWing.entries()].map(([wing, v]) => ({ wing, ...v })),
  };
}

/**
 * §33.4 — when the day would end, given the week somebody is typing.
 *
 * **Prospective, not actual.** The authority for a timetable that exists is its
 * `periods` rows, which is what `GET /:id/class-periods` reads: they carry real
 * start and end times and they get §28.4 right, where an activity before the
 * first period makes the day start *earlier* rather than pushing period 1
 * later. This answers the different question the guided setup has to answer —
 * *"what will this be when I press Next?"* — where no rows exist yet, so there
 * is nothing to read and the arithmetic is the only answer available.
 *
 * Keeping them separate is deliberate. Collapsing them would mean either the
 * step showing a stale figure from the last save while somebody edits, or the
 * server recomputing what it can already read.
 *
 * Returns `HH:MM`, or null when the start time is unusable — a half-typed
 * `"0"` in a time field is an ordinary state, and a confident "ends at 00:40"
 * is worse than showing nothing for a keystroke.
 */
export function dayEndsAt(week: {
  startTime: string;
  periodsPerDay: number;
  periodDurationMins: number;
  breaks?: Array<{ durationMins: number }>;
  activities?: Array<{ durationMins: number; placement?: string }>;
}): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((week.startTime ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;

  const teaching = Math.max(0, Math.floor(week.periodsPerDay || 0)) * Math.max(0, Math.floor(week.periodDurationMins || 0));
  const breaks = (week.breaks ?? []).reduce((n, b) => n + Math.max(0, b.durationMins || 0), 0);
  /*
    Only the activities that come AFTER the teaching day extend it. One before
    the first period moves the START earlier (§28.4) and so does not push the
    finish out; counting it here would add an assembly to both ends of the day.
  */
  const after = (week.activities ?? [])
    .filter((a) => a.placement === "after_last")
    .reduce((n, a) => n + Math.max(0, a.durationMins || 0), 0);

  const total = h * 60 + min + teaching + breaks + after;
  // A day that runs past midnight is nonsense a school would want to see
  // rather than a wrapped time that looks plausible.
  if (total >= 24 * 60) return null;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The week's capacity: periods per day × working days.
 *
 * The same arithmetic `capacityForClassSections` does on the server, shown
 * while somebody types rather than discovered at Readiness — because it is the
 * ceiling every later periods/week entry is checked against, and a school that
 * finds out at step 9 has to come back to step 5.
 */
export function weeklyCapacity(
  periodsPerDay: number,
  workingDays: number[],
  /**
   * §34 — weekdays that run a shape of their own (a short Saturday).
   *
   * Optional, and absent means every working day is `periodsPerDay` long —
   * which is every school that has not said otherwise, and is exactly the
   * product this function used to return. Supplying it turns the product into
   * the sum it has to be once one day can differ.
   */
  dayShapes?: DayShape[] | null,
): number {
  return weekPeriods({ periodsPerDay, dayShapes }, workingDays ?? []);
}
