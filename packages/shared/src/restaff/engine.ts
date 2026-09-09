/**
 * §29.3 — who can take a class whose teacher has gone.
 *
 * ## The question this engine answers, and the one it does not
 *
 * The plan for §29 said this module would reuse `SolverState.check()`. Building
 * it made clear that would have been the wrong reuse, and the distinction is
 * worth stating because it is the whole design:
 *
 *   `SolverState.check()` answers **"can this lesson go in this cell?"**
 *   This module answers **"can this teacher take this lesson where it already
 *   is?"**
 *
 * In a reassignment the cell does not move (§29.0). The class-section slot, the
 * room, the subject, the period and the span are all unchanged by construction,
 * so re-checking them would be re-deriving facts that were true before anyone
 * pressed anything — and forcing the question through `check()` would mean
 * building a `SolverVariable` that lies about span, `dayKey`, `samePeriodKey`
 * and the room pools, then discarding most of the answer.
 *
 * So what is re-checked here is exactly the **teacher-side** half, and it draws
 * its data from the same places the solver does rather than deriving its own:
 * `buildTeacherCtx` for availability, the alternate-day set and the P1 rule,
 * and `effectiveMinByTeacher` for §20. That is what keeps the two from
 * disagreeing — §20's arithmetic in particular is one module by rule, never
 * re-derived at a call site.
 *
 * What is deliberately NOT re-checked, because the cell is not moving:
 * `uq_class_slot`, `uq_room_slot`, room availability, a subject's per-day cap,
 * §4.6's same-period rule, §4.8 block contiguity and §26.3's lunch rules.
 *
 * ## Pure
 *
 * No database, no Prisma, no ids invented. It is handed a snapshot, the units
 * on the table and everybody's current occupancy, and returns a plan. The API
 * layer writes it (§29.4) or throws it away.
 */
import type { FeasibilitySnapshot } from "../feasibility/types";
import { effectiveMinByTeacher } from "../feasibility/min-day";
import { buildTeacherCtx } from "../solver/variables";
import type { SolverInput } from "../solver/types";

export type RestaffUnitType = "mapping" | "merged_group" | "elective_option" | "class_teacher";

/** One published cell a unit occupies. Merged groups are deduplicated (§4.10). */
export interface RestaffCell {
  dayOfWeek: number;
  periodNumber: number;
  /** NULL on a §4.9 option row — the lesson belongs to a block, not a section. */
  classSectionId: number | null;
}

export interface RestaffUnit {
  type: RestaffUnitType;
  id: number;
  label: string;
  fromTeacherId: number;
  subjectId: number | null;
  classIds: number[];
  classSectionIds: number[];
  periodsPerWeek: number;
  cells: RestaffCell[];
}

/** Where a teacher already is. The units being reassigned are NOT in here. */
export interface RestaffOccupancy {
  teacherId: number;
  dayOfWeek: number;
  periodNumber: number;
}

export interface RestaffInput {
  snapshot: FeasibilitySnapshot;
  /** §4.7a rows, in `SolverInput`'s shape — the same rows the solver prunes on. */
  teacherUnavailability: SolverInput["teacherUnavailability"];
  units: RestaffUnit[];
  occupancy: RestaffOccupancy[];
  /** Who may be given work. Everything else is scored against nobody. */
  candidateTeacherIds: number[];
  /**
   * §27.13 — the subjects each teacher is declared for, UNIONED with what they
   * are already mapped to. Absent or empty is "not stated", never "teaches
   * nothing" (invariant 7).
   */
  subjectsByTeacher: Record<number, number[]>;
  /**
   * §29.3 continuity — what each teacher already teaches HERE, after the
   * released units are taken out.
   *
   * Two levels because they mean different things to a school: keeping the
   * teacher a class-section already has is the outcome people actually want,
   * while "they teach the other section of Class 5" is a much weaker comfort.
   * Both are scoring only; neither can make an illegal assignment legal.
   */
  sectionsByTeacher: Record<number, number[]>;
  classesByTeacher: Record<number, number[]>;
}

export interface RestaffCandidate {
  teacherId: number;
  teacherName: string;
  ok: boolean;
  /** Why not. Empty when `ok` — a refusal always names itself. */
  reasons: string[];
  /** Higher is better. Meaningless when `!ok`. */
  score: number;
  loadBefore: number;
  loadAfter: number;
  loadCap: number;
}

export interface RestaffAssignment {
  unit: RestaffUnit;
  toTeacherId: number | null;
  /** Every candidate considered, best first — the screen shows the top few. */
  candidates: RestaffCandidate[];
}

export interface RestaffPlan {
  assignments: RestaffAssignment[];
  covered: number;
  uncovered: number;
  /** Per receiving teacher, so the screen can show what the change costs them. */
  loads: Array<{
    teacherId: number;
    teacherName: string;
    before: number;
    after: number;
    cap: number;
    /**
     * §28.1 — at or above the school's own "getting full" line.
     *
     * A warning and never a refusal, exactly as Check 12 is: a teacher at 80%
     * of their limit is a normally employed teacher, and the school asked to be
     * told, not to be stopped. The engine has already refused anything actually
     * over the cap; this is the number in between.
     */
    alert: boolean;
  }>;
  /**
   * §29.3 — how many uncovered units were rescued by moving something already
   * assigned. Reported so the pass can be seen to be earning its place rather
   * than trusted to.
   */
  ejections: number;
}

const cell = (d: number, p: number) => `${d}:${p}`;

/**
 * A teacher's week, as it stands and as it would stand.
 *
 * Mutable on purpose: a plan assigns several units to the same teacher one
 * after another, and the second must be scored against the load the first
 * created. A pure per-unit check would happily give one teacher four classes
 * that each fit alone and together break their weekly cap.
 */
class Week {
  readonly busy = new Set<string>();
  readonly perDay = new Map<number, number>();
  total = 0;

  constructor(cells: Array<{ dayOfWeek: number; periodNumber: number }>) {
    for (const c of cells) this.add(c.dayOfWeek, c.periodNumber);
  }

  add(day: number, period: number) {
    if (this.busy.has(cell(day, period))) return;
    this.busy.add(cell(day, period));
    this.perDay.set(day, (this.perDay.get(day) ?? 0) + 1);
    this.total += 1;
  }

  /**
   * Give a cell back.
   *
   * Only ever called with a cell this plan itself added (§29.3's ejection pass
   * tracks them per assignment), never with one from the school's standing
   * occupancy — taking one of those away would invent free time a teacher does
   * not have.
   */
  remove(day: number, period: number) {
    if (!this.busy.has(cell(day, period))) return;
    this.busy.delete(cell(day, period));
    const left = (this.perDay.get(day) ?? 1) - 1;
    if (left <= 0) this.perDay.delete(day);
    else this.perDay.set(day, left);
    this.total -= 1;
  }

  has(day: number, period: number) {
    return this.busy.has(cell(day, period));
  }

  onDay(day: number) {
    return this.perDay.get(day) ?? 0;
  }

  /** Longest back-to-back run on one day if `extra` were added. */
  runWith(day: number, extra: number[], perDay: number): number {
    let best = 0;
    let run = 0;
    for (let p = 1; p <= perDay; p++) {
      const occupied = this.busy.has(cell(day, p)) || extra.includes(p);
      run = occupied ? run + 1 : 0;
      if (run > best) best = run;
    }
    return best;
  }
}

/**
 * Score a single teacher against a single unit, on a week that already carries
 * whatever the plan has given them so far.
 *
 * Returns every reason it fails rather than the first, because the screen has
 * to explain a vacancy that nobody can cover — and "Rekha is busy Tuesday P3"
 * plus "and would be over her weekly limit" is a different conversation from
 * either alone.
 */
function evaluate(
  input: RestaffInput,
  unit: RestaffUnit,
  teacherId: number,
  week: Week,
  ctx: ReturnType<typeof buildTeacherCtx>,
  minPerDay: Map<number, number>,
): RestaffCandidate {
  const snap = input.snapshot;
  const info = snap.teachers.find((t) => t.id === teacherId);
  const c = ctx.get(teacherId);
  const name = info?.name ?? `teacher ${teacherId}`;
  const base: RestaffCandidate = {
    teacherId, teacherName: name, ok: false, reasons: [], score: 0,
    loadBefore: week.total, loadAfter: week.total, loadCap: info?.maxPeriodsPerWeek ?? 0,
  };
  if (!info || !c) {
    // The snapshot carries active teachers only, so an id that is not in it is
    // inactive or belongs to nobody — either way, nothing may be given to them.
    return { ...base, reasons: ["not an active teacher in this school"] };
  }

  const reasons: string[] = [];

  // ── §18: guests are never given the regular curriculum ──────────────────
  if (info.employmentType === "guest") {
    reasons.push("is a guest teacher, so they take extra classes only (§18)");
  }

  // ── §18: teaching scope. Empty means NOT STATED, never "no classes". ────
  if (info.eligibleClassIds.length > 0) {
    const outside = unit.classIds.filter((id) => !info.eligibleClassIds.includes(id));
    if (outside.length > 0) reasons.push("does not teach that class");
  }

  // ── §27.13: what they teach. Same "empty is not stated" rule. ───────────
  const subjects = input.subjectsByTeacher[teacherId] ?? [];
  if (unit.subjectId !== null && subjects.length > 0 && !subjects.includes(unit.subjectId)) {
    reasons.push("does not teach that subject");
  }

  // ── §27.16: and whether the subject is taught to that class at all. ─────
  const declared = unit.subjectId !== null ? snap.subjectClasses?.[unit.subjectId] : undefined;
  if (declared && declared.length > 0 && unit.classIds.some((id) => !declared.includes(id))) {
    reasons.push("that subject is not set for that class (§27.16)");
  }

  /*
    A class-teacher role has no cells, so every check below it is vacuous.
    Returning here rather than falling through with an empty loop keeps the
    "no reason given" case impossible: a candidate is either eligible for the
    class or has been told why not.
  */
  if (unit.type === "class_teacher") {
    return {
      ...base,
      ok: reasons.length === 0,
      reasons,
      // Owning a class costs no periods, so the tie-break is continuity alone:
      // somebody who already teaches the section is the obvious class teacher.
      score: reasons.length === 0 ? continuity(input, unit, teacherId) : 0,
    };
  }

  const perDay = snap.config.periodsPerDay;
  const byDay = new Map<number, number[]>();
  for (const cl of unit.cells) {
    byDay.set(cl.dayOfWeek, [...(byDay.get(cl.dayOfWeek) ?? []), cl.periodNumber]);
  }

  // ── the cells themselves ────────────────────────────────────────────────
  const clashes: string[] = [];
  const unavailable: string[] = [];
  for (const cl of unit.cells) {
    if (week.has(cl.dayOfWeek, cl.periodNumber)) clashes.push(cell(cl.dayOfWeek, cl.periodNumber));
    // §4.7a — the same blocked-cell set the solver prunes on, whole days
    // already expanded by `buildTeacherCtx`.
    if (c.blocked.has(`${cl.dayOfWeek}:${cl.periodNumber}`)) {
      unavailable.push(cell(cl.dayOfWeek, cl.periodNumber));
    }
    // §4.7 alternate-day teachers work a fixed set of days.
    if (!c.allowedDays.has(cl.dayOfWeek)) unavailable.push(cell(cl.dayOfWeek, cl.periodNumber));
  }
  if (clashes.length > 0) {
    reasons.push(`is already teaching at ${describe(clashes)}`);
  }
  if (unavailable.length > 0) {
    reasons.push(`is not available at ${describe([...new Set(unavailable)])}`);
  }

  // ── invariant 2: alternate_period is a HARD rule, never a preference ────
  if (info.periodPattern === "alternate_period") {
    const backToBack = unit.cells.some((cl) =>
      week.has(cl.dayOfWeek, cl.periodNumber - 1) ||
      week.has(cl.dayOfWeek, cl.periodNumber + 1) ||
      (byDay.get(cl.dayOfWeek) ?? []).includes(cl.periodNumber + 1));
    if (backToBack) reasons.push("never takes two periods in a row, and this would");
  }

  // ── daily and weekly caps ───────────────────────────────────────────────
  for (const [day, periods] of byDay) {
    const after = week.onDay(day) + periods.filter((p) => !week.has(day, p)).length;
    if (after > info.maxPeriodsPerDay) {
      reasons.push(`would have ${after} periods on day ${day}, over their daily maximum of ${info.maxPeriodsPerDay}`);
      break;
    }
  }
  const adding = unit.cells.filter((cl) => !week.has(cl.dayOfWeek, cl.periodNumber)).length;
  /*
    §3.10 — a teacher's week is summed across every timetable they appear in.

    A receiving teacher may already be at 24 of 30 in another wing, and a plan
    that only counted this one would hand them six more and call it comfortable.
  */
  const elsewhere = snap.crossConfigTeacherLoad[teacherId]?.periods ?? 0;
  const after = week.total + elsewhere + adding;
  if (after > info.maxPeriodsPerWeek) {
    reasons.push(
      `would reach ${after} periods a week, over their limit of ${info.maxPeriodsPerWeek}` +
        (elsewhere > 0 ? ` (${elsewhere} of them in another timetable)` : ""),
    );
  }

  // ── longest back-to-back run (§15.3) ────────────────────────────────────
  if (info.maxConsecutivePeriodsPerDay !== null) {
    for (const [day, periods] of byDay) {
      const run = week.runWith(day, periods, perDay);
      if (run > info.maxConsecutivePeriodsPerDay) {
        reasons.push(`would give them ${run} periods back to back, over their limit of ${info.maxConsecutivePeriodsPerDay}`);
        break;
      }
    }
  }

  // ── the class-teacher P1 rule (invariant 2, HARD) ───────────────────────
  //
  // A teacher with `always_first_period` takes P1 of their OWN class every day
  // and never P1 anywhere else. Reassigning somebody else's first period to
  // them breaks the second half of that.
  if (c.hasP1Rule) {
    const foreignP1 = unit.cells.some((cl) =>
      cl.periodNumber === 1 &&
      (cl.classSectionId === null || !c.p1OwnSections.has(cl.classSectionId)));
    if (foreignP1) reasons.push("takes period 1 with their own class every day, so cannot take it here");
  }

  const ok = reasons.length === 0;
  return {
    ...base,
    ok,
    reasons,
    loadAfter: week.total + adding,
    score: ok ? score(input, unit, teacherId, info, week, adding, minPerDay) : 0,
  };
}

/**
 * How good a fit, once it is a legal one.
 *
 * Continuity first and by a wide margin: a class that keeps a teacher it
 * already knows is the outcome a school actually wants, and it is the one thing
 * here that a person would notice. Everything after it is tie-breaking.
 */
function score(
  input: RestaffInput,
  unit: RestaffUnit,
  teacherId: number,
  info: FeasibilitySnapshot["teachers"][number],
  week: Week,
  adding: number,
  minPerDay: Map<number, number>,
): number {
  let s = 100;
  s += continuity(input, unit, teacherId);

  // Declared for the subject beats merely not being refused for it (§27.13).
  const subjects = input.subjectsByTeacher[teacherId] ?? [];
  if (unit.subjectId !== null && subjects.includes(unit.subjectId)) s += 25;

  /*
    Spare capacity, as a fraction rather than a count.

    A count would always prefer the part-timer with a small cap simply because
    they teach few periods; the fraction asks "who has most room left", which is
    what a school means by "give it to whoever is free".
  */
  const cap = Math.max(1, info.maxPeriodsPerWeek);
  s += Math.round(((cap - (week.total + adding)) / cap) * 30);

  /*
    §20 — a day is either free or carries at least N periods.

    A lower bound, so it is scored rather than enforced: filling a teacher's
    one-period day up to their minimum is a small good, and refusing an
    otherwise legal assignment because it created a short day would trade a
    covered class for a tidier week. Completeness outranks shape.
  */
  const min = minPerDay.get(teacherId) ?? 0;
  if (min > 0) {
    for (const cl of unit.cells) {
      const before = week.onDay(cl.dayOfWeek);
      if (before > 0 && before < min) s += 3;
      if (before === 0) s -= 4; // starting a new day owes the whole minimum
    }
  }
  return s;
}

/**
 * Already teaches this class-section, or at least this class.
 *
 * The strongest signal in the score, and by a wide margin on purpose: a class
 * that keeps a face it knows is the outcome a school wants, and it is the one
 * thing here a person would notice. It is scoring only — continuity can never
 * make an illegal assignment legal.
 */
function continuity(input: RestaffInput, unit: RestaffUnit, teacherId: number): number {
  const sections = input.sectionsByTeacher[teacherId] ?? [];
  if (unit.classSectionIds.some((cs) => sections.includes(cs))) return 60;
  const classes = input.classesByTeacher[teacherId] ?? [];
  if (unit.classIds.some((cl) => classes.includes(cl))) return 25;
  return 0;
}

/** "Mon P3, Tue P1" rather than a list of coordinates. */
function describe(cells: string[]): string {
  const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const shown = cells.slice(0, 3).map((k) => {
    const [d, p] = k.split(":").map(Number);
    return `${DAYS[d] ?? `day ${d}`} P${p}`;
  });
  return shown.join(", ") + (cells.length > 3 ? `, and ${cells.length - 3} more` : "");
}

/**
 * §29.3 — one named teacher takes everything.
 *
 * The "somebody joined and replaces the leaver" case, and the honest thing
 * about it is that it is validated **unit by unit** rather than as a whole. A
 * flat yes/no would be useless: what a school needs to hear is "four of these
 * five fit; Class 9-B Maths clashes with their Thursday P2", which is a
 * different conversation from "no".
 */
export function planReplace(input: RestaffInput, toTeacherId: number): RestaffPlan {
  return plan(input, () => [toTeacherId], /* best */ false);
}

/**
 * §29.3 — several existing teachers absorb the vacancy between them.
 *
 * Every candidate is scored for every unit and the best legal one takes it.
 * Units are handled hardest-first — most periods, fewest legal candidates —
 * because a greedy pass that spends its only qualified teacher on an easy unit
 * leaves the hard one uncovered for no reason.
 */
export function planRedistribute(input: RestaffInput): RestaffPlan {
  return plan(input, () => input.candidateTeacherIds, /* best */ true);
}

function plan(
  input: RestaffInput,
  candidatesFor: (unit: RestaffUnit) => number[],
  pickBest: boolean,
): RestaffPlan {
  const snap = input.snapshot;
  /*
    The solver's own derivations, not a second copy of them.

    `buildTeacherCtx` wants a full `SolverInput`; only the two fields below are
    read for teacher context, so the rest is filled with empty structures rather
    than by building a real input this module has no use for. If that function
    ever grows a third dependency this cast stops compiling, which is the right
    way to find out.
  */
  const ctx = buildTeacherCtx({
    snapshot: snap,
    teacherUnavailability: input.teacherUnavailability,
  } as SolverInput);
  const minPerDay = effectiveMinByTeacher(snap);

  // Everybody's week as it stands, with the released units already taken out.
  const weeks = new Map<number, Week>();
  const byTeacher = new Map<number, RestaffOccupancy[]>();
  for (const o of input.occupancy) {
    byTeacher.set(o.teacherId, [...(byTeacher.get(o.teacherId) ?? []), o]);
  }
  for (const t of snap.teachers) weeks.set(t.id, new Week(byTeacher.get(t.id) ?? []));
  const before = new Map([...weeks].map(([id, w]) => [id, w.total]));

  /*
    Hardest first.

    More periods is harder; fewer legal candidates is harder still, and it is
    computed here rather than guessed because the two disagree often — a
    two-period elective option with one qualified teacher must be settled before
    a five-period mapping that four people could take.
  */
  const ranked = [...input.units].sort((a, b) => {
    const fit = (u: RestaffUnit) =>
      candidatesFor(u).filter((id) => evaluate(input, u, id, weeks.get(id) ?? new Week([]), ctx, minPerDay).ok).length;
    return fit(a) - fit(b) || b.cells.length - a.cells.length;
  });

  const key = (u: RestaffUnit) => `${u.type}:${u.id}`;
  const assignments: RestaffAssignment[] = [];
  /** What each assignment actually added to a week, so it can be given back. */
  const added = new Map<string, string[]>();

  const give = (unit: RestaffUnit, teacherId: number) => {
    const w = weeks.get(teacherId);
    if (!w) return;
    const cells: string[] = [];
    for (const cl of unit.cells) {
      if (w.has(cl.dayOfWeek, cl.periodNumber)) continue;
      w.add(cl.dayOfWeek, cl.periodNumber);
      cells.push(cell(cl.dayOfWeek, cl.periodNumber));
    }
    added.set(key(unit), cells);
  };
  const takeBack = (unit: RestaffUnit, teacherId: number) => {
    const w = weeks.get(teacherId);
    for (const c of added.get(key(unit)) ?? []) {
      const [d, p] = c.split(":").map(Number);
      w?.remove(d, p);
    }
    added.delete(key(unit));
  };
  /** Every candidate for a unit, best first. Named `rank` so it does not shadow
   *  the module-level `score`, which is a different thing entirely. */
  const rank = (unit: RestaffUnit, ids: number[]) =>
    ids
      .map((id) => evaluate(input, unit, id, weeks.get(id) ?? new Week([]), ctx, minPerDay))
      .sort((a, b) => Number(b.ok) - Number(a.ok) || b.score - a.score);

  for (const unit of ranked) {
    const candidates = rank(unit, candidatesFor(unit));
    const chosen = pickBest
      ? candidates.find((c) => c.ok) ?? null
      : candidates[0]?.ok
        ? candidates[0]
        : null;
    // The week the NEXT unit is scored against. Without this a teacher who fits
    // four classes one at a time is given all four and breaks their cap.
    if (chosen) give(unit, chosen.teacherId);
    assignments.push({ unit, toTeacherId: chosen?.teacherId ?? null, candidates });
  }

  /*
    §29.3 — the depth-1 ejection pass.

    Hardest-first ordering is a PREDICTION, made before anything is assigned,
    and predictions go stale: the count of legal candidates changes as soon as
    somebody's week fills up. So after the greedy pass, each uncovered unit gets
    one more try — can a teacher who is nearly right be freed by handing one of
    their new units to somebody else?

    Depth 1 on purpose. Chaining would turn a bounded pass into a search, and
    the failure mode of a search here is not a worse plan but a slow screen: a
    school with twenty vacated units and forty candidates would pay for depth
    two in seconds, to rescue a case that hardest-first has usually already
    prevented.

    A rescue is only accepted when BOTH halves succeed — the displaced unit
    finds a new home AND the uncovered one is then legal. A half-completed swap
    that left the displaced unit homeless would trade one uncovered class for
    another and call it progress.
  */
  let ejections = 0;
  if (pickBest) {
    for (const stuck of assignments.filter((a) => a.toTeacherId === null)) {
      let rescued = false;
      for (const candidate of candidatesFor(stuck.unit)) {
        if (rescued) break;
        // Only units this plan gave them: the school's standing week is not
        // ours to rearrange, and moving it would be the "no other timetable is
        // impacted" promise broken from the inside.
        const theirs = assignments.filter((a) => a.toTeacherId === candidate && added.has(key(a.unit)));
        for (const holder of theirs) {
          takeBack(holder.unit, candidate);
          const freed = rank(stuck.unit, [candidate])[0];
          if (!freed?.ok) { give(holder.unit, candidate); continue; }

          const elsewhere = rank(holder.unit, candidatesFor(holder.unit).filter((id) => id !== candidate))
            .find((c) => c.ok);
          if (!elsewhere) { give(holder.unit, candidate); continue; }

          give(holder.unit, elsewhere.teacherId);
          holder.toTeacherId = elsewhere.teacherId;
          give(stuck.unit, candidate);
          stuck.toTeacherId = candidate;
          // Re-scored so the screen shows why THIS teacher was chosen, not the
          // refusal they were carrying from the greedy pass.
          stuck.candidates = rank(stuck.unit, candidatesFor(stuck.unit));
          ejections += 1;
          rescued = true;
          break;
        }
      }
    }
  }

  // Back into the order the school listed them, so the screen reads as the
  // vacancy does rather than as the algorithm's own queue.
  const order = new Map(input.units.map((u, i) => [`${u.type}:${u.id}`, i]));
  assignments.sort((a, b) =>
    (order.get(`${a.unit.type}:${a.unit.id}`) ?? 0) - (order.get(`${b.unit.type}:${b.unit.id}`) ?? 0));

  const touched = [...new Set(assignments.map((a) => a.toTeacherId).filter((id): id is number => id !== null))];
  const alertPct = snap.config.loadAlertPct ?? 75;
  return {
    assignments,
    covered: assignments.filter((a) => a.toTeacherId !== null).length,
    uncovered: assignments.filter((a) => a.toTeacherId === null).length,
    ejections,
    loads: touched.map((id) => {
      const info = snap.teachers.find((t) => t.id === id);
      const cap = info?.maxPeriodsPerWeek ?? 0;
      const after = weeks.get(id)?.total ?? 0;
      /*
        §3.10 again — the alert is measured against the teacher's WHOLE week,
        not this timetable's share of it. Somebody at 20 of 30 here and 6 in
        another wing is at 87%, and a line drawn round one wing would say 67%
        and be comfortably wrong.
      */
      const elsewhere = snap.crossConfigTeacherLoad[id]?.periods ?? 0;
      return {
        teacherId: id,
        teacherName: info?.name ?? `teacher ${id}`,
        before: before.get(id) ?? 0,
        after,
        cap,
        alert: cap > 0 && ((after + elsewhere) / cap) * 100 >= alertPct,
      };
    }),
  };
}
