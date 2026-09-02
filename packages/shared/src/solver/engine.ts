/**
 * §5.2-5.4 — backtracking search with MRV ordering, seeded least-disruptive
 * value ordering, conflict-directed backjumping, restarts, and a best-partial
 * fallback with per-variable reasons when the budget runs out.
 */
import type { Placement, SolverInput, SolveOptions, SolverResult, SolverVariable, UnplacedVariable } from "./types";
import { SolverState, teacherPeriodBudget, teachersOf } from "./state";
import { buildTeacherCtx, buildVariables } from "./variables";

/** deterministic PRNG (mulberry32) — reproducible runs per seed (task 2.5) */
function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Frame {
  variable: SolverVariable;
  values: Array<{ day: number; period: number }>;
  nextValue: number;
  placedAt: { day: number; period: number; roomId: number | null } | null;
  conflictSet: Set<number>;
}

export function solveTimetable(input: SolverInput, opts: SolveOptions = {}): SolverResult {
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 30_000;
  const teacherCtx = buildTeacherCtx(input);
  const baseVars = buildVariables(input, teacherCtx);
  const total = baseVars.length;

  let steps = 0, backtracks = 0, restarts = 0, consolidatedDays = 0;

  /**
   * One full search: restarts with a sliced time budget, each attempt followed
   * by the §5.4 repair pass so a 99% partial never burns the remaining budget
   * on thrashing.
   */
  const search = (minBudget: Map<number, number> | null, deadline: number) => {
    let best: { placements: Placement[]; unplaced: UnplacedVariable[] } = { placements: [], unplaced: [] };
    const maxRestarts = 3;
    const window = deadline - Date.now();
    for (let attempt = 0; attempt <= maxRestarts; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const slice = Math.max(500, Math.min(remaining, Math.floor(window / (maxRestarts + 1))));
      const random = rng((input.seed ?? 1) + attempt * 7919);
      const out = attemptSolve(input, baseVars, random, Date.now(), slice, opts, minBudget, () => steps++, () => backtracks++);
      if (out.placements.length > best.placements.length) best = out;
      if (best.unplaced.length === 0) break;
      const repaired = repair(input, baseVars, out.placements, minBudget);
      if (repaired.unplaced.length < best.unplaced.length || best.placements.length === 0) best = repaired;
      if (best.unplaced.length === 0) break;
      restarts = attempt + 1;
    }
    return best;
  };

  // §20 tightens the search: a school whose sections are 100% full and whose
  // subjects are capped at two periods a day has far fewer legal shapes once
  // every teacher's week also has to divide into whole days. A first pass tries
  // to honour the minimum while building, which is where it belongs...
  //
  // Two passes, and the order matters. The first enforces the minimum *while*
  // building, which is where a constraint belongs and where any school with
  // slack in its staffing finishes. The second is the pre-§20 solver exactly —
  // no budget, no day-shaping in the value ordering — and it exists so a new
  // rule can never cost a school lessons: a timetable missing four periods is
  // worse than one where two teachers have a short Tuesday.
  //
  // (A middle rung keeping only the day-shaping value ordering was tried and
  // dropped: on a school tight enough to need it, it failed to complete just as
  // the enforced pass had, and doubled the wall clock to reach the same answer.)
  const minBudget = teacherPeriodBudget(baseVars);
  const enforced = [...new SolverState(input).minPerDay.values()].some((m) => m > 1);
  let best = search(enforced ? minBudget : null, started + (enforced ? Math.floor(budgetMs * 0.4) : budgetMs));

  if (enforced && best.unplaced.length > 0) {
    const plain = search(null, Date.now() + budgetMs);
    if (plain.unplaced.length < best.unplaced.length) best = plain;
  }

  // Whichever pass won, win back what shape can still be won by *moving*
  // lessons — which cannot cost a placement, so it is safe to run whenever
  // anything is short, including after a successful enforced pass whose
  // relaxed-minimum teachers still came up thin.
  const beforeShape = enforced ? countShortDays(input, baseVars, best.placements).length : 0;
  if (beforeShape > 0) {
    const placements = consolidateShortDays(input, baseVars, best.placements, Date.now() + Math.floor(budgetMs * 0.5));
    consolidatedDays = beforeShape - countShortDays(input, baseVars, placements).length;
    best = { ...best, placements };
  }

  return {
    placements: best.placements,
    unplaced: best.unplaced,
    totalVariables: total,
    stats: {
      steps,
      backtracks,
      restarts,
      ms: Date.now() - started,
      shortTeacherDays: countShortDays(input, baseVars, best.placements).length,
      consolidatedDays,
    },
  };
}

/**
 * §20 — consolidate a *finished* timetable's short teacher-days.
 *
 * The search above enforces the minimum while it builds, which is the right
 * way round and works whenever a school has any slack. A school where the
 * total teaching load divided by (teachers x days) sits barely above the
 * minimum has almost none, and there the rule and completeness pull against
 * each other. This pass exists for exactly that case: it starts from a
 * complete timetable and only ever *moves* lessons, so it cannot cost a single
 * placement — the worst it can do is fail to improve.
 *
 * The move it makes is a whole-day evacuation: take every lesson a teacher has
 * on a day that is too thin, and try to re-home all of them on other days. All
 * or nothing, and kept only if the school's total shortfall actually falls —
 * shuffling one short day into another is not progress.
 */
export function consolidateShortDays(
  input: SolverInput,
  baseVars: SolverVariable[],
  placements: Placement[],
  deadline: number,
): Placement[] {
  const state = new SolverState(input);
  const varById = new Map(baseVars.map((v) => [v.id, v]));
  const byVar = new Map<number, Placement>();
  /** which variable holds each (section, day, period) — the swap-partner index */
  const occupant = new Map<string, number>();
  /**
   * Where each variable stood before the current attempt touched it.
   *
   * Recorded by *position*, not as a list of steps: an attempt contains swaps,
   * and replaying a swap backwards one move at a time puts two lessons in one
   * cell halfway through. Lifting everything touched and then putting it all
   * back is order-independent, and order-independence is the whole point.
   */
  let touched: Map<number, Placement> | null = null;

  const cellKeys = (v: SolverVariable, day: number, period: number) =>
    v.classSectionIds.flatMap((cs) =>
      Array.from({ length: v.span }, (_, i) => `${cs}@${day}:${period + i}`),
    );
  const put = (v: SolverVariable, day: number, period: number, roomId: number | null) => {
    state.place(v, day, period, roomId);
    byVar.set(v.id, { ...byVar.get(v.id)!, day, period, roomId });
    for (const k of cellKeys(v, day, period)) occupant.set(k, v.id);
  };
  const lift = (v: SolverVariable) => {
    const at = byVar.get(v.id)!;
    state.unplace(v, at.day, at.period, at.roomId);
    for (const k of cellKeys(v, at.day, at.period)) occupant.delete(k);
    return at;
  };
  const touch = (v: SolverVariable) => {
    if (touched && !touched.has(v.id)) touched.set(v.id, byVar.get(v.id)!);
  };

  for (const p of placements) {
    const v = varById.get(p.variableId);
    if (!v) continue;
    byVar.set(p.variableId, p);
    state.place(v, p.day, p.period, p.roomId);
    for (const k of cellKeys(v, p.day, p.period)) occupant.set(k, v.id);
  }

  let metric = state.totalShortfall();

  /**
   * Get this lesson off `awayFrom`, swapping with whatever is in the way if
   * need be — which is the normal case, not the exception. A school whose
   * sections are 100% full has no empty cell anywhere, so a pass that could
   * only *move* lessons would be a no-op on exactly the timetables that need
   * it. Takes the first legal landing, best day first; whether the attempt as
   * a whole was worth making is the caller's judgement.
   */
  const rehome = (v: SolverVariable, awayFrom: number): boolean => {
    touch(v);
    const home = lift(v);
    const cands = v.domain
      .filter((c) => c.day !== awayFrom)
      .sort((a, b) => dayCost(state, v, a.day) - dayCost(state, v, b.day));

    for (const c of cands) {
      if (Date.now() >= deadline) break;
      const direct = state.check(v, c.day, c.period);
      if (direct.ok) { put(v, c.day, c.period, direct.roomId); return true; }

      const holderId = occupant.get(`${v.classSectionIds[0]}@${c.day}:${c.period}`);
      const w = holderId !== undefined ? varById.get(holderId) : undefined;
      if (!w || w.id === v.id || w.span !== v.span) continue;

      const wHome = lift(w);
      const forV = state.check(v, c.day, c.period);
      if (forV.ok) {
        state.place(v, c.day, c.period, forV.roomId);
        const forW = state.check(w, home.day, home.period);
        state.unplace(v, c.day, c.period, forV.roomId);
        if (forW.ok) {
          touch(w);
          put(w, home.day, home.period, forW.roomId);
          put(v, c.day, c.period, forV.roomId);
          return true;
        }
      }
      put(w, wHome.day, wHome.period, wHome.roomId);
    }
    put(v, home.day, home.period, home.roomId);
    return false;
  };

  /**
   * Clear one thin teacher-day entirely.
   *
   * All or nothing, because half of it is worse than none: taking one lesson
   * off a two-period Tuesday leaves a one-period Tuesday, which scores worse
   * than what it started with. So the whole day moves speculatively and is
   * kept only if the school's total shortfall actually falls.
   */
  const evacuate = (teacherId: number, day: number): boolean => {
    const lessons = [...byVar.values()]
      .filter((p) => p.day === day && teachersOf(varById.get(p.variableId)!).includes(teacherId))
      .map((p) => varById.get(p.variableId)!);
    if (lessons.length === 0) return false;

    touched = new Map();
    let all = true;
    for (const v of lessons) {
      if (!rehome(v, day)) { all = false; break; }
    }
    if (all && state.totalShortfall() < metric) {
      touched = null;
      metric = state.totalShortfall();
      return true;
    }
    for (const id of touched.keys()) lift(varById.get(id)!);
    for (const [id, at] of touched) put(varById.get(id)!, at.day, at.period, at.roomId);
    touched = null;
    return false;
  };

  for (let round = 0; round < 8 && metric > 0 && Date.now() < deadline; round++) {
    let improved = false;
    // Thinnest days first: a day holding one lesson clears as soon as that one
    // lesson finds a home, which is the cheapest win available.
    for (const s of state.shortDays().sort((a, b) => a.periods - b.periods)) {
      if (Date.now() >= deadline) break;
      if (evacuate(s.teacherId, s.day)) improved = true;
    }
    if (!improved) break;
  }

  return [...byVar.values()];
}

/** How unwelcome `day` is for this lesson, §20-wise: 0 = every teacher is
 *  already past their minimum there, higher = it would start a thin day. */
function dayCost(state: SolverState, v: SolverVariable, day: number): number {
  let cost = 0;
  for (const t of teachersOf(v)) {
    const min = state.minPerDayOf(t);
    const count = state.teacherDayLoad(t, day);
    if (min > 1 && count === 0) cost += min;
    else if (min > 1 && count < min) cost += min - count;
  }
  return cost;
}

/**
 * §20 audit over a finished (or partial) assignment: which teacher-days ended
 * up with periods but fewer than the teacher's minimum. Replaying through a
 * plain SolverState keeps the arithmetic in one place — the same counters the
 * search maintained, rather than a second implementation that could disagree.
 */
export function countShortDays(
  input: SolverInput,
  baseVars: SolverVariable[],
  placements: Placement[],
): Array<{ teacherId: number; day: number; periods: number; min: number }> {
  const state = new SolverState(input);
  const byId = new Map(baseVars.map((v) => [v.id, v]));
  for (const p of placements) {
    const v = byId.get(p.variableId);
    if (v) state.place(v, p.day, p.period, p.roomId);
  }
  return state.shortDays();
}

function repair(
  input: SolverInput,
  baseVars: SolverVariable[],
  placements: Placement[],
  minBudget: Map<number, number> | null,
): { placements: Placement[]; unplaced: UnplacedVariable[] } {
  const state = new SolverState(input, { minPerDayBudget: minBudget ?? undefined });
  const varById = new Map(baseVars.map((v) => [v.id, v]));
  const placementByVar = new Map<number, Placement>();
  for (const p of placements) {
    state.place(varById.get(p.variableId)!, p.day, p.period, p.roomId);
    placementByVar.set(p.variableId, p);
  }
  const makePlacement = (v: SolverVariable, day: number, period: number, roomId: number | null): Placement => ({
    variableId: v.id,
    classSectionIds: v.classSectionIds,
    subjectId: v.subjectId,
    teacherId: v.teacherId,
    mergedGroupId: v.mergedGroupId,
    electiveBlockId: v.electiveBlockId,
    options: v.options,
    day,
    period,
    span: v.span,
    roomId,
  });

  let progress = true;
  let rounds = 0;
  while (progress && rounds++ < 50) {
    progress = false;
    const unplacedVars = baseVars.filter((v) => !placementByVar.has(v.id));
    if (unplacedVars.length === 0) break;
    for (const v of unplacedVars) {
      // direct fit first
      let placed = false;
      for (const cand of v.domain) {
        const res = state.check(v, cand.day, cand.period);
        if (res.ok) {
          state.place(v, cand.day, cand.period, res.roomId);
          placementByVar.set(v.id, makePlacement(v, cand.day, cand.period, res.roomId));
          placed = true;
          break;
        }
      }
      if (placed) { progress = true; continue; }
      // depth-1 ejection: evict a single blocker and re-home it elsewhere
      for (const cand of v.domain) {
        const res = state.check(v, cand.day, cand.period);
        const uniqueBlockers = [...new Set(res.blockers)].filter((b) => b > 0);
        if (res.ok || uniqueBlockers.length !== 1) continue;
        const victimVar = varById.get(uniqueBlockers[0]);
        const victimPlacement = victimVar && placementByVar.get(victimVar.id);
        if (!victimVar || !victimPlacement) continue;
        state.unplace(victimVar, victimPlacement.day, victimPlacement.period, victimPlacement.roomId);
        const retry = state.check(v, cand.day, cand.period);
        if (retry.ok) {
          state.place(v, cand.day, cand.period, retry.roomId);
          // re-home the victim
          let rehomed = false;
          for (const vc of victimVar.domain) {
            const vr = state.check(victimVar, vc.day, vc.period);
            if (vr.ok) {
              state.place(victimVar, vc.day, vc.period, vr.roomId);
              placementByVar.set(victimVar.id, makePlacement(victimVar, vc.day, vc.period, vr.roomId));
              rehomed = true;
              break;
            }
          }
          if (rehomed) {
            placementByVar.set(v.id, makePlacement(v, cand.day, cand.period, retry.roomId));
            placed = true;
            break;
          }
          state.unplace(v, cand.day, cand.period, retry.roomId);
        }
        state.place(victimVar, victimPlacement.day, victimPlacement.period, victimPlacement.roomId);
      }
      if (placed) progress = true;
    }
  }

  const finalPlacements = [...placementByVar.values()];
  const placedIds = new Set(finalPlacements.map((p) => p.variableId));
  const unplaced: UnplacedVariable[] = baseVars
    .filter((v) => !placedIds.has(v.id))
    .map((v) => ({
      variableId: v.id,
      label: `${v.classSectionLabels.join("+")} · ${v.subjectName}${v.span > 1 ? ` (block of ${v.span})` : ""}`,
      reason: "no conflict-free slot found even after repair — place manually on the board",
    }));
  return { placements: finalPlacements, unplaced };
}

function attemptSolve(
  input: SolverInput,
  baseVars: SolverVariable[],
  random: () => number,
  started: number,
  budgetMs: number,
  opts: SolveOptions,
  minBudget: Map<number, number> | null,
  onStep: () => void,
  onBacktrack: () => void,
): { placements: Placement[]; unplaced: UnplacedVariable[] } {
  const state = new SolverState(input, { minPerDayBudget: minBudget ?? undefined });

  // §5.2 static constrainedness order: smallest domain first, blocks and merged
  // groups early, tie-broken by the teacher's cross-section degree.
  const teacherDegree = new Map<number, number>();
  for (const v of baseVars) {
    for (const t of teachersOf(v)) teacherDegree.set(t, (teacherDegree.get(t) ?? 0) + 1);
  }
  const degreeOf = (v: SolverVariable) =>
    teachersOf(v).reduce((n, t) => n + (teacherDegree.get(t) ?? 0), 0);
  const unassigned = [...baseVars].sort((a, b) => {
    const score = (v: SolverVariable) =>
      v.domain.length - v.span * 8 - v.classSectionIds.length * 6 - (v.samePeriodKey ? 10 : 0) - degreeOf(v) * 0.2;
    return score(a) - score(b);
  });

  const stack: Frame[] = [];
  const assignedIndex = new Map<number, number>(); // variableId -> stack depth
  let stepCount = 0;

  const legalValues = (v: SolverVariable, conflictSet: Set<number>) => {
    const values: Array<{ day: number; period: number }> = [];
    for (const cand of v.domain) {
      const res = state.check(v, cand.day, cand.period);
      if (res.ok) values.push(cand);
      else for (const b of res.blockers) conflictSet.add(b);
    }
    // §5.2 value ordering: seeded jitter, then prefer spread (low section/teacher
    // day load); class-teacher own-section variables pull toward Period 1 (§4.7).
    const varTeachers = teachersOf(v);
    const ownP1 = varTeachers.some((t) => {
      const tc = state.teacherCtx.get(t);
      return tc?.hasP1Rule && v.classSectionIds.every((id) => tc.p1OwnSections.has(id));
    });
    const jitter = new Map(values.map((val) => [val, random()]));
    /**
     * §20 — what a day is worth to this teacher. Only when the rule is being
     * enforced: the relaxed fallback pass has to behave exactly as the solver
     * did before §20 existed, or it inherits the very bias it exists to escape.
     *
     * The old rule was simply "prefer the emptiest day", which is precisely
     * what produced the one-period days: a light load, offered five equally
     * empty days, ends up spread one lesson to each. Now a day the teacher has
     * already started but not yet filled is the cheapest place to put a lesson,
     * and opening a fresh day is the most expensive — so the week packs itself
     * into whole days instead of dribbling across them. Once a day is past the
     * minimum the old spread preference takes over again, so nobody's Monday
     * absorbs the entire week.
     */
    const dayPreference = (t: number, day: number) => {
      const min = minBudget ? state.minPerDayOf(t) : 1;
      const count = state.teacherDayLoad(t, day);
      if (min <= 1) return count;
      if (count === 0) return 6;
      if (count < min) return -8;
      return count * 0.5;
    };
    values.sort((a, b) => {
      const load = (val: { day: number; period: number }) =>
        state.sectionDayLoad(v.classSectionIds[0], v.dayKey, val.day) * 4 +
        varTeachers.reduce((n, t) => n + dayPreference(t, val.day), 0) +
        (ownP1 ? (val.period === 1 ? -8 : 0) : 0) +
        (jitter.get(val) ?? 0);
      return load(a) - load(b);
    });
    return values;
  };

  while (stack.length < unassigned.length) {
    if (++stepCount % 200 === 0 && Date.now() - started > budgetMs) break;
    onStep();

    // bounded MRV (§5.2): among the next 24 statically-ordered unassigned
    // variables, pick the one with the fewest legal values right now.
    const pool = unassigned.filter((v) => !assignedIndex.has(v.id)).slice(0, 24);
    if (pool.length === 0) break;
    let chosen = pool[0];
    let chosenValues: Array<{ day: number; period: number }> | null = null;
    let chosenConflicts = new Set<number>();
    let bestCount = Infinity;
    for (const v of pool) {
      const conflicts = new Set<number>();
      const values = legalValues(v, conflicts);
      if (values.length < bestCount) {
        bestCount = values.length;
        chosen = v;
        chosenValues = values;
        chosenConflicts = conflicts;
        if (values.length === 0) break;
      }
    }

    const frame: Frame = {
      variable: chosen,
      values: chosenValues ?? [],
      nextValue: 0,
      placedAt: null,
      conflictSet: chosenConflicts,
    };

    // try values; on exhaustion, conflict-directed backjump (§5.3)
    let advanced = false;
    while (true) {
      if (frame.nextValue < frame.values.length) {
        const val = frame.values[frame.nextValue++];
        const res = state.check(frame.variable, val.day, val.period);
        if (!res.ok) { for (const b of res.blockers) frame.conflictSet.add(b); continue; }
        state.place(frame.variable, val.day, val.period, res.roomId);
        frame.placedAt = { ...val, roomId: res.roomId };
        assignedIndex.set(frame.variable.id, stack.length);
        stack.push(frame);
        opts.onProgress?.(stack.length, unassigned.length);
        advanced = true;
        break;
      }
      // dead end → jump to the deepest variable that caused it
      onBacktrack();
      let target = -1;
      for (const blocker of frame.conflictSet) {
        const depth = assignedIndex.get(blocker);
        if (depth !== undefined && depth > target) target = depth;
      }
      if (target < 0) target = stack.length - 1; // chronological fallback
      if (target < 0) return finish(state, stack, unassigned); // truly stuck at root
      // unwind to target, merging conflict sets so blame propagates upward
      while (stack.length > target) {
        const popped = stack.pop()!;
        assignedIndex.delete(popped.variable.id);
        if (popped.placedAt) {
          state.unplace(popped.variable, popped.placedAt.day, popped.placedAt.period, popped.placedAt.roomId);
          popped.placedAt = null;
        }
        if (stack.length === target) {
          for (const c of frame.conflictSet) if (c !== popped.variable.id) popped.conflictSet.add(c);
          // resume trying the popped frame's remaining values
          Object.assign(frame, popped);
        }
      }
      if (Date.now() - started > budgetMs) return finish(state, stack, unassigned);
    }
    if (!advanced) break;
  }
  return finish(state, stack, unassigned);
}

function finish(
  state: SolverState,
  stack: Frame[],
  allVars: SolverVariable[],
): { placements: Placement[]; unplaced: UnplacedVariable[] } {
  const placements: Placement[] = stack
    .filter((f) => f.placedAt)
    .map((f) => ({
      variableId: f.variable.id,
      classSectionIds: f.variable.classSectionIds,
      subjectId: f.variable.subjectId,
      teacherId: f.variable.teacherId,
      mergedGroupId: f.variable.mergedGroupId,
      electiveBlockId: f.variable.electiveBlockId,
      options: f.variable.options,
      day: f.placedAt!.day,
      period: f.placedAt!.period,
      span: f.variable.span,
      roomId: f.placedAt!.roomId,
    }));
  const placedIds = new Set(placements.map((p) => p.variableId));
  const unplaced: UnplacedVariable[] = allVars
    .filter((v) => !placedIds.has(v.id))
    .map((v) => {
      // best-effort reason: what blocks its first few domain values now
      const reasons = new Set<string>();
      for (const cand of v.domain.slice(0, 12)) {
        const res = state.check(v, cand.day, cand.period);
        if (!res.ok && res.reason) reasons.add(res.reason);
      }
      return {
        variableId: v.id,
        label: `${v.classSectionLabels.join("+")} · ${v.subjectName}${v.span > 1 ? ` (block of ${v.span})` : ""}`,
        reason:
          v.domain.length === 0
            ? "no legal slot exists after hard-rule pruning"
            : `no conflict-free slot found (${[...reasons].slice(0, 3).join("; ") || "search budget exhausted"})`,
      };
    });
  return { placements, unplaced };
}
