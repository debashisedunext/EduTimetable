import { describe, expect, it } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { PermissionsGuard } from "./permissions.guard";

function contextFor(required: string[] | undefined, user: unknown) {
  const reflector = {
    getAllAndOverride: () => required,
  } as any;
  const context = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as any;
  return { reflector, context };
}

const permissionsService = (held: string[]) =>
  ({ getForRole: async () => held }) as any;

describe("PermissionsGuard (server-side RBAC, §15.3)", () => {
  it("passes when no permission is required", async () => {
    const { reflector, context } = contextFor(undefined, { roleId: 1 });
    const guard = new PermissionsGuard(reflector, permissionsService([]));
    expect(await guard.canActivate(context)).toBe(true);
  });

  it("rejects a user whose role lacks the required permission", async () => {
    const { reflector, context } = contextFor([PERMISSIONS.ROLES_MANAGE], { roleId: 4 });
    const guard = new PermissionsGuard(
      reflector,
      permissionsService([PERMISSIONS.TIMETABLE_VIEW_OWN]),
    );
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it("passes when the role holds every required permission", async () => {
    const { reflector, context } = contextFor([PERMISSIONS.MASTERS_MANAGE], { roleId: 3 });
    const guard = new PermissionsGuard(
      reflector,
      permissionsService([PERMISSIONS.MASTERS_MANAGE, PERMISSIONS.TIMETABLE_EDIT]),
    );
    expect(await guard.canActivate(context)).toBe(true);
  });
});
