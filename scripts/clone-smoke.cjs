/**
 * Phase 19 Step 2 (§3.12) — cloning a timetable into a new session.
 * Runs against the LIVE stack, on a school built for it.
 *
 *   docker compose exec api node /app/scripts/clone-smoke.cjs
 *
 *   1. PREVIEW  — counts every row it would write, and creates nothing at all
 *   2. REFUSE   — the same session is refused (a class-section belongs to one
 *                 session and one timetable), and so is a taken name
 *   3. COPY     — periods, class-sections, class teachers, home rooms, the
 *                 curriculum, mappings, merged groups and elective blocks with
 *                 all their options land, re-pointed at the new sections
 *   4. NOT      — slots, drafts, publications and extra classes do NOT
 *   5. STAFF    — a teacher who has left is reported and their lessons left
 *                 out; the curriculum still records the demand
 *   6. APART    — the two sessions do not contaminate each other: separate
 *                 syllabi, separate mappings, and neither timetable's teacher
 *                 load counts the other's
 *
 * Everything it creates is prefixed ZZCLN and removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const P = "ZZCLN";
const SCHOOL = 99072;

let failed = 0;
const check = (ok, l, x = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${x ? ` — ${x}` : ""}`);
  if (!ok) failed = 1;
};

async function session() {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ erpUserId: `${P}-1`, erpRole: "ADMIN", name: "Clone Admin", email: "c@zz.test", schoolId: SCHOOL }),
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
      prisma.timetableSlot.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.timetableDraft.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.timetablePublication.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.electiveOption.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.electiveBlockMember.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.electiveBlock.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.mergedTeachingGroupMember.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.mergedTeachingGroup.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherSubjectClassSection.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherClassEligibility.deleteMany({ where: { schoolId: SCHOOL } }),
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
  // Small, but it contains one of everything the clone has to carry: a home
  // room, a class teacher, a merged group across two sections, a split elective
  // with two options, and one teacher who has since left.
  console.log("A timetable with one of everything the clone has to carry:");
  await prisma.school.create({ data: { id: SCHOOL, code: `${P}-SCHOOL`, name: `${P} Clone School` } });
  const role = await prisma.role.create({ data: { schoolId: SCHOOL, name: "Super Admin", isSystem: true } });
  const perms = await prisma.rolePermission.findMany({
    where: { role: { schoolId: 1, name: "Super Admin" } }, select: { permission: true },
  });
  await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permission: p.permission, schoolId: SCHOOL })) });
  await prisma.erpRoleMapping.create({ data: { schoolId: SCHOOL, erpRole: "ADMIN", roleId: role.id } });

  const year = await prisma.academicYear.create({
    data: { schoolId: SCHOOL, name: `${P} 25-26`, startDate: new Date("2025-04-01"), endDate: new Date("2026-03-31") },
  });
  const config = await prisma.timetableConfig.create({
    data: {
      schoolId: SCHOOL, name: `${P} Wing 25-26`, academicYearId: year.id,
      workingDays: [1, 2, 3, 4, 5], periodsPerDay: 6, periodDurationMins: 40,
      startTime: "08:00", extraPeriodsPerDay: 1, extraPeriodDurationMins: 30,
      description: "the source", status: "active",
    },
  });
  // Six teaching periods, a break, and the §18 extra window.
  await prisma.period.createMany({
    data: [
      ...Array.from({ length: 6 }, (_, i) => ({
        schoolId: SCHOOL, timetableConfigId: config.id, sortOrder: i + 1, periodNumber: i + 1,
        startTime: `0${8 + i}:00`.slice(-5), endTime: `0${8 + i}:40`.slice(-5), isBreak: false, isExtra: false,
      })),
      { schoolId: SCHOOL, timetableConfigId: config.id, sortOrder: 7, periodNumber: null, startTime: "14:00", endTime: "14:20", isBreak: true, isExtra: false, breakName: "Lunch" },
      { schoolId: SCHOOL, timetableConfigId: config.id, sortOrder: 8, periodNumber: 7, startTime: "14:20", endTime: "14:50", isBreak: false, isExtra: true },
    ],
  });

  const room = await prisma.room.create({ data: { schoolId: SCHOOL, name: `${P} Home`, roomType: "classroom" } });
  const langRoomA = await prisma.room.create({ data: { schoolId: SCHOOL, name: `${P} Lang A`, roomType: "classroom" } });
  const langRoomB = await prisma.room.create({ data: { schoolId: SCHOOL, name: `${P} Lang B`, roomType: "classroom" } });
  const hall = await prisma.room.create({ data: { schoolId: SCHOOL, name: `${P} Hall`, roomType: "auditorium", isShared: true } });

  const english = await prisma.subject.create({ data: { schoolId: SCHOOL, name: `${P} English` } });
  const maths = await prisma.subject.create({ data: { schoolId: SCHOOL, name: `${P} Maths` } });
  const pe = await prisma.subject.create({ data: { schoolId: SCHOOL, name: `${P} PE` } });
  const french = await prisma.subject.create({ data: { schoolId: SCHOOL, name: `${P} French` } });
  const sanskrit = await prisma.subject.create({ data: { schoolId: SCHOOL, name: `${P} Sanskrit` } });

  const cls = await prisma.schoolClass.create({ data: { schoolId: SCHOOL, name: `${P} Class 5`, sequence: 5 } });
  const secA = await prisma.section.create({ data: { classId: cls.id, name: "A", schoolId: SCHOOL } });
  const secB = await prisma.section.create({ data: { classId: cls.id, name: "B", schoolId: SCHOOL } });

  const mkTeacher = (code, extra = {}) =>
    prisma.teacher.create({
      data: {
        schoolId: SCHOOL, employeeCode: `${P}-${code}`, name: `${P} ${code}`,
        maxPeriodsPerDay: 6, maxPeriodsPerWeek: 30, minPeriodsPerDay: 0, ...extra,
      },
    });
  const tEnglish = await mkTeacher("English");
  const tMaths = await mkTeacher("Maths");
  const tPe = await mkTeacher("PE");
  const tFrench = await mkTeacher("French");
  const tSanskrit = await mkTeacher("Sanskrit");
  // The one who has left. Their Maths in 5-B must not be carried forward.
  const tGone = await mkTeacher("Gone", { isActive: false });

  const mkSection = (sectionId, classTeacherId) =>
    prisma.classSection.create({
      data: {
        schoolId: SCHOOL, classId: cls.id, sectionId, academicYearId: year.id,
        timetableConfigId: config.id, strength: 30, homeRoomId: room.id, classTeacherId,
      },
    });
  const csA = await mkSection(secA.id, tEnglish.id);
  const csB = await mkSection(secB.id, tMaths.id);

  for (const [subject, ppw] of [[english, 6], [maths, 6], [pe, 2], [french, 3]]) {
    await prisma.classSubject.create({
      data: { schoolId: SCHOOL, classId: cls.id, academicYearId: year.id, subjectId: subject.id, periodsPerWeek: ppw, maxPeriodsPerDay: 2 },
    });
  }

  const mkMapping = (teacherId, subjectId, classSectionId, periodsPerWeek, preferredRoomId = null) =>
    prisma.teacherSubjectClassSection.create({
      data: { schoolId: SCHOOL, teacherId, subjectId, classSectionId, periodsPerWeek, preferredRoomId },
    });
  await mkMapping(tEnglish.id, english.id, csA.id, 6);
  await mkMapping(tEnglish.id, english.id, csB.id, 6);
  await mkMapping(tMaths.id, maths.id, csA.id, 6, room.id);
  await mkMapping(tGone.id, maths.id, csB.id, 6);          // the departed teacher

  // A merged group: PE for both sections at once, in the hall.
  await prisma.mergedTeachingGroup.create({
    data: {
      schoolId: SCHOOL, subjectId: pe.id, teacherId: tPe.id, periodsPerWeek: 2, roomId: hall.id,
      members: { create: [{ schoolId: SCHOOL, classSectionId: csA.id }, { schoolId: SCHOOL, classSectionId: csB.id }] },
    },
  });

  // A §4.9 split elective: both sections free the same period, two options.
  await prisma.electiveBlock.create({
    data: {
      schoolId: SCHOOL, name: `${P} Third Language`, periodsPerWeek: 3, maxPeriodsPerDay: 1,
      placement: "same_period",
      members: { create: [{ schoolId: SCHOOL, classSectionId: csA.id }, { schoolId: SCHOOL, classSectionId: csB.id }] },
      options: {
        create: [
          { schoolId: SCHOOL, subjectId: french.id, teacherId: tFrench.id, roomId: langRoomA.id },
          { schoolId: SCHOOL, subjectId: sanskrit.id, teacherId: tSanskrit.id, roomId: langRoomB.id },
        ],
      },
    },
  });

  // Output the clone must NOT copy: a published slot and an §18 extra class.
  const draft = await prisma.timetableDraft.create({
    data: { schoolId: SCHOOL, timetableConfigId: config.id, draftNo: 1, label: "D1", status: "published" },
  });
  await prisma.timetableSlot.create({
    data: {
      schoolId: SCHOOL, timetableConfigId: config.id, draftId: draft.id, classSectionId: csA.id,
      subjectId: english.id, teacherId: tEnglish.id, roomId: room.id,
      dayOfWeek: 1, periodNumber: 1, status: "published", source: "auto",
    },
  });
  await prisma.extraClass.create({
    data: {
      schoolId: SCHOOL, timetableConfigId: config.id, classSectionId: csA.id, subjectId: maths.id,
      teacherId: tMaths.id, dayOfWeek: 1, periodNumber: 7, reason: "revision",
    },
  });

  const token = await session();
  check(Boolean(token), "signed in as an admin of the test school");

  // ------------------------------------------------------------- 1. PREVIEW
  console.log("\nThe preview counts every row and writes none of them:");
  const target = { name: `${P} CY 26-27`, startDate: "2026-04-01", endDate: "2027-03-31" };
  const before = {
    configs: await prisma.timetableConfig.count({ where: { schoolId: SCHOOL } }),
    years: await prisma.academicYear.count({ where: { schoolId: SCHOOL } }),
    sections: await prisma.classSection.count({ where: { schoolId: SCHOOL } }),
    curriculum: await prisma.classSubject.count({ where: { schoolId: SCHOOL } }),
    mappings: await prisma.teacherSubjectClassSection.count({ where: { schoolId: SCHOOL } }),
  };
  const prev = await call("POST", `/timetable-configs/${config.id}/clone/preview`, token, {
    name: `${P} Wing 26-27`, newYear: target,
  });
  check(prev.status === 200 || prev.status === 201, "preview accepted", `${prev.status}`);
  const plan = prev.json;
  check(plan?.counts?.periods === 8, "counts all 8 periods incl. break and extra window", `${plan?.counts?.periods}`);
  check(plan?.counts?.classSectionsNew === 2, "counts 2 new class-sections", `${plan?.counts?.classSectionsNew}`);
  check(plan?.counts?.curriculum === 4, "counts 4 curriculum rows", `${plan?.counts?.curriculum}`);
  check(plan?.counts?.mappings === 3, "counts 3 mappings — the departed teacher's is not among them", `${plan?.counts?.mappings}`);
  check(plan?.counts?.mergedGroups === 1, "counts the merged group", `${plan?.counts?.mergedGroups}`);
  check(plan?.counts?.electiveBlocks === 1 && plan?.counts?.electiveOptions === 2,
    "counts the elective block and both options", `${plan?.counts?.electiveBlocks}/${plan?.counts?.electiveOptions}`);
  check(plan?.counts?.classTeachers === 2, "counts both class teachers", `${plan?.counts?.classTeachers}`);
  const inactiveNote = (plan?.warnings ?? []).find((w) => w.code === "INACTIVE_TEACHER");
  check(Boolean(inactiveNote) && inactiveNote.rows.some((r) => r.includes("Gone")),
    "warns about the teacher who has left, by name", inactiveNote?.rows?.join(", "));
  check(typeof plan?.sourceReadiness === "number" || plan?.sourceReadiness === null,
    "reports what the source reads today", `${plan?.sourceReadiness}`);

  const after = {
    configs: await prisma.timetableConfig.count({ where: { schoolId: SCHOOL } }),
    years: await prisma.academicYear.count({ where: { schoolId: SCHOOL } }),
    sections: await prisma.classSection.count({ where: { schoolId: SCHOOL } }),
    curriculum: await prisma.classSubject.count({ where: { schoolId: SCHOOL } }),
    mappings: await prisma.teacherSubjectClassSection.count({ where: { schoolId: SCHOOL } }),
  };
  check(JSON.stringify(before) === JSON.stringify(after),
    "nothing was written — not even the new academic year", JSON.stringify(after));

  // -------------------------------------------------------------- 2. REFUSE
  console.log("\nA clone that cannot be correct is refused, with a reason:");
  const sameYear = await call("POST", `/timetable-configs/${config.id}/clone`, token, {
    name: `${P} Wing copy`, academicYearId: year.id,
  });
  check(sameYear.status === 400 && /DIFFERENT academic session/i.test(sameYear.json?.message ?? ""),
    "the same session is refused, naming why", (sameYear.json?.message ?? "").slice(0, 60));

  const nameTaken = await call("POST", `/timetable-configs/${config.id}/clone/preview`, token, {
    name: `${P} Wing 25-26`, academicYearId: year.id,
  });
  check(nameTaken.status === 400, "so is cloning onto its own name in its own session", `${nameTaken.status}`);

  const noTarget = await call("POST", `/timetable-configs/${config.id}/clone`, token, { name: `${P} Nowhere` });
  check(noTarget.status === 400, "and a clone with no target session", `${noTarget.status}`);

  // ---------------------------------------------------------------- 3. COPY
  console.log("\nThe clone lands, re-pointed at the new session's sections:");
  const made = await call("POST", `/timetable-configs/${config.id}/clone`, token, {
    name: `${P} Wing 26-27`, newYear: target,
  });
  check(made.status === 200 || made.status === 201, "clone accepted", `${made.status}`);
  const newId = made.json?.id;
  check(Number.isInteger(newId) && newId !== config.id, "a new timetable was created", `${newId}`);

  const clone = await prisma.timetableConfig.findUnique({
    where: { id: newId }, include: { periods: true, academicYear: true, classSections: { include: { section: true } } },
  });
  check(clone?.academicYear?.name === target.name, "in the new session", clone?.academicYear?.name);
  check(clone?.status === "draft", "as a draft, not wearing the source's 'active' badge", clone?.status);
  check(clone?.periods.length === 8, "with all 8 periods", `${clone?.periods.length}`);
  check(clone?.periods.filter((p) => p.isBreak).length === 1 && clone?.periods.filter((p) => p.isExtra).length === 1,
    "including the break and the §18 extra window");
  check(clone?.extraPeriodsPerDay === 1 && clone?.periodDurationMins === 40 && clone?.startTime === "08:00",
    "and the day's shape");
  check(clone?.classSections.length === 2, "2 class-sections", `${clone?.classSections.length}`);

  const newA = clone.classSections.find((cs) => cs.sectionId === secA.id);
  const newB = clone.classSections.find((cs) => cs.sectionId === secB.id);
  check(newA.id !== csA.id && newB.id !== csB.id, "which are new rows, not the source's");
  check(newA.homeRoomId === room.id && newA.strength === 30, "home room and strength came across");
  check(newA.classTeacherId === tEnglish.id && newB.classTeacherId === tMaths.id, "and both class teachers");

  const newCurriculum = await prisma.classSubject.findMany({ where: { academicYearId: clone.academicYearId } });
  check(newCurriculum.length === 4, "4 curriculum rows in the new session", `${newCurriculum.length}`);
  check(newCurriculum.every((r) => r.academicYearId === clone.academicYearId),
    "every one filed against the new session (§3.11)");

  const newMappings = await prisma.teacherSubjectClassSection.findMany({
    where: { classSectionId: { in: [newA.id, newB.id] } },
  });
  check(newMappings.length === 3, "3 mappings", `${newMappings.length}`);
  check(newMappings.every((m) => m.classSectionId === newA.id || m.classSectionId === newB.id),
    "all re-pointed at the NEW sections");
  check(newMappings.some((m) => m.preferredRoomId === room.id), "a preferred room survived the copy");

  const newGroups = await prisma.mergedTeachingGroup.findMany({
    where: { members: { some: { classSectionId: { in: [newA.id, newB.id] } } } }, include: { members: true },
  });
  check(newGroups.length === 1 && newGroups[0].members.length === 2, "the merged group, with both members");
  check(newGroups[0].roomId === hall.id, "still in the hall");
  check(newGroups[0].members.every((m) => m.classSectionId === newA.id || m.classSectionId === newB.id),
    "its members re-pointed too");

  const newBlocks = await prisma.electiveBlock.findMany({
    where: { members: { some: { classSectionId: { in: [newA.id, newB.id] } } } },
    include: { members: true, options: true },
  });
  check(newBlocks.length === 1, "the §4.9 elective block", `${newBlocks.length}`);
  check(newBlocks[0].options.length === 2, "with both its options", `${newBlocks[0].options.length}`);
  check(newBlocks[0].placement === "same_period", "and its placement rule (§4.9 Phase 15)", newBlocks[0].placement);
  check(new Set(newBlocks[0].options.map((o) => o.teacherId)).size === 2 &&
        new Set(newBlocks[0].options.map((o) => o.roomId)).size === 2,
    "each option keeping its own teacher and room");
  check(newBlocks[0].members.every((m) => m.classSectionId === newA.id || m.classSectionId === newB.id),
    "members re-pointed");

  // ----------------------------------------------------------------- 4. NOT
  console.log("\nThe generated timetable is deliberately NOT copied:");
  check((await prisma.timetableSlot.count({ where: { timetableConfigId: newId } })) === 0,
    "no slots — the point is to adjust and Generate");
  check((await prisma.timetableDraft.count({ where: { timetableConfigId: newId } })) === 0, "no drafts");
  check((await prisma.timetablePublication.count({ where: { timetableConfigId: newId } })) === 0, "no publications");
  check((await prisma.extraClass.count({ where: { timetableConfigId: newId } })) === 0,
    "and no extra classes — they run on dates, and next session's are not this session's");
  check((await prisma.timetableSlot.count({ where: { timetableConfigId: config.id } })) === 1,
    "the source's own published week is untouched");

  // --------------------------------------------------------------- 5. STAFF
  console.log("\nThe teacher who has left is left out, and the demand still shows:");
  check(!newMappings.some((m) => m.teacherId === tGone.id), "no mapping names them");
  check(newCurriculum.some((r) => r.subjectId === maths.id && r.periodsPerWeek === 6),
    "but the curriculum still asks for 6 periods of Maths, so Readiness will name the gap");
  check((made.json?.warnings ?? []).some((w) => w.code === "INACTIVE_TEACHER"),
    "and the response says so");

  // --------------------------------------------------------------- 6. APART
  console.log("\nThe two sessions do not contaminate each other:");
  const { buildFeasibilitySnapshot } = req("/app/apps/api/dist/solver/input.js");
  const snapNew = await buildFeasibilitySnapshot(prisma, newId);
  const snapOld = await buildFeasibilitySnapshot(prisma, config.id);
  check(snapNew.subjectRequirements.length === 4 && snapOld.subjectRequirements.length === 4,
    "each timetable sees exactly its own 4 curriculum rows",
    `${snapNew.subjectRequirements.length}/${snapOld.subjectRequirements.length}`);
  const crossNew = Object.values(snapNew.crossConfigTeacherLoad).reduce((n, v) => n + v.periods, 0);
  const crossOld = Object.values(snapOld.crossConfigTeacherLoad).reduce((n, v) => n + v.periods, 0);
  check(crossNew === 0 && crossOld === 0,
    "and neither counts the other's teaching against its capacity (§3.10, §3.11)",
    `new ${crossNew} · old ${crossOld}`);

  const listNew = await call("GET", `/mappings?academicYearId=${clone.academicYearId}`, token);
  const listOld = await call("GET", `/mappings?academicYearId=${year.id}`, token);
  check((listNew.json ?? []).length === 4 && (listOld.json ?? []).length === 5,
    "the Mapping screen shows one session at a time (3+group / 4+group)",
    `${(listNew.json ?? []).length} vs ${(listOld.json ?? []).length}`);
  const blocksNew = await call("GET", `/elective-blocks?academicYearId=${clone.academicYearId}`, token);
  check((blocksNew.json ?? []).length === 1,
    "and so does the Electives screen, which would otherwise show the same block twice",
    `${(blocksNew.json ?? []).length}`);

  // Re-cloning into the same target is refused on the name, so nothing doubles.
  const again = await call("POST", `/timetable-configs/${config.id}/clone`, token, {
    name: `${P} Wing 26-27`, newYear: target,
  });
  check(again.status === 400, "cloning again onto the same name is refused", `${again.status}`);

  // ----------------------------------------------------------------- cleanup
  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { id: SCHOOL } })) === 0, "test school removed");

  await prisma.$disconnect();
  console.log(failed ? "\nSOME CLONE CHECKS FAILED" : "\nALL CLONE CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
