/**
 * Cache invalidation (§14, §17).
 *
 * Two bugs live here if nobody is watching, and both have bitten:
 *
 *   - **Forgetting the reports.** Publishing used to drop the slot caches and
 *     nothing else, so a class-section grid anyone had opened while the
 *     timetable was still a draft kept being served for the rest of its hour —
 *     a full week of "Free" for a timetable that had just gone live.
 *   - **Reaching outside the school.** Invalidation by `redis.keys("slots:*")`
 *     blocks the whole Redis instance and, once 9.1 put a school prefix in
 *     front of every key, silently matched nothing at all.
 *
 * So these pin what gets deleted *and* what does not.
 */
import { describe, expect, it } from "vitest";
import { CacheKeysService } from "./cache-keys.service";
import { readinessKey, reportKey, slotsKey } from "./cache-keys";

/** A Redis stand-in that is a Map, with a real SCAN over the key space. */
function fakeRedis(keys: string[]) {
  const store = new Set(keys);
  return {
    store,
    del: async (...ks: string[]) => {
      let n = 0;
      for (const k of ks) if (store.delete(k)) n++;
      return n;
    },
    scan: async (cursor: string, _m: string, pattern: string, _c: string, _n: number) => {
      const re = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
      return cursor === "0" ? ["0", [...store].filter((k) => re.test(k))] : ["0", []];
    },
  } as never;
}

const serviceFor = (redis: never, schoolId: number | null) =>
  new CacheKeysService({ schoolId: () => schoolId } as never, redis);

/** School 7's world, plus a neighbour's keys that must survive everything. */
const world = () => [
  slotsKey(7, 100, "draft"),
  slotsKey(7, 100, "published"),
  slotsKey(7, 100, "ctx"),
  slotsKey(7, 101, "draft"),
  readinessKey(7, 100),
  // §30.7 — a SECOND config's readiness, which is the one a per-config sweep
  // cannot reach and the reason the sweep is by pattern. Without this row the
  // assertion about it passes because the key was never there.
  readinessKey(7, 101),
  reportKey(7, "cs:260:base"),
  reportKey(7, "cs:260:2026-08-26"),
  reportKey(7, "t:408:base"),
  slotsKey(8, 100, "published"),
  reportKey(8, "cs:260:base"),
  readinessKey(8, 100),
];

describe("CacheKeysService.invalidateTimetable", () => {
  it("drops the config's slot caches AND every report of that school", async () => {
    const redis = fakeRedis(world());
    await serviceFor(redis, 7).invalidateTimetable(100);
    const left = [...(redis as unknown as { store: Set<string> }).store];

    expect(left).not.toContain(slotsKey(7, 100, "published"));
    // The half that used to be forgotten — this is the published-report bug.
    expect(left).not.toContain(reportKey(7, "cs:260:base"));
    expect(left).not.toContain(reportKey(7, "cs:260:2026-08-26"));
    expect(left).not.toContain(reportKey(7, "t:408:base"));
  });

  it("never touches another school's cache", async () => {
    const redis = fakeRedis(world());
    await serviceFor(redis, 7).invalidateTimetable(100);
    const left = [...(redis as unknown as { store: Set<string> }).store];
    expect(left).toContain(slotsKey(8, 100, "published"));
    expect(left).toContain(reportKey(8, "cs:260:base"));
    expect(left).toContain(readinessKey(8, 100));
  });

  it("leaves this school's other configs' DRAFTS alone", async () => {
    const redis = fakeRedis(world());
    await serviceFor(redis, 7).invalidateTimetable(100);
    const left = [...(redis as unknown as { store: Set<string> }).store];
    // Publishing one wing does not change another wing's draft grid.
    expect(left).toContain(slotsKey(7, 101, "draft"));
  });

  /**
   * §30.7 — this test asserted the OPPOSITE until stage 6, and the rule it
   * stated was true when it was written: readiness answered "is this
   * timetable's master data feasible?", which publishing a different wing
   * cannot change.
   *
   * It answers more than that now. A readiness result also carries the clashes
   * with the other timetables that are LIVE — a teacher in two wings at 09:14 —
   * so publishing B genuinely changes what A reports. Swept by pattern rather
   * than by config id, because the answer that went stale belongs to a
   * different config from the one being published, which is exactly what a
   * per-config sweep cannot reach.
   */
  it("drops every readiness answer the school holds, because publishing changes what the others say", async () => {
    const redis = fakeRedis(world());
    await serviceFor(redis, 7).invalidateTimetable(100);
    const left = [...(redis as unknown as { store: Set<string> }).store];
    expect(left).not.toContain(readinessKey(7, 100));
    expect(left).not.toContain(readinessKey(7, 101));
    // Still nothing of anybody else's (§17).
    expect(left).toContain(readinessKey(8, 100));
  });

  it("without a config — a substitution is dated, not scoped — drops every slot cache of the school", async () => {
    const redis = fakeRedis(world());
    await serviceFor(redis, 7).invalidateTimetable();
    const left = [...(redis as unknown as { store: Set<string> }).store];
    expect(left).not.toContain(slotsKey(7, 100, "draft"));
    expect(left).not.toContain(slotsKey(7, 101, "draft"));
    expect(left).not.toContain(reportKey(7, "cs:260:2026-08-26"));
    expect(left).toContain(slotsKey(8, 100, "published"));
  });

  it("refuses to build a key with no school in context rather than writing a global one", async () => {
    await expect(serviceFor(fakeRedis([]), null).invalidateTimetable(100)).rejects.toThrow(/tenant context/);
  });
});
