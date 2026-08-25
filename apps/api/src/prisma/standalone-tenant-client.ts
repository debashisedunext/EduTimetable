/**
 * Tenant connections outside Nest (§17.5, Phase 9.4).
 *
 * The solver worker is a plain Node process, not a Nest application, but it
 * writes timetable slots — so it has to reach the same database the request
 * that queued the job would have. Without this a dedicated tenant's generation
 * would silently land in the shared database: the slots would exist, scoped to
 * a school id that means something else there, and nobody would see them.
 *
 * A deliberately small cache — a worker handles one job at a time and the same
 * tenant repeatedly, so a Map keyed by tenant id is the whole requirement.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaClient as ControlClient } from "../../prisma/generated/control-client";
import { decryptSecret } from "../common/crypto.util";
import { withSchoolScope } from "./school-scope";
import type { TenantContextService } from "../tenant/tenant-context.service";

interface Cached {
  base: PrismaClient;
  scoped: PrismaClient;
}

export class StandaloneTenantClients {
  private readonly cache = new Map<number, Cached>();
  private control: ControlClient | null = null;

  constructor(
    private readonly shared: PrismaClient,
    private readonly sharedScoped: PrismaClient,
    private readonly tenant: TenantContextService,
  ) {}

  private controlClient(): ControlClient | null {
    const url = process.env.CONTROL_DATABASE_URL;
    if (!url) return null;
    this.control ??= new ControlClient({ datasources: { db: { url } } });
    return this.control;
  }

  /**
   * The school-scoped client for a tenant. Falls back to the shared database
   * for a shared-mode tenant, an unknown one, or a deployment with no registry
   * — all of which are correct answers, not errors.
   */
  async scopedFor(tenantId: number | null | undefined): Promise<PrismaClient> {
    if (tenantId == null) return this.sharedScoped;
    const hit = this.cache.get(tenantId);
    if (hit) return hit.scoped;

    const control = this.controlClient();
    if (!control) return this.sharedScoped;

    const tenant = await control.tenant.findUnique({
      where: { id: tenantId },
      select: { mode: true, dbUrlEncrypted: true },
    });
    if (!tenant || tenant.mode !== "dedicated" || !tenant.dbUrlEncrypted) return this.sharedScoped;

    const base = new PrismaClient({
      datasources: { db: { url: decryptSecret(tenant.dbUrlEncrypted) } },
    });
    await base.$connect();
    const entry: Cached = { base, scoped: withSchoolScope(base, this.tenant) };
    this.cache.set(tenantId, entry);
    return entry.scoped;
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.cache.values()].map((c) => c.base.$disconnect().catch(() => undefined)));
    await this.control?.$disconnect().catch(() => undefined);
    this.cache.clear();
  }
}
