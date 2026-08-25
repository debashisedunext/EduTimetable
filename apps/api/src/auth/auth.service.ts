import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type Redis from "ioredis";
import type { ErpSsoTokenPayload, SessionTokenPayload } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { REDIS } from "../redis/redis.module";
import { ErpKeysService } from "./erp-keys.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { TenantRegistryService } from "../control/tenant-registry.service";

const NONCE_TTL_SECONDS = 120;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly erpKeys: ErpKeysService,
    private readonly tenant: TenantContextService,
    private readonly registry: TenantRegistryService,
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

    // The registry is the authority on whether a school may be served at all
    // (§17.3). Checked before the nonce is burned, so a refused login can be
    // retried once the school is un-suspended. A deployment with no registry
    // (single school, no CONTROL_DATABASE_URL) skips this — there is nothing
    // to suspend.
    if (this.registry.available) {
      const tenant = await this.registry.byLocalSchoolId(payload.schoolId);
      if (tenant && tenant.status !== "active") {
        throw new ForbiddenException(
          `${tenant.displayName} is ${tenant.status} — contact your administrator`,
        );
      }
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

    // Provisioning runs inside the token's own school. It cannot be scoped by
    // an *existing* context — this is the moment the user's school is first
    // established — so the verified token's schoolId opens one (9.1 / §17).
    // A forged claim buys nothing: it is the RS256 signature that is trusted,
    // and the scope simply confines every query below to whatever it claimed.
    return this.tenant.runAs({ schoolId: payload.schoolId, origin: "sso" }, () =>
      this.provision(payload),
    );
  }

  private async provision(payload: ErpSsoTokenPayload): Promise<{ sessionToken: string }> {
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
