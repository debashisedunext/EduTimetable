/**
 * Phase 19 Step 1 (§3) — the curriculum and teacher load are scoped to an
 * academic year. Runs against the LIVE stack, on a school built for it.
 *
 *   docker compose exec api node /app/scripts/year-scope-smoke.cjs
 *
 *   1. KEY      — the same class + subject in two sessions is two rows, and
 *                 two rows in the SAME session is still refused
 *   2. SNAPSHOT — a config sees only its own session's curriculum, so the
 *                 solver cannot be handed last year's syllabus
 *   3. LOAD     — a teacher's periods in ANOTHER YEAR do not consume this
 *                 year's capacity, while another config in the SAME year
 *                 still does. This is the bug that made a rolled-over school
 *                 read as hopelessly overloaded before anyone touched it.
 *   4. CAP      — periods/week is capped by this session's week, not by a
 *                 finished year's shorter one
 *
 * Everything it creates is prefixed ZZYSC and removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const P = "ZZYSC";
const SCHOOL = 99071;

let failed = 0;
const check = (ok, l, x = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${x ? ` — ${x}` : ""}`);
  if (!ok) failed = 1;
};

async function session() {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ erpUserId: `${P}-1`, erpRole: "ADMIN", name: "Year Admin", email: "y@zz.test", schoolId: SCHOOL }),
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

(async () => {
  const prisma = new PrismaClient();

  const purge = async () => {
    await prisma.$transaction([
      prisma.timetableSlot.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.timetableDraft.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherSubjectClassSection.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherClassEligibility.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.classSubject.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.classSection.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.section.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.period.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.timetableConfig.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.schoolClass.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacher.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.subject.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.academicYear.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.notification.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.auditLog.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.user.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.erpRoleMapping.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.rolePermission.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.role.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.school.deleteMany({ where: { id: SCHOOL } }),
    ]);
  };
  await purge();

  // ---------------------------------------------------------------- fixture
  // One school, one class, one subject, one teacher — and TWO sessions, each
  // with its own timetable. The same shape a school has the day after it rolls
  // over into the next year.
  console.log("A school running two sessions at once:");
  await prisma.school.create({ data: { id: SCHOOL, code: `${P}-SCHOOL`, name: `${P} Year School` } });
  const role = await prisma.role.create({ data: { schoolId: SCHOOL, name: "Super Admin", isSystem: true } });
  const perms = await prisma.rolePermission.findMany({
    where: { role: { schoolId: 1, name: "Super Admin" } }, select: { permission: true },
  });
  await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permission: p.permission, schoolId: SCHOOL })) });
  await prisma.erpRoleMapping.create({ data: { schoolId: SCHOOL, erpRole: "ADMIN", roleId: role.id } });

  const subject = await prisma.subject.create({ data: { schoolId: SCHOOL, name: `${P} English` } });
  const cls = await prisma.schoolClass.create({ data: { schoolId: SCHOOL, name: `${P} Class 5`, sequence: 5 } });
  const sec = await prisma.section.create({ data: { classId: cls.id, name: "A", schoolId: SCHOOL } });
  const teacher = await prisma.teacher.create({
    data: {
      schoolId: SCHOOL, employeeCode: `${P}-T1`, name: `${P} Teacher`,
      maxPeriodsPerDay: 6, maxPeriodsPerWeek: 30, minPeriodsPerDay: 0,
      eligibility: { create: [{ classId: cls.id, schoolId: SCHOOL }] },
    },
  });

  // The old session's week is deliberately SHORTER (3 periods/day vs 8), so a
  // capacity check that reaches across years would quote the wrong ceiling.
  // 3×5 = 15 against 8×5 = 40 leaves room to straddle the two while staying
  // inside the 1-20 bound the curriculum form itself enforces (§4.8).
  const mkYear = async (name, from, to, periodsPerDay) => {
    const year = await prisma.academicYear.create({
      data: { schoolId: SCHOOL, name: `${P} ${name}`, startDate: new Date(from), endDate: new Date(to), isActive: name === "26-27" },
    });
    const config = await prisma.timetableConfig.create({
      data: { schoolId: SCHOOL, name: `${P} Wing ${name}`, academicYearId: year.id, workingDays: [1, 2, 3, 4, 5], periodsPerDay },
    });
    const cs = await prisma.classSection.create({
      data: { classId: cls.id, sectionId: sec.id, academicYearId: year.id, schoolId: SCHOOL, timetableConfigId: config.id, strength: 30 },
    });
    return { year, config, cs };
  };
  const oldYr = await mkYear("25-26", "2025-04-01", "2026-03-31", 3);
  const newYr = await mkYear("26-27", "2026-04-01", "2027-03-31", 8);
  const token = await session();
  check(Boolean(token), "signed in as an admin of the test school");

  // ------------------------------------------------------------- 1. THE KEY
  console.log("\nThe same class + subject in two sessions is two curriculum rows:");
  const c1 = await call("POST", "/class-subjects", token,
    { classId: cls.id, academicYearId: oldYr.year.id, subjectId: subject.id, periodsPerWeek: 4 });
  const c2 = await call("POST", "/class-subjects", token,
    { classId: cls.id, academicYearId: newYr.year.id, subjectId: subject.id, periodsPerWeek: 10 });
  check(c1.status === 201 && c2.status === 201,
    "both sessions accept their own row", `${c1.status}/${c2.status}`);
  check((await prisma.classSubject.count({ where: { schoolId: SCHOOL } })) === 2,
    "two rows exist, not one overwritten");

  const dupe = await call("POST", "/class-subjects", token,
    { classId: cls.id, academicYearId: newYr.year.id, subjectId: subject.id, periodsPerWeek: 3 });
  check(dupe.status === 409,
    "a second row for the SAME class+subject+session is still refused", `${dupe.status}`);

  const listAll = await call("GET", "/class-subjects", token);
  const listNew = await call("GET", `/class-subjects?academicYearId=${newYr.year.id}`, token);
  check(listAll.json.length === 2 && listNew.json.length === 1,
    "the list narrows to one session on request", `${listAll.json.length} → ${listNew.json.length}`);
  check(listNew.json[0].periodsPerWeek === 10,
    "and it is the right session's row", `${listNew.json[0].periodsPerWeek} periods/week`);

  // ---------------------------------------------------------- 2. THE SNAPSHOT
  // What the solver and the Feasibility Engine are handed. If both years'
  // rows reached it, the requirement map (keyed class:subject) would collapse
  // to whichever loaded last — silently timetabling the wrong syllabus.
  console.log("\nA timetable is handed only its own session's syllabus:");
  const { buildFeasibilitySnapshot } = req("/app/apps/api/dist/solver/input.js");
  const snapNew = await buildFeasibilitySnapshot(prisma, newYr.config.id);
  const snapOld = await buildFeasibilitySnapshot(prisma, oldYr.config.id);
  check(snapNew.subjectRequirements.length === 1 && snapNew.subjectRequirements[0].periodsPerWeek === 10,
    "26-27's timetable sees 26-27's 10 periods/week",
    `${snapNew.subjectRequirements.length} row(s), ${snapNew.subjectRequirements[0]?.periodsPerWeek}/wk`);
  check(snapOld.subjectRequirements.length === 1 && snapOld.subjectRequirements[0].periodsPerWeek === 4,
    "25-26's timetable sees 25-26's 4 periods/week",
    `${snapOld.subjectRequirements.length} row(s), ${snapOld.subjectRequirements[0]?.periodsPerWeek}/wk`);

  // ------------------------------------------------------------- 3. THE LOAD
  // The bug this step exists to fix. One teacher, mapped in both sessions.
  console.log("\nA teacher's load in another SESSION does not consume this session's capacity:");
  await prisma.teacherSubjectClassSection.create({
    data: { schoolId: SCHOOL, teacherId: teacher.id, subjectId: subject.id, classSectionId: oldYr.cs.id, periodsPerWeek: 4 },
  });
  await prisma.teacherSubjectClassSection.create({
    data: { schoolId: SCHOOL, teacherId: teacher.id, subjectId: subject.id, classSectionId: newYr.cs.id, periodsPerWeek: 10 },
  });
  const loaded = await buildFeasibilitySnapshot(prisma, newYr.config.id);
  const cross = loaded.crossConfigTeacherLoad[teacher.id];
  check(cross === undefined || cross.periods === 0,
    "last session's 4 periods are NOT counted against this one",
    `crossConfigTeacherLoad = ${cross ? cross.periods : 0}`);

  // ...and the same teacher in a second timetable of the SAME session still is.
  const sibling = await prisma.timetableConfig.create({
    data: { schoolId: SCHOOL, name: `${P} Wing 26-27 B`, academicYearId: newYr.year.id, workingDays: [1, 2, 3, 4, 5], periodsPerDay: 8 },
  });
  const cls2 = await prisma.schoolClass.create({ data: { schoolId: SCHOOL, name: `${P} Class 6`, sequence: 6 } });
  const sec2 = await prisma.section.create({ data: { classId: cls2.id, name: "A", schoolId: SCHOOL } });
  const cs2 = await prisma.classSection.create({
    data: { classId: cls2.id, sectionId: sec2.id, academicYearId: newYr.year.id, schoolId: SCHOOL, timetableConfigId: sibling.id, strength: 30 },
  });
  await prisma.teacherSubjectClassSection.create({
    data: { schoolId: SCHOOL, teacherId: teacher.id, subjectId: subject.id, classSectionId: cs2.id, periodsPerWeek: 7 },
  });
  const withSibling = await buildFeasibilitySnapshot(prisma, newYr.config.id);
  const crossSame = withSibling.crossConfigTeacherLoad[teacher.id];
  check(crossSame && crossSame.periods === 7,
    "but the other WING of the same session still is (§3.10)",
    `crossConfigTeacherLoad = ${crossSame ? crossSame.periods : 0}`);

  // ------------------------------------------------------------- 4. THE CAP
  // 25-26's week is 3×5 = 15 periods; 26-27's is 8×5 = 40. The same 18 must be
  // accepted for 26-27 and refused for 25-26 — before the year reached
  // `capacityForClass`, the tightest week across every session the class had
  // ever run decided what the admin was allowed to type.
  console.log("\nPeriods/week is capped by this session's week, not a finished one's:");
  const subject2 = await prisma.subject.create({ data: { schoolId: SCHOOL, name: `${P} Maths` } });
  const wide = await call("POST", "/class-subjects", token,
    { classId: cls.id, academicYearId: newYr.year.id, subjectId: subject2.id, periodsPerWeek: 18 });
  check(wide.status === 201,
    "18 periods/week is fine in 26-27's 40-period week", `${wide.status}`);
  const narrow = await call("POST", "/class-subjects", token,
    { classId: cls.id, academicYearId: oldYr.year.id, subjectId: subject2.id, periodsPerWeek: 18 });
  check(narrow.status === 400 && /15 periods/.test(narrow.json?.message ?? ""),
    "the same 18 is refused in 25-26's 15-period week, naming its timetable",
    (narrow.json?.message ?? "").slice(0, 70));

  // ----------------------------------------------------------------- cleanup
  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { id: SCHOOL } })) === 0, "test school removed");

  await prisma.$disconnect();
  console.log(failed ? "\nSOME YEAR-SCOPE CHECKS FAILED" : "\nALL YEAR-SCOPE CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
