import { BadRequestException, Body, Controller, Post, Req } from "@nestjs/common";
import type { SessionTokenPayload } from "@edutimetable/shared";
import { AuthService } from "./auth.service";

/**
 * Switching between the schools one user may work in (§17.4).
 *
 * There is no permission gate here on purpose: the authority is the signed
 * session token's own `schoolIds`, which came from the signed ERP token. A
 * permission could be granted by an admin of one school and would say nothing
 * about whether the ERP grants access to another.
 *
 * A new session token is issued rather than the current one being mutated, so
 * every downstream check — REST scoping, Socket.IO rooms, the AI tool layer —
 * keeps reading the school from exactly one place.
 */
@Controller("auth")
export class SchoolSwitchController {
  constructor(private readonly auth: AuthService) {}

  @Post("switch-school")
  async switch(
    @Req() req: { user: SessionTokenPayload },
    @Body() body: { tenantId?: unknown; schoolId?: unknown },
  ) {
    // `tenantId` is the identifier that survives schools living in separate
    // databases; `schoolId` is accepted for deployments with only one (§17.5).
    const positive = (v: unknown) => {
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : undefined;
    };
    const tenantId = positive(body?.tenantId);
    const schoolId = positive(body?.schoolId);
    if (tenantId === undefined && schoolId === undefined) {
      throw new BadRequestException("tenantId or schoolId is required");
    }
    return this.auth.switchSchool(req.user, { tenantId, schoolId });
  }
}
