/**
 * The Redis DI token lives in its own leaf module so services that need both
 * the client and CacheKeysService (which redis.module provides) do not form an
 * import cycle — a cycle here resolves the token to `undefined` at decoration
 * time and Nest fails to construct the service.
 */
export const REDIS = "REDIS_CLIENT";
