import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type Redis from "ioredis";
import { runFeasibility, type FeasibilityResult, type FeasibilitySnapshot } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { REDIS } from "../redis/redis.module";
import { CacheKeysService } from "../redis/cache-keys.service";
import { EventsGateway } from "../events/events.gateway";
import { buildFeasibilitySnapshot } from "../solver/input";
import { ValidityService } from "../validity/validity.service";

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
    private readonly validity: ValidityService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async getReadiness(configId: number): Promise<FeasibilityResult> {
    const key = this.keys.readiness(configId);
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached);
    const snapshot = await this.buildSnapshot(configId);
    const result = runFeasibility(snapshot);
    /*
      §30.7 — clashes with the OTHER live timetables, appended AFTER the score.

      After, deliberately, and in two senses. The engine is Phase A: it reads a
      snapshot of demand and answers "can a solution exist?", with no placements
      in it at all. This compares two weeks that are already placed, which is a
      different question and does not belong in that snapshot — putting it there
      would mean handing the pre-flight engine the output of the thing it is
      supposed to run before.

      And after the SCORE, because a clash with another timetable does not make
      this one less able to generate. §28.1 settled the same point for Check 12:
      a school that asks to be told something has not become less ready by
      asking, and a dashboard falling to 96% for answering reads as the warning
      having broken something.
    */
    const withClashes: FeasibilityResult = {
      ...result,
      warnings: [...result.warnings, ...(await this.validity.clashesFor(configId))],
    };
    await this.redis.set(key, JSON.stringify(withClashes), "EX", 3600);
    return withClashes;
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
