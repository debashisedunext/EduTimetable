/**
 * Phase 11 (§18) — teaching scope, engagement type and extra classes.
 * Runs against the LIVE stack, on a school built for it.
 *
 *   docker compose exec api node /app/scripts/teacher-scope-smoke.cjs
 *
 *   1. SCOPE    — a teacher cannot be given a class outside their scope, by
 *                 any route: mapping, merged group, elective, class teacher
 *   2. GUEST    — a guest teacher is refused the regular curriculum entirely
 *   3. CHECK 8  — and the Feasibility Engine says so for data that got in anyway
 *   4. COVER    — scope is a hard gate for substitutes; guests are never offered
 *   5. WINDOW   — an extra class must go in the extra window, not the school day
 *   6. EXTRA    — it lands as a source='extra' slot, guarded by the same keys
 *   7. SURVIVES — re-generating and publishing do not cancel it
 *
 * Everything it creates is prefixed ZZSCP and removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const P = "ZZSCP";
const SCHOOL = 99070;

let failed = 0;
const check = (ok, l, x = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${x ? ` — ${x}` : ""}`);
  if (!ok) failed = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session() {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ erpUserId: `${P}-1`, erpRole: "ADMIN", name: "Scope Admin", email: "s@zz.test", schoolId: SCHOOL }),
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
      prisma.extraClass.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.substitutionLog.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherAbsence.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.timetableSlot.deleteMany({ where: { schoolId: SCHOOL } }),
      // §22: after the slots — the draft FK is RESTRICT (generated draft_scope)
      prisma.timetableDraft.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.timetablePublication.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.electiveOption.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.electiveBlockMember.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.electiveBlock.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.mergedTeachingGroupMember.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.mergedTeachingGroup.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherSubjectClassSection.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherClassEligibility.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherUnavailability.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.classSubject.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.classSection.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.section.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.period.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.timetableConfig.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.schoolClass.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacher.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.room.deleteMany({ where: { schoolId: SCHOOL } }),
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
  // Two classes at opposite ends of the school, and a teacher for each.
  console.log("A primary teacher and a senior teacher, each scoped to their own end:");
  await prisma.school.create({ data: { id: SCHOOL, code: `${P}-SCHOOL`, name: `${P} Scope School` } });
  const role = await prisma.role.create({ data: { schoolId: SCHOOL, name: "Super Admin", isSystem: true } });
  const perms = await prisma.rolePermission.findMany({
    where: { role: { schoolId: 1, name: "Super Admin" } }, select: { permission: true },
  });
  await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permission: p.permission, schoolId: SCHOOL })) });
  await prisma.erpRoleMapping.create({ data: { schoolId: SCHOOL, erpRole: "ADMIN", roleId: role.id } });

  const year = await prisma.academicYear.create({
    data: { schoolId: SCHOOL, name: `${P} 26-27`, startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31") },
  });
  const config = await prisma.timetableConfig.create({
    data: { schoolId: SCHOOL, name: `${P} Wing`, academicYearId: year.id, workingDays: [1, 2, 3, 4, 5], periodsPerDay: 4 },
  });
  const subject = await prisma.subject.create({ data: { schoolId: SCHOOL, name: `${P} English` } });
  const room = await prisma.room.create({ data: { schoolId: SCHOOL, name: `${P} Room`, roomType: "classroom" } });

  const mk = async (name, seq) => {
    const cls = await prisma.schoolClass.create({ data: { schoolId: SCHOOL, name: `${P} ${name}`, sequence: seq } });
    const sec = await prisma.section.create({ data: { classId: cls.id, name: "A", schoolId: SCHOOL } });
    const cs = await prisma.classSection.create({
      data: { classId: cls.id, sectionId: sec.id, academicYearId: year.id, schoolId: SCHOOL, timetableConfigId: config.id, strength: 30 },
    });
    await prisma.classSubject.create({
      data: { schoolId: SCHOOL, classId: cls.id, academicYearId: year.id, subjectId: subject.id, periodsPerWeek: 20, maxPeriodsPerDay: 4 },
    });
    return { cls, cs };
  };
  const primary = await mk("Class 1", 1);
  const senior = await mk("Class 12", 12);

  const teacher = async (name, classIds, employmentType = "permanent") =>
    prisma.teacher.create({
      data: {
        schoolId: SCHOOL, employeeCode: `${P}-${name}`, name: `${P} ${name}`,
        maxPeriodsPerDay: 6, maxPeriodsPerWeek: 40, employmentType,
        eligibility: { create: classIds.map((classId) => ({ classId, schoolId: SCHOOL })) },
      },
    });
  const tPrimary = await teacher("Primary", [primary.cls.id]);
  const tSenior = await teacher("Senior", [senior.cls.id]);
  const tGuest = await teacher("Guest", [senior.cls.id], "guest");

  const token = await session();
  check(Boolean(token), "admin session");

  // ------------------------------------------------------------- 1. SCOPE
  console.log("\nA teacher cannot be given a class outside their scope — by any route:");
  const wrong = await call("POST", "/mappings", token, {
    teacherId: tPrimary.id, subjectId: subject.id, classSectionIds: [senior.cs.id], periodsPerWeek: 4,
  });
  check(wrong.status === 400 && /does not teach/.test(wrong.text), "subject mapping", `${wrong.status}`);
  check(/Class 12/.test(wrong.text) && /teaching scope/.test(wrong.text),
    "and the refusal names the class and the fix", (wrong.json?.message ?? "").slice(0, 110));

  const right = await call("POST", "/mappings", token, {
    teacherId: tPrimary.id, subjectId: subject.id, classSectionIds: [primary.cs.id], periodsPerWeek: 20,
  });
  check(right.status === 201, "their own class is accepted", `${right.status}`);

  const ct = await call("PUT", `/class-sections/${senior.cs.id}/class-teacher`, token, { teacherId: tPrimary.id });
  check(ct.status === 400, "class-teacher assignment", `${ct.status}`);

  const merged = await call("POST", "/merged-groups", token, {
    teacherId: tPrimary.id, subjectId: subject.id, periodsPerWeek: 2,
    classSectionIds: [primary.cs.id, senior.cs.id],
  });
  check(merged.status === 400, "merged group with a class outside scope", `${merged.status}`);

  const elective = await call("POST", "/elective-blocks", token, {
    name: `${P} Block`, periodsPerWeek: 2, classSectionIds: [senior.cs.id],
    options: [
      { subjectId: subject.id, teacherId: tPrimary.id, roomId: room.id },
      { subjectId: subject.id, teacherId: tSenior.id, roomId: room.id },
    ],
  });
  check(elective.status === 400, "elective option teacher", `${elective.status}`);

  // ------------------------------------------------------------- 2. GUEST
  console.log("\nA guest teacher is not part of the regular timetable:");
  const guestMap = await call("POST", "/mappings", token, {
    teacherId: tGuest.id, subjectId: subject.id, classSectionIds: [senior.cs.id], periodsPerWeek: 4,
  });
  check(guestMap.status === 400 && /guest teacher/.test(guestMap.text), "refused a subject mapping", `${guestMap.status}`);
  check(/Extra Classes/.test(guestMap.text), "and is pointed at where they do belong",
    (guestMap.json?.message ?? "").slice(0, 110));

  // ----------------------------------------------------------- 3. CHECK 8
  console.log("\nThe Feasibility Engine catches what the endpoints did not:");
  // Written straight to the database, as an older build or a narrowed scope would.
  await prisma.teacherSubjectClassSection.create({
    data: { schoolId: SCHOOL, teacherId: tSenior.id, subjectId: subject.id, classSectionId: senior.cs.id, periodsPerWeek: 20 },
  });
  await prisma.teacherClassEligibility.deleteMany({ where: { teacherId: tSenior.id } });
  await prisma.teacherClassEligibility.create({ data: { teacherId: tSenior.id, classId: primary.cls.id, schoolId: SCHOOL } });
  const r1 = await call("GET", `/timetable-configs/${config.id}/readiness`, token);
  const notEligible = (r1.json?.blockers ?? []).find((b) => b.code === "TEACHER_NOT_ELIGIBLE");
  check(Boolean(notEligible), "a scope narrowed after the mapping is a blocker", notEligible?.message?.slice(0, 90));

  // put it back
  await prisma.teacherClassEligibility.deleteMany({ where: { teacherId: tSenior.id } });
  await prisma.teacherClassEligibility.create({ data: { teacherId: tSenior.id, classId: senior.cls.id, schoolId: SCHOOL } });

  // ------------------------------------------------------------ 5. WINDOW
  console.log("\nAn extra class must go in the extra window, not the school day:");
  const noWindow = await call("POST", "/extra-classes", token, {
    timetableConfigId: config.id, classSectionId: senior.cs.id, subjectId: subject.id,
    teacherId: tGuest.id, dayOfWeek: 1, periodNumber: 2,
  });
  check(noWindow.status === 400 && /no extra-class window/.test(noWindow.text),
    "with no window configured, it says so", (noWindow.json?.message ?? "").slice(0, 100));

  const structure = await call("PUT", `/timetable-configs/${config.id}/structure`, token, {
    startTime: "08:00", periodsPerDay: 4, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5],
    breaks: [], extraPeriodsPerDay: 2, extraPeriodDurationMins: 45,
  });
  check(structure.status === 200, "a window is added after the teaching day",
    `day ends ${structure.json?.endTime}, extra until ${structure.json?.extraEndTime}`);

  const inDay = await call("POST", "/extra-classes", token, {
    timetableConfigId: config.id, classSectionId: senior.cs.id, subjectId: subject.id,
    teacherId: tGuest.id, dayOfWeek: 1, periodNumber: 2,
  });
  check(inDay.status === 400 && /part of the teaching day/.test(inDay.text),
    "a teaching period is still refused, naming the window", (inDay.json?.message ?? "").slice(0, 100));

  // ------------------------------------------------------------- 6. EXTRA
  console.log("\nThe extra class lands as a real slot, guarded by the same keys:");
  const made = await call("POST", "/extra-classes", token, {
    timetableConfigId: config.id, classSectionId: senior.cs.id, subjectId: subject.id,
    teacherId: tGuest.id, dayOfWeek: 1, periodNumber: 5, roomId: room.id,
    reason: "Board revision", effectiveFrom: "2026-09-01", effectiveTo: "2026-11-30",
  });
  check(made.status === 201, "created, with a guest teacher taking it", `${made.status}`);

  const slots = await prisma.timetableSlot.findMany({ where: { schoolId: SCHOOL, source: "extra" } });
  check(slots.length === 2, "one slot in draft and one in published, so it shows either way",
    slots.map((s) => s.status).sort().join(" + "));
  check(slots.every((s) => s.teacherOccupancyKey === `T-${tGuest.id}`),
    "carrying the teacher's occupancy, so uq_teacher_slot applies");

  // the same teacher cannot be in two places in that cell
  let refusedDouble = false;
  try {
    await prisma.timetableSlot.create({
      data: {
        schoolId: SCHOOL, timetableConfigId: config.id, status: "draft",
        classSectionId: primary.cs.id, dayOfWeek: 1, periodNumber: 5,
        subjectId: subject.id, teacherId: tGuest.id, teacherOccupancyKey: `T-${tGuest.id}`, source: "extra",
      },
    });
  } catch (e) { refusedDouble = /uq_teacher_slot|Unique constraint/.test(String(e.message)); }
  check(refusedDouble, "the database refuses the same teacher twice in that cell");

  const dup = await call("POST", "/extra-classes", token, {
    timetableConfigId: config.id, classSectionId: senior.cs.id, subjectId: subject.id,
    teacherId: tSenior.id, dayOfWeek: 1, periodNumber: 5,
  });
  check(dup.status === 409 || dup.status === 400, "and a second extra class in the same cell for that section", `${dup.status}`);

  // ---------------------------------------------------------- 7. SURVIVES
  console.log("\nRe-generating and publishing do not cancel it:");
  await call("POST", `/timetable-configs/${config.id}/generate`, token, { mode: "fast" });
  let state = null;
  for (let i = 0; i < 60 && state !== "completed" && state !== "failed"; i++) {
    await sleep(500);
    state = (await call("GET", `/timetable-configs/${config.id}/generate/latest`, token)).json?.state ?? null;
  }
  const afterGen = await prisma.timetableSlot.count({ where: { schoolId: SCHOOL, source: "extra", status: "draft" } });
  check(state === "completed" && afterGen === 1, "survives a re-generation", `${state}, ${afterGen} extra draft row(s)`);

  const published = await call("POST", `/timetable-configs/${config.id}/board/publish`, token);
  const afterPub = await prisma.timetableSlot.groupBy({
    by: ["status"], where: { schoolId: SCHOOL, source: "extra" }, _count: true,
  });
  check(published.status === 201 && afterPub.length === 2,
    "and survives a publish, in both statuses",
    afterPub.map((g) => `${g.status} ${g._count}`).join(" + "));

  // ------------------------------------------------------------ 4. COVER
  console.log("\nScope is a hard gate for cover, and guests are never offered:");
  const absence = await call("POST", "/absences", token, {
    teacherId: tSenior.id, date: "2026-09-07", reason: "Ill",
  });
  const plan = await call("GET", `/absences/${absence.json?.id}/plan`, token);
  const candidates = JSON.stringify(plan.json ?? {});
  check(plan.status === 200, "a cover plan was produced", `${plan.status}`);
  check(!candidates.includes(`${P} Guest`), "the guest teacher is not among the candidates");
  check(!candidates.includes(`${P} Primary`), "nor the primary teacher, who does not cover Class 12");

  // ----------------------------------------------------------------- cleanup
  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { id: SCHOOL } })) === 0, "test school removed");

  await prisma.$disconnect();
  console.log(failed ? "\nSOME SCOPE CHECKS FAILED" : "\nALL SCOPE CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
