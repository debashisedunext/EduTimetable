/**
 * Phase 9.5 / 9.6 (§17.4) — the ERP owns school identity, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/sso-schools-smoke.cjs
 *
 * The requirement this proves: a school's name is never hardcoded and never
 * invented by the application. It arrives on the SSO token, is refreshed on
 * every login, and a trust administrator can move between their schools inside
 * the app — creating a timetable in whichever one they choose.
 *
 *   1. NAME    — a school named on the token is created with that name.
 *   2. RENAME  — the same code with a new name renames it; nothing duplicates.
 *   3. TRUST   — a trust token provisions every school it lists, seeded well
 *                enough that its users can actually sign in.
 *   4. SWITCH  — the user moves between them and lands in the right one, with
 *                the role that school gives them.
 *   5. REFUSE  — a school the ERP did not grant is refused, whatever is asked.
 *   6. CREATE  — a timetable created after switching belongs to the new school.
 *
 * Everything it creates is prefixed ZZSSO and removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = require("/app/apps/api/prisma/generated/control-client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const P = "ZZSSO";
const CODES = [`${P}-A`, `${P}-B`, `${P}-C`];
const TRUST = { code: `${P}-TRUST`, name: `${P} Education Trust` };

let failed = 0;
const check = (ok, l, x = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${x ? ` — ${x}` : ""}`);
  if (!ok) failed = 1;
};

/** Walk the real /sso/callback flow with whatever claims the ERP would send. */
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
  const control = process.env.CONTROL_DATABASE_URL
    ? new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } })
    : null;

  // ------------------------------------------------------- 1. NAME from ERP
  console.log("A school is named by the ERP, not by the application:");
  const first = await signIn({
    erpUserId: `${P}-admin`, erpRole: "ADMIN", name: "Trust Admin", email: "ta@zz.test",
    school: { code: CODES[0], name: `${P} Original Name` },
  });
  check(Boolean(first.token), "signing in with a brand-new school works", first.location.split("/").pop()?.slice(0, 20));

  const created = await prisma.school.findUnique({ where: { code: CODES[0] } });
  check(created?.name === `${P} Original Name`, "the school was created with the ERP's name", created?.name);

  const me1 = await call("GET", "/me", first.token);
  check(me1.json?.school?.name === `${P} Original Name`, "and the session reports it", me1.json?.school?.name);

  // It must be usable immediately: roles and the ERP role mapping are seeded.
  check(me1.json?.role === "Super Admin", "a new school is seeded well enough to use", me1.json?.role);
  const perms = await prisma.rolePermission.count({ where: { schoolId: created.id } });
  check(perms > 0, "its permission registry is populated", `${perms} permission rows`);

  // ---------------------------------------------------------- 2. RENAME
  console.log("\nRenaming it in the ERP renames it here, on the next login:");
  const renamed = await signIn({
    erpUserId: `${P}-admin`, erpRole: "ADMIN", name: "Trust Admin", email: "ta@zz.test",
    school: { code: CODES[0], name: `${P} Renamed By ERP` },
  });
  const afterRename = await prisma.school.findUnique({ where: { code: CODES[0] } });
  check(afterRename?.name === `${P} Renamed By ERP`, "the name follows the ERP", afterRename?.name);
  check(afterRename?.id === created.id, "and it is the same school, not a second one", `id ${afterRename?.id}`);
  const total = await prisma.school.count({ where: { code: { startsWith: P } } });
  check(total === 1, "no duplicate school was created", `${total} school(s)`);

  const me2 = await call("GET", "/me", renamed.token);
  check(me2.json?.school?.name === `${P} Renamed By ERP`, "the session reports the new name", me2.json?.school?.name);

  // ------------------------------------------------------------- 3. TRUST
  console.log("\nA trust token provisions every school it lists:");
  const trustSignIn = await signIn({
    erpUserId: `${P}-admin`, erpRole: "ADMIN", name: "Trust Admin", email: "ta@zz.test",
    school: { code: CODES[0], name: `${P} Renamed By ERP` },
    trust: TRUST,
    schools: [
      { code: CODES[0], name: `${P} Renamed By ERP` },
      { code: CODES[1], name: `${P} Second Branch` },
      { code: CODES[2], name: `${P} Third Branch` },
    ],
  });
  const all = await prisma.school.findMany({ where: { code: { startsWith: P } }, orderBy: { code: "asc" } });
  check(all.length === 3, "all three schools exist", all.map((s) => s.name).join(", "));
  check(all.every((s) => s.trustName === TRUST.name), "each carries the trust", TRUST.name);

  const me3 = await call("GET", "/me", trustSignIn.token);
  check(me3.json?.schools?.length === 3, "the session offers all three to switch between", `${me3.json?.schools?.length}`);
  check(me3.json?.trust?.name === TRUST.name, "and names the trust", me3.json?.trust?.name);
  check(me3.json?.school?.code === CODES[0], "the active school is the one the token opened in", me3.json?.school?.code);

  if (control) {
    const registered = await control.tenant.findMany({ where: { schoolCode: { startsWith: P } } });
    check(registered.length === 3, "all three are registered as tenants", `${registered.length}`);
    const trustRow = await control.trust.findFirst({ where: { code: TRUST.code } });
    check(Boolean(trustRow) && registered.every((t) => t.trustId === trustRow.id),
      "and grouped under the trust", trustRow?.name);
  }

  // ------------------------------------------------------------ 4. SWITCH
  console.log("\nThe user moves between their schools inside the app:");
  const target = all.find((s) => s.code === CODES[1]);
  const switched = await call("POST", "/auth/switch-school", trustSignIn.token, { schoolId: target.id });
  check(switched.status === 201 || switched.status === 200, "switch-school issues a new session", `${switched.status}`);

  const me4 = await call("GET", "/me", switched.json?.sessionToken);
  check(me4.json?.school?.id === target.id, "the session is now in the other school", me4.json?.school?.name);
  check(me4.json?.schools?.length === 3, "and can still reach the others", `${me4.json?.schools?.length}`);

  // Scoping follows the switch: the new school has none of the first's data.
  const roomsHere = await call("GET", "/rooms", switched.json?.sessionToken);
  check(Array.isArray(roomsHere.json) && roomsHere.json.length === 0,
    "it sees the new school's data, not the old school's", `${roomsHere.json?.length} room(s)`);

  // ------------------------------------------------------------ 5. REFUSE
  console.log("\nA school the ERP did not grant is refused:");
  const outsider = await prisma.school.findFirst({ where: { code: { not: { startsWith: P } } } });
  const refused = await call("POST", "/auth/switch-school", switched.json?.sessionToken, { schoolId: outsider.id });
  check(refused.status === 403, "switching to an ungranted school", `${refused.status}`);

  const teacherIn = await signIn({
    erpUserId: `${P}-teacher`, erpRole: "TEACHER", name: "A Teacher", email: "t@zz.test",
    school: { code: CODES[0], name: `${P} Renamed By ERP` },
  });
  const teacherSwitch = await call("POST", "/auth/switch-school", teacherIn.token, { schoolId: target.id });
  check(teacherSwitch.status === 403, "a single-school user cannot switch at all", `${teacherSwitch.status}`);

  // ------------------------------------------------------------ 6. CREATE
  console.log("\nA timetable created after switching belongs to the new school:");
  const year = await call("POST", "/academic-years", switched.json?.sessionToken, {
    name: `${P} 26-27`, startDate: "2026-04-01", endDate: "2027-03-31",
  });
  const cfg = await call("POST", "/timetable-configs", switched.json?.sessionToken, {
    name: `${P} Wing`, academicYearId: year.json?.id,
  });
  check(cfg.status === 201 && cfg.json?.schoolId === target.id,
    "created in the switched-to school", `schoolId ${cfg.json?.schoolId} (${target.name})`);

  const visibleToFirst = await call("GET", "/timetable-configs", trustSignIn.token);
  const leaked = (visibleToFirst.json ?? []).some((c) => c.id === cfg.json?.id);
  check(!leaked, "and is invisible from the other school's session", leaked ? "LEAKED" : "not listed");

  // ----------------------------------------------------------------- cleanup
  console.log("\nCleanup:");
  const ids = all.map((s) => s.id);
  await prisma.timetableConfig.deleteMany({ where: { schoolId: { in: ids } } });
  await prisma.academicYear.deleteMany({ where: { schoolId: { in: ids } } });
  await prisma.notification.deleteMany({ where: { schoolId: { in: ids } } });
  await prisma.user.deleteMany({ where: { schoolId: { in: ids } } });
  await prisma.erpRoleMapping.deleteMany({ where: { schoolId: { in: ids } } });
  await prisma.rolePermission.deleteMany({ where: { schoolId: { in: ids } } });
  await prisma.role.deleteMany({ where: { schoolId: { in: ids } } });
  await prisma.school.deleteMany({ where: { id: { in: ids } } });
  if (control) {
    await control.tenant.deleteMany({ where: { schoolCode: { startsWith: P } } });
    await control.trust.deleteMany({ where: { code: TRUST.code } });
    await control.$disconnect();
  }
  const left = await prisma.school.count({ where: { code: { startsWith: P } } });
  check(left === 0, "test schools removed", `${left} left`);

  await prisma.$disconnect();
  console.log(failed ? "\nSOME SSO SCHOOL CHECKS FAILED" : "\nALL SSO SCHOOL CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
