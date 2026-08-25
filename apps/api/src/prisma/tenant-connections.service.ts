/**
 * Per-tenant database connections (§17.5, Phase 9.4).
 *
 * A school in `shared` mode lives in the application's own database and uses
 * the default connection — that is every school today and the whole of a
 * single-school or trust-group deployment. A school in `dedicated` mode has its
 * own database and its own credentials, and this is what opens it.
 *
 * Design notes worth keeping:
 *
 *   - **Keyed by tenant id, not school id.** A dedicated tenant's local
 *     `school_id` is usually 1 — and so is everyone else's. Only the
 *     control-plane tenant id is unique across databases.
 *
 *   - **Bounded.** Every open client holds a connection pool, so the arithmetic
 *     `active_tenants × connection_limit ≤ MySQL max_connections` is a real
 *     constraint, not a footnote. The registry enforces a hard cap on open
 *     clients, evicts the least-recently-used one past it, and closes clients
 *     that have gone idle. Saturation is logged loudly rather than discovered
 *     as a stall.
 *
 *   - **Resolved once per request.** Property access on the PrismaService proxy
 *     is synchronous; opening a connection is not. The guard resolves the
 *     client up front and binds it to the tenant context, so the proxy only
 *     ever performs a synchronous read.
 *
 *   - **Scoped like everything else.** Each tenant client is wrapped in the 9.1
 *     scoping extension too. A dedicated database is not a reason to stop
 *     filtering by school_id: it is defence in depth, and nothing stops a
 *     dedicated database from later holding a second school.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaBaseService } from "./prisma-base.service";
import { withSchoolScope } from "./school-scope";
import { TenantContextService } from "../tenant/tenant-context.service";
import { TenantRegistryService } from "../control/tenant-registry.service";
import { behindMessage, expectedVersion, schemaStatus, type SchemaStatus } from "./schema-version";

interface Entry {
  base: PrismaClient;
  scoped: PrismaClient;
  lastUsedAt: number;
  displayName: string;
  schema: SchemaStatus;
}

const num = (name: string, fallback: number) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

@Injectable()
export class TenantConnectionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantConnectionsService.name);
  private readonly clients = new Map<number, Entry>();
  /** In-flight opens, so a burst of requests for one tenant opens one client. */
  private readonly opening = new Map<number, Promise<Entry>>();

  /** Connections each dedicated tenant's pool may hold. */
  private readonly poolLimit = num("TENANT_POOL_LIMIT", 5);
  /** Hard cap on simultaneously open dedicated clients. */
  private readonly maxClients = num("TENANT_MAX_CLIENTS", 20);
  /** Close a tenant's client after this long without a request. */
  private readonly idleMs = num("TENANT_IDLE_MS", 10 * 60 * 1000);

  private defaultScoped: PrismaClient | null = null;
  /** Checked once at boot; the shared database serves most schools. */
  private defaultSchema: SchemaStatus | null = null;

  constructor(
    private readonly base: PrismaBaseService,
    private readonly tenant: TenantContextService,
    private readonly registry: TenantRegistryService,
  ) {}

  /** The shared application database, behind the scoping extension. */
  defaultClient(): PrismaClient {
    this.defaultScoped ??= withSchoolScope(this.base, this.tenant);
    return this.defaultScoped;
  }

  /**
   * The shared database, refused if it is behind this build.
   *
   * The same rule as a dedicated tenant, for the same reason: serving from a
   * database that is missing columns the code references produces cryptic
   * failures scattered across whichever screens happen to touch them first.
   * `GET /health` is public and does not go through this, so the deployment can
   * still be asked what is wrong.
   */
  private sharedClientChecked(): PrismaClient {
    if (this.defaultSchema && !this.defaultSchema.ok) {
      throw new Error(behindMessage("The shared application database", this.defaultSchema));
    }
    return this.defaultClient();
  }

  /**
   * Verify the shared database against this build, once. Called at boot so a
   * deployment that forgot to migrate says so immediately rather than at the
   * first request that touches a new column (9.3 / §17.3).
   */
  async checkDefaultSchema(): Promise<SchemaStatus> {
    this.defaultSchema ??= await schemaStatus(this.base);
    if (!this.defaultSchema.ok) {
      this.logger.error(behindMessage("The shared application database", this.defaultSchema));
    } else if (this.defaultSchema.ahead.length > 0) {
      this.logger.warn(
        `The shared database has ${this.defaultSchema.ahead.length} migration(s) this build does not ship — ` +
          `it was migrated by a newer version. Tolerated during a rollout.`,
      );
    }
    return this.defaultSchema;
  }

  /** How many dedicated clients are open, for the health endpoint and alarms. */
  stats() {
    return {
      expectedSchema: expectedVersion(),
      sharedSchema: this.defaultSchema
        ? { ok: this.defaultSchema.ok, applied: this.defaultSchema.applied, missing: this.defaultSchema.missing.length }
        : null,
      open: this.clients.size,
      maxClients: this.maxClients,
      poolLimit: this.poolLimit,
      /** At the cap, every new school evicts another's connection (§17.7). */
      saturated: this.clients.size >= this.maxClients,
      /** Worst-case connections this process can hold against all databases. */
      maxConnections: this.maxClients * this.poolLimit,
      tenants: [...this.clients.entries()].map(([id, e]) => ({
        tenantId: id,
        displayName: e.displayName,
        idleMs: Date.now() - e.lastUsedAt,
        schema: { ok: e.schema.ok, applied: e.schema.applied, missing: e.schema.missing.length },
      })),
    };
  }

  /**
   * Resolve the connection for a tenant and bind it to the current context.
   * Returns the client so callers that want it directly can have it.
   */
  async bind(tenantId: number | null | undefined): Promise<PrismaClient> {
    const client = await this.clientFor(tenantId);
    this.tenant.bindConnection(client);
    return client;
  }

  /**
   * The tenant's connection *without* the scoping extension.
   *
   * Only provisioning uses this: it decides which school a session belongs to,
   * so it cannot already be scoped to one, and the rows it writes (`schools`,
   * the permission registry) are what scoping would filter on.
   */
  async clientForUnscoped(tenantId: number | null | undefined): Promise<PrismaClient> {
    if (tenantId == null || !this.registry.available) return this.base;
    const tenant = await this.registry.byId(tenantId);
    if (!tenant || tenant.mode !== "dedicated") return this.base;
    const existing = this.clients.get(tenantId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.base;
    }
    await this.clientFor(tenantId);
    return this.clients.get(tenantId)!.base;
  }

  async clientFor(tenantId: number | null | undefined): Promise<PrismaClient> {
    if (tenantId == null || !this.registry.available) return this.sharedClientChecked();

    const tenant = await this.registry.byId(tenantId);
    // Unknown tenant, or one that lives in the shared database: the default
    // connection is the correct answer, not an error.
    if (!tenant || tenant.mode !== "dedicated") return this.sharedClientChecked();

    const existing = this.clients.get(tenantId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing.scoped;
    }

    const inFlight = this.opening.get(tenantId);
    if (inFlight) return (await inFlight).scoped;

    const promise = this.open(tenantId, tenant.displayName);
    this.opening.set(tenantId, promise);
    try {
      return (await promise).scoped;
    } finally {
      this.opening.delete(tenantId);
    }
  }

  private async open(tenantId: number, displayName: string): Promise<Entry> {
    const url = await this.registry.connectionUrlFor(tenantId);
    if (!url) {
      throw new Error(`Tenant ${tenantId} is dedicated but has no stored connection URL`);
    }

    this.sweepIdle();
    if (this.clients.size >= this.maxClients) await this.evictOldest();

    const base = new PrismaClient({ datasources: { db: { url: this.withPoolLimit(url) } } });
    try {
      await base.$connect();
    } catch (e) {
      await base.$disconnect().catch(() => undefined);
      // Deliberately does not echo the URL: it carries the tenant's credentials.
      throw new Error(`Could not connect to tenant ${tenantId} (${displayName}): ${(e as Error).message}`);
    }

    // The version gate (9.3 / §17.3). A tenant whose database is behind this
    // build does not fail on connect — it fails later, inside a query, as
    // "Unknown column …", on whichever screen happens to touch the new column
    // first, with nothing pointing at the real cause. Refuse it here instead,
    // with a message that names the missing migration and the fix.
    const schema = await schemaStatus(base);
    if (!schema.ok) {
      await base.$disconnect().catch(() => undefined);
      throw new Error(behindMessage(`${displayName} (tenant ${tenantId})`, schema));
    }
    if (schema.ahead.length > 0) {
      this.logger.warn(
        `Tenant ${tenantId} (${displayName}) has ${schema.ahead.length} migration(s) this build does not ship — ` +
          `migrated by a newer version. Tolerated during a rollout.`,
      );
    }

    const entry: Entry = {
      base,
      scoped: withSchoolScope(base, this.tenant),
      lastUsedAt: Date.now(),
      displayName,
      schema,
    };
    this.clients.set(tenantId, entry);
    this.logger.log(
      `Opened connection to tenant ${tenantId} (${displayName}) — ${this.clients.size}/${this.maxClients} clients, ` +
        `up to ${this.clients.size * this.poolLimit} connections in use`,
    );
    if (this.clients.size >= this.maxClients) {
      this.logger.warn(
        `Dedicated connection cap reached (${this.maxClients}). Further tenants will evict the ` +
          `least-recently-used one. Raise TENANT_MAX_CLIENTS only alongside MySQL max_connections ` +
          `— the budget is TENANT_MAX_CLIENTS × TENANT_POOL_LIMIT (§17.5).`,
      );
    }
    return entry;
  }

  /**
   * Prisma takes its pool size from the connection string, so the registry —
   * not whoever typed the URL — decides how many connections a tenant may hold.
   */
  private withPoolLimit(url: string): string {
    if (/[?&]connection_limit=/.test(url)) return url;
    return `${url}${url.includes("?") ? "&" : "?"}connection_limit=${this.poolLimit}`;
  }

  private async close(tenantId: number, reason: string) {
    const entry = this.clients.get(tenantId);
    if (!entry) return;
    this.clients.delete(tenantId);
    await entry.base.$disconnect().catch(() => undefined);
    this.logger.log(`Closed connection to tenant ${tenantId} (${entry.displayName}) — ${reason}`);
  }

  private sweepIdle() {
    const cutoff = Date.now() - this.idleMs;
    for (const [id, entry] of this.clients) {
      if (entry.lastUsedAt < cutoff) void this.close(id, "idle");
    }
  }

  private async evictOldest() {
    let oldestId: number | null = null;
    let oldest = Infinity;
    for (const [id, entry] of this.clients) {
      if (entry.lastUsedAt < oldest) {
        oldest = entry.lastUsedAt;
        oldestId = id;
      }
    }
    if (oldestId !== null) await this.close(oldestId, "evicted at the connection cap");
  }

  async onModuleInit() {
    // Say it at boot, not at the first request that touches a new column.
    await this.checkDefaultSchema().catch((e) =>
      this.logger.error(`Could not verify the shared database's schema version: ${(e as Error).message}`),
    );
  }

  async onModuleDestroy() {
    await Promise.all([...this.clients.keys()].map((id) => this.close(id, "shutdown")));
  }
}
