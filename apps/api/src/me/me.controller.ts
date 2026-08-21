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
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role.name,
      permissions,
      teacherId: user.teacherId,
    };
  }
}
