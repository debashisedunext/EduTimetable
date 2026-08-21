import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type Redis from "ioredis";
import type { ErpSsoTokenPayload, SessionTokenPayload } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { REDIS } from "../redis/redis.module";
import { ErpKeysService } from "./erp-keys.service";

const NONCE_TTL_SECONDS = 120;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly erpKeys: ErpKeysService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Full SSO entry (§15.1): verify the ERP's RS256 token, burn its nonce,
   * provision/refresh the user (sync-on-login; Admin role overrides win),
   * and issue this app's own session JWT.
   */
  async handleSsoToken(erpToken: string): Promise<{ sessionToken: string }> {
    let payload: ErpSsoTokenPayload;
    try {
      payload = this.erpKeys.verifyErpToken(erpToken);
    } catch {
      throw new UnauthorizedException("Invalid or expired SSO token");
    }

    if (!payload.jti) throw new UnauthorizedException("SSO token missing nonce");
    const fresh = await this.redis.set(
      `sso:nonce:${payload.jti}`,
      "1",
      "EX",
      NONCE_TTL_SECONDS,
      "NX",
    );
    if (fresh === null) throw new UnauthorizedException("SSO token replayed");

    const mapping = await this.prisma.erpRoleMapping.findUnique({
      where: { schoolId_erpRole: { schoolId: payload.schoolId, erpRole: payload.erpRole } },
    });
    if (!mapping) {
      throw new ForbiddenException(`No timetable role mapped for ERP role '${payload.erpRole}'`);
    }

    const existing = await this.prisma.user.findUnique({
      where: {
        schoolId_erpUserId: { schoolId: payload.schoolId, erpUserId: payload.erpUserId },
      },
    });

    const user = existing
      ? await this.prisma.user.update({
          where: { id: existing.id },
          data: {
            name: payload.name,
            email: payload.email,
            teacherId: payload.teacherId ?? null,
            lastLoginAt: new Date(),
            // sync-on-login must not clobber an Admin's role override (§15.1)
            ...(existing.roleOverridden ? {} : { roleId: mapping.roleId }),
          },
        })
      : await this.prisma.user.create({
          data: {
            schoolId: payload.schoolId,
            erpUserId: payload.erpUserId,
            name: payload.name,
            email: payload.email,
            teacherId: payload.teacherId ?? null,
            roleId: mapping.roleId,
            lastLoginAt: new Date(),
          },
        });

    if (!user.isActive) throw new ForbiddenException("User is deactivated");

    const session: SessionTokenPayload = {
      sub: user.id,
      schoolId: user.schoolId,
      roleId: user.roleId,
    };
    const sessionToken = await this.jwtService.signAsync(session, { expiresIn: "8h" });
    return { sessionToken };
  }
}
