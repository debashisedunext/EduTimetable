/**
 * §37 — how many teachers a timetable needs, subject by subject.
 *
 * ## What question this answers, and which one it does not
 *
 * *"Given what this school teaches and who it employs, where is it short?"*
 *
 * That is arithmetic over demand and capacity. It is **not** the Feasibility
 * Engine's question, which is harder and different: whether a legal timetable
 * can be built at all — rooms, clashes, day shapes, placement patterns. A
 * school can pass this and fail Readiness, and it can fail this while every
 * lesson it has actually entered places perfectly. Neither is a substitute for
 * the other, and this module deliberately shares none of the solver's machinery
 * (§29.3 made the same call for the reassignment engine, and for the same
 * reason: forcing one question into the other's shape means building a variable
 * that lies about half its fields and discarding most of the answer).
 *
 * ## Why it lives in `packages/shared`
 *
 * `apps/web` has no test harness, and the arithmetic IS the feature: an
 * off-by-one in the section multiplier tells a school to hire four people it
 * does not need, and a double-counted teacher tells it to hire none when it
 * needs three. Same rule as `mergeShownWings`, `mergeByWing` and `fixed-fill`.
 *
 * ## The three things it gets right that a subtraction does not
 *
 *  1. **Demand is a CLASS fact multiplied by sections** (§27). `periods_per_week`
 *     is stored per class, so Class 5's six Mathematics is six for 5-A, six for
 *     5-B and six for 5-C. Summing the column would report a fifth of the truth
 *     on a four-section school.
 *  2. **A merged group costs its teacher one lesson, not one per section**
 *     (§4.10), and a **split elective's options** carry their own periods while
 *     belonging to no class-section at all (§4.9) — so one has to be subtracted
 *     and the other added, and neither falls out of the curriculum table.
 *  3. **Spare capacity can only be spent once.** A teacher qualified for three
 *     subjects has their free periods counted three times by any per-subject
 *     sum. That is not a rounding error: it is the difference between "you are
 *     fine" and "you are three teachers short", in the direction that does the
 *     damage. The allocation is a max-flow, so every free period is given to at
 *     most one subject.
 */

/** One line of "where this subject's periods come from". */
export interface DemandLine {
  kind: "curriculum" | "merged" | "elective";
  /** The class, the group, or the elective block — whatever the line is about. */
  label: string;
  /** Periods a week for one section, where that is meaningful. */
  per?: number;
  sections?: number;
  /** The signed contribution to demand. Negative for a merged group. */
  periods: number;
}

export interface RequirementSnapshot {
  /** Context for the report's prose. The arithmetic is all in periods. */
  workingDays: number;
  periodsPerDay: number;
  subjects: Array<{ id: number; name: string; category?: string }>;
  /** Class id → name, for the breakdown lines. */
  classNames: Record<number, string>;
  /** How many sections of each class THIS timetable teaches. */
  sectionsPerClass: Record<number, number>;
  /** The class-section ids this timetable teaches — the scope of `assigned`. */
  sectionIds: number[];
  /** Year-scoped already (§3.11), and limited to this timetable's classes. */
  curriculum: Array<{ classId: number; subjectId: number; periodsPerWeek: number }>;
  mappings: Array<{ teacherId: number; subjectId: number; classSectionId: number; periodsPerWeek: number }>;
  /** §4.10 — members already narrowed to this timetable's sections. */
  mergedGroups: Array<{ subjectId: number; memberSectionIds: number[]; periodsPerWeek: number }>;
  /** §4.9 — blocks this timetable runs, with the subjects their options teach. */
  electives: Array<{ name: string; periodsPerWeek: number; optionSubjectIds: number[] }>;
  /** §27.13 — declared, not derived. */
  declaredSubjects: Array<{ teacherId: number; subjectId: number }>;
  /**
   * Active teachers, with capacity and what they already carry.
   *
   * `cap` and `load` are computed by the caller, deliberately: capacity depends
   * on §4.7a availability and §20 patterns, and load is summed across the whole
   * §30 pool. Both already have one definition each elsewhere, and a second
   * here would be a second opinion about the number every candidate is scored
   * against (§29.3's rule).
   */
  teachers: Array<{ id: number; name: string; cap: number; load: number }>;
  /**
   * §32 — the subjects this timetable declares it teaches.
   *
   * `null` means "not stated", which is every subject (invariant 7) — NOT
   * "teaches nothing". Getting that backwards reports a fully staffed school as
   * needing its entire faculty replaced.
   */
  narrowedTo: number[] | null;
}

export interface SubjectRequirement {
  id: number;
  name: string;
  category: string;
  /** Periods a week this timetable must teach. */
  demand: number;
  /** Periods a week currently mapped to somebody, within this timetable. */
  assigned: number;
  /** Unassigned periods. Never negative — see `over`. */
  gap: number;
  /** Assigned BEYOND the curriculum. A mapping to check, never a hire. */
  over: number;
  /** Teacher ids able to teach it: declared (§27.13) or already mapped. */
  qualified: number[];
  /** Of the gap, how much the qualified teachers' spare can actually absorb. */
  covered: number;
  /** What is left after that — the number a hire is for. */
  short: number;
  breakdown: DemandLine[];
}

export interface RequirementReport {
  targetLoad: number;
  subjects: SubjectRequirement[];
  totals: {
    demand: number;
    /** Assigned, capped at demand so over-assignment cannot flatter coverage. */
    assigned: number;
    gap: number;
    covered: number;
    short: number;
    over: number;
    /** Every teacher's unused periods, whether or not anybody can use them. */
    spare: number;
    overCap: number;
    unassigned: number;
    /** `short / targetLoad`, the report's headline. */
    teachersNeeded: number;
  };
}

/**
 * Demand per subject, with the arithmetic that produced it.
 *
 * Exported separately because it is the half most likely to be wrong and the
 * half worth asserting on its own.
 */
export function buildDemand(snap: RequirementSnapshot): Map<number, { total: number; lines: DemandLine[] }> {
  const allowed = snap.narrowedTo === null ? null : new Set(snap.narrowedTo);
  const out = new Map<number, { total: number; lines: DemandLine[] }>();
  const add = (subjectId: number, periods: number, line: DemandLine) => {
    if (allowed && !allowed.has(subjectId)) return;
    const row = out.get(subjectId) ?? { total: 0, lines: [] };
    row.total += periods;
    row.lines.push(line);
    out.set(subjectId, row);
  };

  for (const r of snap.curriculum) {
    const sections = snap.sectionsPerClass[r.classId] ?? 0;
    // A class this timetable does not teach contributes nothing — and must not
    // contribute a zero LINE either, or the breakdown lists classes the reader
    // cannot find on the screen they are sent to.
    if (sections === 0 || r.periodsPerWeek <= 0) continue;
    add(r.subjectId, r.periodsPerWeek * sections, {
      kind: "curriculum",
      label: snap.classNames[r.classId] ?? `Class ${r.classId}`,
      per: r.periodsPerWeek,
      sections,
      periods: r.periodsPerWeek * sections,
    });
  }

  /*
    §4.10 — one teacher, several sections, one lesson.

    The curriculum above has already counted the subject once per section,
    because that is what the children receive. What a STAFFING report needs is
    what the teacher spends, so the echo sections come back off. A group of one
    is not a group and is skipped: subtracting zero would still print a line
    saying something had been saved.
  */
  for (const g of snap.mergedGroups) {
    const members = g.memberSectionIds.length;
    if (members < 2 || g.periodsPerWeek <= 0) continue;
    const saved = g.periodsPerWeek * (members - 1);
    if (!out.has(g.subjectId)) continue;
    add(g.subjectId, -saved, {
      kind: "merged",
      label: `${members} sections taught together`,
      periods: -saved,
    });
  }

  /*
    §4.9 — an elective option's periods belong to no class-section.

    They are real teaching by a real teacher and appear in no curriculum row
    for any section, so anything reading `class_subjects` alone reports a
    language block as costing nothing.
  */
  for (const b of snap.electives) {
    if (b.periodsPerWeek <= 0) continue;
    for (const subjectId of b.optionSubjectIds) {
      add(subjectId, b.periodsPerWeek, {
        kind: "elective",
        label: b.name,
        per: b.periodsPerWeek,
        sections: 1,
        periods: b.periodsPerWeek,
      });
    }
  }

  return out;
}

/**
 * Give each subject's shortfall as much of the qualified teachers' spare as can
 * actually reach it.
 *
 * A max-flow, because spare is **shared**: source → teacher (their free
 * periods) → subject (if qualified, unbounded) → sink (that subject's gap). The
 * maximum flow is the largest number of unassigned periods existing staff could
 * take on; what does not flow is the shortfall a hire is for.
 *
 * Edmonds-Karp, which is BFS augmenting paths — a few dozen subjects and a few
 * hundred teachers make this instant, and a heuristic here would be a number
 * that is wrong in a direction nobody can predict.
 *
 * Exported so the property test can drive it directly.
 */
export function allocateSpare(
  gaps: Array<{ gap: number; qualified: number[] }>,
  teachers: Array<{ id: number; spare: number }>,
): number[] {
  const T = teachers.length;
  const S = gaps.length;
  const SRC = T + S;
  const SNK = T + S + 1;
  const N = T + S + 2;
  const index = new Map(teachers.map((t, i) => [t.id, i]));

  const cap: Array<Map<number, number>> = Array.from({ length: N }, () => new Map());
  const edge = (a: number, b: number, c: number) => {
    cap[a].set(b, (cap[a].get(b) ?? 0) + c);
    // The residual edge must exist even at zero, or the search can never undo a
    // choice — which turns a max-flow into a greedy pass that reports too
    // little coverage and therefore too many hires.
    if (!cap[b].has(a)) cap[b].set(a, 0);
  };

  teachers.forEach((t, i) => edge(SRC, i, Math.max(0, t.spare)));
  gaps.forEach((g, j) => {
    edge(T + j, SNK, Math.max(0, g.gap));
    for (const id of g.qualified) {
      const i = index.get(id);
      if (i !== undefined) edge(i, T + j, Number.MAX_SAFE_INTEGER);
    }
  });

  for (;;) {
    const prev = new Array<number>(N).fill(-1);
    prev[SRC] = SRC;
    const queue = [SRC];
    while (queue.length > 0 && prev[SNK] < 0) {
      const u = queue.shift() as number;
      for (const [v, c] of cap[u]) {
        if (c > 0 && prev[v] < 0) { prev[v] = u; queue.push(v); }
      }
    }
    if (prev[SNK] < 0) break;
    let f = Number.POSITIVE_INFINITY;
    for (let v = SNK; v !== SRC; v = prev[v]) f = Math.min(f, cap[prev[v]].get(v) as number);
    for (let v = SNK; v !== SRC; v = prev[v]) {
      cap[prev[v]].set(v, (cap[prev[v]].get(v) as number) - f);
      cap[v].set(prev[v], (cap[v].get(prev[v]) ?? 0) + f);
    }
  }

  // The flow into the sink is what came back along the residual edge.
  return gaps.map((_, j) => cap[SNK].get(T + j) ?? 0);
}

export function analyseRequirement(
  snap: RequirementSnapshot,
  targetLoad: number,
): RequirementReport {
  const demand = buildDemand(snap);
  const mine = new Set(snap.sectionIds);

  /*
    Assigned is scoped to THIS timetable's sections, while `load` on a teacher
    is pool-wide (§30.11). Both are right: what a subject has been given here is
    a fact about this week, and how full a person is has to count the other
    wings or the answer is the "67% where the truth is 87%" mistake.
  */
  const assigned = new Map<number, number>();
  const qualified = new Map<number, Set<number>>();
  const qual = (subjectId: number, teacherId: number) => {
    const set = qualified.get(subjectId) ?? new Set<number>();
    set.add(teacherId);
    qualified.set(subjectId, set);
  };
  for (const m of snap.mappings) {
    qual(m.subjectId, m.teacherId);
    if (mine.has(m.classSectionId)) {
      assigned.set(m.subjectId, (assigned.get(m.subjectId) ?? 0) + m.periodsPerWeek);
    }
  }
  // §27.13 — declared, and the union with mapped is deliberate: schools that
  // predate the table have no declarations at all.
  for (const d of snap.declaredSubjects) qual(d.subjectId, d.teacherId);

  const spare = snap.teachers.map((t) => ({ id: t.id, spare: Math.max(0, t.cap - t.load) }));

  const rows: SubjectRequirement[] = [];
  for (const s of snap.subjects) {
    const d = demand.get(s.id);
    if (!d || d.total <= 0) continue;
    const a = assigned.get(s.id) ?? 0;
    rows.push({
      id: s.id,
      name: s.name,
      category: s.category ?? "scholastic",
      demand: d.total,
      assigned: a,
      gap: Math.max(0, d.total - a),
      /*
        Over-assignment is reported, never netted off.

        Mapped periods beyond what the curriculum asks are a data fault, not
        spare teaching: folding them into coverage would let a school with 600
        bad mapping rows read as comfortably staffed.
      */
      over: Math.max(0, a - d.total),
      qualified: [...(qualified.get(s.id) ?? [])].sort((x, y) => x - y),
      covered: 0,
      short: 0,
      breakdown: d.lines,
    });
  }

  const covered = allocateSpare(rows, spare);
  rows.forEach((r, i) => { r.covered = covered[i]; r.short = r.gap - covered[i]; });

  const sum = (f: (r: SubjectRequirement) => number) => rows.reduce((acc, r) => acc + f(r), 0);
  const short = sum((r) => r.short);
  return {
    targetLoad,
    // Worst first, which is the order somebody acts in. Ties by demand so the
    // list is stable rather than in whatever order the subjects table came back.
    subjects: rows.sort((a, b) => b.short - a.short || b.gap - a.gap || b.demand - a.demand),
    totals: {
      demand: sum((r) => r.demand),
      assigned: sum((r) => Math.min(r.assigned, r.demand)),
      gap: sum((r) => r.gap),
      covered: sum((r) => r.covered),
      short,
      over: sum((r) => r.over),
      spare: spare.reduce((a, t) => a + t.spare, 0),
      overCap: snap.teachers.filter((t) => t.load > t.cap).length,
      unassigned: snap.teachers.filter((t) => t.load === 0).length,
      // Guarded: a target of zero is not a school with infinite need, it is a
      // caller that passed nothing.
      teachersNeeded: targetLoad > 0 ? short / targetLoad : 0,
    },
  };
}
