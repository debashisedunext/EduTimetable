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
import { PrismaBaseService } from "../prisma/prisma-base.service";
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
  ) {}

  /**
   * Find-or-create the school this claim describes, and refresh its details
   * from the ERP. Returns the local `schools.id`.
   */
  async syncSchool(claim: ErpSchoolClaim, trust?: ErpTrustClaim): Promise<number> {
    const code = claim.code.trim().slice(0, 40);
    const name = claim.name.trim().slice(0, 120);
    if (!code || !name) {
      throw new Error("ERP school claim must carry both a code and a name");
    }

    // Descriptive fields are only overwritten when the ERP actually sent them —
    // a token that omits a logo should not erase one somebody configured here.
    const descriptive = {
      name,
      ...(claim.shortName !== undefined ? { shortName: claim.shortName?.slice(0, 40) ?? null } : {}),
      ...(claim.logoUrl !== undefined ? { logoUrl: claim.logoUrl?.slice(0, 255) ?? null } : {}),
      ...(claim.timezone ? { timezone: claim.timezone.slice(0, 40) } : {}),
      ...(claim.address !== undefined ? { address: claim.address?.slice(0, 255) ?? null } : {}),
      ...(trust ? { trustCode: trust.code.slice(0, 40), trustName: trust.name.slice(0, 120) } : {}),
    };

    const existing = await this.prisma.school.findUnique({ where: { code } });
    if (existing) {
      await this.prisma.school.update({ where: { id: existing.id }, data: descriptive });
      await this.registerTenant(existing.id, code, name, trust);
      return existing.id;
    }

    const created = await this.prisma.school.create({ data: { code, ...descriptive } });
    this.logger.log(`Provisioned new school '${name}' (${code}) as school_id ${created.id}`);
    await this.seedRoles(created.id);
    await this.registerTenant(created.id, code, name, trust);
    return created.id;
  }

  /**
   * A brand-new school needs the permission registry and the ERP role mapping
   * before anyone can be provisioned into it — the same rows `prisma/seed.ts`
   * writes for the first school, applied to every subsequent one.
   */
  private async seedRoles(schoolId: number): Promise<void> {
    for (const [name, permissions] of Object.entries(DEFAULT_ROLES)) {
      const role = await this.prisma.role.upsert({
        where: { schoolId_name: { schoolId, name } },
        create: { schoolId, name, isSystem: true },
        update: {},
      });
      await this.prisma.rolePermission.createMany({
        data: permissions.map((permission) => ({ roleId: role.id, permission, schoolId })),
        skipDuplicates: true,
      });
    }
    for (const [erpRole, roleName] of ERP_ROLE_DEFAULTS) {
      const role = await this.prisma.role.findUnique({
        where: { schoolId_name: { schoolId, name: roleName } },
      });
      if (!role) continue;
      await this.prisma.erpRoleMapping.upsert({
        where: { schoolId_erpRole: { schoolId, erpRole } },
        create: { schoolId, erpRole, roleId: role.id },
        update: {},
      });
    }
  }

  /** Mirror the school into the tenant registry, with its trust. No-op without one. */
  private async registerTenant(
    localSchoolId: number,
    code: string,
    name: string,
    trust?: ErpTrustClaim,
  ): Promise<void> {
    const control = this.control.client;
    if (!control) return;

    const instance =
      (await control.erpInstance.findFirst({ orderBy: { id: "asc" } })) ??
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

    await control.tenant.upsert({
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
  }
}
