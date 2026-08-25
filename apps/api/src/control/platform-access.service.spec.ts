/**
 * Platform access (§17.6, Phase 9.8).
 *
 * The containment property — that a school's own admin cannot grant themselves
 * authority over the registry — is proved end to end in
 * `scripts/platform-console-smoke.cjs`. These pin the two decisions underneath
 * it: identity is the ERP's, and the check is per request rather than minted
 * into a session token that would keep saying yes for eight hours after a
 * revocation.
 */
import { describe, expect, it, vi } from "vitest";
import { PlatformAccessService } from "./platform-access.service";

const controlWith = (rows: Array<{ erpUserId: string; isActive: boolean }>) => {
  const findFirst = vi.fn(async ({ where }: { where: { erpUserId: string; isActive: boolean } }) =>
    rows.find((r) => r.erpUserId === where.erpUserId && r.isActive) ?? null,
  );
  return { service: { client: { platformUser: { findFirst } } }, findFirst };
};

describe("PlatformAccessService", () => {
  it("grants a registered platform admin", async () => {
    const { service } = controlWith([{ erpUserId: "ERP-1", isActive: true }]);
    const access = new PlatformAccessService(service as never);
    await expect(access.isPlatformAdmin({ sub: 1, schoolId: 1, roleId: 1, erpUserId: "ERP-1" })).resolves.toBe(true);
  });

  it("refuses everyone else, whatever their school role", async () => {
    // The session carries no hint of school seniority on purpose: this is a
    // different axis, and a Super Admin is not closer to platform access than
    // anyone else.
    const { service } = controlWith([{ erpUserId: "ERP-1", isActive: true }]);
    const access = new PlatformAccessService(service as never);
    await expect(access.isPlatformAdmin({ sub: 2, schoolId: 1, roleId: 1, erpUserId: "ERP-2" })).resolves.toBe(false);
  });

  it("refuses a revoked admin", async () => {
    const { service } = controlWith([{ erpUserId: "ERP-1", isActive: false }]);
    const access = new PlatformAccessService(service as never);
    await expect(access.isPlatformAdmin({ sub: 1, schoolId: 1, roleId: 1, erpUserId: "ERP-1" })).resolves.toBe(false);
  });

  it("refuses a session with no ERP identity", async () => {
    // Pre-9.5 tokens carry no erpUserId; there is nothing to match, so the
    // answer is no rather than a lookup on undefined.
    const { service, findFirst } = controlWith([{ erpUserId: "ERP-1", isActive: true }]);
    const access = new PlatformAccessService(service as never);
    await expect(access.isPlatformAdmin({ sub: 1, schoolId: 1, roleId: 1 })).resolves.toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("refuses when there is no registry at all", async () => {
    // A single-school deployment has no control plane and therefore no platform
    // to administer — the safe answer is no, not "everyone".
    const access = new PlatformAccessService({ client: null } as never);
    await expect(access.isPlatformAdmin({ sub: 1, schoolId: 1, roleId: 1, erpUserId: "ERP-1" })).resolves.toBe(false);
  });

  it("honours the bootstrap allowlist without touching the database", async () => {
    // The first platform admin cannot be granted through a console that
    // requires already being one.
    const { service, findFirst } = controlWith([]);
    process.env.PLATFORM_ADMIN_ERP_USER_IDS = " ERP-BOOT , ERP-OTHER ";
    try {
      const access = new PlatformAccessService(service as never);
      await expect(access.isPlatformAdmin({ sub: 1, schoolId: 1, roleId: 1, erpUserId: "ERP-BOOT" })).resolves.toBe(true);
      expect(findFirst).not.toHaveBeenCalled();
    } finally {
      delete process.env.PLATFORM_ADMIN_ERP_USER_IDS;
    }
  });

  it("caches, so the check costs a Map read on the hot path", async () => {
    const { service, findFirst } = controlWith([{ erpUserId: "ERP-1", isActive: true }]);
    const access = new PlatformAccessService(service as never);
    const session = { sub: 1, schoolId: 1, roleId: 1, erpUserId: "ERP-1" };
    await access.isPlatformAdmin(session);
    await access.isPlatformAdmin(session);
    await access.isPlatformAdmin(session);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("forgets on invalidate, so a revocation can bite immediately", async () => {
    const { service, findFirst } = controlWith([{ erpUserId: "ERP-1", isActive: true }]);
    const access = new PlatformAccessService(service as never);
    const session = { sub: 1, schoolId: 1, roleId: 1, erpUserId: "ERP-1" };
    await access.isPlatformAdmin(session);
    access.invalidate();
    await access.isPlatformAdmin(session);
    expect(findFirst).toHaveBeenCalledTimes(2);
  });
});
