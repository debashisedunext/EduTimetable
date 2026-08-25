import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import type { SessionTokenPayload } from "@edutimetable/shared";
import { ControlPrismaService } from "./control-prisma.service";
import { TenantRegistryService } from "./tenant-registry.service";
import { PlatformAccessService } from "./platform-access.service";
import { RequirePlatformAdmin } from "./platform.guard";
import { TenantConnectionsService } from "../prisma/tenant-connections.service";
import { expectedVersion, schemaStatus } from "../prisma/schema-version";
import { toInt } from "../masters/crud.util";

/**
 * The Platform Console (§17.6, Phase 9.8) — the view from above every school.
 *
 * Deliberately narrow. It answers "which schools exist, are they reachable, are
 * their databases current, and should this one be served right now" — and
 * nothing else. In particular:
 *
 *   - **It cannot create a school.** Provisioning creates a database, which
 *     carries credentials and is an operator action (`pnpm tenant:create`).
 *     A console button that quietly creates databases is how you end up with
 *     databases nobody remembers creating.
 *   - **It cannot delete one.** A school holding data is not something to
 *     remove through a web form; suspension is the reversible equivalent and is
 *     what an operator actually wants.
 *   - **It never returns a connection URL.** Those are credentials (§13.2 key
 *     custody); the console reports *whether* one is stored and whether it
 *     works, never what it is.
 */
@Controller("platform")
@RequirePlatformAdmin()
export class PlatformController {
  constructor(
    private readonly control: ControlPrismaService,
    private readonly registry: TenantRegistryService,
    private readonly connections: TenantConnectionsService,
    private readonly access: PlatformAccessService,
  ) {}

  /** Deployment-wide state: schools, connection budget, schema version. */
  @Get("overview")
  async overview(@Req() req: { user: SessionTokenPayload }) {
    const client = this.control.client;
    const tenants = client ? await client.tenant.findMany() : [];
    void this.access.touch(req.user.erpUserId ?? "");
    return {
      registry: this.control.available,
      expectedSchema: expectedVersion(),
      schools: {
        total: tenants.length,
        active: tenants.filter((t) => t.status === "active").length,
        suspended: tenants.filter((t) => t.status === "suspended").length,
        shared: tenants.filter((t) => t.mode === "shared").length,
        dedicated: tenants.filter((t) => t.mode === "dedicated").length,
        behind: tenants.filter((t) => t.schemaVersion && t.schemaVersion !== expectedVersion()).length,
      },
      connections: this.connections.stats(),
    };
  }

  /** Every school the platform knows about. Registry data only — fast, no fan-out. */
  @Get("tenants")
  async tenants() {
    const client = this.control.client;
    if (!client) return [];
    const rows = await client.tenant.findMany({
      orderBy: [{ trustId: "asc" }, { displayName: "asc" }],
      include: { trust: true, erpInstance: { select: { id: true, name: true } } },
    });
    const expected = expectedVersion();
    return rows.map((t) => ({
      id: t.id,
      schoolCode: t.schoolCode,
      displayName: t.displayName,
      mode: t.mode,
      status: t.status,
      localSchoolId: t.localSchoolId,
      schemaVersion: t.schemaVersion,
      // Compared against the build so the console can flag it without opening
      // a connection to every school (§17.3).
      schemaCurrent: t.schemaVersion === null ? null : t.schemaVersion === expected,
      trust: t.trust ? { id: t.trust.id, code: t.trust.code, name: t.trust.name } : null,
      erpInstance: t.erpInstance,
      /** Whether credentials are stored — never what they are. */
      hasStoredUrl: t.dbUrlEncrypted !== null,
      createdAt: t.createdAt,
    }));
  }

  /**
   * Open this school's database and report what came back: reachable, and
   * current with this build? Done on demand rather than on the listing, because
   * a hundred schools would mean a hundred connections to render a table.
   */
  @Post("tenants/:id/test")
  async test(@Param("id") id: string) {
    const tenantId = toInt(id, "id");
    const tenant = await this.registry.byId(tenantId);
    if (!tenant) return { ok: false, error: "No such school in the registry" };
    const started = Date.now();
    try {
      const client = await this.connections.clientForUnscoped(tenantId);
      const schema = await schemaStatus(client);
      const schools = await client.school.count();
      return {
        ok: true,
        ms: Date.now() - started,
        mode: tenant.mode,
        schema: { ok: schema.ok, applied: schema.applied, expected: schema.expected, missing: schema.missing },
        schoolsInDatabase: schools,
      };
    } catch (e) {
      // The message may name the missing migration (§17.3) — useful. It must
      // never carry the connection URL, which the adapters already strip.
      return { ok: false, ms: Date.now() - started, error: (e as Error).message };
    }
  }

  /**
   * Suspend or reinstate a school. Suspension stops its users signing in
   * (§17.3) and is the reversible alternative to deletion, which this console
   * deliberately does not offer.
   */
  @Post("tenants/:id/status")
  async setStatus(@Param("id") id: string, @Body() body: { status?: string }) {
    const client = this.control.require();
    const tenantId = toInt(id, "id");
    const status = body?.status === "suspended" ? "suspended" : "active";
    const updated = await client.tenant.update({ where: { id: tenantId }, data: { status } });
    // Both caches key on tenant identity, and a suspension that takes 30s to
    // bite is a suspension an operator watches not happen.
    this.registry.invalidate();
    return { id: updated.id, displayName: updated.displayName, status: updated.status };
  }

  /** Who else holds platform access. Read-only: granting is a command (§17.6). */
  @Get("admins")
  admins() {
    return this.access.list();
  }
}
