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
import {
  configSlotsKeyPattern,
  scanDel,
  readinessKey,
  reportKey,
  reportKeyPattern,
  schoolKeyPattern,
  slotsKey,
  slotsKeyPattern,
} from "./cache-keys";

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
   */
  async invalidateSchool(schoolId: number): Promise<number> {
    return this.scanDel(schoolKeyPattern(schoolId));
  }

  /**
   * Drop everything derived from a school's *published* timetable: the slot
   * caches for the config, and this school's report aggregates.
   *
   * The reports are the half that used to be forgotten. Publishing dropped the
   * slot caches only, so a class-section report anyone had opened before the
   * publish went on being served from cache for the rest of its hour — showing
   * a grid of "Free" for a timetable that had just gone live. Every write that
   * changes a published slot or a substitution belongs here: publish, extra
   * classes (which write published rows directly) and the substitute engine.
   *
   * `configId` is optional because a substitution is dated, not scoped to one
   * timetable; without it every slot cache the school owns goes instead.
   */
  async invalidateTimetable(configId?: number): Promise<number> {
    const schoolId = this.schoolId();
    const removed =
      configId === undefined
        ? await this.scanDel(slotsKeyPattern(schoolId))
        // §22: the suffix is open-ended now (`draft:d7`, `published:2026-04-11`),
        // so naming three exact keys leaves every per-draft copy stale. Sweep
        // the config's whole prefix instead.
        : await this.scanDel(configSlotsKeyPattern(schoolId, configId));
    return removed + (await this.scanDel(reportKeyPattern(schoolId)));
  }

  /**
   * SCAN rather than KEYS: KEYS blocks the whole Redis instance, which under
   * many tenants is a shared-fate stall (§14).
   */
  private scanDel(pattern: string): Promise<number> {
    return scanDel(this.redis, pattern);
  }
}
