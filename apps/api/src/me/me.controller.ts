import { Controller, Get, NotFoundException, Req } from "@nestjs/common";
import type {
  MeResponse,
  Permission,
  SessionSchool,
  SessionTokenPayload,
} from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../auth/permissions.service";
import { PrismaBaseService } from "../prisma/prisma-base.service";
import { TenantRegistryService } from "../control/tenant-registry.service";
import { PlatformAccessService } from "../control/platform-access.service";

@Controller("me")
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionsService: PermissionsService,
    private readonly base: PrismaBaseService,
    private readonly registry: TenantRegistryService,
    private readonly platform: PlatformAccessService,
  ) {}

  @Get()
  async me(@Req() req: { user: SessionTokenPayload }): Promise<MeResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.sub },
      include: { role: true },
    });
    if (!user) throw new NotFoundException();
    const permissions = (await this.permissionsService.getForRole(user.roleId)) as Permission[];
    // Scoped like everything else, so this can only ever be the session's own
    // school (9.1) — and it exists at all only because 9.2 gave school_id a
    // parent row to name.
    const school = await this.prisma.school.findUnique({ where: { id: req.user.schoolId } });
    if (!school) throw new NotFoundException("School not found");

    // The schools this session may switch to (§17.4).
    //
    // Sourced from the tenant registry, not from any application database.
    // That is the whole point of the registry holding a display name: once
    // schools live in separate databases, listing them from the data would
    // mean opening every one of those databases to render a dropdown.
    // The ids come from the signed session token, so this cannot list a school
    // the ERP did not grant.
    const active = {
      id: school.id,
      tenantId: req.user.tenantId ?? null,
      code: school.code,
      name: school.name,
      shortName: school.shortName,
      logoUrl: school.logoUrl,
      timezone: school.timezone,
    };

    let schools: SessionSchool[] = [active];
    const grantedTenants = req.user.grants ?? [];
    if (grantedTenants.length > 1) {
      const tenants = await this.registry.byIds(grantedTenants);
      schools = tenants.map((t) =>
        t.tenantId === active.tenantId
          ? active
          : {
              id: t.schoolId,
              tenantId: t.tenantId,
              code: t.schoolCode,
              name: t.displayName,
              shortName: null,
              logoUrl: null,
              timezone: active.timezone,
            },
      );
    } else if ((req.user.schoolIds?.length ?? 0) > 1) {
      // No registry: one database, so the schools table can answer directly.
      const rows = await this.base.school.findMany({
        where: { id: { in: req.user.schoolIds! }, isActive: true },
        orderBy: { name: "asc" },
      });
      schools = rows.map((s) => ({
        id: s.id,
        tenantId: null,
        code: s.code,
        name: s.name,
        shortName: s.shortName,
        logoUrl: s.logoUrl,
        timezone: s.timezone,
      }));
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role.name,
      permissions,
      teacherId: user.teacherId,
      school: active,
      schools,
      // Renders the nav item only; the guard is the authority (§17.6).
      platformAdmin: await this.platform.isPlatformAdmin(req.user),
      trust:
        school.trustCode && school.trustName
          ? { code: school.trustCode, name: school.trustName }
          : null,
    };
  }
}
