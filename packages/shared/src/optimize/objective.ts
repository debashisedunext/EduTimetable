/**
 * §5.6 — the soft-objective model. Feasibility is binary and owned by the CSP
 * engine; THIS module defines what makes one feasible timetable *nicer* than
 * another. It is the single definition of "nice": the CP-SAT model minimizes
 * exactly these three terms, and the same scorer grades both engines' output
 * so "optimized mode" can be proven better rather than asserted.
 *
 * Pure functions over placements — no solver state, no I/O.
 */
import type { Placement, SolverInput, SolverVariable } from "../solver/types";

export interface ObjectiveWeights {
  /** free periods sandwiched between two teaching periods on the same day */
  teacherGaps: number;
  /** peak daily load per teacher — pushes work off overloaded days */
  dailyLoadBalance: number;
  /** lab↔classroom switches between consecutive periods for a class-section */
  roomChanges: number;
  /**
   * §26.2 — how late in the day high-priority subjects sit.
   *
   * The one term that is about the CHILDREN rather than the staff, which is why
   * it is weighted above the others: a week with two extra teacher gaps and
   * Maths in the mornings is the better week.
   */
  subjectPriority: number;
}

export const DEFAULT_WEIGHTS: ObjectiveWeights = {
  teacherGaps: 5,
  dailyLoadBalance: 2,
  roomChanges: 1,
  subjectPriority: 3,
};

export interface ObjectiveScore {
  /** total gap periods across all teachers and days (lower is better) */
  teacherGaps: number;
  /** sum over teachers of their busiest day's period count (lower = flatter weeks) */
  peakDailyLoad: number;
  /** lab/classroom switches between consecutive periods, summed over section-days */
  roomChanges: number;
  /**
   * §26.2 — Σ over lessons of `(priority − 3) × (period − 1)`.
   *
   * Lower is better, like every other term, and the sign falls out of that
   * directly: a priority-5 subject scores 0 in period 1 and +10 in period 6, so
   * sitting late costs it; a priority-1 subject scores the mirror image, so
   * pushing Library late is as much of a gain as pulling Maths early. Priority
   * 3 — the neutral default, and what every subject had before this phase —
   * contributes exactly nothing, which is what makes the term invisible to a
   * school that never sets it.
   *
   * An earlier draft negated this, on the reasoning that "high priority early"
   * ought to be the low number. It already is: negating pushed Maths to last
   * period and called it an improvement. The unit test is what said so.
   */
  subjectPriority: number;
  /** weighted total the optimizer minimizes */
  weighted: number;
  /** per-teacher gap detail, worst first — drives the "what improved" report */
  worstTeachers: Array<{ teacherId: number; gaps: number }>;
}

/** Expand a placement into the individual (day, period) cells it occupies. */
function cellsOf(p: Placement): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let s = 0; s < p.span; s++) out.push([p.day, p.period + s]);
  return out;
}

export function scoreTimetable(
  input: SolverInput,
  placements: Placement[],
  variables: SolverVariable[],
  weights: Partial<ObjectiveWeights> = DEFAULT_WEIGHTS,
): ObjectiveScore {
  /**
   * Merged, not used raw. A caller supplying three of the four weights — which
   * every caller written before §26.2 added a fourth does — would otherwise
   * multiply by `undefined` and score the whole timetable `NaN`, and a NaN
   * score compares false against everything: the optimizer would silently stop
   * adopting improvements rather than fail. A missing weight means the default.
   */
  const w: ObjectiveWeights = { ...DEFAULT_WEIGHTS, ...weights };
  const days = input.snapshot.config.workingDays;
  const perDay = input.snapshot.config.periodsPerDay;
  const labSubjects = new Set(input.snapshot.labSubjectIds);
  const varById = new Map(variables.map((v) => [v.id, v]));

  // ---- teacher gaps + peak daily load ----
  const busy = new Map<number, Map<number, Set<number>>>(); // teacher -> day -> periods
  for (const p of placements) {
    // A §4.9 elective busies every option's teacher at once; an ordinary or
    // merged placement busies exactly one.
    const teachers = p.options.length > 0 ? p.options.map((o) => o.teacherId) : p.teacherId !== null ? [p.teacherId] : [];
    for (const t of teachers) {
      const byDay = busy.get(t) ?? new Map<number, Set<number>>();
      const set = byDay.get(p.day) ?? new Set<number>();
      for (const [, period] of cellsOf(p)) set.add(period);
      byDay.set(p.day, set);
      busy.set(t, byDay);
    }
  }

  let teacherGaps = 0;
  let peakDailyLoad = 0;
  const perTeacherGaps: Array<{ teacherId: number; gaps: number }> = [];
  for (const [teacherId, byDay] of busy) {
    let gapsForTeacher = 0;
    let peak = 0;
    for (const day of days) {
      const periods = [...(byDay.get(day) ?? [])].sort((a, b) => a - b);
      if (periods.length === 0) continue;
      peak = Math.max(peak, periods.length);
      const span = periods[periods.length - 1] - periods[0] + 1;
      gapsForTeacher += span - periods.length;
    }
    teacherGaps += gapsForTeacher;
    peakDailyLoad += peak;
    if (gapsForTeacher > 0) perTeacherGaps.push({ teacherId, gaps: gapsForTeacher });
  }

  // ---- room changes: lab↔non-lab switches between consecutive periods ----
  // A class-section normally sits in its home room; the solver only moves the
  // children when a lab period lands, so clustering lab periods == fewer moves.
  const labCells = new Map<number, Map<number, Set<number>>>(); // section -> day -> periods
  for (const p of placements) {
    const v = varById.get(p.variableId);
    // Elective options carry fixed rooms, so a block never counts as a lab move.
    const needsLab = v ? v.needsLabRoom : p.subjectId !== null && labSubjects.has(p.subjectId);
    if (!needsLab) continue;
    for (const cs of p.classSectionIds) {
      const byDay = labCells.get(cs) ?? new Map<number, Set<number>>();
      const set = byDay.get(p.day) ?? new Set<number>();
      for (const [, period] of cellsOf(p)) set.add(period);
      byDay.set(p.day, set);
      labCells.set(cs, byDay);
    }
  }
  let roomChanges = 0;
  for (const [, byDay] of labCells) {
    for (const day of days) {
      const set = byDay.get(day);
      if (!set || set.size === 0) continue;
      for (let p = 1; p < perDay; p++) {
        if (set.has(p) !== set.has(p + 1)) roomChanges++;
      }
    }
  }

  // ---- §26.2 subject priority: how late high-priority subjects sit ----
  //
  // Deliberately soft. "Maths must be in period 1" cannot hold for twenty
  // sections at once, so as a hard rule it would make every real school
  // infeasible; as a score it pulls the whole week in the right direction and
  // still places everything.
  let subjectPriority = 0;
  for (const p of placements) {
    // An elective block runs several subjects at once — each option's priority
    // counts, since each is a real lesson for the children taking it.
    const subjectIds = p.options.length > 0
      ? p.options.map((o) => o.subjectId)
      : p.subjectId !== null ? [p.subjectId] : [];
    for (const id of subjectIds) {
      const pl = input.snapshot.subjectPlacement?.[id];
      if (!pl) continue;
      for (const [, period] of cellsOf(p)) {
        subjectPriority += (pl.priority - 3) * (period - 1);
      }
    }
  }
  const weighted =
    w.teacherGaps * teacherGaps +
    w.dailyLoadBalance * peakDailyLoad +
    w.roomChanges * roomChanges +
    w.subjectPriority * subjectPriority;

  return {
    teacherGaps,
    peakDailyLoad,
    roomChanges,
    subjectPriority,
    weighted,
    worstTeachers: perTeacherGaps.sort((a, b) => b.gaps - a.gaps).slice(0, 10),
  };
}

/** Human-readable delta between two runs, for the Generate screen. */
export function describeImprovement(before: ObjectiveScore, after: ObjectiveScore): string {
  const parts: string[] = [];
  const d = (label: string, b: number, a: number) => {
    if (b === a) return;
    parts.push(`${label} ${b} → ${a} (${a < b ? "−" : "+"}${Math.abs(b - a)})`);
  };
  d("teacher gaps", before.teacherGaps, after.teacherGaps);
  d("peak daily load", before.peakDailyLoad, after.peakDailyLoad);
  d("room changes", before.roomChanges, after.roomChanges);
  return parts.length === 0 ? "no measurable change" : parts.join(" · ");
}
