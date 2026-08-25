import { Controller, Get, Inject } from "@nestjs/common";
import type Redis from "ioredis";
import { PrismaBaseService } from "../prisma/prisma-base.service";
import { REDIS } from "../redis/redis.module";
import { Public } from "../auth/decorators";

@Controller("health")
export class HealthController {
  constructor(
    // The liveness probe is deliberately school-agnostic — it asks the pool
    // whether it is up, not what any one school can see.
    private readonly prisma: PrismaBaseService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Public()
  @Get()
  async check() {
    const [db, redis] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      this.redis.ping().then((r) => r === "PONG").catch(() => false),
    ]);
    return { status: db && redis ? "ok" : "degraded", db, redis };
  }
}
