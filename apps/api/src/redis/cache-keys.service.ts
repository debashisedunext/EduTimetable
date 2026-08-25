/**
 * Injectable wrapper over cache-keys.ts that supplies the ambient school, so
 * call sites read `this.keys.slots(configId, "draft")` and cannot forget the
 * namespace. Requesting a key with no tenant context is a programming error
 * and throws rather than silently writing to a global key that another school
 * could then read.
 */
import { Inject, Injectable } from "@nestjs/common";
import type Redis from "ioredis";
import { TenantContextService } from "../tenant/tenant-context.service";
import { REDIS } from "./redis.tokens";
import { readinessKey, reportKey, schoolKeyPattern, slotsKey } from "./cache-keys";

@Injectable()
export class CacheKeysService {
  constructor(
    private readonly tenant: TenantContextService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  schoolId(): number {
    const id = this.tenant.schoolId();
    if (id === null) {
      throw new Error(
        "Cache key requested outside a tenant context — an unnamespaced key would be readable by other schools",
      );
    }
    return id;
  }

  readiness(configId: number) {
    return readinessKey(this.schoolId(), configId);
  }

  slots(configId: number, suffix: string) {
    return slotsKey(this.schoolId(), configId, suffix);
  }

  report(name: string) {
    return reportKey(this.schoolId(), name);
  }

  /**
   * Drop every cached value belonging to one school — and only that school.
   * SCAN rather than KEYS: KEYS blocks the whole Redis instance, which under
   * many tenants is a shared-fate stall (§14).
   */
  async invalidateSchool(schoolId: number): Promise<number> {
    const pattern = schoolKeyPattern(schoolId);
    let cursor = "0";
    let removed = 0;
    do {
      const [next, batch] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
      cursor = next;
      if (batch.length > 0) removed += await this.redis.del(...batch);
    } while (cursor !== "0");
    return removed;
  }
}
