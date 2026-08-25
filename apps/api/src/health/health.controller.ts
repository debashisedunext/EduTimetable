import { Controller, Get, Inject } from "@nestjs/common";
import type Redis from "ioredis";
import { PrismaBaseService } from "../prisma/prisma-base.service";
import { REDIS } from "../redis/redis.module";
import { Public } from "../auth/decorators";
import { TenantConnectionsService } from "../prisma/tenant-connections.service";

@Controller("health")
export class HealthController {
  constructor(
    // The liveness probe is deliberately school-agnostic — it asks the pool
    // whether it is up, not what any one school can see.
    private readonly prisma: PrismaBaseService,
    private readonly connections: TenantConnectionsService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Public()
  @Get()
  async check() {
    const [db, redis] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      this.redis.ping().then((r) => r === "PONG").catch(() => false),
    ]);
    // Connection-pool headroom (§17.5) and schema versions (§17.3): the
    // connection budget is TENANT_MAX_CLIENTS × TENANT_POOL_LIMIT against
    // MySQL's max_connections, and a database behind this build is a release
    // that half-deployed. Both belong somewhere an alarm can watch them.
    const connections = this.connections.stats();
    const schemaOk = connections.sharedSchema?.ok !== false;
    return {
      status: db && redis && schemaOk ? "ok" : "degraded",
      db,
      redis,
      schema: schemaOk ? "ok" : "behind",
      connections,
    };
  }
}
