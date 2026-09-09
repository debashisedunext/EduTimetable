/**
 * Phase 23 (§23) — ERP master-data sync, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/erp-sync-smoke.cjs
 *
 * The sync reads the ERP's REST API and nothing else. The dev stack runs a
 * stand-in (`erp-fake`, from `scripts/fake-erp-api.cjs`) over the fixture
 * database, and this drives the real endpoints against it — over HTTP, from
 * another container, with a token, exactly as production would.
 *
 *    1. STATUS     — per master: configured, endpoint, rows held. No ERP call.
 *    2. PROBE      — every endpoint answers, and a broken one is NAMED
 *    3. PREVIEW    — counts what would change, and writes nothing
 *    4. APPLY      — the five core masters land
 *    5. OWNED      — a re-sync updates the ERP's fields and NOTHING else. The
 *                    property the whole feature turns on: a sync that reset
 *                    max_periods_per_day would change the next Generate's
 *                    output with nothing on any screen saying why.
 *    6. INACTIVE   — a teacher the ERP marks inactive is updated, not removed
 *    7. IMPACT     — a teacher the ERP DROPPED is a removal, and the preview
 *                    counts every dependent row before anything goes
 *    8. CONFIRM    — no confirmation, no deletion. Wrong name, no deletion.
 *    9. CASCADE    — and when it does go, nothing is left pointing at it
 *   10. REPLACE    — delete-and-reinsert re-mints every id, and is REFUSED
 *                    where it would require deleting a timetable
 *   11. UNWIRED    — a master with no endpoint says so, and blocks nothing else
 *   12. LOGS       — every run recorded: ok, blocked and failed alike
 *   13. TWO SCHOOLS— one ERP, two schools, neither sees the other's rows
 *
 * Everything it creates is prefixed ZZERP and removed at the end.
 */
const { createRequire } = require("node:module");
const fs = require("node:fs");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { groupFor } = require("./resource-groups.cjs");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const P = "ZZERP";
const SCHOOL = 99073;
const CODE = `${P}-SCHOOL`;
const ERP_URL = process.env.ERP_DATABASE_URL || "mysql://root:edutimetable_dev@mysql:3306/erp_fixture";
const MAPPING_FILE = process.env.ERP_API_FILE || "/app/scripts/erp-api.dev.json";

let failed = 0;
const check = (ok, l, x = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${x ? ` — ${x}` : ""}`);
  if (!ok) failed = 1;
};

async function tokenFor(code, name, who) {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      erpUserId: `${who}-1`, erpRole: "ADMIN", name: `${who} Admin`, email: `${who}@zzerp.test`,
      school: { code, name },
    }),
  });
  const { token } = await r.json();
  const cb = await fetch(`${API}/api/sso/callback?token=${token}`, { redirect: "manual" });
  return (cb.headers.get("location") || "").split("#token=")[1] ?? null;
}

async function call(method, p, token, body) {
  const res = await fetch(`${API}/api${p}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

const preview = (token, sheet, mode = "refresh") =>
  call("POST", "/sync/erp/preview", token, { sheet, mode });
const apply = (token, sheet, mode = "refresh", extra = {}) =>
  call("POST", "/sync/erp/apply", token, { sheet, mode, ...extra });

/** Sync every master in dependency order, the way the screen's five buttons do. */
async function syncAll(token, name, mode = "refresh") {
  const out = {};
  for (const sheet of ["Academic Years", "Classes", "Class Sections", "Subjects", "Teachers"]) {
    const r = await apply(token, sheet, mode, { confirm: name });
    out[sheet] = r.json;
  }
  return out;
}

(async () => {
  const prisma = new PrismaClient();
  const erp = new PrismaClient({ datasources: { db: { url: ERP_URL } } });
  const SCHOOL2 = SCHOOL + 1;
  const SCHOOLS = [SCHOOL, SCHOOL2];
  const NAME = `${P} Sync School`;
  const CODE2 = `${P}2-SCHOOL`;
  const NAME2 = `${P}2 Other School`;

  const purge = async () => {
    await prisma.erpSyncRun.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.timetableSlot.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.timetableDraft.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.period.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.teacherSubjectClassSection.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.teacherClassEligibility.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.classSubject.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.classSection.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.timetableConfig.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.teacher.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.section.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.schoolClass.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.subject.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.academicYear.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.user.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.erpRoleMapping.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.rolePermission.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.role.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.school.deleteMany({ where: { id: { in: SCHOOLS } } });
  };
  const cleanErp = async () => {
    for (const c of [CODE, CODE2]) {
      const rows = await erp.$queryRawUnsafe(`SELECT id FROM schools WHERE code = ?`, c);
      for (const r of rows) {
        const id = Number(r.id);
        for (const t of ["sections", "classes", "subjects", "staff", "academic_sessions"]) {
          await erp.$executeRawUnsafe(`DELETE FROM ${t} WHERE school_id = ?`, id);
        }
        await erp.$executeRawUnsafe(`DELETE FROM schools WHERE id = ?`, id);
      }
    }
  };
  await purge();
  await cleanErp();

  // -------------------------------------------------- the stand-in ERP's rows
  //
  // Inserted into the fixture database the `erp-fake` service serves. The app
  // never touches this database — it reads the same rows over HTTP.
  console.log("A school in the stand-in ERP:");
  await erp.$executeRawUnsafe(`INSERT INTO schools (code, name) VALUES (?, ?)`, CODE, NAME);
  const [{ sid }] = await erp.$queryRawUnsafe(`SELECT id AS sid FROM schools WHERE code = ?`, CODE);
  const S = Number(sid);
  await erp.$executeRawUnsafe(
    `INSERT INTO academic_sessions (school_id, name, start_date, end_date, is_current)
     VALUES (?, ?, '2026-04-01', '2027-03-31', 1)`, S, `${P} 2026-27`);
  const [{ ssid }] = await erp.$queryRawUnsafe(`SELECT id AS ssid FROM academic_sessions WHERE school_id = ?`, S);
  for (const [n, o] of [[`${P} Class 5`, 5], [`${P} Class 6`, 6]]) {
    await erp.$executeRawUnsafe(`INSERT INTO classes (school_id, name, display_order) VALUES (?, ?, ?)`, S, n, o);
  }
  const cls = await erp.$queryRawUnsafe(`SELECT id, name FROM classes WHERE school_id = ? ORDER BY display_order`, S);
  for (const c of cls) {
    for (const [sec, n] of [["A", 32], ["B", 30]]) {
      await erp.$executeRawUnsafe(
        `INSERT INTO sections (school_id, class_id, session_id, name, strength) VALUES (?, ?, ?, ?, ?)`,
        S, Number(c.id), Number(ssid), sec, n);
    }
  }
  for (const [n, c] of [[`${P} English`, "ENG"], [`${P} Maths`, "MAT"], [`${P} Science`, "SCI"]]) {
    await erp.$executeRawUnsafe(`INSERT INTO subjects (school_id, name, code) VALUES (?, ?, ?)`, S, n, c);
  }
  for (const [code, name, teaching] of [
    [`${P}-T1`, "Aditi Verma", 1], [`${P}-T2`, "Rahul Nair", 1],
    [`${P}-T3`, "Meera Das", 1], [`${P}-NT`, "Accounts Person", 0],
  ]) {
    await erp.$executeRawUnsafe(
      `INSERT INTO staff (school_id, employee_code, name, is_active, is_teaching) VALUES (?, ?, ?, 1, ?)`,
      S, code, name, teaching);
  }
  check(true, "ERP populated", "2 classes, 4 sections, 3 subjects, 3 teachers (+1 non-teaching)");

  // ------------------------------------------------------------- our school
  await prisma.school.create({ data: { id: SCHOOL, code: CODE, name: NAME } });
  const role = await prisma.role.create({ data: { schoolId: SCHOOL, name: "Super Admin", isSystem: true } });
  const perms = await prisma.rolePermission.findMany({
    where: { role: { schoolId: 1, name: "Super Admin" } }, select: { permission: true },
  });
  await prisma.rolePermission.createMany({
    data: perms.map((p) => ({ roleId: role.id, permission: p.permission, schoolId: SCHOOL })),
  });
  await prisma.erpRoleMapping.create({ data: { schoolId: SCHOOL, erpRole: "ADMIN", roleId: role.id } });
  const token = await tokenFor(CODE, NAME, P);
  check(Boolean(token), "signed in as an admin of the test school");

  // ------------------------------------------------------------- 1. STATUS
  console.log("\nThe screen's own state, without calling the ERP:");
  const st = await call("GET", "/sync/erp/status", token);
  if (!st.json?.configured) {
    console.log(`  SKIP  no ERP API configured (${st.json?.reason ?? "unknown"})`);
    console.log("        start the stand-in with: docker compose up -d erp-fake");
    await purge(); await cleanErp();
    await prisma.$disconnect(); await erp.$disconnect();
    process.exit(0);
  }
  check(st.json.masters.length === 5, "five masters listed", st.json.describe);
  check(st.json.masters.every((m) => m.configured && m.endpoint),
    "each names the endpoint it calls",
    st.json.masters.map((m) => `${m.sheet}→${m.endpoint?.split("?")[0]}`).join(" · "));
  check(st.json.masters.every((m) => m.held === 0 && m.lastRun === null),
    "and reports nothing held and nothing synced yet");

  // -------------------------------------------------------------- 2. PROBE
  console.log("\nThe probe calls every endpoint for real:");
  const probe = await call("GET", "/sync/erp/probe", token);
  check(probe.json?.configured && probe.json?.connected,
    "connected and resolved the school by its shared code", `erpSchoolId ${probe.json?.erpSchoolId}`);
  check((probe.json?.sheets ?? []).every((s) => s.ok),
    "every endpoint answered and produced its fields",
    (probe.json?.sheets ?? []).map((s) => `${s.sheet}:${s.ok ? "ok" : s.error ?? s.missingColumns.join(",")}`).join(" · "));

  // An endpoint that stops working must NAME the failure, not return nothing.
  await erp.$executeRawUnsafe(`ALTER TABLE subjects CHANGE COLUMN code short_code VARCHAR(10)`);
  const broken = await call("GET", "/sync/erp/probe", token);
  const subjProbe = (broken.json?.sheets ?? []).find((s) => s.sheet === "Subjects");
  check(subjProbe && !subjProbe.ok && Boolean(subjProbe.error),
    "a broken endpoint fails loudly rather than reporting 0 rows", (subjProbe?.error ?? "").slice(0, 80));
  await erp.$executeRawUnsafe(`ALTER TABLE subjects CHANGE COLUMN short_code code VARCHAR(10)`);

  // ------------------------------------------------------------ 3. PREVIEW
  console.log("\nThe preview counts what would change, and writes nothing:");
  const prevTeachers = await preview(token, "Teachers");
  check(prevTeachers.json?.plan?.create === 3 && prevTeachers.json?.plan?.remove === 0,
    "3 teachers to add — the non-teaching staff member is not one",
    JSON.stringify(prevTeachers.json?.plan && {
      c: prevTeachers.json.plan.create, u: prevTeachers.json.plan.update, r: prevTeachers.json.plan.remove,
    }));
  check(prevTeachers.json?.confirmRequired === false, "and no confirmation is needed to add rows");
  check((await prisma.teacher.count({ where: { schoolId: SCHOOL } })) === 0, "nothing was written");

  // A master whose parents are missing says so rather than silently dropping.
  const prevSections = await preview(token, "Class Sections");
  check((prevSections.json?.warnings ?? []).some((w) => /Classes|Academic Years/.test(w)),
    "and Class Sections warns that its parents are not synced yet",
    (prevSections.json?.warnings ?? [])[0]?.slice(0, 70));

  // -------------------------------------------------------------- 4. APPLY
  console.log("\nEach master's button lands its own rows:");
  const landed = await syncAll(token, NAME);
  check(landed["Teachers"]?.status === "ok", "every apply reported ok",
    Object.entries(landed).map(([k, v]) => `${k}:${v?.status}`).join(" "));
  check((await prisma.academicYear.count({ where: { schoolId: SCHOOL } })) === 1, "1 academic year");
  check((await prisma.schoolClass.count({ where: { schoolId: SCHOOL } })) === 2, "2 classes");
  check((await prisma.classSection.count({ where: { schoolId: SCHOOL } })) === 4, "4 class-sections");
  check((await prisma.subject.count({ where: { schoolId: SCHOOL } })) === 3, "3 subjects");
  const teachers = await prisma.teacher.findMany({ where: { schoolId: SCHOOL } });
  check(teachers.length === 3, "3 teachers", `${teachers.length}`);
  const anySection = await prisma.classSection.findFirst({ where: { schoolId: SCHOOL } });
  check(anySection?.strength === 32 || anySection?.strength === 30,
    "with strength carried across", `${anySection?.strength}`);
  check(anySection?.timetableConfigId === null,
    "and NOT assigned to a timetable — a §3.10 decision the ERP knows nothing about");

  // -------------------------------------------------------------- 5. OWNED
  console.log("\nA re-sync changes the ERP's fields and nothing else:");
  const t1 = teachers.find((x) => x.employeeCode === `${P}-T1`);
  await prisma.teacher.update({
    where: { id: t1.id },
    data: {
      maxPeriodsPerDay: 4, minPeriodsPerDay: 2, maxPeriodsPerWeek: 18,
      periodPattern: "alternate_day", alternateDaySet: [1, 3, 5],
      classTeacherPeriodRule: "always_first_period", employmentType: "adhoc",
    },
  });
  const sub = await prisma.subject.findFirst({ where: { schoolId: SCHOOL, name: `${P} Maths` } });
  await prisma.subject.update({ where: { id: sub.id }, data: { isLab: true, requiresDoublePeriod: true } });

  await erp.$executeRawUnsafe(`UPDATE staff SET name = 'Aditi Sharma' WHERE employee_code = ?`, `${P}-T1`);
  const prev2 = await preview(token, "Teachers");
  const changed = (prev2.json?.plan?.rows ?? []).find((r) => r.verdict === "update");
  check(prev2.json?.plan?.update === 1 && changed?.changes?.length === 1 && changed.changes[0].field === "name",
    "the preview finds exactly the one real change, with old and new",
    JSON.stringify(changed?.changes));

  await apply(token, "Teachers", "refresh", { confirm: NAME });
  const after1 = await prisma.teacher.findUnique({ where: { id: t1.id } });
  check(after1.name === "Aditi Sharma", "the name was updated from the ERP", after1.name);
  check(
    after1.maxPeriodsPerDay === 4 && after1.minPeriodsPerDay === 2 && after1.maxPeriodsPerWeek === 18 &&
      after1.periodPattern === "alternate_day" && after1.classTeacherPeriodRule === "always_first_period" &&
      after1.employmentType === "adhoc" && JSON.stringify(after1.alternateDaySet) === "[1,3,5]",
    "and EVERY scheduling field survived untouched",
    `${after1.maxPeriodsPerDay}/day · ${after1.periodPattern} · ${after1.employmentType}`,
  );
  const subAfter = await prisma.subject.findUnique({ where: { id: sub.id } });
  check(subAfter.isLab === true && subAfter.requiresDoublePeriod === true,
    "a subject's lab flags survived too — the ERP has no opinion on them");

  // ----------------------------------------------------------- 6. INACTIVE
  console.log("\nInactive is not absent:");
  await erp.$executeRawUnsafe(`UPDATE staff SET is_active = 0 WHERE employee_code = ?`, `${P}-T2`);
  await apply(token, "Teachers", "refresh", { confirm: NAME });
  const t2 = await prisma.teacher.findFirst({ where: { schoolId: SCHOOL, employeeCode: `${P}-T2` } });
  check(t2 !== null && t2.isActive === false,
    "a teacher the ERP marks inactive is updated in place, not removed", `isActive=${t2?.isActive}`);

  // ------------------------------------------------------------- 7. IMPACT
  //
  // Now the destructive path. T3 gets a mapping, a timetable slot and a user
  // login before the ERP drops her, so the impact count has something real to
  // find — and so the cascade has something real to leave dangling if it is
  // wrong.
  console.log("\nA teacher the ERP has dropped is a removal, counted first:");
  const t3 = await prisma.teacher.findFirst({ where: { schoolId: SCHOOL, employeeCode: `${P}-T3` } });
  const year = await prisma.academicYear.findFirst({ where: { schoolId: SCHOOL } });
  const cfg = await prisma.timetableConfig.create({
    data: {
      resourceGroupId: await groupFor(prisma, year.id),
      schoolId: SCHOOL, academicYearId: year.id, name: `${P} Wing`,
      periodsPerDay: 6, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5],
    },
  });
  const section = await prisma.classSection.findFirst({ where: { schoolId: SCHOOL } });
  await prisma.classSection.update({ where: { id: section.id }, data: { timetableConfigId: cfg.id, classTeacherId: t3.id } });
  await prisma.teacherSubjectClassSection.create({
    data: { schoolId: SCHOOL, teacherId: t3.id, subjectId: sub.id, classSectionId: section.id, periodsPerWeek: 4 },
  });
  await prisma.timetableSlot.create({
    data: {
      schoolId: SCHOOL, timetableConfigId: cfg.id, status: "published",
      classSectionId: section.id, dayOfWeek: 1, periodNumber: 1,
      subjectId: sub.id, teacherId: t3.id, source: "auto",
    },
  });
  const teacherUser = await prisma.user.create({
    data: { schoolId: SCHOOL, erpUserId: `${P}-T3-USER`, name: "Meera Das", email: "m@zzerp.test", teacherId: t3.id, roleId: role.id },
  });

  await erp.$executeRawUnsafe(`DELETE FROM staff WHERE employee_code = ?`, `${P}-T3`);
  const prev3 = await preview(token, "Teachers");
  const impact = prev3.json?.impact;
  const labels = (impact?.lines ?? []).map((l) => l.label).join(" | ");
  check(prev3.json?.plan?.remove === 1 && prev3.json?.confirmRequired === true,
    "the preview reports one removal, and demands a confirmation");
  check(/timetable slots/.test(labels) && /subject mappings/.test(labels),
    "and names the timetable rows and mappings that would go with her", labels);
  check(/class-teacher assignments/.test(labels) && /teacher logins/.test(labels),
    "including the two that would otherwise dangle silently — no foreign key guards either");
  check(impact?.publishedSlots === 1,
    "and says how many are in a PUBLISHED timetable", `${impact?.publishedSlots}`);

  // ------------------------------------------------------------ 8. CONFIRM
  console.log("\nNo confirmation, no deletion:");
  const noConfirm = await apply(token, "Teachers", "refresh");
  check(noConfirm.json?.status === "blocked", "an apply with no confirmation is refused", noConfirm.json?.status);
  check(/486|deletes 1|removes/i.test(noConfirm.json?.error ?? "") || /deletes 1/.test(noConfirm.json?.error ?? ""),
    "and the refusal says what it would have deleted", (noConfirm.json?.error ?? "").slice(0, 90));
  check((await prisma.teacher.count({ where: { id: t3.id } })) === 1, "the teacher is still there");

  const wrongName = await apply(token, "Teachers", "refresh", { confirm: "not the school" });
  check(wrongName.json?.status === "blocked", "a wrong confirmation is refused too");
  check((await prisma.timetableSlot.count({ where: { teacherId: t3.id } })) === 1,
    "and her published timetable row is untouched");

  // ------------------------------------------------------------ 9. CASCADE
  console.log("\nWhen it does go, nothing is left pointing at it:");
  const removed = await apply(token, "Teachers", "refresh", { confirm: NAME, fingerprint: prev3.json.fingerprint });
  check(removed.json?.status === "ok" && removed.json?.deleted === 1,
    "the confirmed apply removed her", `deleted ${removed.json?.deleted}`);
  check((await prisma.teacher.count({ where: { id: t3.id } })) === 0, "the teacher row is gone");
  check((await prisma.teacherSubjectClassSection.count({ where: { teacherId: t3.id } })) === 0, "her mappings are gone");
  check((await prisma.timetableSlot.count({ where: { teacherId: t3.id } })) === 0,
    "her timetable rows are gone — NOT left pointing at a teacher that no longer exists");
  const sectionAfter = await prisma.classSection.findUnique({ where: { id: section.id } });
  check(sectionAfter.classTeacherId === null, "the class-teacher assignment was cleared, not orphaned");
  const userAfter = await prisma.user.findUnique({ where: { id: teacherUser.id } });
  check(userAfter.teacherId === null,
    "and her login no longer points at a deleted teacher — that id would be reused");
  check((await prisma.timetableConfig.count({ where: { id: cfg.id } })) === 1,
    "the timetable itself survived: a masters sync does not delete a timetable");

  // ------------------------------------------------------------ 10. REPLACE
  console.log("\nReplace re-mints every id, and is refused where a timetable depends on it:");
  const subjectsBefore = await prisma.subject.findMany({ where: { schoolId: SCHOOL }, orderBy: { id: "asc" } });
  const prevRep = await preview(token, "Subjects", "replace");
  check(prevRep.json?.plan?.remove === 3 && prevRep.json?.plan?.create === 3,
    "replace removes all and adds all — even the rows that match",
    JSON.stringify({ r: prevRep.json?.plan?.remove, c: prevRep.json?.plan?.create }));
  const repApplied = await apply(token, "Subjects", "replace", { confirm: NAME, fingerprint: prevRep.json.fingerprint });
  check(repApplied.json?.status === "ok", "applied", repApplied.json?.error ?? "");
  const subjectsAfter = await prisma.subject.findMany({ where: { schoolId: SCHOOL }, orderBy: { id: "asc" } });
  check(subjectsAfter.length === 3, "3 subjects again");
  check(subjectsAfter.every((s) => !subjectsBefore.some((b) => b.id === s.id)),
    "every id is new — which is exactly why refresh is the default",
    `${subjectsBefore.map((s) => s.id)} → ${subjectsAfter.map((s) => s.id)}`);

  const prevYear = await preview(token, "Academic Years", "replace");
  check(Boolean(prevYear.json?.impact?.blocked) && /timetable/i.test(prevYear.json.impact.blocked),
    "replacing a session a timetable belongs to is REFUSED, and names it",
    (prevYear.json?.impact?.blocked ?? "").slice(0, 90));
  const yearApply = await apply(token, "Academic Years", "replace", { confirm: NAME });
  check(yearApply.json?.status === "blocked" &&
        (await prisma.academicYear.count({ where: { schoolId: SCHOOL } })) === 1,
    "and the apply is refused too, with the session still there");

  // ------------------------------------------------------------ 11. UNWIRED
  //
  // A master with no endpoint. The mapping file is edited and re-read through
  // the real endpoint, rather than by restarting the API — which is also the
  // loop somebody integrating a real ERP will be in.
  console.log("\nA master with no API configured says so, and blocks nothing else:");
  const original = fs.readFileSync(MAPPING_FILE, "utf8");
  try {
    const partial = JSON.parse(original);
    delete partial.sheets.Subjects;
    fs.writeFileSync(MAPPING_FILE, JSON.stringify(partial, null, 2));
    await call("POST", "/sync/erp/reload", token);
    const st2 = await call("GET", "/sync/erp/status", token);
    const subjCard = (st2.json?.masters ?? []).find((m) => m.sheet === "Subjects");
    check(subjCard?.configured === false && /No API integration has been done/i.test(subjCard?.reason ?? ""),
      "the card reports no integration, by name", (subjCard?.reason ?? "").slice(0, 70));
    check((st2.json?.masters ?? []).filter((m) => m.configured).length === 4,
      "the other four are unaffected");
    const refused = await preview(token, "Subjects");
    check(refused.status === 400 && /No API integration/i.test(JSON.stringify(refused.json)),
      "and syncing it is refused with that reason, not a connection error", `${refused.status}`);
    const stillWorks = await apply(token, "Classes", "refresh", { confirm: NAME });
    check(stillWorks.json?.status === "ok", "while another master still syncs normally");
  } finally {
    fs.writeFileSync(MAPPING_FILE, original);
    await call("POST", "/sync/erp/reload", token);
  }
  const restored = await call("GET", "/sync/erp/status", token);
  check((restored.json?.masters ?? []).every((m) => m.configured),
    "the mapping file was handed back intact");

  // --------------------------------------------------------- 11b. SECURED
  //
  // §23.8. Everything above already ran through OAuth2 — the stand-in ERP
  // refuses an unauthenticated read — so what is left to prove is the parts
  // that are invisible when they work: that we mint one token rather than one
  // per request, that the admin's identity arrives, and that a revoked token
  // heals instead of failing the sync.
  console.log("\nThe ERP is secured, and the credential behaves:");
  const erpBase = (st.json.describe.match(/https?:\/\/[^\s·]+/) ?? [])[0] ?? "";
  const erpRoot = erpBase.replace(/\/api\/v1$/, "");
  const erpStats = async () => (await (await fetch(`${erpRoot}/api/v1/_test/stats`)).json());

  // Warm the cache first. Step 11 reloaded the mapping, which rebuilds the
  // reader and discards its cached token — so without this the next request
  // would mint a fresh token and never meet the 401 this is testing.
  await preview(token, "Classes");

  const before = await erpStats();
  check(before.tokensIssued >= 1 && before.reads > 0,
    "the whole suite so far ran on OAuth2 access tokens",
    `${before.tokensIssued} token(s) for ${before.reads} reads`);
  check(before.reads > before.tokensIssued,
    "one token served many requests — not one grant per call",
    `${before.reads} reads / ${before.tokensIssued} tokens`);
  check(before.lastActingUser === `${P}-1`,
    "and the ERP was told WHICH admin triggered it, from the SSO identity",
    `X-ERP-Acting-User: ${before.lastActingUser}`);

  // Revoke every token behind our back — a rotation, or an ERP restart.
  await fetch(`${erpRoot}/api/v1/_test/revoke`);
  const healed = await preview(token, "Classes");
  const after = await erpStats();
  check(healed.status === 200 || healed.status === 201,
    "a revoked token does not fail the sync: it is refreshed and the request retried once",
    `${healed.status}`);
  check(after.tokensIssued > before.tokensIssued && after.unauthorized > before.unauthorized,
    "and the 401 really happened — this is the retry path, not a cached success",
    `+${after.tokensIssued - before.tokensIssued} token, +${after.unauthorized - before.unauthorized} 401`);

  // A wrong secret must name the setting, not report a mystery.
  const goodSecret = process.env.ERP_API_CLIENT_SECRET;
  try {
    process.env.ERP_API_CLIENT_SECRET = "wrong-secret";
    const { ErpAuthenticator } = req("/app/apps/api/dist/sync/erp-auth.js");
    const auth = new ErpAuthenticator({
      mode: "oauth2", tokenUrl: `${erpRoot}/api/v1/oauth/token`,
      clientId: "edutimetable", clientSecretEnv: "ERP_API_CLIENT_SECRET",
    });
    let msg = "";
    try { await auth.headers(); } catch (e) { msg = e.message; }
    check(/refused our credentials/i.test(msg) && /ERP_API_CLIENT_SECRET/.test(msg),
      "a rejected client secret says so, and names the variable to fix", msg.slice(0, 95));
    check(!msg.includes("wrong-secret"),
      "and never echoes the secret itself — these messages are shown on screen and logged");
  } finally {
    process.env.ERP_API_CLIENT_SECRET = goodSecret;
  }

  // --------------------------------------------------------------- 12. LOGS
  console.log("\nEvery run is in the history, including the refused ones:");
  const logs = await call("GET", "/sync/erp/logs?limit=100", token);
  const rows = logs.json ?? [];
  check(rows.length > 0, `${rows.length} runs logged`);
  check(rows.some((r) => r.status === "blocked" && r.sheet === "Teachers"),
    "the refusals are recorded, not just the successes");
  check(rows.some((r) => r.status === "ok" && r.mode === "replace" && r.sheet === "Subjects"),
    "and the destructive run is recorded with its mode");
  const okRun = rows.find((r) => r.status === "ok" && r.sheet === "Teachers" && r.deleted === 1);
  check(Boolean(okRun?.endpoint) && okRun?.durationMs >= 0,
    "with the endpoint it called and how long it took", `${okRun?.endpoint} · ${okRun?.durationMs}ms`);
  check(Boolean(okRun?.detail?.impact),
    "and the impact the admin consented to, so the deletion has an answer later");

  // -------------------------------------------------------- 13. TWO SCHOOLS
  //
  // The check that earns this route family its §17.8 exemption. The sync takes
  // no id from the request: it reads the ERP with the SESSION's school code and
  // writes through the scoped client. So two schools must see two ERPs.
  console.log("\nTwo schools sync their own ERP data and nobody else's:");
  await erp.$executeRawUnsafe(`INSERT INTO schools (code, name) VALUES (?, ?)`, CODE2, NAME2);
  const [{ sid2 }] = await erp.$queryRawUnsafe(`SELECT id AS sid2 FROM schools WHERE code = ?`, CODE2);
  const S2 = Number(sid2);
  await erp.$executeRawUnsafe(`INSERT INTO subjects (school_id, name, code) VALUES (?, ?, 'AST')`, S2, `${P}2 Astronomy`);
  await erp.$executeRawUnsafe(
    `INSERT INTO staff (school_id, employee_code, name, is_active, is_teaching) VALUES (?, ?, 'Other Person', 1, 1)`,
    S2, `${P}2-T9`);

  await prisma.school.create({ data: { id: SCHOOL2, code: CODE2, name: NAME2 } });
  const role2 = await prisma.role.create({ data: { schoolId: SCHOOL2, name: "Super Admin", isSystem: true } });
  await prisma.rolePermission.createMany({
    data: perms.map((p) => ({ roleId: role2.id, permission: p.permission, schoolId: SCHOOL2 })),
  });
  await prisma.erpRoleMapping.create({ data: { schoolId: SCHOOL2, erpRole: "ADMIN", roleId: role2.id } });
  const token2 = await tokenFor(CODE2, NAME2, `${P}2`);

  const prevB = await preview(token2, "Subjects");
  const bLabels = JSON.stringify(prevB.json?.plan?.rows ?? []);
  check(bLabels.includes("Astronomy"), "B's preview shows B's ERP rows");
  check(!bLabels.includes(`${P} English`), "and none of A's, though both live in the same ERP");

  await apply(token2, "Subjects", "refresh", { confirm: NAME2 });
  const bSubjects = await prisma.subject.count({ where: { schoolId: SCHOOL2 } });
  check(bSubjects === 1, "B's sync wrote exactly B's one subject", `${bSubjects}`);
  check((await prisma.subject.count({ where: { schoolId: SCHOOL, name: `${P}2 Astronomy` } })) === 0,
    "and nothing of B's landed in A");
  check((await prisma.subject.count({ where: { schoolId: SCHOOL } })) === 3,
    "A's subjects are untouched by B's sync");
  const bLogs = await call("GET", "/sync/erp/logs?limit=100", token2);
  check((bLogs.json ?? []).every((r) => r.schoolId === SCHOOL2),
    "and B's sync history contains only B's runs", `${(bLogs.json ?? []).length} rows`);

  // ----------------------------------------------------------------- cleanup
  console.log("\nCleanup:");
  await purge();
  await cleanErp();
  check((await prisma.school.count({ where: { id: { in: SCHOOLS } } })) === 0, "test schools removed");
  const [{ n }] = await erp.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM schools`);
  check(Number(n) === 2,
    "the fixture ERP is handed back with its two demo schools — the Sync screen still works", `${n}`);
  check(fs.readFileSync(MAPPING_FILE, "utf8") === original, "and the mapping file is byte-identical");

  await prisma.$disconnect();
  await erp.$disconnect();
  console.log(failed ? "\nSOME ERP SYNC CHECKS FAILED" : "\nALL ERP SYNC CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
