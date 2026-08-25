import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type Redis from "ioredis";
import type { ErpSchoolClaim, ErpSsoTokenPayload, SessionTokenPayload } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { REDIS } from "../redis/redis.module";
import { ErpKeysService } from "./erp-keys.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { TenantRegistryService } from "../control/tenant-registry.service";
import { SchoolProvisioningService } from "../control/school-provisioning.service";

const NONCE_TTL_SECONDS = 120;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly erpKeys: ErpKeysService,
    private readonly tenant: TenantContextService,
    private readonly registry: TenantRegistryService,
    private readonly provisioning: SchoolProvisioningService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Full SSO entry (§15.1, extended in §17.4): verify the ERP's RS256 token,
   * burn its nonce, bring the school(s) it names in line with the ERP, provision
   * the user, and issue this app's own session JWT.
   *
   * The ERP owns school identity. Names are never hardcoded and never invented
   * here — they arrive on the token and are refreshed on every login, so a
   * school renamed in the ERP is renamed here without anyone re-typing it.
   */
  async handleSsoToken(erpToken: string): Promise<{ sessionToken: string }> {
    let payload: ErpSsoTokenPayload;
    try {
      payload = this.erpKeys.verifyErpToken(erpToken);
    } catch {
      throw new UnauthorizedException("Invalid or expired SSO token");
    }

    // Schools are created and named outside any school's scope — this is the
    // moment the session's school is decided, so it cannot already be scoped
    // to one. Runs before the nonce is burned so a token refused below can be
    // retried rather than being spent.
    const { activeSchoolId, grantedSchoolIds } = await this.tenant.runUnscoped("sso-provision", () =>
      this.resolveSchools(payload),
    );

    // The registry is the authority on whether a school may be served at all
    // (§17.3). A deployment with no registry (single school, no
    // CONTROL_DATABASE_URL) skips this — there is nothing to suspend.
    if (this.registry.available) {
      const tenant = await this.registry.byLocalSchoolId(activeSchoolId);
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

    return this.tenant.runAs({ schoolId: activeSchoolId, origin: "sso" }, () =>
      this.provision({
        schoolId: activeSchoolId,
        grantedSchoolIds,
        erpUserId: payload.erpUserId,
        erpRole: payload.erpRole,
        name: payload.name,
        email: payload.email,
        teacherId: payload.teacherId ?? null,
      }),
    );
  }

  /**
   * Turn the token's school claims into local school ids, creating and
   * refreshing rows as needed.
   *
   * Three shapes are accepted, in order of preference:
   *   1. `school` (+ optional `schools[]`) — the Phase 9.5 contract. The ERP
   *      names its schools; a trust administrator's token lists all of theirs.
   *   2. `schools[]` alone — the first entry becomes the active school.
   *   3. `schoolId` alone — a deployment whose ERP has not been updated yet.
   *      The school must already exist; nothing is created from a bare number,
   *      because a number carries no name.
   */
  private async resolveSchools(
    payload: ErpSsoTokenPayload,
  ): Promise<{ activeSchoolId: number; grantedSchoolIds: number[] }> {
    const granted = new Map<string, number>();
    const listed: ErpSchoolClaim[] = payload.schools ?? [];

    for (const claim of listed) {
      granted.set(claim.code, await this.provisioning.syncSchool(claim, payload.trust));
    }

    let activeSchoolId: number;
    if (payload.school) {
      activeSchoolId = await this.provisioning.syncSchool(payload.school, payload.trust);
      granted.set(payload.school.code, activeSchoolId);
    } else if (listed.length > 0) {
      activeSchoolId = granted.get(listed[0].code)!;
    } else if (typeof payload.schoolId === "number") {
      const existing = await this.prisma.school.findUnique({ where: { id: payload.schoolId } });
      if (!existing) {
        throw new ForbiddenException(
          `SSO token names school ${payload.schoolId}, which does not exist here. ` +
            `Send the school's code and name on the token so it can be provisioned (§17.4).`,
        );
      }
      activeSchoolId = existing.id;
      granted.set(existing.code, existing.id);
    } else {
      throw new UnauthorizedException("SSO token names no school");
    }

    return { activeSchoolId, grantedSchoolIds: [...new Set(granted.values())] };
  }

  /**
   * Find-or-refresh the user inside one school and mint a session for it.
   * Shared by SSO entry and by switching school, so both paths provision
   * identically — a user can be an Admin in one school and a Teacher in
   * another, and each session reflects the school it is for.
   */
  private async provision(input: {
    schoolId: number;
    grantedSchoolIds: number[];
    erpUserId: string;
    erpRole: string;
    name?: string;
    email?: string;
    teacherId?: number | null;
  }): Promise<{ sessionToken: string }> {
    const { schoolId, erpUserId, erpRole } = input;
    const mapping = await this.prisma.erpRoleMapping.findUnique({
      where: { schoolId_erpRole: { schoolId, erpRole } },
    });
    if (!mapping) {
      throw new ForbiddenException(`No timetable role mapped for ERP role '${erpRole}'`);
    }

    const existing = await this.prisma.user.findUnique({
      where: { schoolId_erpUserId: { schoolId, erpUserId } },
    });

    const user = existing
      ? await this.prisma.user.update({
          where: { id: existing.id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.email !== undefined ? { email: input.email } : {}),
            ...(input.teacherId !== undefined ? { teacherId: input.teacherId } : {}),
            lastLoginAt: new Date(),
            // sync-on-login must not clobber an Admin's role override (§15.1)
            ...(existing.roleOverridden ? {} : { roleId: mapping.roleId }),
          },
        })
      : await this.prisma.user.create({
          data: {
            schoolId,
            erpUserId,
            name: input.name ?? erpUserId,
            email: input.email ?? "",
            teacherId: input.teacherId ?? null,
            roleId: mapping.roleId,
            lastLoginAt: new Date(),
          },
        });

    if (!user.isActive) throw new ForbiddenException("User is deactivated");

    const session: SessionTokenPayload = {
      sub: user.id,
      schoolId: user.schoolId,
      roleId: user.roleId,
      erpUserId,
      erpRole,
      schoolIds: input.grantedSchoolIds,
    };
    const sessionToken = await this.jwtService.signAsync(session, { expiresIn: "8h" });
    return { sessionToken };
  }

  /**
   * Switch the session to another of the user's schools (§17.4).
   *
   * The granted list comes from the signed session token, which came from the
   * signed ERP token — so a request cannot reach a school the ERP did not
   * grant, whatever it asks for. The user is re-provisioned in the target
   * school, because their role there is that school's business: Admin in one
   * and Teacher in another is a normal arrangement in a trust.
   */
  async switchSchool(
    session: SessionTokenPayload,
    targetSchoolId: number,
  ): Promise<{ sessionToken: string }> {
    const granted = session.schoolIds ?? [session.schoolId];
    if (!granted.includes(targetSchoolId)) {
      throw new ForbiddenException("You do not have access to that school");
    }
    if (!session.erpUserId || !session.erpRole) {
      // Pre-9.5 sessions carry no ERP identity, so the target school's role
      // cannot be resolved. Signing in again through the ERP fixes it.
      throw new BadRequestException("This session predates school switching — sign in again");
    }
    if (this.registry.available) {
      const tenant = await this.registry.byLocalSchoolId(targetSchoolId);
      if (tenant && tenant.status !== "active") {
        throw new ForbiddenException(`${tenant.displayName} is ${tenant.status}`);
      }
    }
    return this.tenant.runAs({ schoolId: targetSchoolId, origin: "switch-school" }, () =>
      this.provision({
        schoolId: targetSchoolId,
        grantedSchoolIds: granted,
        erpUserId: session.erpUserId!,
        erpRole: session.erpRole!,
      }),
    );
  }
}
