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

/** suffix: "draft" | "published" | "ctx" | "<status>:<date>" */
export const slotsKey = (schoolId: number, configId: number, suffix: string) =>
  `${schoolPrefix(schoolId)}:slots:${configId}:${suffix}`;

/** Report aggregates — `name` already encodes the report and its arguments. */
export const reportKey = (schoolId: number, name: string) =>
  `${schoolPrefix(schoolId)}:rpt:${name}`;

/** Match pattern for "everything cached for this school". */
export const schoolKeyPattern = (schoolId: number) => `${schoolPrefix(schoolId)}:*`;
