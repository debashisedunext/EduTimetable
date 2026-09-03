import { BadRequestException, Body, Controller, Get, NotFoundException, Put, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { SelfServeProvisioningService } from "../control/self-serve-provisioning.service";
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly selfServe: SelfServeProvisioningService,
  ) {}

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

    // §15.3 Phase 25.1 — a name the ERP writes is not ours to change.
    //
    // The ERP overwrites it from the token on EVERY login, so accepting an edit
    // would store a change that silently reverts the next time anybody signs
    // in — and produce a bug report nobody who did not sign in again can
    // reproduce.
    //
    // Keyed on `erpNameSyncedAt`, NOT on `origin`, and the difference matters:
    // Phase 9.2 back-filled PLACEHOLDER names ("School 1") for schools that
    // predate school claims, and explicitly documented that an admin fixes them
    // here. Those receive no name from the ERP, so nothing would overwrite the
    // edit — refusing them would strand a school called "School 1" forever.
    // Only a school the ERP has actually named is refused.
    //
    // The descriptive fields below (logo, address, timezone) stay editable
    // either way: SSO only overwrites those when the ERP actually sends them.
    const school = await this.prisma.school.findUnique({ where: { id: req.user.schoolId } });
    if (!school) throw new NotFoundException("School not found");
    const renaming =
      body.name !== undefined && str(body.name, 120) !== school.name;
    if (renaming && school.erpNameSyncedAt !== null) {
      throw new BadRequestException(
        `${school.name}'s name comes from your ERP, so it is set there — a change made here ` +
          `would be overwritten the next time anyone signs in. Rename it in the ERP and it will ` +
          `update here automatically.`,
      );
    }

    // A self-serve school's registry entry carries a display name too; leaving
    // it stale would make the Platform Console disagree with the app.
    if (renaming) {
      await this.selfServe.renameTenant(school.code, str(body.name, 120) ?? school.name);
    }

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
