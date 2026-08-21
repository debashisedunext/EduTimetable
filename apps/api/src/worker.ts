/**
 * The worker process (compose service `worker`). Phase 0 ships a plain BullMQ
 * worker proving the queue pipeline end to end; Phase 2 replaces the demo
 * processor with the solver engine (still in this container, off the API's
 * request path — CLAUDE.md invariant).
 */
import { Worker } from "bullmq";

const connection = {
  host: process.env.REDIS_HOST ?? "redis",
  port: Number(process.env.REDIS_PORT ?? 6379),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const worker = new Worker(
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

worker.on("completed", (job) => console.log(`[worker] demo job ${job.id} completed`));
worker.on("failed", (job, err) => console.error(`[worker] job ${job?.id} failed:`, err));
console.log("[worker] listening on queue 'demo'");
