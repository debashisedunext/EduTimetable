/**
 * The worker process (compose service `worker`). Runs the Phase 2 solver as a
 * background job — CPU-heavy generation never touches the API's request path
 * (CLAUDE.md invariant). Progress streams to the api via BullMQ QueueEvents,
 * which the EventsGateway forwards to Socket.IO clients.
 */
import { Worker } from "bullmq";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import {
  buildTeacherCtx,
  buildVariables,
  DEFAULT_WEIGHTS,
  describeImprovement,
  runFeasibility,
  scoreTimetable,
  solveTimetable,
  type ObjectiveWeights,
} from "@edutimetable/shared";
import { buildSolverInput } from "./solver/input";
import { optimizeWithCpSat, type OptimizeOutcome } from "./solver/optimize";
import { writeDraftSlots } from "./solver/writer";

const connection = {
  host: process.env.REDIS_HOST ?? "redis",
  port: Number(process.env.REDIS_PORT ?? 6379),
};
const prisma = new PrismaClient();
const redis = new Redis(connection);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Phase 0 pipeline demo — kept as the smoke path for the queue infrastructure.
new Worker(
  "demo",
  async (job) => {
    const steps: number = job.data.steps ?? 20;
    for (let i = 1; i <= steps; i++) {
      await sleep(150);
      await job.updateProgress(Math.round((i / steps) * 100));
    }
    return { placed: steps };
  },
  { connection },
);

new Worker(
  "solver",
  async (job) => {
    const configId: number = job.data.configId;
    console.log(`[worker] solver job ${job.id}: config ${configId}`);
    const input = await buildSolverInput(prisma, configId);

    // Phase A gate (§1 design thesis): the solver only runs on proven-feasible input.
    const feasibility = runFeasibility(input.snapshot);
    if (!feasibility.ready) {
      throw new Error(
        `Feasibility gate failed: ${feasibility.blockers.length} blocker(s) — fix them on the Readiness Dashboard first`,
      );
    }

    let lastReported = 0;
    const result = solveTimetable(input, {
      budgetMs: 30_000,
      onProgress: (placed, total) => {
        if (placed - lastReported >= Math.max(1, Math.floor(total / 50)) || placed === total) {
          lastReported = placed;
          void job.updateProgress({ placed, total });
        }
      },
    });

    // ---- Phase 6 (§5.6): optional soft-optimization pass ----
    // The fast result above is already valid and is the floor: CP-SAT's answer
    // is adopted only if it verifies AND scores better (task 6.3 parity gate).
    const mode: "fast" | "optimized" = job.data.mode === "optimized" ? "optimized" : "fast";
    const weights: ObjectiveWeights = { ...DEFAULT_WEIGHTS, ...(job.data.weights ?? {}) };
    const variables = buildVariables(input, buildTeacherCtx(input));
    let placements = result.placements;
    const before = scoreTimetable(input, placements, variables, weights);
    let optimization: OptimizeOutcome = {
      attempted: false,
      adopted: false,
      status: "SKIPPED",
      detail: "fast mode — feasibility only",
    };

    if (mode === "optimized" && result.unplaced.length === 0) {
      void job.updateProgress({ placed: result.placements.length, total: result.totalVariables, phase: "optimizing" });
      optimization = await optimizeWithCpSat(
        input,
        variables,
        placements,
        weights,
        Number(job.data.optimizeBudgetSec ?? 30),
      );
      if (optimization.adopted && optimization.placements) placements = optimization.placements;
    } else if (mode === "optimized") {
      optimization = {
        attempted: false,
        adopted: false,
        status: "SKIPPED",
        detail: `${result.unplaced.length} variable(s) unplaced — optimizing a partial timetable would hide the gap`,
      };
    }
    const after = scoreTimetable(input, placements, variables, weights);

    const { rows } = await writeDraftSlots(prisma, configId, placements);
    await redis.del(`slots:${configId}:draft`);

    const summary = {
      configId,
      // echoed for the §9 solver-completed notification (NotificationsService)
      userId: job.data.userId ?? undefined,
      mode,
      placements: placements.length,
      total: result.totalVariables,
      placedVariables: placements.length,
      totalVariables: result.totalVariables,
      slotRows: rows,
      unplaced: result.unplaced,
      stats: result.stats,
      objective: {
        weights,
        before,
        after,
        improvement: describeImprovement(before, after),
        optimization,
      },
    };
    console.log(
      `[worker] solver job ${job.id} done [${mode}]: ${summary.placedVariables}/${summary.totalVariables} vars, ${rows} slot rows, ${result.unplaced.length} unplaced, ${result.stats.ms}ms · objective ${before.weighted}→${after.weighted} (${optimization.detail})`,
    );
    return summary;
  },
  { connection, concurrency: 1 },
);

console.log("[worker] listening on queues 'demo', 'solver'");
