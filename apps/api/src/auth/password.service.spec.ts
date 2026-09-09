import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, PasswordService } from "./password.service";
import { LoginThrottleService, ACCOUNT_MAX_FAILURES } from "./login-throttle.service";

/**
 * §15.3 Phase 25.0 — the parts of the credential path with no Prisma, no HTTP
 * and no Redis in them.
 *
 * The live suite (`scripts/auth-smoke.cjs`) proves the flows end to end. These
 * pin the rules underneath, where a regression is silent: a hash that stops
 * being upgraded, a policy that starts accepting six characters, a lockout that
 * counts wrong.
 */

const svc = new PasswordService();

describe("§15.3 password policy", () => {
  it("asks for length rather than a composition puzzle", () => {
    // A rule demanding a symbol and a digit produces `Password1!`, which is in
    // every cracking dictionary, while rejecting a four-word passphrase that is
    // orders of magnitude stronger. Length is what costs an attacker something.
    expect(svc.problemWith("correct horse battery staple")).toBeNull();
    expect(svc.problemWith("P@ssw0rd!")).not.toBeNull();
  });

  it("names the requirement in the refusal", () => {
    expect(svc.problemWith("short")).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it("refuses nothing at all, and non-strings", () => {
    expect(svc.problemWith("")).not.toBeNull();
    expect(svc.problemWith(undefined)).not.toBeNull();
    expect(svc.problemWith(null)).not.toBeNull();
    expect(svc.problemWith(12345678901234)).not.toBeNull();
  });

  it("bounds the top end too", () => {
    expect(svc.problemWith("x".repeat(1025))).not.toBeNull();
    expect(svc.problemWith("x".repeat(1024))).toBeNull();
  });
});

describe("§15.3 hashing", () => {
  it("produces an argon2id hash and verifies it", async () => {
    const h = await svc.hash("correct horse battery staple");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await svc.verify("correct horse battery staple", h)).toBe(true);
    expect(await svc.verify("correct horse battery stapler", h)).toBe(false);
  }, 20_000);

  it("salts, so the same password twice is two different hashes", async () => {
    const [a, b] = [await svc.hash("the same password here"), await svc.hash("the same password here")];
    expect(a).not.toBe(b);
    expect(await svc.verify("the same password here", a)).toBe(true);
    expect(await svc.verify("the same password here", b)).toBe(true);
  }, 20_000);

  it("returns false rather than throwing on a malformed or empty stored hash", async () => {
    // Load-bearing: `verify` is also called against the dummy hash for
    // addresses that do not exist. An exception there would make "no such
    // account" measurably different from "wrong password".
    expect(await svc.verify("anything", "")).toBe(false);
    expect(await svc.verify("anything", "not-a-hash")).toBe(false);
    expect(await svc.verify("anything", "$argon2id$broken")).toBe(false);
  });

  it("flags a hash made at a lower cost, and accepts today's", async () => {
    expect(svc.needsRehash("$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA")).toBe(true);
    expect(svc.needsRehash("$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA")).toBe(false);
    // A higher cost than ours is not "needs rehashing" — downgrading would be
    // the opposite of the point.
    expect(svc.needsRehash("$argon2id$v=19$m=131072,t=4,p=1$c2FsdA$aGFzaA")).toBe(false);
  });

  it("treats anything that is not argon2id as needing a rehash", () => {
    expect(svc.needsRehash("$2b$10$abcdefghijklmnopqrstuv")).toBe(true); // bcrypt
    expect(svc.needsRehash("")).toBe(true);
    expect(svc.needsRehash("plaintext")).toBe(true);
  });

  it("the dummy hash is a real one, so verifying against it costs real time", async () => {
    const dummy = await svc.dummyHash();
    expect(dummy.startsWith("$argon2id$")).toBe(true);
    expect(await svc.verify("anything at all", dummy)).toBe(false);
    // Stable within a process, so it is hashed once rather than per request.
    expect(await svc.dummyHash()).toBe(dummy);
  }, 20_000);
});

describe("§15.3 token comparison", () => {
  it("compares equal-length hex safely and rejects mismatches", () => {
    const a = "a".repeat(64);
    expect(PasswordService.safeEqualHex(a, a)).toBe(true);
    expect(PasswordService.safeEqualHex(a, "b".repeat(64))).toBe(false);
    expect(PasswordService.safeEqualHex(a, "a".repeat(62))).toBe(false);
    expect(PasswordService.safeEqualHex("zz", "zz")).toBe(false); // not hex
  });
});

describe("§15.3 lockout arithmetic", () => {
  const throttle = new LoginThrottleService({} as never);

  it("counts up and locks exactly at the threshold, not before", () => {
    let state = { failedLogins: 0, lockedUntil: null as Date | null };
    for (let i = 1; i < ACCOUNT_MAX_FAILURES; i++) {
      state = throttle.nextFailureState(state);
      expect(state.failedLogins).toBe(i);
      expect(state.lockedUntil).toBeNull();
    }
    state = throttle.nextFailureState(state);
    expect(state.failedLogins).toBe(ACCOUNT_MAX_FAILURES);
    expect(state.lockedUntil).toBeInstanceOf(Date);
    expect(state.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("reads a lock as over once its moment has passed", () => {
    expect(throttle.isLocked({ lockedUntil: new Date(Date.now() + 60_000) })).toBe(true);
    expect(throttle.isLocked({ lockedUntil: new Date(Date.now() - 1) })).toBe(false);
    expect(throttle.isLocked({ lockedUntil: null })).toBe(false);
  });
});
