/**
 * Fair scheduling across schools (§17.7, Phase 9.9).
 *
 * The solver worker ran at `concurrency: 1`, which is right for one school —
 * generation is CPU-bound and single-threaded, so running several at once only
 * timeshares a core. With many schools it is a **head-of-line block**: a school
 * whose generation takes 60 seconds stalls every other school's 5-second job
 * behind it, and the smaller school's wait is entirely someone else's doing.
 *
 * Two changes together fix that, and neither works alone:
 *
 *   1. **Concurrency above one.** Even on a single core, timesharing beats
 *      queueing for fairness: B's 5s job behind A's 60s job finishes at 65s
 *      with concurrency 1, and at roughly 10s with concurrency 2. Nobody
 *      finishes later than they would have; the small job finishes far sooner.
 *
 *   2. **A per-school cap on jobs actually running.** Concurrency alone is not
 *      fairness — one school queueing four jobs would simply occupy all four
 *      slots and block everyone anyway. With a cap of one running job per
 *      school, the slots go to *different* schools.
 *
 * A capped-out job is **deferred, not failed**: BullMQ's `moveToDelayed` +
 * `DelayedError` puts it back on the queue after a short wait without
 * consuming a retry or marking it failed. It is not starvation — the running
 * job releases the lock when it finishes, and the deferred job takes it next.
 *
 * BullMQ's own job groups would do this natively, but they are a Pro feature;
 * this is the equivalent in OSS terms, and it is small enough to read.
 */
import { DelayedError, type Job } from "bullmq";
import type Redis from "ioredis";

/** How long a school may hold a slot before the lock is assumed abandoned. */
const LOCK_TTL_SECONDS = Number(process.env.SOLVER_LOCK_TTL_SECONDS ?? 900);
/** How long a capped-out job waits before trying again. */
const DEFER_MS = Number(process.env.SOLVER_DEFER_MS ?? 3_000);

export const inFlightKey = (queue: string, schoolId: number) => `sched:inflight:${queue}:${schoolId}`;

/**
 * Try to claim this school's slot on a queue.
 *
 * The lock carries a TTL so a worker that dies mid-job cannot lock a school out
 * forever — the worst case is that school waiting out the TTL, rather than
 * needing manual intervention. It is released in a `finally`, so the TTL is the
 * backstop and not the normal path.
 */
export async function acquireSlot(
  redis: Redis,
  queue: string,
  schoolId: number,
  jobId: string,
): Promise<boolean> {
  const result = await redis.set(inFlightKey(queue, schoolId), jobId, "EX", LOCK_TTL_SECONDS, "NX");
  return result !== null;
}

/**
 * Release this school's slot — but only if we still hold it. Deleting
 * unconditionally would let a job whose lock had already expired delete the
 * lock of the *next* job for the same school.
 */
export async function releaseSlot(
  redis: Redis,
  queue: string,
  schoolId: number,
  jobId: string,
): Promise<void> {
  const key = inFlightKey(queue, schoolId);
  const held = await redis.get(key);
  if (held === jobId) await redis.del(key);
}

/**
 * Wrap a job handler so at most one job per school runs at a time.
 *
 * `token` is BullMQ's job-lock token and must be passed through: `moveToDelayed`
 * refuses without it, and a job deferred without it would be lost rather than
 * re-queued.
 */
export function withFairScheduling<T>(
  redis: Redis,
  queue: string,
  handler: (job: Job, schoolId: number) => Promise<T>,
  onDefer?: (job: Job, schoolId: number) => void,
) {
  return async (job: Job, token?: string): Promise<T> => {
    const schoolId: unknown = job.data?.schoolId;
    // Nothing to be fair about without a school; run it.
    if (typeof schoolId !== "number") return handler(job, -1);

    const jobId = String(job.id);
    if (!(await acquireSlot(redis, queue, schoolId, jobId))) {
      onDefer?.(job, schoolId);
      await job.moveToDelayed(Date.now() + DEFER_MS, token);
      // Tells BullMQ the job was deferred deliberately: not a failure, no retry
      // consumed, no error logged.
      throw new DelayedError();
    }

    try {
      return await handler(job, schoolId);
    } finally {
      await releaseSlot(redis, queue, schoolId, jobId).catch(() => undefined);
    }
  };
}

/** What the Platform Console reports about queue fairness (§17.6). */
export async function schedulingStats(redis: Redis, queue: string) {
  const keys = await redis.keys(inFlightKey(queue, 0).replace(/:0$/, ":*"));
  return {
    queue,
    runningSchools: keys.map((k) => Number(k.split(":").pop())).filter((n) => Number.isFinite(n)),
  };
}
