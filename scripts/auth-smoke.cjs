/**
 * Phase 25.0 (§15.3) — local accounts, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/auth-smoke.cjs
 *
 * This is the first credential this application has ever owned. Everything here
 * is a property that, if it silently stopped holding, would not show up as a
 * broken screen — it would show up as somebody else's password. So the checks
 * are deliberately about the parts nobody sees:
 *
 *   1. METHODS   — the deployment says which ways in it actually offers
 *   2. REGISTER  — same answer for a new and an existing address
 *   3. VERIFY    — one-shot, and it signs you in
 *   4. LOGIN     — works, and upgrades a weak hash while it has the plaintext
 *   5. SILENCE   — unknown address and wrong password: same body, same TIME
 *   6. TOKENS    — account and session tokens are not interchangeable, either way
 *   7. LOCKOUT   — failures lock, and a lockout is indistinguishable from a typo
 *   8. RESET     — one-shot, invalidates its siblings, and actually changes it
 *   9. AT REST   — argon2id in the row, sha256 in the token table, plaintext nowhere
 *  10. WEAK      — a short password is refused with a reason
 *
 * Everything it creates uses @zzauth.test and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("/app/apps/api/prisma/generated/control-client");
const { createHash } = require("node:crypto");
const argon2 = req("@node-rs/argon2");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzauth.test";
const PW = "correct horse battery staple";
const PW2 = "a different long passphrase";

let failed = 0;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = 1;
};

async function call(path, body, token) {
  const res = await fetch(`${API}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

/** The one-shot token out of the message the app would have emailed. */
async function mailToken(to, kind) {
  const r = await call(`/dev/mail/token?to=${encodeURIComponent(to)}&kind=${kind}`);
  return r.json?.token ?? null;
}

const timed = async (fn) => {
  const t = Date.now();
  await fn();
  return Date.now() - t;
};

(async () => {
  const control = new PrismaClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");
  const purge = () => control.account.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });

  /**
   * Forget this source address's failures.
   *
   * Needed because the suite itself makes ~30 deliberate failures, which is
   * well past the 20-per-15-minutes budget — and once that trips, a CORRECT
   * password is refused too. That is the throttle working exactly as intended;
   * it is also a hidden precondition that would quietly make later checks pass
   * or fail for the wrong reason. Section 11 tests the budget on purpose.
   */
  const clearIpBudget = async () => {
    const keys = await redis.keys("throttle:*:ip:*");
    if (keys.length) await redis.del(...keys);
  };

  await purge();
  await clearIpBudget();

  const owner = `owner@${DOMAIN}`;
  const other = `second@${DOMAIN}`;
  const ghost = `nobody-at-all@${DOMAIN}`;

  // ────────────────────────────────────────────────────────── 1. METHODS
  console.log("\nThe deployment reports how it can be entered:");
  const methods = await call("/auth/methods");
  check(methods.json?.local === true && methods.json?.sso === true,
    "both local accounts and SSO are offered", JSON.stringify(methods.json));

  // ───────────────────────────────────────────────────────── 2. REGISTER
  console.log("\nRegistering says the same thing whoever you are:");
  const reg = await call("/auth/register", {
    email: owner, password: PW, name: "ZZ Owner", organisation: "ZZ Trust", country: "India",
  });
  check(reg.status < 300, "a new address registers", `${reg.status}`);
  const firstMessage = reg.json?.message ?? "";
  check(/on its way/i.test(firstMessage), "and is told to check their email", firstMessage.slice(0, 50));

  const dup = await call("/auth/register", { email: owner, password: PW, name: "Impostor" });
  check(dup.status < 300 && dup.json?.message === firstMessage,
    "an address that ALREADY EXISTS gets the identical answer — never 'already registered'");
  check((await control.account.count({ where: { email: owner } })) === 1,
    "and no second account was made");
  check((await control.account.findUnique({ where: { email: owner } })).name === "ZZ Owner",
    "nor was the real one overwritten by the impostor's name");
  // The real owner is told instead — that is the safe place to raise it.
  check(Boolean(await mailToken(owner, "reset")),
    "the genuine mailbox owner is emailed about it, rather than the form telling a stranger");

  // ─────────────────────────────────────────────────────────── 3. VERIFY
  console.log("\nVerification is one-shot, and signs you in:");
  const vt = await mailToken(owner, "verify");
  check(Boolean(vt), "a verification link was generated");
  const ver = await call("/auth/verify", { token: vt });
  check(ver.status < 300 && Boolean(ver.json?.accountToken),
    "verifying returns a signed-in account token — they proved the mailbox seconds ago");
  check(ver.json?.account?.emailVerified === true, "and the account reads as verified");
  const again = await call("/auth/verify", { token: vt });
  check(again.status === 400, "the same link cannot be used twice", `${again.status}`);

  // ──────────────────────────────────────────────────────────── 4. LOGIN
  console.log("\nSigning in:");
  const login = await call("/auth/login", { email: owner, password: PW });
  check(login.status < 300 && Boolean(login.json?.accountToken), "the right password signs in");
  const accountToken = login.json.accountToken;
  const claims = JSON.parse(Buffer.from(accountToken.split(".")[1], "base64url").toString());
  check(claims.typ === "account" && claims.kind === "owner",
    "the token says what KIND of credential it is — which is what keeps the two apart",
    `typ=${claims.typ} kind=${claims.kind}`);

  // A hash made with a lower cost must be upgraded silently, while the
  // plaintext is legitimately in hand. Simulated by writing a weak one.
  // Hashed FOR REAL at the lower cost. Editing the parameters inside an
  // existing encoded hash does not work — the digest was computed with the
  // real ones, so a doctored string simply fails to verify and the login this
  // is meant to exercise never happens. (It also makes the wrong-password path
  // cheap, which then breaks the timing check two sections later.)
  const weak = await control.account.update({
    where: { email: owner },
    data: {
      passwordHash: await argon2.hash(PW, {
        algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1,
      }),
    },
  });
  check(/m=19456,t=2/.test(weak.passwordHash), "planted a hash genuinely made at a lower cost",
    weak.passwordHash.slice(0, 30));
  await call("/auth/login", { email: owner, password: PW });
  const upgraded = await control.account.findUnique({ where: { email: owner } });
  check(!/m=19456,t=2/.test(upgraded.passwordHash),
    "signing in re-hashed it at today's cost — nobody was asked to reset anything",
    upgraded.passwordHash.slice(0, 34));

  // ────────────────────────────────────────────────────────── 5. SILENCE
  console.log("\nAn unknown address and a wrong password are indistinguishable:");
  await clearIpBudget();
  const unknown = await call("/auth/login", { email: ghost, password: PW });
  const wrong = await call("/auth/login", { email: owner, password: "not the password at all" });
  check(unknown.status === wrong.status, "same status", `${unknown.status} / ${wrong.status}`);
  check(unknown.json?.message === wrong.json?.message, "same message", unknown.json?.message);

  // ...and the same TIME. Skipping the hash for an unknown address makes that
  // path ~1ms against ~113ms, and the gap is a customer list anyone can read.
  const samples = 4;
  let tUnknown = 0, tWrong = 0;
  for (let i = 0; i < samples; i++) {
    tUnknown += await timed(() => call("/auth/login", { email: ghost, password: PW }));
    tWrong += await timed(() => call("/auth/login", { email: owner, password: `nope-${i}` }));
  }
  const [u, w] = [tUnknown / samples, tWrong / samples];
  const ratio = Math.max(u, w) / Math.max(1, Math.min(u, w));
  check(ratio < 2, "and the same time, so the difference cannot be measured",
    `unknown ${Math.round(u)}ms vs wrong ${Math.round(w)}ms (ratio ${ratio.toFixed(2)})`);

  // ─────────────────────────────────────────────────────────── 6. TOKENS
  console.log("\nAn account token and a session token are not interchangeable:");
  const me = await call("/auth/account", undefined, accountToken);
  check(me.status === 200 && me.json?.email === owner, "an account token reads its own account");
  for (const path of ["/me", "/classes", "/timetable-configs"]) {
    const r = await call(path, undefined, accountToken);
    check(r.status === 401, `an account token is refused by ${path}`,
      r.json?.message?.slice(0, 46));
  }
  // ...and the other way. A school session must not be spendable out here.
  const erp = await call("/dev/erp-token", {
    erpUserId: "ZZAUTH-1", erpRole: "ADMIN", name: "Seed Admin", email: `sso@${DOMAIN}`,
    school: { code: "SEED-001", name: "Seed" },
  });
  const cb = await fetch(`${API}/api/sso/callback?token=${erp.json.token}`, { redirect: "manual" });
  const sessionToken = (cb.headers.get("location") || "").split("#token=")[1];
  check(Boolean(sessionToken), "an SSO session was minted for the reverse test");
  const reverse = await call("/auth/account", undefined, sessionToken);
  check(reverse.status === 401, "a school session token is refused by /auth/account",
    reverse.json?.message?.slice(0, 46));
  const stillWorks = await call("/me", undefined, sessionToken);
  check(stillWorks.status === 200, "while that same session still opens the app normally — SSO is untouched");

  // ────────────────────────────────────────────────────────── 7. LOCKOUT
  console.log("\nRepeated failures lock the account, and say nothing about it:");
  await clearIpBudget();
  await control.account.update({ where: { email: owner }, data: { failedLogins: 0, lockedUntil: null } });
  let lockedMessage = null;
  for (let i = 0; i < 9; i++) {
    const r = await call("/auth/login", { email: owner, password: `wrong-${i}` });
    lockedMessage = r.json?.message;
  }
  const locked = await control.account.findUnique({ where: { email: owner } });
  check(locked.lockedUntil !== null && locked.lockedUntil > new Date(),
    "the account is locked", `${locked.failedLogins} failures`);
  check(lockedMessage === wrong.json?.message,
    "and the message never changed — 'account locked' would confirm the address exists");
  const duringLock = await call("/auth/login", { email: owner, password: PW });
  check(duringLock.status === 401,
    "even the CORRECT password is refused while locked — so the lock is real, not cosmetic");
  await control.account.update({ where: { email: owner }, data: { failedLogins: 0, lockedUntil: null } });

  // ──────────────────────────────────────────────────────────── 8. RESET
  console.log("\nResetting a password:");
  await clearIpBudget();
  const unknownForgot = await call("/auth/forgot", { email: ghost });
  const knownForgot = await call("/auth/forgot", { email: owner });
  check(unknownForgot.json?.message === knownForgot.json?.message,
    "forgot-password says the same for a known and an unknown address",
    knownForgot.json?.message?.slice(0, 44));

  // Two outstanding links; using one must kill the other.
  await call("/auth/forgot", { email: owner });
  const outstanding = await control.accountToken.count({
    where: { account: { email: owner }, purpose: "reset", usedAt: null },
  });
  check(outstanding >= 2, "two reset links are outstanding", `${outstanding}`);

  const rt = await mailToken(owner, "reset");
  const reset = await call("/auth/reset", { token: rt, password: PW2 });
  check(reset.status < 300, "the newest link resets the password", `${reset.status}`);
  check((await call("/auth/login", { email: owner, password: PW })).status === 401,
    "the old password stops working");
  check((await call("/auth/login", { email: owner, password: PW2 })).status < 300,
    "the new password works");
  check((await call("/auth/reset", { token: rt, password: "yet another passphrase" })).status === 400,
    "and that link cannot be used a second time");
  const leftOver = await control.accountToken.count({
    where: { account: { email: owner }, purpose: "reset", usedAt: null },
  });
  check(leftOver === 0,
    "every OTHER outstanding link died with it — an older mail must not still change the password",
    `${leftOver} left unused`);

  // ────────────────────────────────────────────────────────── 9. AT REST
  console.log("\nWhat is actually stored:");
  const row = await control.account.findUnique({ where: { email: owner } });
  check(row.passwordHash.startsWith("$argon2id$"), "the password is an argon2id hash",
    row.passwordHash.slice(0, 30));
  check(!row.passwordHash.includes(PW2) && !JSON.stringify(row).includes(PW2),
    "and the plaintext appears nowhere on the row");
  const anyToken = await control.accountToken.findFirst({ where: { account: { email: owner } } });
  check(/^[0-9a-f]{64}$/.test(anyToken.tokenHash),
    "tokens are stored as a SHA-256, so a leaked backup hands nobody a working link",
    anyToken.tokenHash.slice(0, 16) + "…");
  // Prove the stored hash really is the hash OF the emailed token, not a
  // separate random value that merely looks like one.
  await call("/auth/forgot", { email: owner });
  const proofToken = await mailToken(owner, "reset");
  const proof = await control.accountToken.findUnique({
    where: { tokenHash: createHash("sha256").update(proofToken).digest("hex") },
  });
  check(Boolean(proof), "and it is genuinely sha256(the token that was emailed)");

  // ───────────────────────────────────────────────────────────── 10. WEAK
  console.log("\nA weak password is refused, with the reason:");
  const short = await call("/auth/register", { email: other, password: "short1!", name: "Too Short" });
  check(short.status === 400, "a short password is refused", `${short.status}`);
  check(/12 characters/.test(short.json?.message ?? ""),
    "and says what would be acceptable rather than a rule list", short.json?.message?.slice(0, 70));
  check((await control.account.count({ where: { email: other } })) === 0, "no account was created");

  // ────────────────────────────────────────────────────── 11. IP THROTTLE
  console.log("\nOne source address cannot spray many addresses:");
  await clearIpBudget();
  await control.account.update({ where: { email: owner }, data: { failedLogins: 0, lockedUntil: null } });
  // Spraying: ONE common password against MANY addresses. No single account
  // ever accumulates failures, so a per-account counter never fires — only the
  // per-IP one sees this at all. Limiting one axis and calling it rate
  // limiting is the usual mistake.
  for (let i = 0; i < 22; i++) {
    await call("/auth/login", { email: "sprayed-" + i + "@" + DOMAIN, password: "one common password" });
  }
  const sprayed = await control.account.findUnique({ where: { email: owner } });
  check(sprayed.failedLogins === 0,
    "spraying leaves every individual account counter at zero — which is why per-account alone is not enough");
  const blocked = await call("/auth/login", { email: owner, password: PW2 });
  check(blocked.status === 401,
    "but the source address is throttled, so even a correct password waits", String(blocked.status));
  check(/too many/i.test(blocked.json?.message ?? ""),
    "and this one DOES say why — it is the connection being refused, not an address being confirmed",
    (blocked.json?.message ?? "").slice(0, 56));
  await clearIpBudget();
  check((await call("/auth/login", { email: owner, password: PW2 })).status < 300,
    "and it works again once the budget is clear");
  // ─────────────────────────────────────────────────────────────── cleanup
  console.log("\nCleanup:");
  await purge();
  check((await control.account.count({ where: { email: { endsWith: `@${DOMAIN}` } } })) === 0,
    "test accounts removed");
  await control.$disconnect();
  redis.disconnect();

  console.log(failed ? "\nSOME AUTH CHECKS FAILED" : "\nALL AUTH CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
