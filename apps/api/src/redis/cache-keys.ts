/**
 * Phase 9.1 (§17) — every Redis key is namespaced by school.
 *
 * Before this, keys were global (`readiness:{configId}`, `slots:{configId}:…`)
 * and, worse, invalidation ran `redis.keys("readiness:*")` — so one school
 * editing one subject flushed the readiness and slot caches of *every* school
 * in the deployment. Config ids happen to be globally unique today, so this
 * was a correctness-and-cost bug rather than a data leak; under 9.3's
 * database-per-tenant mode, where ids repeat across databases, it would have
 * become a real one.
 *
 * The pure functions below are the single definition of the key shapes, shared
 * by the API (via CacheKeysService, which supplies the ambient school) and the
 * solver worker (which passes the school from its job data).
 */

/** Everything a school owns lives under this prefix, and nothing else does. */
export const schoolPrefix = (schoolId: number) => `s${schoolId}`;

export const readinessKey = (schoolId: number, configId: number) =>
  `${schoolPrefix(schoolId)}:readiness:${configId}`;

/**
 * §30.7 — every readiness answer this school holds.
 *
 * Needed because a readiness answer stopped being about one timetable alone:
 * it now reports clashes with the OTHER timetables that are live, so publishing
 * B changes what A says. Sweeping by config id would miss exactly that.
 */
export const readinessKeyPattern = (schoolId: number) => `${schoolPrefix(schoolId)}:readiness:*`;

/** suffix: "draft" | "published" | "ctx" | "<status>:<date>" */
export const slotsKey = (schoolId: number, configId: number, suffix: string) =>
  `${schoolPrefix(schoolId)}:slots:${configId}:${suffix}`;

/** Report aggregates — `name` already encodes the report and its arguments. */
export const reportKey = (schoolId: number, name: string) =>
  `${schoolPrefix(schoolId)}:rpt:${name}`;

/** Match pattern for "everything cached for this school". */
export const schoolKeyPattern = (schoolId: number) => `${schoolPrefix(schoolId)}:*`;

/** Match pattern for this school's slot caches, whatever the config. */
export const slotsKeyPattern = (schoolId: number) => `${schoolPrefix(schoolId)}:slots:*`;

/**
 * Every cached payload of ONE timetable, whatever suffix it carries.
 *
 * §22 made the suffix open-ended: a draft payload is cached per draft
 * (`…:slots:119:draft:d7`), so the old "delete these three exact keys" no
 * longer reaches them and a board edit would leave every draft-scoped copy
 * stale. Matching the config prefix is what keeps invalidation total.
 */
export const configSlotsKeyPattern = (schoolId: number, configId: number) =>
  `${schoolPrefix(schoolId)}:slots:${configId}:*`;

/**
 * Match pattern for this school's report aggregates.
 *
 * Reports are keyed by what they are *about* — a class-section, a teacher, a
 * date — never by the timetable config, so there is no way to delete "the
 * reports affected by publishing config 7" one key at a time. They are cheap
 * to recompute and publishing is rare, so the whole set goes.
 */
export const reportKeyPattern = (schoolId: number) => `${schoolPrefix(schoolId)}:rpt:*`;


/**
 * Delete every key matching a pattern, without blocking Redis.
 *
 * SCAN rather than KEYS: KEYS blocks the whole instance, which under many
 * tenants is a shared-fate stall (§14). Lives here rather than on the service
 * because the BullMQ worker has no Nest context and must sweep the same keys
 * the same way — two implementations would drift the moment one changed.
 */
export async function scanDel(
  redis: { scan(...args: never[]): Promise<[string, string[]]>; del(...keys: string[]): Promise<number> },
  pattern: string,
): Promise<number> {
  let cursor = "0";
  let removed = 0;
  do {
    const [next, batch] = await (redis.scan as unknown as (
      c: string,
      m: "MATCH",
      p: string,
      c2: "COUNT",
      n: number,
    ) => Promise<[string, string[]]>)(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = next;
    if (batch.length > 0) removed += await redis.del(...batch);
  } while (cursor !== "0");
  return removed;
}
