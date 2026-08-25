/**
 * Phase 9.10 (§17.5, §17.8) — a school on a second, genuinely separate MySQL
 * server, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/dedicated-db-smoke.cjs
 *
 * `dedicated-tenant-smoke.cjs` (9.4) covers a school with its own database on
 * the *same* server. This covers the case that one cannot: a different **host**
 * with different **credentials**, which is what the "each school has its own
 * database with distinct credentials" requirement actually means.
 *
 * The difference is not cosmetic. On one server, code that ignored the stored
 * connection URL and fell back to the default connection would still find a
 * database of the right name, and every behavioural assertion would pass while
 * the routing was doing nothing. Point a tenant at `mysql-b` with a user that
 * exists only there, and that fallback cannot even open a socket. The registry
 * URL is now load-bearing, and a test can fail when it stops being used.
 *
 *   1. PROVISION  — the operator command reaches another server and migrates it
 *   2. REGISTER   — the registry holds it as dedicated, credentials encrypted
 *   3. ROUTE      — a session for that school reads and writes on mysql-b
 *   4. CREDENTIAL — and does so as that server's own user, not the default one
 *   5. SEPARATE   — nothing of it appears in the shared database, and vice versa
 *   6. MIGRATE    — §17.3's walk covers a school on another server too
 *
 * The tenant and its database are left in place: they are the fixture the dev
 * stack is expected to have, and re-running is idempotent.
 */
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = require("/app/apps/api/prisma/generated/control-client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const TENANT_URL = process.env.TENANT_B_DATABASE_URL;
const CODE = "ZZDED-B";
const NAME = "ZZ Branch Campus";
const P = "ZZDEDB";

let failed = 0;
const check = (ok, l, x = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${x ? ` — ${x}` : ""}`);
  if (!ok) failed = 1;
};

async function signIn(claims) {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(claims),
  });
  const { token } = await r.json();
  const cb = await fetch(`${API}/api/sso/callback?token=${token}`, { redirect: "manual" });
  return (cb.headers.get("location") || "").split("#token=")[1] ?? null;
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
  if (!TENANT_URL) {
    console.error("TENANT_B_DATABASE_URL is not set — is this running inside the dev compose stack?");
    process.exit(1);
  }
  const host = new URL(TENANT_URL).host;
  const user = new URL(TENANT_URL).username;

  // ------------------------------------------------------------ 1. PROVISION
  console.log(`Provisioning a school onto ${host} as '${user}':`);
  execFileSync("pnpm", ["--filter", "@edutimetable/api", "tenant:create",
    "--code", CODE, "--name", NAME, "--url", TENANT_URL], { cwd: "/app", stdio: "inherit" });

  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const branch = new PrismaClient({ datasources: { db: { url: TENANT_URL } } });
  const shared = new PrismaClient(); // the default DATABASE_URL

  // ------------------------------------------------------------- 2. REGISTER
  const tenant = await control.tenant.findFirst({ where: { schoolCode: CODE } });
  check(tenant?.mode === "dedicated", "registered as a dedicated tenant", `mode=${tenant?.mode}`);
  check(tenant?.dbUrlEncrypted !== null, "its connection URL is stored, encrypted at rest");
  // The registry is the only place that knows where this school lives. Nothing
  // in the application's own configuration names mysql-b.
  const stored = tenant?.dbUrlEncrypted ? Buffer.from(tenant.dbUrlEncrypted).toString("utf8") : "";
  check(!stored.includes(host) && !stored.includes(new URL(TENANT_URL).password),
    "and the stored bytes are not the URL in the clear", `${stored.length} byte(s) of ciphertext`);

  // ---------------------------------------------------------------- 3. ROUTE
  console.log("\nA session for that school reads and writes on the other server:");
  const token = await signIn({
    erpUserId: `${P}-1`, erpRole: "ADMIN", name: "Branch Admin", email: "branch@zz.test",
    school: { code: CODE, name: NAME },
  });
  check(Boolean(token), "the ERP's school code opened a session");

  const session = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  check(session.tenantId === tenant.id, "the session carries the tenant, not just the school",
    `tenantId=${session.tenantId} · schoolId=${session.schoolId}`);

  const roomName = `${P} Branch Room`;
  await branch.room.deleteMany({ where: { name: roomName } });
  const created = await call("POST", "/rooms", token, { name: roomName, roomType: "classroom" });
  check(created.status === 201, "a write through the API succeeded", `${created.status}`);

  const onBranch = await branch.room.findFirst({ where: { name: roomName } });
  const onShared = await shared.room.findFirst({ where: { name: roomName } });
  check(Boolean(onBranch) && !onShared, "the row landed on mysql-b and nowhere else",
    `mysql-b ${onBranch ? "yes" : "no"} · shared ${onShared ? "yes" : "no"}`);

  // ----------------------------------------------------------- 4. CREDENTIAL
  // The canary: this user exists only on mysql-b, and has no rights on the
  // default server. If routing had silently used the default connection the
  // write above could not have happened at all — but it is worth stating the
  // asymmetry outright, because it is the reason this test exists.
  console.log("\nThe credentials in the registry are the ones actually used:");
  const wrongServer = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL.replace(/\/\/[^@]+@/, `//${user}:${new URL(TENANT_URL).password}@`) } },
  });
  let refusedOnDefault = false;
  try {
    await wrongServer.$queryRaw`SELECT 1`;
  } catch {
    refusedOnDefault = true;
  }
  await wrongServer.$disconnect().catch(() => undefined);
  check(refusedOnDefault, `'${user}' cannot connect to the default server at all`,
    refusedOnDefault ? "so the write above can only have gone to mysql-b" : "the user exists on both — this test proves less than it claims");

  // ------------------------------------------------------------- 5. SEPARATE
  console.log("\nNeither database can see the other, despite sharing local ids:");
  const branchSchool = await branch.school.findUnique({ where: { code: CODE } });
  const sharedSchools = await shared.school.findMany({ select: { id: true, code: true } });
  check(sharedSchools.some((s) => s.id === branchSchool.id) && !sharedSchools.some((s) => s.code === CODE),
    "both databases have a school with the same local id, and they are different schools",
    `local id ${branchSchool.id}: '${CODE}' on mysql-b, '${sharedSchools.find((s) => s.id === branchSchool.id)?.code}' on the shared server`);

  const listed = await call("GET", "/rooms", token);
  const rooms = Array.isArray(listed.json) ? listed.json : [];
  const sharedRoomNames = new Set((await shared.room.findMany({ select: { name: true } })).map((r) => r.name));
  const bleed = rooms.filter((r) => sharedRoomNames.has(r.name));
  check(listed.status === 200 && bleed.length === 0, "GET /rooms returns mysql-b's rooms only",
    bleed.length ? `leaked ${bleed.map((r) => r.name).join(", ")}` : `${rooms.length} room(s), none from the shared database`);

  // --------------------------------------------------------------- 6. MIGRATE
  // §17.3: a migration is not deployed until every school's database has it,
  // and "every" now includes one on another server. A tenant behind the build
  // is refused on connect rather than served, so this is not a nicety.
  console.log("\nThe migration walk covers a school on another server:");
  const walk = execFileSync("pnpm", ["--filter", "@edutimetable/api", "migrate:all", "--", "--dry-run"],
    { cwd: "/app", encoding: "utf8" });
  // The walk names each database by host, with the password redacted — so the
  // host is what to look for, and seeing it proves the plan reached off-server.
  const line = walk.split("\n").find((l) => l.includes(host));
  check(Boolean(line), "migrate:all reaches this school's server in its plan",
    line ? line.trim() : "no line named " + host);
  check(!walk.includes(new URL(TENANT_URL).password),
    "and prints no password while doing it");

  const health = await (await fetch(`${API}/api/health`)).json();
  console.log(`  INFO  connection budget — ${JSON.stringify(health.connections ?? health)}`);

  await Promise.all([control.$disconnect(), branch.$disconnect(), shared.$disconnect()]);
  console.log(failed ? "\nSOME DEDICATED-SERVER CHECKS FAILED" : "\nALL DEDICATED-SERVER CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
