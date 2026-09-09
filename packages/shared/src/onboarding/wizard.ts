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
}

export interface SessionAnswer {
  name: string;
  startDate: string;
  endDate: string;
}

export interface WizardAnswers {
  session?: SessionAnswer;
  wings?: WingAnswer[];
}

/** One row of the grid under the slider. */
export interface PlannedClass {
  className: string;
  /** Ladder position, which becomes `classes.sequence`. */
  sequence: number;
  wing: string;
  sections: string[];
}

/**
 * Expand the wings into the class rows they describe.
 *
 * A class named by two wings is a data error rather than something to merge:
 * `classes.name` is unique per school, so "Class 6 in Middle and Class 6 in
 * Senior" cannot both exist. Reported, not silently deduplicated — the admin
 * has to decide which wing teaches it.
 */
export function planClasses(wings: WingAnswer[]): {
  classes: PlannedClass[];
  issues: Array<{ message: string; fix: string }>;
} {
  const classes: PlannedClass[] = [];
  const issues: Array<{ message: string; fix: string }> = [];
  const claimedBy = new Map<string, string>();

  for (const wing of wings ?? []) {
    const lo = Math.max(0, Math.min(CLASS_LADDER.length - 1, wing.fromIndex));
    const hi = Math.max(lo, Math.min(CLASS_LADDER.length - 1, wing.toIndex));
    for (let i = lo; i <= hi; i++) {
      const className = CLASS_LADDER[i];
      const over = wing.overrides?.[className];
      if (over?.removed) continue;

      const owner = claimedBy.get(className);
      if (owner && owner !== wing.name) {
        issues.push({
          message: `${className} is in both ${owner} and ${wing.name}.`,
          fix: `A class belongs to one wing — narrow one of the two ranges, or remove ${className} from one of them in the grid below.`,
        });
        continue;
      }
      claimedBy.set(className, wing.name);

      const count = Math.max(1, Math.min(60, over?.sections ?? wing.sections ?? 1));
      classes.push({
        className,
        // 1-based ladder position. The gap-free ordering is what matters, not
        // the absolute number.
        sequence: i + 1,
        wing: wing.name,
        sections: sectionLetters(count),
      });
    }
  }
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
export function classSheets(answers: WizardAnswers): {
  sheets: RawSheet[];
  issues: Array<{ message: string; fix: string }>;
} {
  const { classes, issues } = planClasses(answers.wings ?? []);
  if (classes.length === 0) return { sheets: [], issues };
  const year = answers.session?.name ?? "";

  const classRows = classes.map((c) => ({ "Class Name": c.className, Sequence: c.sequence }));
  const sectionRows = classes.flatMap((c) =>
    c.sections.map((s) => ({
      "Class Name": c.className,
      "Section Name": s,
      "Academic Year": year,
      Timetable: c.wing,
    })),
  );

  return { sheets: [asSheet("Classes", classRows), asSheet("Class Sections", sectionRows)], issues };
}

/** What the grid and the summary line show, without touching the database. */
export function planSummary(answers: WizardAnswers): {
  classes: number;
  sections: number;
  perWing: Array<{ wing: string; classes: number; sections: number }>;
} {
  const { classes } = planClasses(answers.wings ?? []);
  const byWing = new Map<string, { classes: number; sections: number }>();
  for (const c of classes) {
    const e = byWing.get(c.wing) ?? { classes: 0, sections: 0 };
    e.classes += 1;
    e.sections += c.sections.length;
    byWing.set(c.wing, e);
  }
  return {
    classes: classes.length,
    sections: classes.reduce((n, c) => n + c.sections.length, 0),
    perWing: [...byWing.entries()].map(([wing, v]) => ({ wing, ...v })),
  };
}

/**
 * The week's capacity: periods per day × working days.
 *
 * The same arithmetic `capacityForClassSections` does on the server, shown
 * while somebody types rather than discovered at Readiness — because it is the
 * ceiling every later periods/week entry is checked against, and a school that
 * finds out at step 9 has to come back to step 5.
 */
export function weeklyCapacity(periodsPerDay: number, workingDays: number[]): number {
  return Math.max(0, Math.floor(periodsPerDay)) * (workingDays?.length ?? 0);
}
