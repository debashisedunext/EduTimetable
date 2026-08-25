import { Controller, Get, NotFoundException, Req } from "@nestjs/common";
import type { MeResponse, Permission, SessionTokenPayload } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../auth/permissions.service";
import { PrismaBaseService } from "../prisma/prisma-base.service";

@Controller("me")
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionsService: PermissionsService,
    private readonly base: PrismaBaseService,
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

    // The schools this session may switch to (§17.4). Read through the base
    // client on purpose: the scoped one would only ever return the active
    // school, and the whole point is to list the others. The ids come from the
    // signed session token, so this cannot list a school the ERP did not grant.
    const grantedIds = req.user.schoolIds?.length ? req.user.schoolIds : [school.id];
    const granted = await this.base.school.findMany({
      where: { id: { in: grantedIds }, isActive: true },
      orderBy: { name: "asc" },
    });
    const shape = (s: (typeof granted)[number]) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      shortName: s.shortName,
      logoUrl: s.logoUrl,
      timezone: s.timezone,
    });

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role.name,
      permissions,
      teacherId: user.teacherId,
      school: shape(school),
      schools: granted.map(shape),
      trust:
        school.trustCode && school.trustName
          ? { code: school.trustCode, name: school.trustName }
          : null,
    };
  }
}
