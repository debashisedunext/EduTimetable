import { Controller, Get, NotFoundException, Req } from "@nestjs/common";
import type { MeResponse, Permission, SessionTokenPayload } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../auth/permissions.service";

@Controller("me")
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionsService: PermissionsService,
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
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role.name,
      permissions,
      teacherId: user.teacherId,
      school: {
        id: school.id,
        code: school.code,
        name: school.name,
        shortName: school.shortName,
        logoUrl: school.logoUrl,
        timezone: school.timezone,
      },
    };
  }
}
