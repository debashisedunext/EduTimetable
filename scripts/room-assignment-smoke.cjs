/**
 * Phase 12 (§19) — fixed rooms, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/room-assignment-smoke.cjs
 *
 * Two things were recorded and never used. `class_sections.home_room_id` has
 * existed since Phase 1 and the solver wrote `room_id = NULL` on every ordinary
 * lesson, so a school that carefully noted which room Class 1-A sits in got a
 * timetable that never mentioned it. And `findFreeLab` took *any* free lab, so
 * a biology period could be sent to the physics lab because it happened to be
 * empty.
 *
 *   1. SET      — both mappings are settable from the Rooms screen
 *   2. GUARD    — one room cannot be home to two class-sections
 *   3. CHECK 9  — the engine names a shared room and an unserved lab subject
 *   4. HOME     — every ordinary lesson lands in its own section's room
 *   5. LAB      — a lab subject lands in a lab that teaches it, never another's
 *   6. GENERAL  — a lab with no subjects listed still serves everything
 *
 * Everything it creates is prefixed ZZROOM and removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { groupFor } = require("./resource-groups.cjs");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const P = "ZZROOM";
const SCHOOL = 99080;

let failed = 0;
const check = (ok, l, x = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${x ? ` — ${x}` : ""}`);
  if (!ok) failed = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session() {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ erpUserId: `${P}-1`, erpRole: "ADMIN", name: "Room Admin", email: "r@zz.test", schoolId: SCHOOL }),
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
      prisma.timetablePublication.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherSubjectClassSection.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherClassEligibility.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.classSubject.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.classSection.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.section.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.period.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.timetableConfig.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.schoolClass.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacher.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.roomSubject.deleteMany({ where: { schoolId: SCHOOL } }),
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

  // ----------------------------------------------------------------- fixture
  // Two sections, five periods a day. Each takes Maths (a normal subject) and
  // Biology (a lab subject) — and there are two labs, one for Biology and one
  // for Physics, so "any free lab" and "the right lab" give different answers.
  console.log("Two sections, two labs, and only one of them teaches Biology:");
  await prisma.school.create({ data: { id: SCHOOL, code: `${P}-SCHOOL`, name: `${P} Room School` } });
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
    data: {
      resourceGroupId: await groupFor(prisma, year.id), schoolId: SCHOOL, name: `${P} Wing`, academicYearId: year.id, workingDays: [1, 2, 3, 4, 5], periodsPerDay: 5 },
  });
  await prisma.period.createMany({
    data: [1, 2, 3, 4, 5].map((n) => ({
      schoolId: SCHOOL, timetableConfigId: config.id, sortOrder: n, periodNumber: n,
      startTime: `${String(7 + n).padStart(2, "0")}:00`, endTime: `${String(7 + n).padStart(2, "0")}:40`,
    })),
  });
  const cls = await prisma.schoolClass.create({ data: { schoolId: SCHOOL, name: `${P} IX`, sequence: 9 } });
  const sections = [];
  for (const name of ["A", "B"]) {
    const sec = await prisma.section.create({ data: { classId: cls.id, name, schoolId: SCHOOL } });
    sections.push(await prisma.classSection.create({
      data: {
        resourceGroupId: await groupFor(prisma, year.id), classId: cls.id, sectionId: sec.id, academicYearId: year.id, schoolId: SCHOOL, timetableConfigId: config.id, strength: 30 },
    }));
  }

  const maths = await prisma.subject.create({ data: { schoolId: SCHOOL, name: `${P} Maths` } });
  const bio = await prisma.subject.create({ data: { schoolId: SCHOOL, name: `${P} Biology`, isLab: true } });
  await prisma.classSubject.create({ data: { schoolId: SCHOOL, classId: cls.id, academicYearId: year.id, subjectId: maths.id, periodsPerWeek: 20, maxPeriodsPerDay: 4 } });
  await prisma.classSubject.create({ data: { schoolId: SCHOOL, classId: cls.id, academicYearId: year.id, subjectId: bio.id, periodsPerWeek: 5, maxPeriodsPerDay: 1 } });

  // One teacher per (subject, section): 20 Maths periods against a 25-period
  // capacity is 80%, comfortably under the tightness warning, so the readiness
  // assertions below are about rooms and nothing else.
  for (const [subject, code, periods] of [[maths, "M", 20], [bio, "B", 5]]) {
    for (const [i, cs] of sections.entries()) {
      const t = await prisma.teacher.create({
        data: {
          schoolId: SCHOOL, employeeCode: `${P}-${code}${i}`, name: `${P} T.${code}${i}`,
          maxPeriodsPerDay: 5, maxPeriodsPerWeek: 40,
          eligibility: { create: [{ classId: cls.id, schoolId: SCHOOL }] },
        },
      });
      await prisma.teacherSubjectClassSection.create({
        data: { schoolId: SCHOOL, teacherId: t.id, subjectId: subject.id, classSectionId: cs.id, periodsPerWeek: periods },
      });
    }
  }

  const token = await session();
  check(Boolean(token), "admin session");

  // --------------------------------------------------------------- 1. SET
  console.log("\nBoth mappings are set from the Rooms screen:");
  const roomA = await call("POST", "/rooms", token, {
    name: `${P} Room 1`, roomType: "classroom", capacity: 40, homeForIds: [sections[0].id],
  });
  const roomB = await call("POST", "/rooms", token, {
    name: `${P} Room 2`, roomType: "classroom", capacity: 40, homeForIds: [sections[1].id],
  });
  check(roomA.status === 201 && roomB.status === 201, "a room can be created as a class-section's home room",
    `${roomA.status}/${roomB.status}`);

  const bioLab = await call("POST", "/rooms", token, {
    name: `${P} Bio Lab`, roomType: "lab", subjectIds: [bio.id],
  });
  const physLab = await call("POST", "/rooms", token, {
    name: `${P} Physics Lab`, roomType: "lab", subjectIds: [],
  });
  check(bioLab.status === 201 && physLab.status === 201, "and a lab can be set up for a subject");

  const listed = await call("GET", "/rooms", token);
  const shown = (listed.json ?? []).find((r) => r.name === `${P} Room 1`);
  const labShown = (listed.json ?? []).find((r) => r.name === `${P} Bio Lab`);
  check(shown?.homeForLabels?.length === 1, "the list reports which class sits where", shown?.homeForLabels?.join(", "));
  check(labShown?.subjectNames?.includes(`${P} Biology`), "and what each lab is set up for", labShown?.subjectNames?.join(", "));

  // ------------------------------------------------------------- 2. GUARD
  console.log("\nOne room cannot be home to two class-sections:");
  const both = await call("PUT", `/rooms/${roomA.json.id}`, token, { homeForIds: [sections[0].id, sections[1].id] });
  check(both.status === 400 && /one class-section/.test(both.text), "refused, with both named",
    (both.json?.message ?? "").slice(0, 110));

  // ----------------------------------------------------------- 3. CHECK 9
  console.log("\nThe Feasibility Engine catches what the screen did not:");
  // Set straight in the database, as an older build or the Class-Sections
  // screen could: both sections pointed at one room.
  await call("PUT", `/class-sections/${sections[1].id}`, token, { homeRoomId: roomA.json.id });
  let rd = await call("GET", `/timetable-configs/${config.id}/readiness`, token);
  const shared = (rd.json?.blockers ?? []).find((b) => b.code === "HOME_ROOM_SHARED");
  check(Boolean(shared), "a shared home room is a blocker naming both sections", shared?.message?.slice(0, 100));
  await call("PUT", `/class-sections/${sections[1].id}`, token, { homeRoomId: roomB.json.id });

  // Point both labs at Maths, so nothing serves Biology. Through the API, not
  // straight into the database: readiness is cached and invalidated by the
  // masters endpoints, so a direct write would be measured against a stale
  // score and the assertion would prove nothing.
  await call("PUT", `/rooms/${bioLab.json.id}`, token, { subjectIds: [maths.id] });
  await call("PUT", `/rooms/${physLab.json.id}`, token, { subjectIds: [maths.id] });
  rd = await call("GET", `/timetable-configs/${config.id}/readiness`, token);
  const unserved = (rd.json?.blockers ?? []).find((b) => b.code === "LAB_SUBJECT_UNSERVED");
  check(Boolean(unserved), "a lab subject no lab teaches is a blocker",
    unserved?.message?.slice(0, 100) ?? `got: ${(rd.json?.blockers ?? []).map((b) => b.code).join(", ") || "none"}`);

  // Put it back: Bio Lab teaches Biology, Physics Lab teaches Maths.
  await call("PUT", `/rooms/${bioLab.json.id}`, token, { subjectIds: [bio.id] });
  await call("PUT", `/rooms/${physLab.json.id}`, token, { subjectIds: [maths.id] });

  rd = await call("GET", `/timetable-configs/${config.id}/readiness`, token);
  check(rd.json?.ready === true, "with both mapped properly, readiness is clean",
    `score ${rd.json?.score}, ${(rd.json?.blockers ?? []).map((b) => b.message.slice(0, 70)).join(" | ") || "0 blockers"}`);

  // -------------------------------------------------------- 4/5. GENERATE
  console.log("\nThe generated timetable puts every lesson where it belongs:");
  await call("POST", `/timetable-configs/${config.id}/generate`, token, { mode: "fast" });
  let state = null;
  for (let i = 0; i < 60 && state !== "completed" && state !== "failed"; i++) {
    await sleep(500);
    state = (await call("GET", `/timetable-configs/${config.id}/generate/latest`, token)).json?.state ?? null;
  }
  check(state === "completed", "generation finished", `${state}`);

  const slots = await prisma.timetableSlot.findMany({ where: { schoolId: SCHOOL, status: "draft" } });
  const homeOf = new Map([[sections[0].id, roomA.json.id], [sections[1].id, roomB.json.id]]);

  const mathsSlots = slots.filter((s) => s.subjectId === maths.id);
  const inOwnRoom = mathsSlots.filter((s) => s.roomId === homeOf.get(s.classSectionId));
  check(mathsSlots.length === 40 && inOwnRoom.length === 40,
    "every ordinary lesson is in its own class-section's room",
    `${inOwnRoom.length} of ${mathsSlots.length}`);

  const bioSlots = slots.filter((s) => s.subjectId === bio.id);
  check(bioSlots.length === 10 && bioSlots.every((s) => s.roomId === bioLab.json.id),
    "every Biology period is in the Bio Lab, never the Physics Lab",
    `${bioSlots.filter((s) => s.roomId === bioLab.json.id).length} of ${bioSlots.length}`);
  check(bioSlots.every((s) => s.roomId !== homeOf.get(s.classSectionId)),
    "and the section leaves its own room to get there");

  // The two sections cannot both be in the one Bio Lab at once — the room is
  // now claimed, so this is enforced rather than assumed.
  const labCells = bioSlots.map((s) => `${s.dayOfWeek}:${s.periodNumber}`);
  check(new Set(labCells).size === labCells.length, "the two sections never share the lab in one period",
    `${labCells.length} lab period(s), all distinct`);

  // -------------------------------------------------------------- 6. GENERAL
  console.log("\nA lab with no subjects listed still serves everything:");
  await call("PUT", `/rooms/${bioLab.json.id}`, token, { subjectIds: [] });
  await call("PUT", `/rooms/${physLab.json.id}`, token, { subjectIds: [] });
  rd = await call("GET", `/timetable-configs/${config.id}/readiness`, token);
  check(rd.json?.ready === true, "the pre-§19 arrangement is still feasible",
    `score ${rd.json?.score}, ${(rd.json?.blockers ?? []).map((b) => b.code).join(", ") || "0 blockers"}`);

  // ------------------------------------------------------------------ cleanup
  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { id: SCHOOL } })) === 0, "test school removed");

  await prisma.$disconnect();
  console.log(failed ? "\nSOME ROOM CHECKS FAILED" : "\nALL ROOM CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
