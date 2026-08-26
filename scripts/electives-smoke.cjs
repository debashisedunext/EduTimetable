/**
 * Phase 10 (§4.9) — split electives, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/electives-smoke.cjs
 *
 * The property under test is the one `uq_class_slot` makes hard: **one slot,
 * several lessons**. Class 5's students all have their language period at the
 * same time, and go to French, Sanskrit or German. Every member section holds
 * that period open exactly once; the three lessons run underneath it with
 * three teachers in three rooms.
 *
 *   1. REFUSE   — the API rejects a block that cannot work, naming the row
 *   2. READY    — a well-formed block reaches 100% readiness
 *   3. SOLVE    — the worker places it, once per week, never twice in a day
 *   4. STORE    — member rows hold the cell, option rows hold the lessons
 *   5. GUARD    — the DB itself refuses a double-booked language teacher
 *   6. REPORT   — the teacher's own timetable shows the lesson, named by block
 *
 * Everything it creates is prefixed ZZELE and removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const P = "ZZELE";

let failed = 0;
const pass = (l, x = "") => console.log(`  PASS  ${l}${x ? ` — ${x}` : ""}`);
const fail = (l, x = "") => { console.log(`  FAIL  ${l}${x ? ` — ${x}` : ""}`); failed = 1; };
const check = (ok, l, x = "") => (ok ? pass(l, x) : fail(l, x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(schoolId) {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ erpUserId: `${P}-1`, erpRole: "ADMIN", name: "Elective Admin", email: "e@zz.test", schoolId }),
  });
  const { token } = await r.json();
  const cb = await fetch(`${API}/api/sso/callback?token=${token}`, { redirect: "manual" });
  return (cb.headers.get("location") || "").split("#token=")[1] ?? null;
}

async function call(method, path, token, body) {
  const res = await fetch(`${API}/api${path}`, {
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
  const SCHOOL = 99060;

  // ------------------------------------------------------------- fixture
  // A tiny school built to have exactly enough room: 2 sections, 5 days x 5
  // periods = 25 slots. 20 periods of ordinary curriculum leave 5 free, and a
  // 5-period language block fills them precisely — so any miscounting of the
  // block shows up immediately as an over- or under-flow.
  console.log("A school with one language block and no slack:");
  const purge = async () => {
    await prisma.$transaction([
      prisma.substitutionLog.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherAbsence.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.timetableSlot.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.timetablePublication.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.auditLog.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.aiChatLog.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.aiSettings.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherUnavailability.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.holiday.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.electiveOption.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.electiveBlockMember.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.electiveBlock.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherSubjectClassSection.deleteMany({ where: { schoolId: SCHOOL } }),
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
      prisma.user.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.erpRoleMapping.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.rolePermission.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.role.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.school.deleteMany({ where: { id: SCHOOL } }),
    ]);
  };
  await purge();

  await prisma.school.create({ data: { id: SCHOOL, code: `${P}-SCHOOL`, name: `${P} Language School` } });
  const role = await prisma.role.create({ data: { schoolId: SCHOOL, name: "Super Admin", isSystem: true } });
  const perms = await prisma.rolePermission.findMany({
    where: { role: { schoolId: 1, name: "Super Admin" } }, select: { permission: true },
  });
  await prisma.rolePermission.createMany({
    data: perms.map((p) => ({ roleId: role.id, permission: p.permission, schoolId: SCHOOL })),
  });
  await prisma.erpRoleMapping.create({ data: { schoolId: SCHOOL, erpRole: "ADMIN", roleId: role.id } });

  const year = await prisma.academicYear.create({
    data: { schoolId: SCHOOL, name: `${P} 26-27`, startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31") },
  });
  const config = await prisma.timetableConfig.create({
    data: { schoolId: SCHOOL, name: `${P} Wing`, academicYearId: year.id, workingDays: [1, 2, 3, 4, 5], periodsPerDay: 5 },
  });
  await prisma.period.createMany({
    data: [1, 2, 3, 4, 5].map((n) => ({
      schoolId: SCHOOL, timetableConfigId: config.id, sortOrder: n, periodNumber: n,
      startTime: `${String(7 + n).padStart(2, "0")}:00`, endTime: `${String(7 + n).padStart(2, "0")}:40`,
    })),
  });
  const cls = await prisma.schoolClass.create({ data: { schoolId: SCHOOL, name: `${P} V`, sequence: 5 } });
  const sections = [];
  for (const name of ["A", "B"]) {
    const sec = await prisma.section.create({ data: { classId: cls.id, name, schoolId: SCHOOL } });
    sections.push(await prisma.classSection.create({
      data: { classId: cls.id, sectionId: sec.id, academicYearId: year.id, schoolId: SCHOOL, timetableConfigId: config.id, strength: 30 },
    }));
  }

  // 4 ordinary subjects x 5 periods = 20, leaving exactly 5 for the block
  const core = [];
  for (const name of ["Maths", "English", "Science", "Hindi"]) {
    const subject = await prisma.subject.create({ data: { schoolId: SCHOOL, name: `${P} ${name}` } });
    const teacher = await prisma.teacher.create({
      data: { schoolId: SCHOOL, employeeCode: `${P}-${name}`, name: `${P} T.${name}`, maxPeriodsPerDay: 5, maxPeriodsPerWeek: 30 },
    });
    await prisma.classSubject.create({
      data: { schoolId: SCHOOL, classId: cls.id, subjectId: subject.id, periodsPerWeek: 5, maxPeriodsPerDay: 2 },
    });
    for (const cs of sections) {
      await prisma.teacherSubjectClassSection.create({
        data: { schoolId: SCHOOL, teacherId: teacher.id, subjectId: subject.id, classSectionId: cs.id, periodsPerWeek: 5 },
      });
    }
    core.push({ subject, teacher });
  }

  const langs = [];
  for (const name of ["French", "Sanskrit", "German"]) {
    langs.push({
      subject: await prisma.subject.create({ data: { schoolId: SCHOOL, name: `${P} ${name}` } }),
      teacher: await prisma.teacher.create({
        data: { schoolId: SCHOOL, employeeCode: `${P}-${name}`, name: `${P} T.${name}`, maxPeriodsPerDay: 5, maxPeriodsPerWeek: 30 },
      }),
      room: await prisma.room.create({ data: { schoolId: SCHOOL, name: `${P} ${name} Room`, roomType: "classroom" } }),
    });
  }

  // Class teachers, so the readiness assertion below is about the block and
  // not about two unrelated CT_UNASSIGNED warnings.
  for (let i = 0; i < sections.length; i++) {
    await prisma.classSection.update({
      where: { id: sections[i].id },
      data: { classTeacherId: core[i].teacher.id },
    });
  }

  const token = await session(SCHOOL);
  check(Boolean(token), "admin session for the school");

  // ------------------------------------------------------------ 1. REFUSE
  console.log("\nThe API refuses a block that could not work, and says why:");
  const members = sections.map((s) => s.id);
  const optionsOf = (list) => list.map((l) => ({ subjectId: l.subject.id, teacherId: l.teacher.id, roomId: l.room.id }));

  const oneOption = await call("POST", "/elective-blocks", token, {
    name: `${P} One`, periodsPerWeek: 5, classSectionIds: members, options: optionsOf([langs[0]]),
  });
  check(oneOption.status === 400 && /at least 2 options/.test(oneOption.text),
    "a block with one option is not a choice", `${oneOption.status}`);

  const sameTeacher = await call("POST", "/elective-blocks", token, {
    name: `${P} Clash`, periodsPerWeek: 5, classSectionIds: members,
    options: [
      { subjectId: langs[0].subject.id, teacherId: langs[0].teacher.id, roomId: langs[0].room.id },
      { subjectId: langs[1].subject.id, teacherId: langs[0].teacher.id, roomId: langs[1].room.id },
    ],
  });
  check(sameTeacher.status === 400 && /same teacher/.test(sameTeacher.text),
    "one teacher cannot take two options at once", `${sameTeacher.status}`);

  const tooLong = await call("POST", "/elective-blocks", token, {
    name: `${P} TooLong`, periodsPerWeek: 30, classSectionIds: members, options: optionsOf(langs),
  });
  check(tooLong.status === 400, "a block longer than the week is refused", `${tooLong.status}`);

  // ------------------------------------------------------------- 2. READY
  console.log("\nA well-formed block reaches 100% readiness:");
  const created = await call("POST", "/elective-blocks", token, {
    name: `${P} Third Language`, periodsPerWeek: 5, maxPeriodsPerDay: 1,
    classSectionIds: members, options: optionsOf(langs),
  });
  check(created.status === 201, "the block was created", `${created.status}`);
  const blockId = created.json?.id;

  const readiness = await call("GET", `/timetable-configs/${config.id}/readiness`, token);
  check(readiness.json?.ready === true && readiness.json?.score === 100,
    "readiness is 100% with the block counted",
    `score ${readiness.json?.score}, ${readiness.json?.blockers?.length ?? "?"} blocker(s)${
      readiness.json?.blockers?.length ? `: ${readiness.json.blockers[0].message}` : ""
    }`);

  // Proof the block's periods are actually counted: drop one core subject by a
  // period and the section should now be UNDER-filled, not exactly full.
  // Through the API, not straight into the database: readiness is cached and
  // invalidated by the masters endpoints, so a direct write would be measured
  // against a stale score and the assertion would prove nothing.
  const spare = await prisma.classSubject.findFirst({ where: { schoolId: SCHOOL, classId: cls.id } });
  await call("PUT", `/class-subjects/${spare.id}`, token, { periodsPerWeek: 4 });
  const loose = await call("GET", `/timetable-configs/${config.id}/readiness`, token);
  const underflow = (loose.json?.warnings ?? []).filter((w) => w.code === "SLOT_UNDERFLOW");
  check(underflow.length === 2, "the block's periods count toward each member section's week",
    `${underflow.length} section(s) reported free slots after freeing one period`);
  await call("PUT", `/class-subjects/${spare.id}`, token, { periodsPerWeek: 5 });
  await prisma.teacherSubjectClassSection.updateMany({ where: { schoolId: SCHOOL, subjectId: spare.subjectId }, data: { periodsPerWeek: 5 } });

  // ------------------------------------------------------------- 3. SOLVE
  console.log("\nThe worker places the block:");
  const gen = await call("POST", `/timetable-configs/${config.id}/generate`, token, { mode: "fast" });
  check(gen.status === 201, "generation queued", `${gen.status} ${gen.text.slice(0, 80)}`);

  let state = null;
  for (let i = 0; i < 60 && state !== "completed" && state !== "failed"; i++) {
    await sleep(500);
    state = (await call("GET", `/timetable-configs/${config.id}/generate/latest`, token)).json?.state ?? null;
  }
  check(state === "completed", "the worker finished", `${state}`);

  // -------------------------------------------------------------- 4. STORE
  console.log("\nOne slot per section, three lessons underneath:");
  const slots = await prisma.timetableSlot.findMany({ where: { schoolId: SCHOOL, status: "draft" } });
  const memberRows = slots.filter((s) => s.electiveBlockId === blockId && s.classSectionId !== null);
  const optionRows = slots.filter((s) => s.electiveBlockId === blockId && s.classSectionId === null);

  check(memberRows.length === 10, "each member section holds the block period open, once per occurrence",
    `${memberRows.length} member row(s) — expected 2 sections x 5 periods`);
  check(optionRows.length === 15, "every option is written as its own lesson",
    `${optionRows.length} option row(s) — expected 3 languages x 5 periods`);
  check(memberRows.every((r) => r.subjectId === null && r.teacherId === null && r.roomId === null),
    "member rows carry no subject or teacher — the lessons do");
  check(optionRows.every((r) => r.teacherId !== null && r.roomId !== null && r.electiveOptionId !== null),
    "option rows carry their own teacher, room and option id");

  // the occurrences share a (day, period) across every member and every option
  const cells = new Map();
  for (const r of [...memberRows, ...optionRows]) {
    const k = `${r.dayOfWeek}:${r.periodNumber}`;
    cells.set(k, (cells.get(k) ?? 0) + 1);
  }
  check(cells.size === 5, "the block occupies exactly 5 cells in the week", `${cells.size} distinct (day, period)`);
  check([...cells.values()].every((n) => n === 5), "and each is one row per member plus one per option",
    `${[...cells.values()].join(", ")} rows per cell`);
  check(new Set([...cells.keys()].map((k) => k.split(":")[0])).size === 5,
    "max 1/day is honoured — the five occurrences fall on five different days");

  // nothing else is scheduled for those sections in the block's cells
  const clash = slots.filter(
    (s) => s.electiveBlockId === null && s.classSectionId !== null && cells.has(`${s.dayOfWeek}:${s.periodNumber}`),
  );
  check(clash.length === 0, "no ordinary lesson was scheduled opposite the block", `${clash.length} clash(es)`);

  // -------------------------------------------------------------- 5. GUARD
  console.log("\nThe database itself refuses a double-booked language teacher:");
  const anyOption = optionRows[0];
  let refused = false;
  try {
    await prisma.timetableSlot.create({
      data: {
        schoolId: SCHOOL, timetableConfigId: config.id, status: "draft",
        classSectionId: sections[0].id, dayOfWeek: anyOption.dayOfWeek, periodNumber: anyOption.periodNumber + 100,
        subjectId: anyOption.subjectId, teacherId: anyOption.teacherId, roomId: null,
        teacherOccupancyKey: anyOption.teacherOccupancyKey, source: "manual",
      },
    });
    // different period, so this one is allowed — now try the SAME cell
    await prisma.timetableSlot.create({
      data: {
        schoolId: SCHOOL, timetableConfigId: config.id, status: "draft",
        classSectionId: sections[0].id, dayOfWeek: anyOption.dayOfWeek, periodNumber: anyOption.periodNumber,
        subjectId: anyOption.subjectId, teacherId: anyOption.teacherId, roomId: null,
        teacherOccupancyKey: anyOption.teacherOccupancyKey, source: "manual",
      },
    });
  } catch (e) {
    refused = /uq_teacher_slot|Unique constraint/.test(String(e.message));
  }
  check(refused, "uq_teacher_slot still fires for an option row's teacher",
    refused ? "the NULL class-section does not weaken it" : "the write was allowed");
  await prisma.timetableSlot.deleteMany({ where: { schoolId: SCHOOL, source: "manual" } });

  // ------------------------------------------------------------- 6. REPORT
  console.log("\nThe language teacher's own timetable shows the lesson:");
  await call("POST", `/timetable-configs/${config.id}/board/publish`, token);
  const report = await call("GET", `/reports/teacher/${langs[0].teacher.id}`, token);
  const grid = JSON.stringify(report.json ?? {});
  check(report.status === 200 && grid.includes(`${P} Third Language`),
    "named by its block, since it belongs to no single section",
    report.status === 200 ? "block name present in the grid" : `${report.status}`);

  // ------------------------------------------------------------------ cleanup
  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { id: SCHOOL } })) === 0, "test school removed");

  await prisma.$disconnect();
  console.log(failed ? "\nSOME ELECTIVE CHECKS FAILED" : "\nALL ELECTIVE CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
