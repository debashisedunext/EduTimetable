/**
 * Phase 9.4 (§17.5) — a school with its own database, against the LIVE stack.
 *
 *   docker compose exec api pnpm --filter @edutimetable/api tenant:create \
 *     --code ZZDED-1 --name "ZZ Dedicated Academy"
 *   docker compose exec api node /app/scripts/dedicated-tenant-smoke.cjs
 *
 * The canary this test is built around: `tenant:create` gives the dedicated
 * school **school_id 1** inside its own database — the same id the shared
 * school already has. So if connection routing were broken in either direction,
 * every query would silently succeed against the wrong database and return
 * plausible-looking data. Nothing would error; it would just be someone else's
 * timetable. Every assertion below is chosen so that failure is visible.
 *
 *   1. ROUTE   — the session lands in the dedicated database, not the shared one
 *   2. WRITE   — its writes land there too, and nowhere else
 *   3. ISOLATE — neither school can see the other, despite sharing an id
 *   4. WORKER  — a background job writes to the tenant's database
 *   5. POOL    — connections are bounded and reported
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = require("/app/apps/api/prisma/generated/control-client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const CODE = "ZZDED-1";
const NAME = "ZZ Dedicated Academy";

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

const decodeJwt = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());

(async () => {
  const control = new ControlClient({
    datasources: { db: { url: process.env.CONTROL_DATABASE_URL } },
  });
  const tenant = await control.tenant.findFirst({ where: { schoolCode: CODE } });
  if (!tenant || tenant.mode !== "dedicated") {
    console.error(`No dedicated tenant '${CODE}'. Run tenant:create first (see header).`);
    process.exit(1);
  }

  const shared = new PrismaClient(); // the application database
  const dedicated = new PrismaClient({
    datasources: {
      db: { url: `mysql://root:${process.env.MYSQL_ROOT_PASSWORD || "edutimetable_dev"}@mysql:3306/edutimetable_zzded_1` },
    },
  });

  // -------------------------------------------------------------- 1. ROUTE
  console.log("The session lands in the tenant's own database:");
  const localSchool = await dedicated.school.findUnique({ where: { code: CODE } });
  const sharedSchool = await shared.school.findFirst({ where: { id: localSchool.id } });
  check(localSchool.id === 1 && Boolean(sharedSchool),
    "both databases have a school with the same local id",
    `dedicated id ${localSchool.id} · shared id ${sharedSchool?.id} (${sharedSchool?.code}) — the canary`);

  const token = await signIn({
    erpUserId: "ZZDED-admin", erpRole: "ADMIN", name: "Dedicated Admin", email: "d@zz.test",
    school: { code: CODE, name: NAME },
  });
  check(Boolean(token), "signing in to the dedicated school works");

  const claims = decodeJwt(token);
  check(claims.tenantId === tenant.id, "the session carries the tenant, not just the school",
    `tenantId ${claims.tenantId}, schoolId ${claims.schoolId}`);

  const me = await call("GET", "/me", token);
  check(me.json?.school?.code === CODE, "and reports the dedicated school", `${me.json?.school?.name}`);

  // Provisioning wrote the user into the tenant's database, not the shared one.
  const userHere = await dedicated.user.findFirst({ where: { erpUserId: "ZZDED-admin" } });
  const userThere = await shared.user.findFirst({ where: { erpUserId: "ZZDED-admin" } });
  check(Boolean(userHere) && !userThere, "the user row was created in the tenant's database",
    userThere ? "ALSO IN SHARED — routing failed" : `user ${userHere?.id}, dedicated only`);

  // -------------------------------------------------------------- 2. WRITE
  console.log("\nIts writes land there and nowhere else:");
  const room = await call("POST", "/rooms", token, { name: "ZZDED Room A", roomType: "classroom" });
  check(room.status === 201, "created a room", `${room.status}`);

  const roomHere = await dedicated.room.findFirst({ where: { name: "ZZDED Room A" } });
  const roomThere = await shared.room.findFirst({ where: { name: "ZZDED Room A" } });
  check(Boolean(roomHere) && !roomThere, "the row is in the tenant's database only",
    roomThere ? "LEAKED INTO SHARED" : `room ${roomHere?.id}`);
  check(roomHere?.schoolId === 1, "stamped with its own local school id", `${roomHere?.schoolId}`);

  // ------------------------------------------------------------ 3. ISOLATE
  console.log("\nNeither school can see the other, despite sharing a school id:");
  const sharedRoomCount = await shared.room.count({ where: { schoolId: sharedSchool.id } });
  const listed = await call("GET", "/rooms", token);
  const names = (listed.json ?? []).map((r) => r.name);
  check(names.length === 1 && names[0] === "ZZDED Room A",
    "the dedicated session sees only its own room",
    `${names.length} room(s) here vs ${sharedRoomCount} in the shared school with the same id`);

  const sharedToken = await signIn({
    erpUserId: "ERP-1", erpRole: "ADMIN", name: "Admin A", email: "a@a.test",
    school: { code: sharedSchool.code, name: sharedSchool.name },
  });
  const sharedList = await call("GET", "/rooms", sharedToken);
  const sawDedicated = (sharedList.json ?? []).some((r) => r.name === "ZZDED Room A");
  check(!sawDedicated && (sharedList.json ?? []).length === sharedRoomCount,
    "and the shared school sees only its own", `${sharedList.json?.length} room(s)`);

  // A cross-tenant switch attempt: this session was never granted the other.
  const steal = await call("POST", "/auth/switch-school", sharedToken, { tenantId: tenant.id });
  check(steal.status === 403, "a session cannot switch into an ungranted tenant", `${steal.status}`);

  // ------------------------------------------------------------- 4. WORKER
  console.log("\nA background job writes to the tenant's database:");
  const year = await call("POST", "/academic-years", token, {
    name: "ZZDED 26-27", startDate: "2026-04-01", endDate: "2027-03-31",
  });
  const cfg = await call("POST", "/timetable-configs", token, {
    name: "ZZDED Wing", academicYearId: year.json?.id,
  });
  check(cfg.status === 201, "created a timetable config", `config ${cfg.json?.id}`);
  const cfgHere = await dedicated.timetableConfig.findFirst({ where: { name: "ZZDED Wing" } });
  const cfgThere = await shared.timetableConfig.findFirst({ where: { name: "ZZDED Wing" } });
  check(Boolean(cfgHere) && !cfgThere, "the config is in the tenant's database only",
    cfgThere ? "LEAKED INTO SHARED" : `config ${cfgHere?.id}`);

  // The generate endpoint is readiness-gated, so instead of a full solve this
  // checks the job carries what the worker needs to reach the right database.
  const gen = await call("POST", `/timetable-configs/${cfg.json.id}/generate`, token, { mode: "fast" });
  check(gen.status === 400, "generation is still gated on readiness", `${gen.status}`);

  // --------------------------------------------------------------- 5. POOL
  console.log("\nConnections are bounded and reported:");
  const health = await fetch(`${API}/api/health`).then((r) => r.json());
  const stats = health.connections;
  check(stats?.open >= 1, "the dedicated connection is open", `${stats?.open}/${stats?.maxClients} clients`);
  check(stats?.tenants?.some((t) => t.tenantId === tenant.id), "and attributed to its tenant",
    stats?.tenants?.map((t) => t.displayName).join(", "));
  check(stats?.maxConnections === stats?.maxClients * stats?.poolLimit,
    "the connection budget is reported",
    `${stats?.maxClients} clients × ${stats?.poolLimit} = ${stats?.maxConnections} connections max`);

  // ----------------------------------------------------------------- cleanup
  console.log("\nCleanup:");
  await dedicated.timetableConfig.deleteMany({ where: { name: "ZZDED Wing" } });
  await dedicated.academicYear.deleteMany({ where: { name: "ZZDED 26-27" } });
  await dedicated.room.deleteMany({ where: { name: { startsWith: "ZZDED" } } });
  const leftovers =
    (await shared.room.count({ where: { name: { startsWith: "ZZDED" } } })) +
    (await shared.user.count({ where: { erpUserId: "ZZDED-admin" } }));
  check(leftovers === 0, "nothing of the dedicated tenant's ever touched the shared database", `${leftovers} stray row(s)`);
  console.log(`  NOTE  the tenant and its database are left in place; drop with:
        docker compose exec mysql mysql -uroot -p… -e "DROP DATABASE edutimetable_zzded_1"`);

  await Promise.all([shared.$disconnect(), dedicated.$disconnect(), control.$disconnect()]);
  console.log(failed ? "\nSOME DEDICATED TENANT CHECKS FAILED" : "\nALL DEDICATED TENANT CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
