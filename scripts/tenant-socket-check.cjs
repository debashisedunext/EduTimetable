/**
 * Phase 9.1 (§17) — Socket.IO events stay inside their school.
 *
 *   docker compose exec api node /app/scripts/tenant-socket-check.cjs
 *
 * Before 9.1 the events gateway used `server.emit(...)`, so solver progress,
 * solver completion (including the full job summary), failure reasons and
 * readiness invalidations went to **every connected client in the deployment**.
 * This connects one client per school and makes School A act, then asserts that
 * A's socket saw the events and B's socket saw nothing at all.
 *
 * socket.io-client lives in the web workspace and the Prisma engine only in
 * the api image, so this runs in `api` and resolves each dependency from the
 * workspace that owns it.
 */
const { createRequire } = require("node:module");
const { io } = createRequire("/app/apps/web/package.json")("socket.io-client");
const { PrismaClient } = createRequire("/app/apps/api/package.json")("@prisma/client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const SCHOOL_A = 1;
const SCHOOL_B = 99003;
const P = "ZZSOCK";

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

/** Connect and record every event this socket is sent. */
function listener(token) {
  const socket = io(API, { auth: { token }, transports: ["websocket"] });
  const seen = [];
  socket.onAny((event, payload) => seen.push({ event, payload }));
  return new Promise((resolve, reject) => {
    socket.on("connect", () => resolve({ socket, seen }));
    socket.on("connect_error", reject);
    setTimeout(() => reject(new Error("socket did not connect")), 8000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const prisma = new PrismaClient();

  // A second school, just enough of it to hold a session.
  // 9.2: school_id now has a real foreign key, so School B has to exist as a
  // row before anything can belong to it.
  await prisma.school.upsert({
    where: { id: SCHOOL_B },
    create: { id: SCHOOL_B, code: `${P}-SCHOOL-B`, name: `${P} Test School B` },
    update: {},
  });
  const roleB = await prisma.role.upsert({
    where: { schoolId_name: { schoolId: SCHOOL_B, name: "Super Admin" } },
    create: { schoolId: SCHOOL_B, name: "Super Admin", isSystem: true },
    update: {},
  });
  const permsA = await prisma.rolePermission.findMany({
    where: { role: { schoolId: SCHOOL_A, name: "Super Admin" } }, select: { permission: true },
  });
  await prisma.rolePermission.createMany({
    data: permsA.map((p) => ({ roleId: roleB.id, permission: p.permission, schoolId: SCHOOL_B })),
    skipDuplicates: true,
  });
  await prisma.erpRoleMapping.upsert({
    where: { schoolId_erpRole: { schoolId: SCHOOL_B, erpRole: "ADMIN" } },
    create: { schoolId: SCHOOL_B, erpRole: "ADMIN", roleId: roleB.id },
    update: {},
  });

  const tokenA = await sessionFor({ erpUserId: "ERP-1", erpRole: "ADMIN", name: "Admin A", email: "a@a.test" });
  const tokenB = await sessionFor({ erpUserId: `${P}-B`, erpRole: "ADMIN", name: "Admin B", email: "b@b.test", schoolId: SCHOOL_B });

  const a = await listener(tokenA);
  const b = await listener(tokenB);
  check(true, "both schools have a live socket");

  // ---- 1. readiness invalidation (fires on any master-data write) ----
  const roomA = await fetch(`${API}/api/rooms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `${P} Room ${Date.now()}`, roomType: "classroom" }),
  }).then((r) => r.json());
  await sleep(1200);

  const aSaw = a.seen.filter((e) => e.event === "readiness:invalidated");
  const bSaw = b.seen.filter((e) => e.event === "readiness:invalidated");
  check(aSaw.length > 0, "A's own edit reached A's socket", `${aSaw.length} event(s)`);
  check(bSaw.length === 0, "B's socket received none of it", `${bSaw.length} event(s)`);

  // ---- 2. the demo queue: progress + completion over BullMQ ----
  b.seen.length = 0;
  a.seen.length = 0;
  const job = await fetch(`${API}/api/demo-jobs`, {
    method: "POST", headers: { Authorization: `Bearer ${tokenA}` },
  }).then((r) => r.json());
  // the demo job is 20 steps at 150ms
  await sleep(5000);

  const aJob = a.seen.filter((e) => e.event.startsWith("demo:"));
  const bJob = b.seen.filter((e) => e.event.startsWith("demo:"));
  check(aJob.length > 0, "A saw its own job's progress", `job ${job.jobId}, ${aJob.length} event(s)`);
  check(bJob.length === 0, "B saw nothing of A's job", `${bJob.length} event(s)`);

  // Nothing at all crossed, whatever the event name.
  const anyCross = b.seen.filter((e) => !e.event.startsWith("notification:"));
  check(anyCross.length === 0, "B's socket saw no cross-school event of any kind",
    anyCross.map((e) => e.event).join(", ") || "silent");

  // ---------------------------------------------------------------- cleanup
  a.socket.close();
  b.socket.close();
  await fetch(`${API}/api/rooms/${roomA.id}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${tokenA}` },
  });
  await prisma.notification.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.user.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.erpRoleMapping.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.rolePermission.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.role.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.school.deleteMany({ where: { id: SCHOOL_B } });
  await prisma.$disconnect();

  console.log(failed ? "\nSOME SOCKET ISOLATION CHECKS FAILED" : "\nALL SOCKET ISOLATION CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
