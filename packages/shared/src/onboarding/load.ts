/**
 * §15.3 Phase 28 — how heavily a plan loads each teacher, and what to do about it.
 *
 * This module exists because of one sentence that used to be true and is not
 * any more. `Syllabus.tsx` said:
 *
 *   > **Load and capacity limits.** The §16 importer runs `assertWithinWeek` on
 *   > every row it writes. A second opinion here that the server then
 *   > contradicts would be worse than no opinion at all.
 *
 * That reasoning was right, and the Allocation screen needs the opinion anyway —
 * a page whose whole point is a live load rail cannot ask the server after every
 * keystroke. The resolution is not to break the rule but to remove the second
 * opinion: **the arithmetic lives here, and the server calls the same function.**
 * It stops being two answers and becomes one answer, computed in two places.
 *
 * Two pieces of arithmetic are easy to get wrong and are therefore owned here
 * rather than at any call site:
 *
 *  1. **A merged group costs its teacher ONE lesson, not one per section.**
 *     §4.10: several sections taught together are a single occupancy event —
 *     which is exactly why merging relieves load without taking a subject away
 *     from anybody. Multiplying by `classSections.length` regardless is the bug
 *     this rule exists to prevent.
 *  2. **Daily reach is a real ceiling, separate from the weekly cap.** A teacher
 *     whose subjects all run one period a day per class can teach at most
 *     `reach × days` in a week however generous their weekly cap is — Check 3's
 *     other half, and the reason `suggestMappings` tracks it while assigning.
 *     It is reported *beside* the weekly figure, never folded into it: they are
 *     two different limits with two different fixes, and a single blended
 *     percentage would name neither.
 */
import {
  defaultsFor,
  type CurriculumCell, type MappingSuggestion, type SubjectAnswer, type TeacherAnswer,
} from "./suggest";
import { planClasses, type WingAnswer } from "./wizard";

/**
 * Where a teacher sits against their weekly cap.
 *
 * Four bands, not three, and the split between `full` and `over` is the load
 * bearing one: a teacher at exactly their cap is the outcome the screen is
 * steering towards, and painting them the same colour as somebody 5 periods
 * over would mean the screen could not tell you which one you must act on.
 */
export type LoadBand = "ok" | "warn" | "full" | "over";

/**
 * 75% — the default point at which a teacher stops having comfortable room.
 *
 * §28.1 made this a per-timetable setting (`timetable_config.load_alert_pct`),
 * because where the line sits is a school's judgement rather than ours. This
 * stays as the default for a caller that has no config to hand.
 */
export const LOAD_WARN_AT = 0.75;

/**
 * @param warnAt fraction (0–1) at which "getting full" begins. Defaults to 75%.
 */
export function loadBand(used: number, cap: number, warnAt: number = LOAD_WARN_AT): LoadBand {
  if (cap <= 0) return used > 0 ? "over" : "ok";
  const pct = used / cap;
  // Compared with a tolerance rather than `===`: these are integers today, but
  // a band that flips on a floating-point hair is a bug nobody can reproduce.
  if (pct > 1 + 1e-9) return "over";
  if (pct >= 1 - 1e-9) return "full";
  // Clamped, so a school that sets 100 gets "full or over" rather than a `warn`
  // band that can never be entered and an `ok` band that runs to the limit.
  return pct >= Math.max(0, Math.min(1, warnAt)) ? "warn" : "ok";
}

export interface TeacherLoad {
  employeeCode: string;
  name: string;
  /** Their stated weekly ceiling — the denominator the screen shows. */
  cap: number;
  used: number;
  /** `used / cap`, or 0 when they have no cap at all. */
  pct: number;
  band: LoadBand;
  /**
   * Σ of the per-day caps of everything assigned to them (§ Check 3).
   *
   * NOT shown as a percentage. `reachCap` below is what it means in a week.
   */
  reach: number;
  /** `reach × working days` — the most this particular plan could ever hold. */
  reachCap: number;
  /** True when the days available bite before the weekly cap does. */
  dayBound: boolean;
  subjects: string[];
  /** Every class-section they stand in front of, merged groups expanded. */
  sections: string[];
  /** Indices into the mappings array, so a caller can act without re-searching. */
  rows: number[];
  guest: boolean;
  wing?: string;
}

export interface LoadInput {
  wings: WingAnswer[];
  /** The curriculum cells — read for `maxPerDay`, which drives reach. */
  curriculum: CurriculumCell[];
  mappings: MappingSuggestion[];
  teachers: TeacherAnswer[];
  /**
   * The subject list — read ONLY for §26.2 `category`, which decides whether a
   * merge may be proposed. Optional, and its absence means no merge is ever
   * suggested, which is the safe direction.
   */
  subjects?: SubjectAnswer[];
  /** Working days per wing. Defaults to five, matching `suggestMappings`. */
  daysByWing?: Record<string, number>;
  /**
   * §28.1 — the school's own "getting full" line, as a fraction.
   *
   * Read from `timetable_config.load_alert_pct`. Absent means 75%, which is
   * what every caller got before the setting existed.
   */
  warnAt?: number;
}

/** The employee code a teacher is known by — minted the way the sheet mints it. */
export function codeOf(t: TeacherAnswer, index: number): string {
  return t.employeeCode?.trim() || `T-${String(index + 1).padStart(3, "0")}`;
}

/** "Class 3-A" → "Class 3". Only the LAST segment is a section, so a class whose
 *  own name contains a hyphen ("Pre-Nursery") survives intact. */
export const classOfSection = (label: string): string =>
  (label ?? "").trim().replace(/-[^-]+$/, "");

/**
 * What one mapping row costs the teacher who holds it.
 *
 * The merged case is the whole reason this is a function. Four sections taught
 * together at 3 periods a week cost 3, not 12 — and getting that wrong would
 * make the advisor's own merge suggestion appear to change nothing.
 */
export function costOf(m: MappingSuggestion): number {
  const sections = Math.max(1, m.classSections.length);
  return m.periodsPerWeek * (m.merged ? 1 : sections);
}

/**
 * Every teacher's load under a given plan.
 *
 * Returns them **heaviest first**, because that is the only order in which a
 * rail of 122 chips answers the question somebody actually has.
 */
export function computeLoads(input: LoadInput): TeacherLoad[] {
  const { classes } = planClasses(input.wings ?? []);
  const wingOfClass = new Map(classes.map((c) => [c.className, c.wing]));
  const days = (wing: string | undefined): number =>
    (wing ? input.daysByWing?.[wing] : undefined) ?? 5;

  const perDay = new Map<string, number>();
  for (const c of input.curriculum ?? []) {
    perDay.set(`${c.className.toLowerCase()}|${c.subjectName.toLowerCase()}`, c.maxPerDay ?? 1);
  }

  const out = new Map<string, TeacherLoad>();
  (input.teachers ?? []).forEach((t, i) => {
    const code = codeOf(t, i);
    out.set(code, {
      employeeCode: code,
      name: t.name,
      cap: t.maxPeriodsPerWeek ?? 30,
      used: 0,
      pct: 0,
      band: "ok",
      reach: 0,
      reachCap: 0,
      dayBound: false,
      subjects: [],
      sections: [],
      rows: [],
      guest: t.employmentType === "guest",
      wing: t.wing,
    });
  });

  (input.mappings ?? []).forEach((m, i) => {
    const row = out.get(m.employeeCode);
    // A mapping naming somebody who is not on the staff list is a coverage
    // problem, not a load one — `coverageGaps` reports it. Silently inventing
    // a teacher here would put a phantom on the rail.
    if (!row) return;
    row.used += costOf(m);
    row.rows.push(i);
    if (!row.subjects.includes(m.subjectName)) row.subjects.push(m.subjectName);
    for (const cs of m.classSections) if (!row.sections.includes(cs)) row.sections.push(cs);
    const className = classOfSection(m.classSections[0] ?? "");
    const cap = perDay.get(`${className.toLowerCase()}|${m.subjectName.toLowerCase()}`) ?? 1;
    // Reach counts the SECTIONS a teacher must visit, because each is a
    // separate lesson on a separate day-slot — except a merged group, which is
    // one lesson however many sections attend it.
    row.reach += cap * (m.merged ? 1 : Math.max(1, m.classSections.length));
  });

  for (const row of out.values()) {
    const wing = row.wing
      ?? wingOfClass.get(classOfSection(row.sections[0] ?? ""))
      ?? undefined;
    row.reachCap = row.reach * days(wing);
    row.dayBound = row.reach > 0 && row.reachCap < row.used;
    row.pct = row.cap > 0 ? row.used / row.cap : 0;
    row.band = loadBand(row.used, row.cap, input.warnAt);
  }

  return [...out.values()].sort(
    (a, b) => b.pct - a.pct || b.used - a.used || a.name.localeCompare(b.name),
  );
}

// ─────────────────────────────────────────────────────────────── easing it

/**
 * A way to relieve a load, in the §21 vocabulary the Feasibility Engine speaks.
 *
 * Three verbs, and the distinction between them is a product decision rather
 * than a taxonomy:
 *
 *  - `redistribute` moves teaching to somebody with room. Nothing about the
 *    school changes except who stands in front of whom.
 *  - `complete` fills in something nobody has stated yet.
 *  - `relax` changes the RULE — raises a cap, cuts a subject's periods. It is
 *    always offered last, always priced in plain words, and (per invariant 19)
 *    never applied by a standing consent: a resolver free to loosen limits can
 *    take any school to a clean board without changing one real thing.
 */
export type LoadChange =
  | { type: "reassign"; rowIndex: number; toCode: string }
  | { type: "merge"; rowIndexes: number[]; className: string; subjectName: string }
  | { type: "assign"; classSection: string; subjectName: string; periodsPerWeek: number; toCode: string }
  | { type: "raiseCap"; employeeCode: string; from: number; to: number }
  | { type: "trimPeriods"; className: string; subjectName: string; from: number; to: number }
  /**
   * Nothing to apply — but the row still has to exist.
   *
   * An unstaffed lesson with no candidate is the most important thing on the
   * list, and dropping it because we have no button would hide the one problem
   * that stops the school generating. Explicit rather than a `raiseCap` with an
   * empty code, which a caller looping over changes would try to run.
   */
  | { type: "none"; reason: string };

export interface LoadRemedy {
  kind: "redistribute" | "complete" | "relax";
  /** One line naming what happens. */
  title: string;
  /** The arithmetic and the consequence, for somebody deciding. */
  detail: string;
  /** Who this is about, so the screen can point at them. */
  employeeCode?: string;
  change: LoadChange;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * What could be done about the teachers who are over, and the lessons nobody
 * has been given.
 *
 * Deliberately **not** a solver. It proposes one good move per problem rather
 * than searching for an optimum, because every one of these is a decision a
 * human makes and a list of forty near-identical options is not help. The
 * screen applies them one at a time and recomputes, so a second pass sees the
 * world the first pass made.
 */
export function relieveLoad(input: LoadInput): LoadRemedy[] {
  const loads = computeLoads(input);
  const mappings = input.mappings ?? [];
  const teachers = input.teachers ?? [];
  const { classes } = planClasses(input.wings ?? []);
  const byClassName = new Map(classes.map((c) => [c.className, c]));

  /** Subject names each teacher listed, lower-cased, for eligibility. */
  const listed = new Map<string, Set<string>>();
  /** §27.9 — the classes they were declared for. Empty means "not stated". */
  const scoped = new Map<string, Set<string>>();
  teachers.forEach((t, i) => {
    const code = codeOf(t, i);
    listed.set(code, new Set((t.subjects ?? []).map((s) => s.toLowerCase())));
    scoped.set(code, new Set((t.classes ?? []).map((c) => c.toLowerCase())));
  });
  const canTeach = (code: string, subject: string) =>
    listed.get(code)?.has(subject.toLowerCase()) ?? false;
  /**
   * §27.9/§18 — may this teacher take this class at all?
   *
   * Checked on every proposal, not only on the eligibility list. A remedy that
   * moved Class 5 Maths to somebody scoped to Class 9–10 would be applied by a
   * click and then refused by the importer, which is the worst of both: the
   * advisor looks wrong and the school still has the overload.
   */
  const canTakeClass = (code: string, classLabel: string) => {
    const s = scoped.get(code);
    if (!s || s.size === 0) return true;              // not stated, never "none"
    return s.has(classOfSection(classLabel).toLowerCase());
  };

  /**
   * Which subjects may be merged across sections without anybody deciding
   * something bigger than a load problem.
   *
   * Read from the §26.2 `category` the school set, falling back to the SAME
   * classifier the importer and the Subjects screen use — never a second guess
   * beside it. A subject the list does not mention is treated as core, which is
   * the safe direction: the cost of a wrong "yes" is four sections of Maths in
   * one room, and the cost of a wrong "no" is one suggestion not offered.
   */
  const coScholastic = new Set(
    (input.subjects ?? [])
      .filter((s) => (s.category ?? defaultsFor(s.name).category) === "co_scholastic")
      .map((s) => s.name.toLowerCase()),
  );

  const out: LoadRemedy[] = [];
  const relax: LoadRemedy[] = [];

  for (const t of loads.filter((l) => l.band === "over")) {
    const excess = t.used - t.cap;

    // ── redistribute: hand one class to somebody who can take it ──────────
    let best: { rowIndex: number; to: TeacherLoad; cost: number } | null = null;
    for (const rowIndex of t.rows) {
      const m = mappings[rowIndex];
      if (!m) continue;
      const cost = costOf(m);
      const candidate = loads
        .filter((x) =>
          x.employeeCode !== t.employeeCode &&
          !x.guest &&                                   // §18: guests are not curriculum
          canTeach(x.employeeCode, m.subjectName) &&
          m.classSections.every((cs) => canTakeClass(x.employeeCode, cs)) &&
          x.used + cost <= x.cap)
        .sort((a, b) => a.pct - b.pct)[0];
      if (!candidate) continue;
      // Prefer the move that lands closest to clearing the excess without
      // overshooting into "we moved half their timetable".
      if (!best || Math.abs(cost - excess) < Math.abs(best.cost - excess)) {
        best = { rowIndex, to: candidate, cost };
      }
    }
    if (best) {
      const m = mappings[best.rowIndex];
      out.push({
        kind: "redistribute",
        employeeCode: t.employeeCode,
        title: `Move ${m.classSections.join(", ")} ${m.subjectName} to ${best.to.name}`,
        detail:
          `${plural(best.cost, "period")} a week. ${t.employeeCode} ${t.used} → ${t.used - best.cost} of ${t.cap}; ` +
          `${best.to.employeeCode} ${best.to.used} → ${best.to.used + best.cost} of ${best.to.cap}. ` +
          `Nothing about the school changes except who stands in front of ${m.classSections.join(", ")}.`,
        change: { type: "reassign", rowIndex: best.rowIndex, toCode: best.to.employeeCode },
      });
    }

    // ── redistribute: teach several sections of one class together ────────
    const mergeable = new Map<string, number[]>();
    for (const rowIndex of t.rows) {
      const m = mappings[rowIndex];
      if (!m || m.merged || m.classSections.length !== 1) continue;
      const className = classOfSection(m.classSections[0]);
      const key = `${className}|${m.subjectName}`;
      mergeable.set(key, [...(mergeable.get(key) ?? []), rowIndex]);
    }
    for (const [key, rowIndexes] of mergeable) {
      if (rowIndexes.length < 2) continue;
      const [className, subjectName] = key.split("|");
      // Only where merging is an ordinary decision. Four sections of Games on
      // the field is normal; four sections of Maths in one room is a decision
      // about children, not about load — and this module must not make it.
      if (!coScholastic.has(subjectName.toLowerCase())) continue;
      const each = mappings[rowIndexes[0]].periodsPerWeek;
      const saved = each * (rowIndexes.length - 1);
      if (saved <= 0) continue;
      const sections = rowIndexes.flatMap((i) => mappings[i].classSections);
      out.push({
        kind: "redistribute",
        employeeCode: t.employeeCode,
        title: `Teach ${className} ${subjectName} to ${sections.join(", ")} together`,
        detail:
          `One lesson instead of ${rowIndexes.length}. ${t.employeeCode} ${t.used} → ${t.used - saved} of ${t.cap}. ` +
          `Every child still gets ${plural(each, "period")} a week — they are taught in one group rather than ${rowIndexes.length}. ` +
          `Offered because ${subjectName} is co-scholastic; a core subject is not merged by a load calculation.`,
        change: { type: "merge", rowIndexes, className, subjectName },
      });
      break;                                   // one merge proposal per teacher
    }

    // ── relax, always last, always priced ─────────────────────────────────
    const raise = Math.max(5, Math.ceil(excess / 5) * 5);
    relax.push({
      kind: "relax",
      employeeCode: t.employeeCode,
      title: `Raise ${t.name}'s weekly limit from ${t.cap} to ${t.cap + raise}`,
      detail:
        `Nothing else moves — the timetable is unchanged, the limit is not. ` +
        `Worth asking whether ${plural(t.used, "period")} a week is a week somebody can actually teach.`,
      change: { type: "raiseCap", employeeCode: t.employeeCode, from: t.cap, to: t.cap + raise },
    });
  }

  // ── complete: a lesson nobody has been given ────────────────────────────
  const covered = new Set<string>();
  for (const m of mappings) {
    for (const cs of m.classSections) {
      covered.add(`${cs.trim().toLowerCase()}|${m.subjectName.toLowerCase()}`);
    }
  }
  for (const cell of input.curriculum ?? []) {
    const cls = byClassName.get(cell.className);
    if (!cls || cell.periodsPerWeek <= 0) continue;
    for (const section of cls.sections) {
      const label = `${cls.className}-${section}`;
      if (covered.has(`${label.toLowerCase()}|${cell.subjectName.toLowerCase()}`)) continue;
      const who = loads
        .filter((x) =>
          !x.guest &&
          canTeach(x.employeeCode, cell.subjectName) &&
          canTakeClass(x.employeeCode, label) &&
          x.used + cell.periodsPerWeek <= x.cap)
        .sort((a, b) => a.pct - b.pct)[0];
      out.push({
        kind: "complete",
        employeeCode: who?.employeeCode,
        title: `${label} ${cell.subjectName} has nobody teaching it`,
        detail: who
          ? `${who.name} has ${plural(who.cap - who.used, "period")} spare. ` +
            `${who.employeeCode} ${who.used} → ${who.used + cell.periodsPerWeek} of ${who.cap}.`
          : `Nobody who teaches ${cell.subjectName} has room for ${plural(cell.periodsPerWeek, "period")} a week. ` +
            `Add a teacher on the Teachers step, or raise a limit below.`,
        change: who
          ? {
              type: "assign",
              classSection: label,
              subjectName: cell.subjectName,
              periodsPerWeek: cell.periodsPerWeek,
              toCode: who.employeeCode,
            }
          : {
              type: "none",
              reason: `Nobody who teaches ${cell.subjectName} has room for it.`,
            },
      });
    }
  }

  // Relax sinks, always. Somebody scrolling to the bottom of this list should
  // find the loosening options because they went looking, never because they
  // were the first thing offered.
  return [...out, ...relax];
}
