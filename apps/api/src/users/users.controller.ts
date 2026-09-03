/**
 * §24.8 Phase 25.6 — the Users & Access endpoints.
 *
 * All behind `roles.manage`: deciding who signs in is the same authority as
 * deciding what a role may do. No school id appears in any path — a session
 * belongs to exactly one school, and taking one would invite passing somebody
 * else's (§17).
 */
import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { type AuthedRequest } from "../masters/crud.util";
import { UsersService } from "./users.service";

@Controller("users")
@RequirePermission(PERMISSIONS.ROLES_MANAGE)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.users.list(req.user.schoolId);
  }

  @Post("invite")
  invite(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    return this.users.invite(req.user.schoolId, body);
  }

  /** Everybody on the teacher master who has no login yet. `dryRun` previews. */
  @Post("invite-teachers")
  inviteTeachers(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    return this.users.inviteTeachers(req.user.schoolId, body);
  }

  @Post(":id/resend")
  resend(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.users.resend(req.user.schoolId, Number(id));
  }

  @Post(":id/deactivate")
  deactivate(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.users.setActive(req.user.schoolId, Number(id), false);
  }

  @Post(":id/reactivate")
  reactivate(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.users.setActive(req.user.schoolId, Number(id), true);
  }

  // There is deliberately NO `PUT /users/:id` here. `PUT /admin/users/:id`
  // already changes a role and a teacher link, with its own audit entry, and it
  // must keep working for ERP users — §15.1's `role_overridden` exists exactly
  // so an admin's explicit choice survives sync-on-login. A second updater that
  // refused ERP schools would have quietly broken that, so the guard this phase
  // adds (one teacher, one login) went into the existing endpoint instead.
}
