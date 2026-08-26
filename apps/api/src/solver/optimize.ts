/**
 * Task 6.1/6.3 — the CP-SAT bridge, used only by the worker.
 *
 * Contract with the rest of the system: this function can fail in any way
 * (service down, timeout, infeasible, buggy answer) and the caller still has a
 * valid timetable, because the fast engine's result is computed first and the
 * optimizer's answer is only adopted when it (a) passes the real
 * ConstraintChecker and (b) scores strictly better on the §5.6 objective.
 */
import {
  buildCpSatModel,
  scoreTimetable,
  verifyAssignment,
  type CpSatResponse,
  type ObjectiveWeights,
  type Placement,
  type SolverInput,
  type SolverVariable,
} from "@edutimetable/shared";

export interface OptimizeOutcome {
  attempted: boolean;
  adopted: boolean;
  status: string;
  detail: string;
  placements?: Placement[];
  wallTimeSec?: number;
}

export async function optimizeWithCpSat(
  input: SolverInput,
  variables: SolverVariable[],
  basePlacements: Placement[],
  weights: ObjectiveWeights,
  budgetSec: number,
): Promise<OptimizeOutcome> {
  // §4.9 split electives are not modelled in CP-SAT: a variable with several
  // simultaneous teachers and a fixed room per option has no representation in
  // the payload. Optimising only the rest and leaving the blocks out would
  // produce placements that collide with them and fail the §5.6 replay gate —
  // burning the whole budget to be rejected. Skipping is the same graceful
  // degradation as the optimizer being down: the fast result is already valid.
  const blocks = input.snapshot.electiveBlocks.length;
  if (blocks > 0) {
    return {
      attempted: false,
      adopted: false,
      status: "SKIPPED",
      detail: `${blocks} split elective block(s) — CP-SAT does not model them yet, so the fast result stands`,
    };
  }

  const url = process.env.OPTIMIZER_URL ?? "http://optimizer:8000";
  const model = buildCpSatModel(input, variables, weights, budgetSec);

  let res: CpSatResponse;
  try {
    const controller = new AbortController();
    // generous client-side ceiling: the solver enforces its own time limit
    const timer = setTimeout(() => controller.abort(), (budgetSec + 30) * 1000);
    const httpRes = await fetch(`${url}/solve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(model),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!httpRes.ok) {
      return { attempted: true, adopted: false, status: `HTTP_${httpRes.status}`, detail: "optimizer rejected the model — keeping the fast result" };
    }
    res = (await httpRes.json()) as CpSatResponse;
  } catch (e) {
    return {
      attempted: true,
      adopted: false,
      status: "UNREACHABLE",
      detail: `optimizer unavailable (${(e as Error).message}) — keeping the fast result`,
    };
  }

  if (res.assignments.length !== variables.length) {
    return {
      attempted: true,
      adopted: false,
      status: res.status,
      detail: `optimizer covered ${res.assignments.length}/${variables.length} variables — keeping the fast result`,
      wallTimeSec: res.wallTimeSec,
    };
  }

  // ---- the parity gate: replay through the real ConstraintChecker ----
  const verified = verifyAssignment(input, variables, res.assignments);
  if (!verified.ok) {
    return {
      attempted: true,
      adopted: false,
      status: "REJECTED_BY_CHECKER",
      detail: `optimizer answer failed hard-constraint verification (${verified.reason}) — keeping the fast result`,
      wallTimeSec: res.wallTimeSec,
    };
  }

  const before = scoreTimetable(input, basePlacements, variables, weights);
  const after = scoreTimetable(input, verified.placements, variables, weights);
  if (after.weighted >= before.weighted) {
    return {
      attempted: true,
      adopted: false,
      status: res.status,
      detail: `optimizer found nothing better (score ${after.weighted} vs ${before.weighted}) — keeping the fast result`,
      wallTimeSec: res.wallTimeSec,
    };
  }

  return {
    attempted: true,
    adopted: true,
    status: res.status,
    detail: `optimized (score ${before.weighted} → ${after.weighted})`,
    placements: verified.placements,
    wallTimeSec: res.wallTimeSec,
  };
}
