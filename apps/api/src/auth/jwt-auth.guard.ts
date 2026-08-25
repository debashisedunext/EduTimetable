import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { SessionTokenPayload } from "@edutimetable/shared";
import { IS_PUBLIC_KEY } from "./decorators";
import { TenantContextService } from "../tenant/tenant-context.service";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly tenant: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers?.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException("Missing bearer token");

    try {
      const user = await this.jwtService.verifyAsync<SessionTokenPayload>(token);
      request.user = user;
      // From here on every Prisma query in this request is filtered to this
      // school — the authority is the signed token, never a request parameter
      // (9.1 / §17).
      this.tenant.attach(user.schoolId, user.sub);
      return true;
    } catch {
      throw new UnauthorizedException("Invalid or expired session");
    }
  }
}
