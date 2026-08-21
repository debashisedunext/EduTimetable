import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Permission, SessionTokenPayload } from "@edutimetable/shared";
import { PERMISSIONS_KEY } from "./decorators";
import { PermissionsService } from "./permissions.service";

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionsService: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user: SessionTokenPayload | undefined = context.switchToHttp().getRequest().user;
    if (!user) return false; // public routes never carry @RequirePermission

    const held = await this.permissionsService.getForRole(user.roleId);
    const missing = required.filter((p) => !held.includes(p));
    if (missing.length > 0) {
      throw new ForbiddenException(`Missing permission: ${missing.join(", ")}`);
    }
    return true;
  }
}
