/**
 * §17.4a — a school's logo can be the image itself, and a bad one is refused
 * rather than stored broken.
 *
 * ## Why this is a smoke and not left to the screen
 *
 * The change is one column widened from VARCHAR(255) to TEXT plus one guard,
 * and both failure modes are **silent**:
 *
 *  - A truncating `slice(255)` on a `data:` URI stores an image that is not an
 *    image. Nothing errors; the logo simply never draws, on every screen, for
 *    the life of that school. That is what every other field in this controller
 *    still does deliberately, which is exactly why the logo had to stop.
 *  - A migration that did not reach every database (§17.3) leaves one school's
 *    upload failing with `Data too long for column` while the next school's
 *    works — so the check runs against the API, which runs against whichever
 *    database the tenant context resolved.
 *
 * So it asserts the round trip is **byte-identical**, that an oversized value
 * is refused BY NAME, and — the assertion that matters most — that the refusal
 * leaves the logo that was already there untouched.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzlg.test";
const PW = "correct horse battery staple";

let failed = 0;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = 1;
};
async function call(method, path, token, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}
const mailToken = async (to, kind) =>
  (await call("GET", `/dev/mail/token?to=${encodeURIComponent(to)}&kind=${kind}`)).json?.token ?? null;

/** A real 1×1 transparent PNG, padded past the old column's 255 characters. */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const BIG = PNG + "#".repeat(4000);

async function main() {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZLG" } }, select: { id: true, code: true },
    });
    const ids = mine.map((s) => s.id);
    for (const m of ["onboardingSession", "notification", "auditLog", "user", "rolePermission", "erpRoleMapping", "role"]) {
      if (ids.length) await prisma[m].deleteMany({ where: { schoolId: { in: ids } } }).catch(() => undefined);
    }
    if (ids.length) await prisma.school.deleteMany({ where: { id: { in: ids } } });
    await control.tenant.deleteMany({ where: { schoolCode: { in: mine.map((s) => s.code) } } });
    await control.account.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  };
  await purge();

  console.log("\nA school, and its logo:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZLG Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const S = (await call("POST", "/schools", acct, { name: "ZZLG School" })).json.sessionToken;

  const fresh = (await call("GET", "/school", S)).json;
  check(fresh.logoUrl === null, "a new school has no logo, which is what makes the default load-bearing", String(fresh.logoUrl));

  const put = await call("PUT", "/school", S, { name: fresh.name, logoUrl: BIG });
  const stored = (await call("GET", "/school", S)).json;
  check(put.status === 200, "an uploaded image is accepted", `HTTP ${put.status}`);
  check(
    stored.logoUrl === BIG,
    "and comes back BYTE-IDENTICAL — the old VARCHAR(255) would have truncated it here",
    `${(stored.logoUrl || "").length} of ${BIG.length} chars`,
  );

  /*
    `/me` is what every screen reads the logo from, so a value that survives
    the school route and not this one would still leave the top bar blank.
  */
  const me = (await call("GET", "/me", S)).json;
  check(me.school.logoUrl === BIG, "and reaches /me, which is what the top bar actually renders");

  const huge = await call("PUT", "/school", S, { name: fresh.name, logoUrl: "x".repeat(61000) });
  check(huge.status === 400, "an image past the column's own limit is REFUSED", `HTTP ${huge.status}`);
  check(
    /too large/i.test(huge.json?.message ?? ""),
    "by name, saying what to do about it",
    (huge.json?.message ?? "").slice(0, 60),
  );
  const after = (await call("GET", "/school", S)).json;
  check(after.logoUrl === BIG, "and the refusal left the logo that was already there untouched");

  const cleared = await call("PUT", "/school", S, { name: fresh.name, logoUrl: "" });
  const none = (await call("GET", "/school", S)).json;
  check(cleared.status === 200 && none.logoUrl === null, "clearing it stores NULL, never \"\" — invariant 7", String(none.logoUrl));

  await purge();
  await prisma.$disconnect();
  await control.$disconnect();
  console.log(failed ? "\nFAILED\n" : "\nAll good.\n");
  process.exit(failed);
}

main().catch((e) => { console.error(e); process.exit(1); });
