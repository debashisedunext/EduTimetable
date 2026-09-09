/**
 * §24.8 Phase 25.6 — users and teacher logins, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/users-smoke.cjs
 *
 * The phase's claim is small and easy to get wrong: **an admin can create a
 * teacher's login, and that teacher can look and do nothing else.** So the
 * assertions that matter are the negatives — a teacher who can reach a write
 * endpoint, or another teacher's grid, is the whole feature failing quietly.
 *
 *   1. INVITE     — an admin invites a teacher; a login exists but cannot be used
 *   2. ACCEPT     — the emailed link sets a password, once and only once
 *   3. ENTER      — the teacher signs in and lands in the one school they are in
 *   4. SEE        — their own timetable, and their linked class-section's
 *   5. NOT TOUCH  — every write endpoint refused by the SERVER, with a 403
 *   6. NOT CREATE — POST /schools refused: only an admin creates a school
 *   7. BULK       — the teacher master, minus guests, minus the emailless
 *   8. REVOKE     — deactivate closes the door, and never deletes the row
 *   9. ERP        — a school whose origin is `erp` refuses all of it
 *
 * Everything it creates uses @zzus.test / "ZZUS " and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzus.test";
const PW = "correct horse battery staple";
const TEACHER_PW = "another perfectly fine passphrase";

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

(async () => {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZUS " } }, select: { id: true, code: true },
    });
    const ids = mine.map((s) => s.id);
    for (const m of [
      "onboardingSession", "aiChatLog", "timetableSlot", "timetableDraft", "timetablePublication",
      "teacherSubjectClassSection", "teacherClassEligibility", "roomSubject", "period",
      "classSubject", "classSection", "section", "subject", "schoolClass", "teacher",
      "room", "timetableConfig", "academicYear", "auditLog", "user", "rolePermission",
      "erpRoleMapping", "role",
    ]) {
      if (ids.length) await prisma[m].deleteMany({ where: { schoolId: { in: ids } } }).catch(() => undefined);
    }
    if (ids.length) await prisma.school.deleteMany({ where: { id: { in: ids } } });
    await control.tenant.deleteMany({ where: { schoolCode: { in: mine.map((s) => s.code) } } });
    await control.account.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
    const keys = await redis.keys("throttle:*:ip:*");
    if (keys.length) await redis.del(...keys);
  };
  await purge();

  // ────────────────────────────────────────── an admin, a school, a teacher
  console.log("\nAn admin with a school and one teacher on the master:");
  const adminEmail = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email: adminEmail, password: PW, name: "ZZUS Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(adminEmail, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZUS High School" });
  check(made.status < 300, "school created", `school ${made.json?.schoolId}`);
  const A = made.json.sessionToken;
  const schoolId = made.json.schoolId;

  // A minimal school: one year, one class, one section, one teacher.
  const year = await call("POST", "/academic-years", A, {
    name: "ZZUS 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  });
  const cls = await call("POST", "/classes", A, { name: "ZZUS Class 6", sequence: 6 });
  // `POST /classes/:id/sections` returns { section, classSection } — the
  // class-section is the row that carries the class teacher, and the one
  // §15's `.class` scope resolves.
  const made2 = await call("POST", `/classes/${cls.json.id}/sections`, A, {
    name: "A", academicYearId: year.json.id,
  });
  const classSectionId = made2.json?.classSection?.id;
  const teacherEmail = `rekha@${DOMAIN}`;
  const teacher = await call("POST", "/teachers", A, {
    employeeCode: "ZZUS-T001", name: "ZZUS Rekha Devi", email: teacherEmail, isActive: true,
  });
  const guest = await call("POST", "/teachers", A, {
    employeeCode: "ZZUS-T002", name: "ZZUS Guest Coach", email: `guest@${DOMAIN}`,
    employmentType: "guest", isActive: true,
  });
  const noEmail = await call("POST", "/teachers", A, {
    employeeCode: "ZZUS-T003", name: "ZZUS No Address", isActive: true,
  });
  check(teacher.status < 300 && guest.status < 300 && noEmail.status < 300,
    "three teachers on the master", `${teacher.status}/${guest.status}/${noEmail.status}`);

  // The teacher is the class teacher of the one section, so §15's `.class`
  // scope has something to resolve.
  const linked = await call("PUT", `/class-sections/${classSectionId}`, A, {
    classTeacherId: teacher.json.id,
  });
  check(linked.status < 300, "the teacher is class teacher of that section, so `.class` scope resolves",
    `${linked.status}`);

  // ─────────────────────────────────────────────────── 1. INVITE
  console.log("\nThe admin creates a login for that teacher:");
  const roles = (await call("GET", "/admin/overview", A)).json?.roles ?? [];
  const teacherRole = roles.find((r) => r.name === "Teacher");
  check(Boolean(teacherRole), "the school has a view-only Teacher role");

  const invited = await call("POST", "/users/invite", A, {
    email: teacherEmail, name: "ZZUS Rekha Devi", roleId: teacherRole.id, teacherId: teacher.json.id,
  });
  check(invited.status < 300, "invitation sent", invited.text.slice(0, 90));

  const listed = (await call("GET", "/users", A)).json ?? [];
  const row = listed.find((u) => u.email === teacherEmail);
  check(row?.state === "invited",
    "and the list SAYS it has not been accepted — 'invited' does not look like 'active'",
    row?.state);
  check(row?.teacher?.id === teacher.json.id, "with the teacher link that makes 'my timetable' theirs");

  const before = await call("POST", "/auth/login", null, { email: teacherEmail, password: TEACHER_PW });
  check(before.status >= 400, "the login does not work before it is accepted", `${before.status}`);

  // Inviting the same person twice is refused BEFORE a second email goes out.
  const twice = await call("POST", "/users/invite", A, {
    email: teacherEmail, name: "ZZUS Rekha Devi", roleId: teacherRole.id,
  });
  check(twice.status >= 400, "and a second invitation to the same person is refused",
    twice.json?.message?.slice(0, 70));

  // ─────────────────────────────────────────────────── 2. ACCEPT
  console.log("\nThe teacher accepts:");
  const inviteToken = await mailToken(teacherEmail, "invite");
  check(Boolean(inviteToken), "an invitation link was emailed");

  const preview = await call("GET", `/auth/invite/${inviteToken}`);
  check(preview.json?.valid === true && preview.json?.needsPassword === true,
    "the link can be LOOKED at without being spent — a mail scanner must not burn it",
    `valid=${preview.json?.valid}`);
  const stillThere = await call("GET", `/auth/invite/${inviteToken}`);
  check(stillThere.json?.valid === true, "…twice, because looking is not accepting");

  const accepted = await call("POST", "/auth/invite/accept", null, {
    token: inviteToken, password: TEACHER_PW,
  });
  check(accepted.status < 300 && Boolean(accepted.json?.accountToken), "accepted, with a password",
    `${accepted.status}`);

  const replay = await call("POST", "/auth/invite/accept", null, {
    token: inviteToken, password: "a completely different passphrase",
  });
  check(replay.status >= 400, "and the link is DEAD on second use", `${replay.status}`);

  // ─────────────────────────────────────────────────── 3. ENTER
  console.log("\nThe teacher signs in:");
  const signedIn = await call("POST", "/auth/login", null, { email: teacherEmail, password: TEACHER_PW });
  check(signedIn.status < 300, "sign-in works with the password they chose", `${signedIn.status}`);
  const teacherAcct = signedIn.json.accountToken;

  const schools = await call("GET", "/schools", teacherAcct);
  check((schools.json?.schools ?? []).length === 1,
    "and their school list holds the ONE school they were invited into — they created none",
    `${(schools.json?.schools ?? []).length} school(s)`);
  check(schools.json?.canCreate === false, "…and offers them no way to create one");

  const entered = await call("POST", `/schools/${schoolId}/enter`, teacherAcct);
  check(entered.status < 300, "they can enter it", `${entered.status}`);
  const T = entered.json.sessionToken;

  // ─────────────────────────────────────────────────── 4. SEE
  console.log("\nWhat they can see:");
  const me = await call("GET", "/me", T);
  check(me.json?.teacherId === teacher.json.id,
    "the session knows which teacher they are — this is what scopes every query",
    `teacherId ${me.json?.teacherId}`);
  const perms = me.json?.permissions ?? [];
  check(perms.includes("timetable.view.own") && !perms.includes("timetable.edit"),
    "view-own, and nothing that edits", perms.join(","));

  const own = await call("GET", `/reports/teacher/${teacher.json.id}`, T);
  check(own.status < 400, "their OWN timetable is theirs to read", `${own.status}`);

  // The negative that matters more than the positive: `.view.own` plus
  // `.view.class` must not become "everybody's".
  const someoneElse = await call("GET", `/reports/teacher/${guest.json.id}`, T);
  check(someoneElse.status >= 400,
    "another teacher's timetable is NOT — view.own is a row filter, not a label",
    `${someoneElse.status}`);

  // ─────────────────────────────────────────────────── 5. NOT TOUCH
  console.log("\nWhat the SERVER refuses them (hiding a button is cosmetic):");
  const writes = [
    ["POST", "/classes", { name: "ZZUS Sneaky", sequence: 9 }],
    ["POST", "/teachers", { employeeCode: "ZZUS-X", name: "ZZUS Sneaky" }],
    ["POST", "/admin/roles", { name: "ZZUS Sneaky" }],
    ["PUT", "/admin/users/1", { roleId: 1 }],
    ["POST", "/users/invite", { email: `x@${DOMAIN}`, name: "X", roleId: teacherRole.id }],
    ["PUT", `/class-sections/${classSectionId}`, { strength: 99 }],
    ["POST", "/onboarding/commit/2", null],
  ];
  for (const [method, path, body] of writes) {
    const r = await call(method, path, T, body);
    check(r.status === 403, `${method} ${path} → 403`, `${r.status}`);
  }

  // ─────────────────────────────────────────────────── 6. NOT CREATE
  const theirSchool = await call("POST", "/schools", teacherAcct, { name: "ZZUS Their Own" });
  check(theirSchool.status === 403,
    "and an invited account cannot create a school of its own — only an admin creates a school",
    `${theirSchool.status}: ${theirSchool.json?.message?.slice(0, 60)}`);

  // ─────────────────────────────────────────────────── 7. BULK
  console.log("\nInviting the rest of the staff:");
  const preview2 = await call("POST", "/users/invite-teachers", A, { dryRun: true });
  const p = preview2.json ?? {};
  check((p.wouldInvite ?? []).length === 0,
    "nobody is proposed twice — the one teacher with a login is skipped",
    `would invite: ${(p.wouldInvite ?? []).join(", ") || "nobody"}`);
  check((p.guestTeachers ?? []).includes("ZZUS Guest Coach"),
    "a guest teacher is EXCLUDED and named — §18 keeps them off the regular timetable",
    (p.guestTeachers ?? []).join(", "));
  check((p.noEmailAddress ?? []).includes("ZZUS No Address"),
    "a teacher with no email is REPORTED, not silently dropped from the count",
    (p.noEmailAddress ?? []).join(", "));
  check((p.alreadyHaveALogin ?? []).includes("ZZUS Rekha Devi"),
    "and the one who already has a login is named too");

  // ─────────────────────────────────────────────────── 8. REVOKE
  console.log("\nRevoking:");
  const off = await call("POST", `/users/${row.id}/deactivate`, A);
  check(off.status < 300, "deactivated", `${off.status}`);
  const stillARow = await prisma.user.findFirst({ where: { schoolId, email: teacherEmail } });
  check(Boolean(stillARow) && stillARow.isActive === false,
    "the row SURVIVES — a user named in the audit log has to stay resolvable",
    `isActive=${stillARow?.isActive}`);

  const afterRevoke = await call("POST", `/schools/${schoolId}/enter`, teacherAcct);
  check(afterRevoke.status >= 400, "and the door is shut, even with a valid account token",
    `${afterRevoke.status}`);
  const emptyList = await call("GET", "/schools", teacherAcct);
  check((emptyList.json?.schools ?? []).length === 0,
    "…and the school no longer appears in their list");

  // The last administrator cannot lock the school out of itself.
  const adminRow = listed.find((u) => u.email === adminEmail);
  const suicide = await call("POST", `/users/${adminRow.id}/deactivate`, A);
  check(suicide.status >= 400,
    "the only remaining administrator cannot deactivate themselves",
    suicide.json?.message?.slice(0, 70));

  // ─────────────────────────────────────────────────── 9. ERP
  console.log("\nAn ERP school manages its people in the ERP:");
  await prisma.school.update({ where: { id: schoolId }, data: { origin: "erp" } });
  const refused = await call("POST", "/users/invite", A, {
    email: `someone@${DOMAIN}`, name: "ZZUS Someone", roleId: teacherRole.id,
  });
  check(refused.status === 403, "POST /users/invite is refused outright",
    refused.json?.message?.slice(0, 80));
  const stillReadable = await call("GET", "/users", A);
  check(stillReadable.status < 300, "…but the list is still readable, so the screen can explain why");

  // ───────────────────────────────────────────────────────────── cleanup
  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { name: { startsWith: "ZZUS " } } })) === 0, "test school removed");
  check((await control.account.count({ where: { email: { endsWith: `@${DOMAIN}` } } })) === 0, "test accounts removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
  console.log(failed ? "\nSOME USER CHECKS FAILED" : "\nALL USER CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
