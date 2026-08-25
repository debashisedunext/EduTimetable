import { Body, Controller, Get, NotFoundException, Put, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { type AuthedRequest } from "./crud.util";

/**
 * The school's own profile (§17, Phase 9.2).
 *
 * There is deliberately no `POST` and no `DELETE`: creating a school is tenant
 * provisioning (§17.3) — it has to register in the control-plane registry in
 * the same breath, or it would be a school nobody can sign in to — and deleting
 * one is a platform operation, not something a school's own admin can do to
 * itself. The scoping extension refuses both at the data layer regardless.
 *
 * The route carries no id: a session belongs to exactly one school, so "the
 * school" is unambiguous, and taking an id would invite passing someone else's.
 */
@Controller("school")
export class SchoolController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async get(@Req() req: AuthedRequest) {
    const school = await this.prisma.school.findUnique({ where: { id: req.user.schoolId } });
    if (!school) throw new NotFoundException("School not found");
    return school;
  }

  /**
   * Rename / re-brand. `code` is intentionally not editable here: it is the
   * identifier the control-plane registry resolves an incoming SSO token
   * against, so changing it from inside the school would lock its own users
   * out. Changing a code is a platform operation (9.8).
   */
  @Put()
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async update(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const str = (v: unknown, max: number) => {
      const s = String(v ?? "").trim();
      return s.length === 0 ? null : s.slice(0, max);
    };
    return this.prisma.school.update({
      where: { id: req.user.schoolId },
      data: {
        ...(body.name !== undefined ? { name: str(body.name, 120) ?? "" } : {}),
        ...(body.shortName !== undefined ? { shortName: str(body.shortName, 40) } : {}),
        ...(body.logoUrl !== undefined ? { logoUrl: str(body.logoUrl, 255) } : {}),
        ...(body.address !== undefined ? { address: str(body.address, 255) } : {}),
        ...(body.timezone !== undefined ? { timezone: str(body.timezone, 40) ?? "Asia/Kolkata" } : {}),
      },
    });
  }
}
