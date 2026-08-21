import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { AuthService } from "./auth.service";

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
  const svc = new AuthService(prisma as any, jwtService as any, erpKeys as any, redis as any);
  return { svc, prisma, jwtService, redis, erpKeys };
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
});
