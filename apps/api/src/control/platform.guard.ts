import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { SessionTokenPayload } from "@edutimetable/shared";
import { PlatformAccessService } from "./platform-access.service";

export const PLATFORM_KEY = "requiresPlatformAdmin";

/**
 * Guards a route at the platform level (§17.6) — above every school, and
 * deliberately not expressible as a school permission, which a school's own
 * admin could grant themselves.
 */
export const RequirePlatformAdmin = () => SetMetadata(PLATFORM_KEY, true);

@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: PlatformAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(PLATFORM_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest();
    const session = request.user as SessionTokenPayload | undefined;
    if (!(await this.access.isPlatformAdmin(session))) {
      // Says what is required without hinting at how to obtain it.
      throw new ForbiddenException(
        "Platform administration is not available to this account. It is granted outside any school.",
      );
    }
    return true;
  }
}
