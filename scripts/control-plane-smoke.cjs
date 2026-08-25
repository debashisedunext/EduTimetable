/**
 * Phase 9.2 (§17.3) — the control plane, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/control-plane-smoke.cjs
 *
 * Proves the four things 9.2 is actually for:
 *
 *   1. `school_id` has a parent. The schools table exists, every school_id
 *      column has a real foreign key to it, and a row cannot claim a school
 *      that does not exist.
 *   2. The registry knows the schools. Every school in the application
 *      database is registered as a tenant, with a code that is meaningful
 *      across databases in a way a numeric id is not.
 *   3. The registry is load-bearing, not decorative: suspending a school stops
 *      its users signing in, and reinstating it lets them back.
 *   4. Nothing leaks. Tenant credentials are not reachable through the API,
 *      and a school cannot create or delete schools from inside its own session.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = require("/app/apps/api/prisma/generated/control-client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const CONTROL_URL = process.env.CONTROL_DATABASE_URL;

let failed = 0;
const check = (ok, l, x = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${x ? ` — ${x}` : ""}`);
  if (!ok) failed = 1;
};

async function sessionFor(payload) {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const { token } = await r.json();
  const cb = await fetch(`${API}/api/sso/callback?token=${token}`, { redirect: "manual" });
  return (cb.headers.get("location") || "").split("#token=")[1];
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
  if (!CONTROL_URL) {
    console.log("CONTROL_DATABASE_URL is not set — nothing to test.");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: CONTROL_URL } } });

  const admin = await sessionFor({ erpUserId: "ERP-1", erpRole: "ADMIN", name: "Admin A", email: "a@a.test" });
  const teacher = await sessionFor({ erpUserId: "ERP-3", erpRole: "TEACHER", name: "R. Sharma", email: "rs@s.test", teacherId: 1 });

  // ------------------------------------------------ 1. school_id has a parent
  console.log("school_id finally has a parent row:");
  const schools = await prisma.school.findMany();
  check(schools.length > 0, "the schools table is populated", `${schools.length} school(s)`);

  const fks = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'schools' AND COLUMN_NAME = 'school_id'`,
  );
  const fkCount = Number(fks[0].n);
  check(fkCount === 30, "every school_id column has a foreign key to it", `${fkCount} of 30`);

  // The FK is the structural guarantee: no row can name a school that isn't there.
  let inventedSchool = null;
  try {
    await prisma.room.create({ data: { schoolId: 987654, name: "ZZCTL Ghost Room" } });
    inventedSchool = "created";
  } catch (e) {
    inventedSchool = /foreign key|constraint/i.test(e.message) ? "refused" : `other: ${e.message.slice(0, 60)}`;
  }
  check(inventedSchool === "refused", "a row cannot claim a school that does not exist", inventedSchool);

  // ------------------------------------------------------- 2. registry knows
  console.log("\nThe registry knows every school:");
  const tenants = await control.tenant.findMany();
  check(tenants.length >= schools.length, "one tenant per school", `${tenants.length} tenant(s)`);
  const forSchool1 = tenants.find((t) => t.localSchoolId === 1);
  check(Boolean(forSchool1), "school 1 is registered", `code ${forSchool1?.schoolCode}, mode ${forSchool1?.mode}`);
  check(forSchool1?.mode === "shared" && forSchool1?.dbUrlEncrypted === null,
    "a shared tenant stores no connection URL", "nothing to leak");

  const instances = await control.erpInstance.findMany();
  check(instances.length > 0, "an ERP installation is registered", instances[0]?.name);

  // ------------------------------------------------------- /me and /school
  console.log("\nThe session knows which school it belongs to:");
  const me = await call("GET", "/me", admin);
  check(me.json?.school?.id === 1 && typeof me.json?.school?.code === "string",
    "GET /me carries the school", `${me.json?.school?.code} — ${me.json?.school?.name}`);

  const before = await call("GET", "/school", admin);
  check(before.status === 200, "GET /school", `${before.json?.name}`);

  const renamed = await call("PUT", "/school", admin, { name: "ZZCTL Renamed School", shortName: "ZZCTL" });
  check(renamed.status === 200 && renamed.json?.name === "ZZCTL Renamed School",
    "an admin can fix the placeholder name", renamed.json?.name);

  // `code` is what the registry resolves logins against — editable from inside
  // the school, it would be a way to lock your own users out.
  const codeAttempt = await call("PUT", "/school", admin, { code: "HIJACK", name: "ZZCTL Renamed School" });
  const afterCode = await prisma.school.findUnique({ where: { id: 1 } });
  check(afterCode?.code !== "HIJACK", "the school code is not editable from inside the school", `${afterCode?.code} (${codeAttempt.status})`);

  const teacherWrite = await call("PUT", "/school", teacher, { name: "ZZCTL Teacher Wrote This" });
  check(teacherWrite.status === 403, "a teacher cannot rename the school", `${teacherWrite.status}`);

  // restore
  await call("PUT", "/school", admin, { name: before.json.name, shortName: before.json.shortName });

  // ------------------------------- 3. suspension actually stops a login
  console.log("\nSuspending a school stops its users signing in:");
  await control.tenant.update({ where: { id: forSchool1.id }, data: { status: "suspended" } });
  // the registry memo is 30s; wait it out rather than reaching into the process
  console.log("    (waiting out the 30s registry cache…)");
  await new Promise((r) => setTimeout(r, 31_000));

  const blocked = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ erpUserId: "ERP-1", erpRole: "ADMIN", name: "Admin A", email: "a@a.test" }),
  }).then((r) => r.json());
  const blockedCb = await fetch(`${API}/api/sso/callback?token=${blocked.token}`, { redirect: "manual" });
  const blockedLocation = blockedCb.headers.get("location") || "";
  check(blockedLocation.includes("sso-error"), "a suspended school cannot sign in", blockedLocation.split("/").pop());

  await control.tenant.update({ where: { id: forSchool1.id }, data: { status: "active" } });
  console.log("    (waiting out the cache again…)");
  await new Promise((r) => setTimeout(r, 31_000));
  const restored = await sessionFor({ erpUserId: "ERP-1", erpRole: "ADMIN", name: "Admin A", email: "a@a.test" });
  check(Boolean(restored), "reinstating the school lets them back in");

  // -------------------------------------------------- 4. nothing leaks
  console.log("\nThe control plane is not reachable from the application API:");
  for (const path of ["/tenants", "/control/tenants", "/admin/tenants", "/trusts"]) {
    const r = await call("GET", path, restored);
    check(r.status === 404, `GET ${path} is not an endpoint`, `${r.status}`);
  }
  const schoolPost = await call("POST", "/school", restored, { code: "NEW", name: "Invented" });
  check(schoolPost.status === 404 || schoolPost.status === 405,
    "a school cannot create another school", `${schoolPost.status}`);

  // ----------------------------------------------------------------- cleanup
  await prisma.room.deleteMany({ where: { name: { startsWith: "ZZCTL" } } });
  await prisma.$disconnect();
  await control.$disconnect();
  console.log(failed ? "\nSOME CONTROL PLANE CHECKS FAILED" : "\nALL CONTROL PLANE CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
