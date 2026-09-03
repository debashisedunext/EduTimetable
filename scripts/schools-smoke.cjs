/**
 * Phase 25.1 (§15.3) — schools an account owns, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/schools-smoke.cjs
 *
 *   1. EMPTY     — a fresh account owns nothing, and is told so
 *   2. CREATE    — one call makes a school, its registry entry, its permission
 *                  registry and the creator's user row — and NEVER a database
 *   3. ENTER     — the account token becomes the ordinary session token
 *   4. ISOLATED  — two schools from ONE account still cannot see each other
 *   5. SWITCH    — a local session can move between its own schools
 *   6. MEMBER    — an invited account may sign in and may NOT create schools
 *   7. UNVERIFIED— an unconfirmed address cannot create anything
 *   8. CAP       — the per-account limit actually caps
 *   9. ORIGIN    — an ERP school's name cannot be edited here; a self-serve one can
 *
 * Everything it creates uses @zzsch.test / ZZSCH- and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzsch.test";
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
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

const mailToken = async (to, kind) =>
  (await call("GET", `/dev/mail/token?to=${encodeURIComponent(to)}&kind=${kind}`)).json?.token ?? null;

/** Register → verify → signed in, returning the account token. */
async function newAccount(email, name) {
  await call("POST", "/auth/register", null, { email, password: PW, name });
  const t = await mailToken(email, "verify");
  const r = await call("POST", "/auth/verify", null, { token: t });
  return r.json?.accountToken ?? null;
}

(async () => {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({ where: { code: { startsWith: "zz-" } }, select: { id: true, code: true } });
    const ids = mine.map((s) => s.id);
    if (ids.length) {
      // FK-safe order: a self-serve school can now carry a whole structure.
      await prisma.onboardingSession.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.period.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.classSubject.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.classSection.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.section.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.subject.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.schoolClass.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.timetableConfig.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.academicYear.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.user.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.rolePermission.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.erpRoleMapping.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.role.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.school.deleteMany({ where: { id: { in: ids } } });
    }
    await control.tenant.deleteMany({ where: { schoolCode: { in: mine.map((s) => s.code) } } });
    await control.account.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
    const keys = await redis.keys("throttle:*:ip:*");
    if (keys.length) await redis.del(...keys);
  };
  await purge();

  const ownerEmail = `owner@${DOMAIN}`;

  // ──────────────────────────────────────────────────────────── 1. EMPTY
  console.log("\nA fresh account owns nothing:");
  const owner = await newAccount(ownerEmail, "ZZ Owner");
  check(Boolean(owner), "registered and verified");
  const empty = await call("GET", "/schools", owner);
  check(empty.status === 200 && empty.json?.schools?.length === 0, "no schools yet",
    `${empty.json?.schools?.length} listed`);
  check(empty.json?.canCreate === true, "but it MAY create one — it registered itself, so it is an owner");

  // ─────────────────────────────────────────────────────────── 2. CREATE
  console.log("\nOne call sets up everything a school needs to be signed in to:");
  const made = await call("POST", "/schools", owner, { name: "ZZ Nalanda Vidyalaya", shortName: "ZZNV" });
  check(made.status < 300 && Number.isInteger(made.json?.schoolId), "the school was created",
    `school ${made.json?.schoolId}`);
  const schoolId = made.json.schoolId;
  const school = await prisma.school.findUnique({ where: { id: schoolId } });
  check(school.origin === "self_serve", "marked self_serve — which is what makes its name editable",
    school.origin);
  check(/^[a-z0-9-]+$/.test(school.code) && school.code === "zz-nalanda-vidyalaya",
    "with a code derived from the name, URL-safe and stable", school.code);

  const roles = await prisma.role.count({ where: { schoolId } });
  check(roles > 0, "the §15.2 permission registry was seeded — a school with no roles is one nobody can enter",
    `${roles} roles`);
  const superAdmin = await prisma.role.findFirst({ where: { schoolId, name: "Super Admin" } });
  const creator = await prisma.user.findFirst({ where: { schoolId, accountId: empty.json.account.id } });
  check(Boolean(creator) && creator.roleId === superAdmin.id,
    "and the creator is its Super Admin", creator?.erpUserId);
  check(creator.erpUserId === `local:${empty.json.account.id}`,
    "identified by a synthetic but stable id, so the unique key and every scope filter still work");

  const tenant = await control.tenant.findFirst({ where: { schoolCode: school.code } });
  check(Boolean(tenant), "it is registered in the control plane");
  check(tenant.mode === "shared",
    "as SHARED — a login may create a school, but never a database (§17.3)", tenant.mode);
  check(tenant.erpInstanceId !== null,
    "under a named self-serve installation, not a NULL one: MySQL allows many NULLs in a unique index, so a null instance would give self-serve schools no uniqueness at all");

  // ──────────────────────────────────────────────────────────── 3. ENTER
  console.log("\nThe account token becomes an ordinary school session:");
  const entered = await call("POST", `/schools/${schoolId}/enter`, owner);
  check(entered.status < 300 && Boolean(entered.json?.sessionToken), "entering returns a session token");
  const session = entered.json.sessionToken;
  const claims = JSON.parse(Buffer.from(session.split(".")[1], "base64url").toString());
  check(claims.typ === undefined && claims.schoolId === schoolId && Number.isInteger(claims.roleId),
    "which is the UNCHANGED SessionTokenPayload — no `typ`, and it carries school and role",
    `school ${claims.schoolId} role ${claims.roleId}`);
  const me = await call("GET", "/me", session);
  check(me.status === 200 && me.json?.role === "Super Admin", "and the ordinary app accepts it", me.json?.role);
  for (const p of ["/classes", "/subjects", "/timetable-configs"]) {
    const r = await call("GET", p, session);
    check(r.status === 200, `${p} answers`, `${r.status}`);
  }

  // ───────────────────────────────────────────────────────── 4. ISOLATED
  console.log("\nTwo schools owned by ONE person are still two schools:");
  const second = await call("POST", "/schools", owner, { name: "ZZ Sunrise Branch" });
  const secondId = second.json.schoolId;
  const s2 = (await call("POST", `/schools/${secondId}/enter`, owner)).json.sessionToken;
  await call("POST", "/subjects", session, { name: "ZZ Only In Nalanda" });
  const inSecond = await call("GET", "/subjects", s2);
  check(!JSON.stringify(inSecond.json ?? []).includes("ZZ Only In Nalanda"),
    "a subject added to one is invisible in the other — same owner, same database, still scoped");
  const crossRead = await call("GET", `/timetable-configs`, s2);
  check(crossRead.status === 200 && (crossRead.json ?? []).length === 0,
    "and the second school starts genuinely empty");

  // ─────────────────────────────────────────────────────────── 5. SWITCH
  console.log("\nA locally-created session can move between its own schools:");
  // The grant is whatever the SIGNED token carries, so `session` — minted when
  // only the first school existed — must NOT be able to reach the second. That
  // is the §17.4 rule, not a bug, and it is worth asserting before the happy
  // path so the happy path cannot pass by accident.
  const stale = await call("POST", "/auth/switch-school", session, { schoolId: secondId });
  check(stale.status === 403,
    "a session minted BEFORE the second school existed cannot reach it — the grant is the token's, not the database's",
    `${stale.status}`);

  const fresh = (await call("POST", `/schools/${schoolId}/enter`, owner)).json.sessionToken;
  const switched = await call("POST", "/auth/switch-school", fresh, { schoolId: secondId });
  check(switched.status < 300 && Boolean(switched.json?.sessionToken),
    "a session minted after both exist switches freely — no ERP token anywhere in the path",
    `${switched.status}`);
  if (switched.json?.sessionToken) {
    const sc = JSON.parse(Buffer.from(switched.json.sessionToken.split(".")[1], "base64url").toString());
    check(sc.schoolId === secondId, "and lands in the school asked for", `school ${sc.schoolId}`);
    check(sc.erpUserId?.startsWith("local:") && sc.erpRole === undefined,
      "carrying a local identity and no ERP role — because there is no ERP to have one from",
      sc.erpUserId);
  }
  const strangerSchool = await prisma.school.findFirst({ where: { origin: "erp" }, select: { id: true } });
  const denied = await call("POST", "/auth/switch-school", fresh, { schoolId: strangerSchool.id });
  check(denied.status === 403 || denied.status === 404,
    "but it cannot reach a school the token never granted", `${denied.status}`);

  // ─────────────────────────────────────────────────────────── 6. MEMBER
  console.log("\nAn invited account may sign in, and may never create schools:");
  const memberEmail = `teacher@${DOMAIN}`;
  const memberToken = await newAccount(memberEmail, "ZZ Teacher");
  // 25.6 mints members through an invitation; here the kind is set directly so
  // the refusal can be proved before that flow exists.
  await control.account.update({ where: { email: memberEmail }, data: { kind: "member" } });
  const memberLogin = await call("POST", "/auth/login", null, { email: memberEmail, password: PW });
  check(memberLogin.status < 300, "a member signs in perfectly well", `${memberLogin.status}`);
  const memberList = await call("GET", "/schools", memberLogin.json.accountToken);
  check(memberList.json?.canCreate === false, "the screen is told not to offer the tile");
  const memberCreate = await call("POST", "/schools", memberLogin.json.accountToken, { name: "ZZ Sneaky School" });
  check(memberCreate.status === 403,
    "and the SERVER refuses anyway — hiding a tile is cosmetic (§15)", `${memberCreate.status}`);
  check((await prisma.school.count({ where: { name: "ZZ Sneaky School" } })) === 0, "nothing was created");
  void memberToken;

  // ──────────────────────────────────── 6b. THE DOOR BACK TO MY SCHOOLS
  //
  // The school name in the top bar leads here. The two credentials expire
  // independently, so somebody eight hours into a session would otherwise be
  // bounced to a login form while holding a perfectly good one — losing the
  // school they were in to reach the screen that lists it.
  console.log("\nSomebody inside a school can get back to the list:");
  const exchanged = await call("POST", "/auth/account/token", session);
  check(exchanged.status < 300 && Boolean(exchanged.json?.accountToken),
    "a session buys an account token for the same person", `${exchanged.status}`);
  const viaExchange = await call("GET", "/schools", exchanged.json?.accountToken);
  check(viaExchange.status < 300,
    "and it opens the school list — the same schools, no new authority",
    `${(viaExchange.json?.schools ?? []).length} school(s)`);

  // ────────────────────────────────────────────────────── 7. UNVERIFIED
  //
  // The rule changed, and the test pins the new BOUNDARY rather than one side
  // of it. Verification used to block sign-in and every school; a new customer
  // filled in the form and was sent to their inbox before seeing anything at
  // all. Now it blocks the SECOND school — which keeps what the gate was for
  // (an unverified address must not be able to fill the registry with rows
  // nobody can reach) while letting somebody start on the one they signed up
  // to build.
  console.log("\nAn unconfirmed address gets one school, and no more:");
  const pendingEmail = `pending@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email: pendingEmail, password: PW, name: "ZZ Pending" });
  const pendingLogin = await call("POST", "/auth/login", null, { email: pendingEmail, password: PW });
  check(pendingLogin.status < 300,
    "an unconfirmed account can sign in — the inbox is no longer in the way",
    `${pendingLogin.status}`);

  const firstUnverified = await call("POST", "/schools", pendingLogin.json.accountToken, { name: "ZZ Unverified School" });
  check(firstUnverified.status < 300, "and can create its FIRST school", `${firstUnverified.status}`);

  const secondUnverified = await call("POST", "/schools", pendingLogin.json.accountToken, { name: "ZZ Unverified Second" });
  check(secondUnverified.status === 403, "but not a second one", `${secondUnverified.status}`);
  check(/confirm your email/i.test(secondUnverified.json?.message ?? ""),
    "with the reason and the fix", secondUnverified.json?.message?.slice(0, 60));
  check((await prisma.school.count({ where: { name: "ZZ Unverified Second" } })) === 0, "and it was not created");

  // The reminder has to be visible, or an address nobody confirms is one
  // nothing can ever be sent to.
  const pendingList = await call("GET", "/schools", pendingLogin.json.accountToken);
  check(pendingList.json?.account?.emailVerified === false,
    "and the school list SAYS the address is unconfirmed, so the screen can ask");

  // ────────────────────────────────────────────────────────────── 8. CAP
  console.log("\nThe per-account limit is real:");
  const cap = empty.json.cap;
  for (let i = (await call("GET", "/schools", owner)).json.schools.length; i < cap; i++) {
    await call("POST", "/schools", owner, { name: `ZZ Filler ${i}` });
  }
  const atCap = await call("GET", "/schools", owner);
  check(atCap.json.schools.length === cap, `the account now holds its ${cap}`, `${atCap.json.schools.length}`);
  check(atCap.json.remaining === 0, "and reports nothing remaining");
  const overCap = await call("POST", "/schools", owner, { name: "ZZ One Too Many" });
  check(overCap.status === 403, "one more is refused", `${overCap.status}`);
  check((await prisma.school.count({ where: { name: "ZZ One Too Many" } })) === 0, "and not created");

  // ─────────────────────────────────────────────────────────── 9. ORIGIN
  console.log("\nWho may rename a school depends on where its name came from:");
  const rename = await call("PUT", "/school", session, { name: "ZZ Nalanda Renamed" });
  check(rename.status < 300, "a SELF-SERVE school renames freely", `${rename.status}`);
  check((await prisma.school.findUnique({ where: { id: schoolId } })).name === "ZZ Nalanda Renamed",
    "and it stuck");
  const registryName = (await control.tenant.findFirst({ where: { schoolCode: school.code } })).displayName;
  check(registryName === "ZZ Nalanda Renamed",
    "the control-plane registry followed it, so the Platform Console cannot disagree with the app",
    registryName);

  // An ERP school, by contrast, is named by the ERP and refreshed every login.
  const erpSession = await (async () => {
    const t = await call("POST", "/dev/erp-token", null, {
      erpUserId: "ZZSCH-1", erpRole: "ADMIN", name: "ZZ ERP Admin", email: `erp@${DOMAIN}`,
      school: { code: "SEED-001", name: "Seed" },
    });
    const cb = await fetch(`${API}/api/sso/callback?token=${t.json.token}`, { redirect: "manual" });
    return (cb.headers.get("location") || "").split("#token=")[1];
  })();
  const erpMe = await call("GET", "/school", erpSession);
  check(erpMe.json?.origin === "erp", "an SSO-provisioned school is marked erp", erpMe.json?.origin);
  check(erpMe.json?.erpNameSyncedAt !== null,
    "and records that the ERP actually named it — which is what makes the refusal below true rather than approximate");
  const beforeName = erpMe.json.name;
  const erpRename = await call("PUT", "/school", erpSession, { name: "ZZ Renamed By Hand" });
  check(erpRename.status === 400,
    "renaming it here is REFUSED — the ERP overwrites the name on every login, so an edit would silently revert",
    `${erpRename.status}`);
  check(/comes from your ERP/i.test(erpRename.json?.message ?? ""),
    "and it says where to do it instead", erpRename.json?.message?.slice(0, 46));
  const afterName = (await call("GET", "/school", erpSession)).json.name;
  check(afterName === beforeName, "the name is untouched", afterName);
  // ...while its descriptive fields, which SSO only overwrites when sent, stay editable.
  const erpTz = await call("PUT", "/school", erpSession, { timezone: "Asia/Dubai" });
  check(erpTz.status < 300, "but its timezone and branding remain editable", `${erpTz.status}`);
  await call("PUT", "/school", erpSession, { timezone: "Asia/Kolkata" });

  // ─────────────────────────────────────────────────────────────── cleanup
  console.log("\nCleanup:");
  // Only rows THIS run created.
  //
  // This used to delete every `origin: self_serve` school, which is a rule
  // about a category rather than about ownership — it would happily remove a
  // real customer's school, and it broke the moment anything else on the box
  // had one. An id is not proof of ownership; the `zz-` code this suite mints
  // is. Same rule the 9.10 sweep states in its own header.
  await purge();
  check((await prisma.school.count({ where: { code: { startsWith: "zz-" } } })) === 0, "test schools removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
  console.log(failed ? "\nSOME SCHOOL CHECKS FAILED" : "\nALL SCHOOL CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
