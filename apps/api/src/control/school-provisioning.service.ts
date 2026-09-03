/**
 * Provisioning a school (§17.3/17.4, Phase 9.5).
 *
 * The ERP is the source of truth for which schools exist and what they are
 * called — the app must never invent or hardcode either. When an SSO token
 * arrives naming a school (or listing a trust's schools), this brings the local
 * database in line with it:
 *
 *   - creates the `schools` row if it is new, keyed by the ERP's stable `code`
 *   - refreshes name / short name / logo / timezone / trust on every login, so a
 *     school renamed in the ERP is renamed here without anyone re-typing it
 *   - seeds the permission registry and ERP role mappings for a brand-new
 *     school, because a school with no roles is one nobody can sign in to
 *   - registers it in the control-plane tenant registry
 *
 * Everything here is idempotent and runs unscoped: it decides which school a
 * session belongs to, so it cannot already be scoped to one.
 */
import { Injectable, Logger } from "@nestjs/common";
import { DEFAULT_ROLES, type ErpSchoolClaim, type ErpTrustClaim } from "@edutimetable/shared";
import { PrismaClient } from "@prisma/client";
import { PrismaBaseService } from "../prisma/prisma-base.service";
import { TenantConnectionsService } from "../prisma/tenant-connections.service";
import { ControlPrismaService } from "./control-prisma.service";
import { TenantRegistryService } from "./tenant-registry.service";

/** ERP role → default timetable role, the §15.1 mapping every school starts with. */
const ERP_ROLE_DEFAULTS: Array<[string, string]> = [
  ["ADMIN", "Super Admin"],
  ["PRINCIPAL", "Principal"],
  ["TEACHER", "Teacher"],
  ["FRONT_OFFICE", "Front Office"],
];

@Injectable()
export class SchoolProvisioningService {
  private readonly logger = new Logger(SchoolProvisioningService.name);

  constructor(
    private readonly prisma: PrismaBaseService,
    private readonly control: ControlPrismaService,
    private readonly registry: TenantRegistryService,
    private readonly connections: TenantConnectionsService,
  ) {}

  /**
   * Find-or-create the school this claim describes, and refresh its details
   * from the ERP.
   *
   * Returns both ids because they answer different questions: `schoolId` is the
   * row inside that school's own database, `tenantId` identifies it across all
   * of them (§17.5).
   *
   * A school already registered as `dedicated` is written to **its own**
   * database, not the shared one. A school nobody has heard of is created in
   * the shared database: the app cannot conjure a database, so moving a school
   * to its own is a platform decision (`pnpm tenant:create`), never something a
   * login does implicitly.
   */
  async syncSchool(
    claim: ErpSchoolClaim,
    trust?: ErpTrustClaim,
  ): Promise<{ schoolId: number; tenantId: number | null }> {
    const code = claim.code.trim().slice(0, 40);
    const name = claim.name.trim().slice(0, 120);
    if (!code || !name) {
      throw new Error("ERP school claim must carry both a code and a name");
    }

    // Descriptive fields are only overwritten when the ERP actually sent them —
    // a token that omits a logo should not erase one somebody configured here.
    const descriptive = {
      name,
      // Records that the ERP genuinely named this school, which is what makes a
      // rename here refusable. `origin` alone cannot tell a real ERP name from
      // a Phase 9.2 placeholder, and refusing both would strand a placeholder
      // school called "School 1" forever (§15.3).
      erpNameSyncedAt: new Date(),
      ...(claim.shortName !== undefined ? { shortName: claim.shortName?.slice(0, 40) ?? null } : {}),
      ...(claim.logoUrl !== undefined ? { logoUrl: claim.logoUrl?.slice(0, 255) ?? null } : {}),
      ...(claim.timezone ? { timezone: claim.timezone.slice(0, 40) } : {}),
      ...(claim.address !== undefined ? { address: claim.address?.slice(0, 255) ?? null } : {}),
      ...(trust ? { trustCode: trust.code.slice(0, 40), trustName: trust.name.slice(0, 120) } : {}),
    };

    // Where does this school's data live? Ask the registry before writing.
    const known = await this.registry.resolveByCode(code);
    const db: PrismaClient =
      known?.mode === "dedicated"
        ? await this.connections.clientForUnscoped(known.tenantId)
        : this.prisma;

    const existing = await db.school.findUnique({ where: { code } });
    if (existing) {
      await db.school.update({ where: { id: existing.id }, data: descriptive });
      const tenantId = await this.registerTenant(existing.id, code, name, trust);
      return { schoolId: existing.id, tenantId };
    }

    const created = await db.school.create({ data: { code, ...descriptive } });
    this.logger.log(
      `Provisioned new school '${name}' (${code}) as school_id ${created.id}` +
        (known?.mode === "dedicated" ? ` in its own database (tenant ${known.tenantId})` : ""),
    );
    await this.seedRoles(created.id, db);
    const tenantId = await this.registerTenant(created.id, code, name, trust);
    return { schoolId: created.id, tenantId };
  }

  /**
   * A brand-new school needs the permission registry and the ERP role mapping
   * before anyone can be provisioned into it — the same rows `prisma/seed.ts`
   * writes for the first school, applied to every subsequent one.
   */
  async seedRoles(schoolId: number, db: PrismaClient = this.prisma): Promise<void> {
    for (const [name, permissions] of Object.entries(DEFAULT_ROLES)) {
      const role = await db.role.upsert({
        where: { schoolId_name: { schoolId, name } },
        create: { schoolId, name, isSystem: true },
        update: {},
      });
      await db.rolePermission.createMany({
        data: permissions.map((permission) => ({ roleId: role.id, permission, schoolId })),
        skipDuplicates: true,
      });
    }
    for (const [erpRole, roleName] of ERP_ROLE_DEFAULTS) {
      const role = await db.role.findUnique({
        where: { schoolId_name: { schoolId, name: roleName } },
      });
      if (!role) continue;
      await db.erpRoleMapping.upsert({
        where: { schoolId_erpRole: { schoolId, erpRole } },
        create: { schoolId, erpRole, roleId: role.id },
        update: {},
      });
    }
  }

  /**
   * Mirror the school into the tenant registry, with its trust, and return the
   * tenant id. Null when the deployment has no registry.
   */
  private async registerTenant(
    localSchoolId: number,
    code: string,
    name: string,
    trust?: ErpTrustClaim,
  ): Promise<number | null> {
    const control = this.control.client;
    if (!control) return null;

    // The self-serve installation (§15.3) is a sentinel, not an ERP — filing a
    // real ERP school under it would be wrong, and "first by id" would do
    // exactly that on a deployment where a self-serve school was created first.
    const instance =
      (await control.erpInstance.findFirst({
        where: { NOT: { name: { contains: "Self-serve" } } },
        orderBy: { id: "asc" },
      })) ??
      (await control.erpInstance.create({
        data: { name: "Edunext ERP (default installation)", publicKeyPem: "" },
      }));

    let trustId: number | null = null;
    if (trust) {
      const row = await control.trust.upsert({
        where: { erpInstanceId_code: { erpInstanceId: instance.id, code: trust.code } },
        create: { erpInstanceId: instance.id, code: trust.code, name: trust.name },
        update: { name: trust.name },
      });
      trustId = row.id;
    }

    const tenant = await control.tenant.upsert({
      where: { erpInstanceId_schoolCode: { erpInstanceId: instance.id, schoolCode: code } },
      create: {
        erpInstanceId: instance.id,
        schoolCode: code,
        displayName: name,
        mode: "shared",
        localSchoolId,
        trustId,
        status: "active",
      },
      // Never touch mode, status or stored credentials from a login — those are
      // the platform's to set, not the ERP's.
      update: { displayName: name, localSchoolId, ...(trustId !== null ? { trustId } : {}) },
    });
    this.registry.invalidate();
    return tenant.id;
  }
}
