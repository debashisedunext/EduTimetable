/**
 * The worker process (compose service `worker`). Runs the Phase 2 solver as a
 * background job — CPU-heavy generation never touches the API's request path
 * (CLAUDE.md invariant). Progress streams to the api via BullMQ QueueEvents,
 * which the EventsGateway forwards to Socket.IO clients.
 */
import { Worker } from "bullmq";
import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
import { runFeasibility, solveTimetable } from "@edutimetable/shared";
import { buildSolverInput } from "./solver/input";
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

    const { rows } = await writeDraftSlots(prisma, configId, result.placements);
    await redis.del(`slots:${configId}:draft`);

    const summary = {
      configId,
      placedVariables: result.placements.length,
      totalVariables: result.totalVariables,
      slotRows: rows,
      unplaced: result.unplaced,
      stats: result.stats,
    };
    console.log(
      `[worker] solver job ${job.id} done: ${summary.placedVariables}/${summary.totalVariables} vars, ${rows} slot rows, ${result.unplaced.length} unplaced, ${result.stats.ms}ms`,
    );
    return summary;
  },
  { connection, concurrency: 1 },
);

console.log("[worker] listening on queues 'demo', 'solver'");
