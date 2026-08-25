/**
 * The raw, unscoped Prisma connection — one pool for the process.
 *
 * Almost nothing should inject this: `PrismaService` is the school-scoped
 * client everything else uses (see prisma.module.ts). Inject PrismaBaseService
 * only for genuinely cross-school work — the health probe, migrations, and the
 * 9.1 isolation tests that must be able to look at both schools' rows to prove
 * the scoped client never did.
 */
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaBaseService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
