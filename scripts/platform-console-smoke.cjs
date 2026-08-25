/**
 * Phase 9.8 (§17.6) — the Platform Console, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/platform-console-smoke.cjs
 *
 * The property this exists to defend is containment: **a school's own Super
 * Admin holds every permission inside that school and must still not be able to
 * govern the registry.** If platform access were a school permission, the
 * admin who manages their own roles could grant it to themselves — authority
 * over other schools' status, connections and existence, obtained from inside
 * the thing it governs.
 *
 *   1. REFUSED  — a school Super Admin, holding every school permission, is
 *                 refused on every platform route
 *   2. GRANTED  — the CLI grants access; the same account is now allowed
 *   3. REPORTS  — the console lists schools with mode, schema and status, and
 *                 tests a connection
 *   4. SUSPENDS — suspending a school actually stops its users signing in
 *   5. LEAKS    — no connection URL appears in any response
 *   6. REVOKED  — revoking takes access away again
 */
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = require("/app/apps/api/prisma/generated/control-client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const ADMIN_ERP_ID = "ZZPLAT-admin";
const API_DIR = "/app/apps/api";
/** The access check is memoised for 30s; grants and revokes have to outwait it. */
const CACHE_MS = 31_000;

let failed = 0;
const check = (ok, l, x = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${x ? ` — ${x}` : ""}`);
  if (!ok) failed = 1;
};
const cli = (args) =>
  execFileSync("pnpm", ["run", "platform:admin", "--", ...args], { cwd: API_DIR, encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(claims) {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(claims),
  });
  const { token } = await r.json();
  const cb = await fetch(`${API}/api/sso/callback?token=${token}`, { redirect: "manual" });
  const location = cb.headers.get("location") || "";
  return { token: location.split("#token=")[1] ?? null, location };
}

async function call(method, path, token, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

(async () => {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const school = await prisma.school.findFirst({ orderBy: { id: "asc" } });

  // Start clean, whatever a previous run left behind.
  await control.platformUser.deleteMany({ where: { erpUserId: ADMIN_ERP_ID } });
  await sleep(CACHE_MS);

  const ROUTES = [
    ["GET", "/platform/overview"],
    ["GET", "/platform/tenants"],
    ["GET", "/platform/admins"],
  ];

  // ------------------------------------------------------------ 1. REFUSED
  console.log("A school's Super Admin cannot reach the platform, however senior:");
  const claims = {
    erpUserId: ADMIN_ERP_ID, erpRole: "ADMIN", name: "School Super Admin", email: "sa@zz.test",
    school: { code: school.code, name: school.name },
  };
  const before = await signIn(claims);
  const me = await call("GET", "/me", before.token);
  check(me.json?.role === "Super Admin", "the account really is a school Super Admin", me.json?.role);
  check((me.json?.permissions ?? []).length > 5,
    "holding every permission its school has to give", `${me.json?.permissions?.length} permissions`);
  check(me.json?.platformAdmin === false, "but /me reports no platform access", `platformAdmin=${me.json?.platformAdmin}`);

  for (const [method, path] of ROUTES) {
    const r = await call(method, path, before.token);
    check(r.status === 403, `${method} ${path}`, `${r.status}`);
  }
  const suspendAttempt = await call("POST", "/platform/tenants/1/status", before.token, { status: "suspended" });
  check(suspendAttempt.status === 403, "POST /platform/tenants/1/status", `${suspendAttempt.status}`);

  // ------------------------------------------------------------ 2. GRANTED
  console.log("\nThe grant is a command on the host, not a button in the app:");
  const granted = cli(["--grant", ADMIN_ERP_ID, "--name", "School Super Admin"]);
  check(granted.includes("Granted platform access"), "platform:admin --grant", ADMIN_ERP_ID);
  const listed = cli(["--list"]);
  check(listed.includes(ADMIN_ERP_ID), "and the CLI lists them");

  console.log("    (waiting out the 30s access cache…)");
  await sleep(CACHE_MS);

  // Deliberately reuses the SAME session token issued before the grant: access
  // is re-checked per request, not minted into the token, so it takes effect
  // without signing in again — and revoking will bite the same way.
  const nowAllowed = await call("GET", "/platform/overview", before.token);
  check(nowAllowed.status === 200, "the same session token now reaches the console", `${nowAllowed.status}`);
  const meNow = await call("GET", "/me", before.token);
  check(meNow.json?.platformAdmin === true, "and /me reports platform access", `platformAdmin=${meNow.json?.platformAdmin}`);

  // ------------------------------------------------------------ 3. REPORTS
  console.log("\nThe console reports the deployment:");
  const overview = nowAllowed.json;
  check(overview?.schools?.total > 0, "school counts", `${overview?.schools?.total} total, ${overview?.schools?.dedicated} with their own database`);
  check(typeof overview?.expectedSchema === "string", "the schema this build expects", overview?.expectedSchema);
  check(overview?.connections?.maxConnections === overview?.connections?.maxClients * overview?.connections?.poolLimit,
    "and the connection budget", `${overview?.connections?.maxConnections} max`);

  const tenants = await call("GET", "/platform/tenants", before.token);
  check(Array.isArray(tenants.json) && tenants.json.length > 0, "the school list", `${tenants.json?.length} school(s)`);
  const first = tenants.json[0];
  check(["shared", "dedicated"].includes(first.mode) && typeof first.status === "string",
    "with where its data lives and its status", `${first.displayName}: ${first.mode}, ${first.status}`);

  const tested = await call("POST", `/platform/tenants/${first.id}/test`, before.token);
  check(tested.json?.ok === true, "and a live connection test",
    `${tested.json?.ms}ms, schema ${tested.json?.schema?.ok ? "current" : "behind"}, ${tested.json?.schoolsInDatabase} school row(s)`);

  // ----------------------------------------------------------- 4. SUSPENDS
  console.log("\nSuspending a school actually stops its users signing in:");
  // Matched on tenant id, not on `localSchoolId`: under §17.5 a school with
  // its own database usually has local id 1 — the same id the shared school
  // has — so `localSchoolId === school.id` can match somebody else's tenant
  // entirely, and this test would then suspend a school whose users it is not
  // about to sign in. The tenant id is the routing key; it is the only thing
  // here that identifies one school across databases.
  const session = JSON.parse(Buffer.from(before.token.split(".")[1], "base64url").toString());
  const target = tenants.json.find((t) => t.id === session.tenantId) ?? first;
  const suspended = await call("POST", `/platform/tenants/${target.id}/status`, before.token, { status: "suspended" });
  check(suspended.json?.status === "suspended", "the console suspends it", suspended.json?.displayName);

  const blocked = await signIn({ ...claims, erpUserId: "ZZPLAT-teacher", erpRole: "TEACHER", name: "T" });
  check(blocked.location.includes("sso-error"), "a user of that school cannot sign in", blocked.location.split("/").pop());

  const reinstated = await call("POST", `/platform/tenants/${target.id}/status`, before.token, { status: "active" });
  check(reinstated.json?.status === "active", "and reinstating it restores them", reinstated.json?.status);
  const allowed = await signIn({ ...claims, erpUserId: "ZZPLAT-teacher", erpRole: "TEACHER", name: "T" });
  check(Boolean(allowed.token), "they can sign in again");

  // -------------------------------------------------------------- 5. LEAKS
  console.log("\nNo credentials leave the console:");
  const blob = JSON.stringify(tenants.json) + JSON.stringify(overview) + JSON.stringify(tested.json);
  check(!/mysql:\/\//.test(blob), "no connection URL in any response");
  check(!/root:|password/i.test(blob), "no credentials of any kind");
  const dedicated = tenants.json.filter((t) => t.mode === "dedicated");
  if (dedicated.length > 0) {
    check(dedicated.every((t) => typeof t.hasStoredUrl === "boolean" && !("dbUrlEncrypted" in t)),
      "a dedicated school reports only THAT a URL is stored", `${dedicated.length} dedicated`);
  } else {
    // `every` on an empty array is vacuously true — that would be a check that
    // cannot fail. dedicated-tenant-smoke.cjs covers this path with a real one.
    console.log("  INFO  no dedicated school in this deployment — URL custody covered by dedicated-tenant-smoke.cjs");
  }

  // ------------------------------------------------------------ 6. REVOKED
  console.log("\nRevoking takes it away again:");
  const revoked = cli(["--revoke", ADMIN_ERP_ID]);
  check(revoked.includes("Revoked platform access"), "platform:admin --revoke");
  console.log("    (waiting out the cache again…)");
  await sleep(CACHE_MS);
  const afterRevoke = await call("GET", "/platform/overview", before.token);
  check(afterRevoke.status === 403, "the same session is refused again", `${afterRevoke.status}`);

  // ----------------------------------------------------------------- cleanup
  console.log("\nCleanup:");
  await control.platformUser.deleteMany({ where: { erpUserId: ADMIN_ERP_ID } });
  await prisma.user.deleteMany({ where: { erpUserId: { startsWith: "ZZPLAT-" } } });
  const left = await control.platformUser.count({ where: { erpUserId: ADMIN_ERP_ID } });
  check(left === 0, "test grant and users removed");

  await prisma.$disconnect();
  await control.$disconnect();
  console.log(failed ? "\nSOME PLATFORM CONSOLE CHECKS FAILED" : "\nALL PLATFORM CONSOLE CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
