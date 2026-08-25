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
    verifyErpToken: vi.fn().mockResolvedValue(payload),
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
    byId: vi.fn().mockResolvedValue(null),
    byIds: vi.fn().mockResolvedValue([]),
    resolveByCode: vi.fn().mockResolvedValue(null),
    ...overrides.registry,
  };
  // 9.5: the ERP owns school identity — provisioning creates/renames the local
  // school row from the token rather than the app hardcoding anything.
  const provisioning = {
    syncSchool: vi
      .fn()
      .mockImplementation(async (claim: any) =>
        claim.code === "SCH-2" ? { schoolId: 2, tenantId: 20 } : { schoolId: 1, tenantId: 10 },
      ),
    ...overrides.provisioning,
  };
  // 9.4: connections route a dedicated tenant to its own database. Default to
  // the shared path, which is what every test here except the routing ones want.
  const connections = {
    clientFor: vi.fn().mockResolvedValue(undefined),
    ...overrides.connections,
  };
  const svc = new AuthService(
    prisma as any,
    jwtService as any,
    erpKeys as any,
    tenant,
    registry as any,
    provisioning as any,
    connections as any,
    redis as any,
  );
  return { svc, prisma, jwtService, redis, erpKeys, registry, provisioning, connections };
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
        byId: vi.fn().mockResolvedValue({
          tenantId: 10,
          schoolId: 1,
          displayName: "Springfield High",
          mode: "shared",
          status: "suspended",
        }),
      },
      erpKeys: {
        verifyErpToken: vi.fn().mockResolvedValue({
          ...payload,
          schoolId: undefined,
          school: { code: "SCH-1", name: "Springfield High" },
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
        byId: vi.fn().mockResolvedValue({
          tenantId: 10,
          schoolId: 1,
          displayName: "Springfield High",
          mode: "shared",
          status: "active",
        }),
      },
      erpKeys: {
        verifyErpToken: vi.fn().mockResolvedValue({
          ...payload,
          schoolId: undefined,
          school: { code: "SCH-1", name: "Springfield High" },
        }),
      },
    });
    await expect(svc.handleSsoToken("erp-token")).resolves.toEqual({ sessionToken: "session-jwt" });
    // Checked by tenant, not by guessing from a school id — school ids repeat
    // across databases, tenant ids do not (§17.5).
    expect(registry.byId).toHaveBeenCalledWith(10);
  });

  it("does not consult a registry that is not configured", async () => {
    // A single-school deployment has no CONTROL_DATABASE_URL and must keep
    // working exactly as it did before Phase 9.
    const { svc, registry } = build({
      provisioning: {
        syncSchool: vi.fn().mockResolvedValue({ schoolId: 1, tenantId: null }),
      },
    });
    await expect(svc.handleSsoToken("erp-token")).resolves.toEqual({ sessionToken: "session-jwt" });
    expect(registry.byId).not.toHaveBeenCalled();
  });
  // ---- Phase 9.5 (§17.4): the ERP owns school identity ----

  it("provisions and names the school from the token, not from anything local", async () => {
    const { svc, provisioning, jwtService } = build({
      erpKeys: {
        verifyErpToken: vi.fn().mockResolvedValue({
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
        verifyErpToken: vi.fn().mockResolvedValue({
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
    // Tenants are the switching key once schools can live in separate databases.
    expect(session.grants.sort()).toEqual([10, 20]);
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
      { schoolId: 2 },
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
        { schoolId: 77 },
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("refuses to switch a session that predates school switching", async () => {
    const { svc } = build();
    await expect(
      svc.switchSchool({ sub: 10, schoolId: 1, roleId: 4, schoolIds: [1, 2] }, { schoolId: 2 }),
    ).rejects.toThrow(/sign in again/);
  });
  // ---- Phase 9.4 (§17.5): routing to a tenant's own database ----

  it("switches by tenant, and refuses a tenant the ERP did not grant", async () => {
    const { svc, registry } = build({
      registry: {
        available: true,
        byId: vi.fn().mockResolvedValue({
          tenantId: 20, schoolId: 1, displayName: "Other School", mode: "dedicated", status: "active",
        }),
      },
    });
    const session = {
      sub: 10, schoolId: 5, roleId: 4, tenantId: 10,
      erpUserId: "E-100", erpRole: "ADMIN", grants: [10, 20], schoolIds: [5, 1],
    };
    await expect(svc.switchSchool(session, { tenantId: 20 })).resolves.toEqual({
      sessionToken: "session-jwt",
    });
    expect(registry.byId).toHaveBeenCalledWith(20);
    await expect(svc.switchSchool(session, { tenantId: 99 })).rejects.toThrow(ForbiddenException);
  });

  it("opens the target tenant's own connection before provisioning into it", async () => {
    // The users row for a dedicated school belongs in that school's database,
    // not the shared one — so the connection must be resolved first.
    const { svc, connections } = build({
      registry: {
        available: true,
        byId: vi.fn().mockResolvedValue({
          tenantId: 20, schoolId: 1, displayName: "Other School", mode: "dedicated", status: "active",
        }),
      },
    });
    await svc.switchSchool(
      { sub: 10, schoolId: 5, roleId: 4, erpUserId: "E-100", erpRole: "ADMIN", grants: [10, 20] },
      { tenantId: 20 },
    );
    expect(connections.clientFor).toHaveBeenCalledWith(20);
  });

  it("refuses a bare school id when the session spans tenants and it is ambiguous", async () => {
    // Two dedicated schools can both be school_id 1; picking one would be a
    // coin toss, so the request has to name the tenant.
    const { svc } = build({
      registry: {
        available: true,
        byIds: vi.fn().mockResolvedValue([
          { tenantId: 10, schoolId: 1, displayName: "A", mode: "dedicated", status: "active" },
          { tenantId: 20, schoolId: 1, displayName: "B", mode: "dedicated", status: "active" },
        ]),
      },
    });
    await expect(
      svc.switchSchool(
        { sub: 10, schoolId: 1, roleId: 4, erpUserId: "E-100", erpRole: "ADMIN", grants: [10, 20], schoolIds: [1] },
        { schoolId: 1 },
      ),
    ).rejects.toThrow(/Ambiguous/);
  });

  it("refuses to switch into a suspended school", async () => {
    const { svc } = build({
      registry: {
        available: true,
        byId: vi.fn().mockResolvedValue({
          tenantId: 20, schoolId: 1, displayName: "Other School", mode: "shared", status: "suspended",
        }),
      },
    });
    await expect(
      svc.switchSchool(
        { sub: 10, schoolId: 5, roleId: 4, erpUserId: "E-100", erpRole: "ADMIN", grants: [10, 20] },
        { tenantId: 20 },
      ),
    ).rejects.toThrow(/suspended/);
  });
});
