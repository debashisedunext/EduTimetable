/**
 * §5.2-5.4 — backtracking search with MRV ordering, seeded least-disruptive
 * value ordering, conflict-directed backjumping, restarts, and a best-partial
 * fallback with per-variable reasons when the budget runs out.
 */
import type { Placement, SolverInput, SolveOptions, SolverResult, SolverVariable, UnplacedVariable } from "./types";
import { SolverState } from "./state";
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

  let best: { placements: Placement[]; unplaced: UnplacedVariable[] } = { placements: [], unplaced: [] };
  let steps = 0, backtracks = 0, restarts = 0;

  // Budget is sliced per attempt: search rarely needs long — near-complete
  // partials are finished by the §5.4 repair pass, which runs after EVERY
  // attempt so a 99% partial never burns the remaining budget on thrashing.
  const maxRestarts = 3;
  for (let attempt = 0; attempt <= maxRestarts; attempt++) {
    const remaining = budgetMs - (Date.now() - started);
    if (remaining <= 0) break;
    const slice = Math.max(500, Math.min(remaining, Math.floor(budgetMs / (maxRestarts + 1))));
    const random = rng((input.seed ?? 1) + attempt * 7919);
    const out = attemptSolve(input, baseVars, random, Date.now(), slice, opts, () => steps++, () => backtracks++);
    if (out.placements.length > best.placements.length) best = out;
    if (best.unplaced.length === 0) break;
    const repaired = repair(input, baseVars, out.placements);
    if (repaired.unplaced.length < best.unplaced.length || best.placements.length === 0) best = repaired;
    if (best.unplaced.length === 0) break;
    restarts = attempt + 1;
  }

  return {
    placements: best.placements,
    unplaced: best.unplaced,
    totalVariables: total,
    stats: { steps, backtracks, restarts, ms: Date.now() - started },
  };
}

function repair(
  input: SolverInput,
  baseVars: SolverVariable[],
  placements: Placement[],
): { placements: Placement[]; unplaced: UnplacedVariable[] } {
  const state = new SolverState(input);
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
  onStep: () => void,
  onBacktrack: () => void,
): { placements: Placement[]; unplaced: UnplacedVariable[] } {
  const state = new SolverState(input);

  // §5.2 static constrainedness order: smallest domain first, blocks and merged
  // groups early, tie-broken by the teacher's cross-section degree.
  const teacherDegree = new Map<number, number>();
  for (const v of baseVars) {
    teacherDegree.set(v.teacherId, (teacherDegree.get(v.teacherId) ?? 0) + 1);
  }
  const unassigned = [...baseVars].sort((a, b) => {
    const score = (v: SolverVariable) =>
      v.domain.length - v.span * 8 - v.classSectionIds.length * 6 - (v.samePeriodKey ? 10 : 0) - (teacherDegree.get(v.teacherId) ?? 0) * 0.2;
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
    const tc = state.teacherCtx.get(v.teacherId);
    const ownP1 = tc?.hasP1Rule && v.classSectionIds.every((id) => tc.p1OwnSections.has(id));
    const jitter = new Map(values.map((val) => [val, random()]));
    values.sort((a, b) => {
      const load = (val: { day: number; period: number }) =>
        state.sectionDayLoad(v.classSectionIds[0], v.subjectId, val.day) * 4 +
        state.teacherDayLoad(v.teacherId, val.day) * 1 +
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
