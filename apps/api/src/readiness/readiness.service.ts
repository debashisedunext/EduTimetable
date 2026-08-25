import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type Redis from "ioredis";
import { runFeasibility, type FeasibilityResult, type FeasibilitySnapshot } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { REDIS } from "../redis/redis.module";
import { CacheKeysService } from "../redis/cache-keys.service";
import { EventsGateway } from "../events/events.gateway";
import { buildFeasibilitySnapshot } from "../solver/input";

/**
 * Task 1.12 — live readiness: snapshot the DB (shared builder, same one the
 * solver worker uses), run the pure engine, cache in Redis. Every master-data
 * mutation calls invalidate(), clearing readiness AND slot caches and pushing
 * `readiness:invalidated` so open dashboards refetch instantly.
 *
 * 9.1: both the cache keys and the broadcast are per-school. Previously
 * invalidate() ran `redis.keys("readiness:*")` and emitted to every connected
 * client, so one school's master-data edit flushed and refetched every other
 * school's dashboards.
 */
@Injectable()
export class ReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly keys: CacheKeysService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async getReadiness(configId: number): Promise<FeasibilityResult> {
    const key = this.keys.readiness(configId);
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached);
    const snapshot = await this.buildSnapshot(configId);
    const result = runFeasibility(snapshot);
    await this.redis.set(key, JSON.stringify(result), "EX", 3600);
    return result;
  }

  /** Called by the Config Service after every master-data mutation. */
  async invalidate(schoolId: number) {
    await this.keys.invalidateSchool(schoolId);
    this.events.emitToSchool(schoolId, "readiness:invalidated", { schoolId });
  }

  async buildSnapshot(configId: number): Promise<FeasibilitySnapshot> {
    try {
      return await buildFeasibilitySnapshot(this.prisma, configId);
    } catch (e) {
      throw new NotFoundException((e as Error).message);
    }
  }
}
