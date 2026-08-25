/**
 * Fair scheduling across schools (§17.7, Phase 9.9).
 *
 * The behaviour is proved end to end in `scripts/fair-scheduling-smoke.cjs`,
 * with real jobs and real timings. These pin the lock's edge cases, which are
 * the parts that fail quietly: a lock released by the wrong job, or one held
 * forever by a worker that died.
 */
import { describe, expect, it, vi } from "vitest";
import { acquireSlot, inFlightKey, releaseSlot } from "./fair-scheduling";

/** A minimal in-memory stand-in for the Redis calls this module makes. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (key: string, value: string, _ex: string, _ttl: number, nx: string) => {
      if (nx === "NX" && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };
}

describe("per-school slots", () => {
  it("lets the first job for a school in", async () => {
    const redis = fakeRedis();
    await expect(acquireSlot(redis as never, "solver", 3, "job-1")).resolves.toBe(true);
  });

  it("keeps a second job for the SAME school out", async () => {
    // This is the cap: concurrency alone is not fairness, because one school
    // queueing four jobs would otherwise take all four worker slots.
    const redis = fakeRedis();
    await acquireSlot(redis as never, "solver", 3, "job-1");
    await expect(acquireSlot(redis as never, "solver", 3, "job-2")).resolves.toBe(false);
  });

  it("lets a DIFFERENT school in at the same time", async () => {
    const redis = fakeRedis();
    await acquireSlot(redis as never, "solver", 3, "job-1");
    await expect(acquireSlot(redis as never, "solver", 4, "job-2")).resolves.toBe(true);
  });

  it("frees the school once the job releases", async () => {
    const redis = fakeRedis();
    await acquireSlot(redis as never, "solver", 3, "job-1");
    await releaseSlot(redis as never, "solver", 3, "job-1");
    await expect(acquireSlot(redis as never, "solver", 3, "job-2")).resolves.toBe(true);
  });

  it("will not let one job release another's lock", async () => {
    // The dangerous case: job-1's lock expires, job-2 acquires, then job-1
    // finishes and releases. Deleting unconditionally would free a slot that
    // job-2 is still using, and two of that school's jobs would run at once.
    const redis = fakeRedis();
    await acquireSlot(redis as never, "solver", 3, "job-2");
    await releaseSlot(redis as never, "solver", 3, "job-1");
    expect(redis.store.get(inFlightKey("solver", 3))).toBe("job-2");
  });

  it("takes a TTL, so a dead worker cannot lock a school out forever", async () => {
    const redis = fakeRedis();
    await acquireSlot(redis as never, "solver", 3, "job-1");
    const [, , ex, ttl, nx] = redis.set.mock.calls[0];
    expect(ex).toBe("EX");
    expect(ttl).toBeGreaterThan(0);
    expect(nx).toBe("NX");
  });

  it("keeps queues separate", async () => {
    // The demo and solver queues both schedule fairly, but a school running a
    // demo job is not a reason to hold up its generation.
    const redis = fakeRedis();
    await acquireSlot(redis as never, "solver", 3, "job-1");
    await expect(acquireSlot(redis as never, "demo", 3, "job-2")).resolves.toBe(true);
  });
});
