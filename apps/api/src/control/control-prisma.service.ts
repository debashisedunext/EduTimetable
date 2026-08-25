/**
 * The control-plane connection (§17.3, Phase 9.2).
 *
 * A second Prisma client, generated from `prisma/control/schema.prisma` against
 * its own database. Nothing here is school-scoped — this schema is *about*
 * schools — so the 9.1 scoping extension is deliberately not applied.
 *
 * Availability is optional on purpose. A single-school deployment that has not
 * run the control-plane migration should keep working exactly as it did before
 * Phase 9, so a missing or unreachable CONTROL_DATABASE_URL degrades to "no
 * registry" rather than refusing to boot. TenantRegistryService then falls back
 * to the single implicit school, which is what such a deployment has.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "../../prisma/generated/control-client";

@Injectable()
export class ControlPrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ControlPrismaService.name);
  private prisma: PrismaClient | null = null;

  async onModuleInit() {
    const url = process.env.CONTROL_DATABASE_URL;
    if (!url) {
      this.logger.warn(
        "CONTROL_DATABASE_URL is not set — running without a tenant registry (single-school mode)",
      );
      return;
    }
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
      await client.$connect();
      await client.$queryRaw`SELECT 1`;
      this.prisma = client;
      this.logger.log("Tenant registry connected");
    } catch (e) {
      await client.$disconnect().catch(() => undefined);
      this.logger.error(
        `Tenant registry unreachable (${(e as Error).message}) — running without it. ` +
          `Run \`pnpm migrate:control\` if this deployment is meant to have one.`,
      );
    }
  }

  async onModuleDestroy() {
    await this.prisma?.$disconnect();
  }

  /** True when a registry is configured, reachable and migrated. */
  get available(): boolean {
    return this.prisma !== null;
  }

  /** The client, or null when there is no registry. Callers must handle null. */
  get client(): PrismaClient | null {
    return this.prisma;
  }

  /** The client, or a thrown error — for operations that make no sense without one. */
  require(): PrismaClient {
    if (!this.prisma) {
      throw new Error(
        "This operation needs the tenant registry, but CONTROL_DATABASE_URL is unset or unreachable",
      );
    }
    return this.prisma;
  }
}
