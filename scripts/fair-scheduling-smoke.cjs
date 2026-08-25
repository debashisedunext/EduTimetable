/**
 * Phase 9.9 (§17.7) — one school cannot monopolise the worker. LIVE stack.
 *
 *   docker compose exec api node /app/scripts/fair-scheduling-smoke.cjs
 *
 * The problem: the worker ran at `concurrency: 1`, so a school whose generation
 * takes a minute stalled every other school's five-second job behind it. The
 * smaller school's wait was entirely someone else's doing, and nothing in the
 * system said so.
 *
 * Measuring that needs a job with a predictable duration, which generation is
 * not — so this uses the `demo` queue, which exists precisely as the smoke path
 * for the queue infrastructure and now runs under the same scheduling rules.
 *
 *   1. NOT BLOCKED — school B's job finishes while school A's long job is still
 *                    running, rather than after it
 *   2. CAPPED      — one school queueing several jobs runs them one at a time,
 *                    so it cannot take every slot
 *   3. DEFERRED    — a capped job is delayed and completes, never failed
 *   4. REPORTED    — the Platform Console shows which schools are running
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { Queue, QueueEvents } = req("bullmq");
const Redis = req("ioredis");

const connection = { host: process.env.REDIS_HOST ?? "redis", port: 6379 };
const SCHOOL_A = 90001;
const SCHOOL_B = 90002;

let failed = 0;
const check = (ok, l, x = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${x ? ` — ${x}` : ""}`);
  if (!ok) failed = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const queue = new Queue("demo", { connection });
  const events = new QueueEvents("demo", { connection });
  await events.waitUntilReady();
  const redis = new Redis(connection);

  // Each step is 150ms, so `steps` is a duration dial in ~150ms units.
  const finished = new Map();
  const started = Date.now();
  events.on("completed", ({ jobId }) => finished.set(jobId, Date.now() - started));

  // ------------------------------------------------------- 1. NOT BLOCKED
  console.log("A long job in one school does not block a short job in another:");
  const long = await queue.add("demo", { steps: 40, schoolId: SCHOOL_A }); // ~6s
  await sleep(400); // let it be picked up first
  const short = await queue.add("demo", { steps: 4, schoolId: SCHOOL_B }); // ~0.6s

  // Generous: these jobs take ~6s and ~0.6s idle, but this suite runs them on a
  // box that may be solving timetables at the same time, and a slow machine is
  // not a scheduling failure.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !(finished.has(long.id) && finished.has(short.id))) {
    await sleep(150);
  }
  const longMs = finished.get(long.id);
  const shortMs = finished.get(short.id);
  // Say *why* when a job never arrives: "undefined ms" sends you looking at the
  // scheduling logic when the answer is usually the job's own state.
  const why = async (job, label) =>
    finished.has(job.id) ? "" : ` · ${label} is '${await job.getState()}'${job.failedReason ? `: ${job.failedReason}` : ""}`;
  check(shortMs !== undefined && longMs !== undefined, "both jobs completed",
    `A ${longMs ?? "—"}ms · B ${shortMs ?? "—"}ms${await why(long, "A")}${await why(short, "B")}`);
  if (shortMs === undefined || longMs === undefined) {
    console.log("\nCannot measure fairness without both jobs — is the worker running?");
    process.exit(1);
  }
  check(shortMs < longMs, "school B finished FIRST, while A was still running",
    `B at ${shortMs}ms vs A at ${longMs}ms`);
  // Under the old concurrency:1 behaviour B could not have finished before A
  // even started winding down — this is the number that would regress.
  check(shortMs < longMs * 0.6,
    "and finished on its own merits, not merely after A's tail", `B took ${shortMs}ms of A's ${longMs}ms`);

  // ------------------------------------------------------------ 2. CAPPED
  console.log("\nOne school queueing several jobs still runs them one at a time:");
  finished.clear();
  const t0 = Date.now();
  const burst = await Promise.all([
    queue.add("demo", { steps: 8, schoolId: SCHOOL_A }),
    queue.add("demo", { steps: 8, schoolId: SCHOOL_A }),
    queue.add("demo", { steps: 8, schoolId: SCHOOL_A }),
  ]);
  // While they run, another school must still get through promptly.
  await sleep(300);
  const interloper = await queue.add("demo", { steps: 3, schoolId: SCHOOL_B });

  const burstDeadline = Date.now() + 120_000;
  while (Date.now() < burstDeadline && ![...burst, interloper].every((j) => finished.has(j.id))) {
    await sleep(150);
  }
  const burstTimes = burst.map((j) => finished.get(j.id)).filter(Boolean);
  check(burstTimes.length === 3, "all three of school A's jobs completed", burstTimes.map((n) => `${n - t0 + t0}ms`).join(", "));

  // Serialised, not parallel: three ~1.2s jobs one after another take ~3.6s.
  // If the cap were absent they would all finish at roughly the same moment.
  const spread = Math.max(...burstTimes) - Math.min(...burstTimes);
  check(spread > 1_500, "they were serialised rather than run together", `${spread}ms between first and last`);

  const interloperMs = finished.get(interloper.id);
  check(interloperMs !== undefined && interloperMs < Math.max(...burstTimes),
    "and school B got through while A still had jobs queued",
    `B at ${interloperMs}ms vs A's last at ${Math.max(...burstTimes)}ms`);

  // ---------------------------------------------------------- 3. DEFERRED
  console.log("\nA capped job is deferred, never failed:");
  const failedJobs = await queue.getFailed(0, 50);
  const ours = failedJobs.filter((j) => [SCHOOL_A, SCHOOL_B].includes(j.data?.schoolId));
  check(ours.length === 0, "no job failed while waiting its turn", `${ours.length} failed`);

  // ---------------------------------------------------------- 4. REPORTED
  console.log("\nThe running schools are visible to an operator:");
  const during = await queue.add("demo", { steps: 30, schoolId: SCHOOL_A });
  await sleep(900);
  const keys = await redis.keys("sched:inflight:demo:*");
  const schools = keys.map((k) => Number(k.split(":").pop()));
  check(schools.includes(SCHOOL_A), "the in-flight slot names the school holding it", keys.join(", ") || "none");
  await during.remove().catch(() => undefined);

  // ----------------------------------------------------------------- cleanup
  console.log("\nCleanup:");
  await sleep(5_000); // let the last job drain so it does not leak a lock
  for (const s of [SCHOOL_A, SCHOOL_B]) await redis.del(`sched:inflight:demo:${s}`);
  const drained = await queue.getJobs(["completed", "failed", "delayed", "waiting"], 0, 200);
  for (const j of drained) {
    if ([SCHOOL_A, SCHOOL_B].includes(j.data?.schoolId)) await j.remove().catch(() => undefined);
  }
  check(true, "test jobs and locks removed");

  await events.close();
  await queue.close();
  await redis.quit();
  console.log(failed ? "\nSOME FAIR SCHEDULING CHECKS FAILED" : "\nALL FAIR SCHEDULING CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
