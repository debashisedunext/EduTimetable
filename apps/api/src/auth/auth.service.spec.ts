import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { TenantContextService } from "../tenant/tenant-context.service";

const payload = {
  erpUserId: "E-100",
  name: "R. Sharma",
  email: "rs@school.test",
  erpRole: "TEACHER",
  schoolId: 1,
  teacherId: 42,
  jti: "nonce-1",
  exp: 0,
};

function build(overrides: Partial<Record<string, any>> = {}) {
  const prisma = {
    erpRoleMapping: { findUnique: vi.fn().mockResolvedValue({ roleId: 4 }) },
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({
        id: 10,
        isActive: true,
        ...data,
      })),
      update: vi.fn().mockImplementation(async ({ data }: any) => ({
        id: 10,
        schoolId: 1,
        roleId: 4,
        isActive: true,
        ...data,
      })),
    },
    school: {
      // the legacy `schoolId` path requires the school to already exist
      findUnique: vi.fn().mockResolvedValue({ id: 1, code: "SCH-1", name: "Existing School" }),
    },
    ...overrides.prisma,
  };
  const jwtService = {
    signAsync: vi.fn().mockResolvedValue("session-jwt"),
    ...overrides.jwtService,
  };
  const redis = { set: vi.fn().mockResolvedValue("OK"), ...overrides.redis };
  const erpKeys = {
    verifyErpToken: vi.fn().mockReturnValue(payload),
    ...overrides.erpKeys,
  };
  // 9.1: provisioning runs inside a tenant context opened from the verified
  // token, so the service now takes the context service too.
  const tenant = new TenantContextService();
  // 9.2: the registry gates suspended schools. Default to "no registry
  // configured", which is what a single-school deployment has, so these tests
  // stay about SSO; the suspension path has its own case below.
  const registry = {
    available: false,
    byLocalSchoolId: vi.fn().mockResolvedValue(null),
    ...overrides.registry,
  };
  // 9.5: the ERP owns school identity — provisioning creates/renames the local
  // school row from the token rather than the app hardcoding anything.
  const provisioning = {
    syncSchool: vi.fn().mockImplementation(async (claim: any) => (claim.code === "SCH-2" ? 2 : 1)),
    ...overrides.provisioning,
  };
  const svc = new AuthService(
    prisma as any,
    jwtService as any,
    erpKeys as any,
    tenant,
    registry as any,
    provisioning as any,
    redis as any,
  );
  return { svc, prisma, jwtService, redis, erpKeys, registry, provisioning };
}

describe("AuthService.handleSsoToken (§15.1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("provisions a new user from the ERP role mapping and issues a session", async () => {
    const { svc, prisma } = build();
    const result = await svc.handleSsoToken("erp-token");
    expect(result.sessionToken).toBe("session-jwt");
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ roleId: 4, teacherId: 42 }) }),
    );
  });

  it("rejects a replayed nonce (single-use, Redis NX)", async () => {
    const { svc } = build({ redis: { set: vi.fn().mockResolvedValue(null) } });
    await expect(svc.handleSsoToken("erp-token")).rejects.toThrow(UnauthorizedException);
  });

  it("rejects an invalid/expired ERP token", async () => {
    const { svc } = build({
      erpKeys: {
        verifyErpToken: vi.fn(() => {
          throw new Error("bad sig");
        }),
      },
    });
    await expect(svc.handleSsoToken("erp-token")).rejects.toThrow(UnauthorizedException);
  });

  it("does not clobber an Admin role override on re-login (sync-on-login rule)", async () => {
    const { svc, prisma } = build({
      prisma: {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: 10,
            roleId: 2,
            roleOverridden: true,
            isActive: true,
          }),
          update: vi.fn().mockImplementation(async ({ data }: any) => ({
            id: 10,
            schoolId: 1,
            roleId: 2,
            isActive: true,
            ...data,
          })),
          create: vi.fn(),
        },
      },
    });
    await svc.handleSsoToken("erp-token");
    const updateData = prisma.user.update.mock.calls[0][0].data;
    expect(updateData.roleId).toBeUndefined();
  });

  it("rejects an ERP role with no timetable mapping", async () => {
    const { svc } = build({
      prisma: { erpRoleMapping: { findUnique: vi.fn().mockResolvedValue(null) } },
    });
    await expect(svc.handleSsoToken("erp-token")).rejects.toThrow(ForbiddenException);
  });

  // ---- Phase 9.2 (§17.3): the tenant registry gates the door ----

  it("refuses a login to a suspended school", async () => {
    const { svc, redis } = build({
      registry: {
        available: true,
        byLocalSchoolId: vi.fn().mockResolvedValue({
          tenantId: 7,
          schoolId: 1,
          displayName: "Springfield High",
          status: "suspended",
        }),
      },
    });
    await expect(svc.handleSsoToken("erp-token")).rejects.toThrow(/suspended/);
    // Refused before the nonce is burned, so the login can be retried once the
    // school is reinstated rather than needing a fresh token from the ERP.
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("lets an active school straight through", async () => {
    const { svc, registry } = build({
      registry: {
        available: true,
        byLocalSchoolId: vi.fn().mockResolvedValue({
          tenantId: 7,
          schoolId: 1,
          displayName: "Springfield High",
          status: "active",
        }),
      },
    });
    await expect(svc.handleSsoToken("erp-token")).resolves.toEqual({ sessionToken: "session-jwt" });
    expect(registry.byLocalSchoolId).toHaveBeenCalledWith(1);
  });

  it("does not consult a registry that is not configured", async () => {
    // A single-school deployment has no CONTROL_DATABASE_URL and must keep
    // working exactly as it did before Phase 9.
    const { svc, registry } = build();
    await expect(svc.handleSsoToken("erp-token")).resolves.toEqual({ sessionToken: "session-jwt" });
    expect(registry.byLocalSchoolId).not.toHaveBeenCalled();
  });
  // ---- Phase 9.5 (§17.4): the ERP owns school identity ----

  it("provisions and names the school from the token, not from anything local", async () => {
    const { svc, provisioning, jwtService } = build({
      erpKeys: {
        verifyErpToken: vi.fn().mockReturnValue({
          ...payload,
          schoolId: undefined,
          school: { code: "SCH-1", name: "Springfield High" },
        }),
      },
    });
    await svc.handleSsoToken("erp-token");
    expect(provisioning.syncSchool).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SCH-1", name: "Springfield High" }),
      undefined,
    );
    expect(jwtService.signAsync.mock.calls[0][0].schoolId).toBe(1);
  });

  it("carries the trust through to provisioning and grants every listed school", async () => {
    const { svc, provisioning, jwtService } = build({
      erpKeys: {
        verifyErpToken: vi.fn().mockReturnValue({
          ...payload,
          schoolId: undefined,
          erpRole: "ADMIN",
          school: { code: "SCH-1", name: "Springfield High" },
          trust: { code: "TR-1", name: "Springfield Education Trust" },
          schools: [
            { code: "SCH-1", name: "Springfield High" },
            { code: "SCH-2", name: "Springfield Primary" },
          ],
        }),
      },
    });
    await svc.handleSsoToken("erp-token");
    expect(provisioning.syncSchool).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SCH-2" }),
      expect.objectContaining({ code: "TR-1" }),
    );
    const session = jwtService.signAsync.mock.calls[0][0];
    expect(session.schoolIds.sort()).toEqual([1, 2]);
  });

  it("refuses a bare numeric school it has never heard of", async () => {
    // A number carries no name, so there is nothing to provision from — the
    // ERP has to send the code and name.
    const { svc } = build({
      prisma: { school: { findUnique: vi.fn().mockResolvedValue(null) } },
    });
    await expect(svc.handleSsoToken("erp-token")).rejects.toThrow(/does not exist here/);
  });

  // ---- Phase 9.6 (§17.4): switching school ----

  it("switches to another granted school and re-resolves the role there", async () => {
    const { svc, prisma, jwtService } = build({
      prisma: {
        // Teacher here, Super Admin in the other school — a normal arrangement
        erpRoleMapping: { findUnique: vi.fn().mockResolvedValue({ roleId: 99 }) },
      },
    });
    await svc.switchSchool(
      { sub: 10, schoolId: 1, roleId: 4, erpUserId: "E-100", erpRole: "ADMIN", schoolIds: [1, 2] },
      2,
    );
    expect(prisma.erpRoleMapping.findUnique).toHaveBeenCalledWith({
      where: { schoolId_erpRole: { schoolId: 2, erpRole: "ADMIN" } },
    });
    const session = jwtService.signAsync.mock.calls[0][0];
    expect(session.schoolId).toBe(2);
    expect(session.roleId).toBe(99);
  });

  it("refuses a school the ERP did not grant, whatever the request asks for", async () => {
    const { svc } = build();
    await expect(
      svc.switchSchool(
        { sub: 10, schoolId: 1, roleId: 4, erpUserId: "E-100", erpRole: "ADMIN", schoolIds: [1, 2] },
        77,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("refuses to switch a session that predates school switching", async () => {
    const { svc } = build();
    await expect(
      svc.switchSchool({ sub: 10, schoolId: 1, roleId: 4, schoolIds: [1, 2] }, 2),
    ).rejects.toThrow(/sign in again/);
  });
});
