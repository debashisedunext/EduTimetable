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
 *   5b. TEACHER — a teacher who ONLY takes an option is still in the payload
 *   5c. DRAG    — the whole block moves as one card on the Draft Board (Ph 16)
 *   6. REPORT   — the teacher's own timetable shows the lesson, named by block

 *   7. CLASS    — and the CLASS's own week names every option, not a free cell
 *   8. PIN      — a fixed block lands on the cells the school chose (Phase 15)
 *
 * Everything it creates is prefixed ZZELE and removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { groupFor } = require("./resource-groups.cjs");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const P = "ZZELE";

let failed = 0;
const pass = (l, x = "") => console.log(`  PASS  ${l}${x ? ` — ${x}` : ""}`);
const fail = (l, x = "") => { console.log(`  FAIL  ${l}${x ? ` — ${x}` : ""}`); failed = 1; };
const check = (ok, l, x = "") => (ok ? pass(l, x) : fail(l, x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * §22 Phase 17 — every generation writes into its OWN named draft, so a raw
 * database read of `status:'draft'` now spans several alternative futures at
 * once. Scope to the live one, exactly as the endpoints do.
 */
async function liveDraft(prisma, configId) {
  const d = await prisma.timetableDraft.findFirst({
    where: { timetableConfigId: configId, status: "draft" },
    orderBy: { draftNo: "desc" },
    select: { id: true },
  });
  return d?.id ?? null;
}

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
      prisma.timetableDraft.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.electiveOption.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.electiveBlockMember.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.electiveBlock.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherClassEligibility.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherSubjectClassSection.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.roomSubject.deleteMany({ where: { schoolId: SCHOOL } }),
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
    data: {
      resourceGroupId: await groupFor(prisma, year.id), schoolId: SCHOOL, name: `${P} Wing`, academicYearId: year.id, workingDays: [1, 2, 3, 4, 5], periodsPerDay: 5 },
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
    // §19: its own room, or Check 9 warns that this section's lessons will
    // show no room and the readiness assertion below measures that instead.
    const home = await prisma.room.create({
      data: { schoolId: SCHOOL, name: `${P} Room ${name}`, roomType: "classroom" },
    });
    sections.push(await prisma.classSection.create({
      data: {
        resourceGroupId: await groupFor(prisma, year.id),
        classId: cls.id, sectionId: sec.id, academicYearId: year.id, schoolId: SCHOOL,
        timetableConfigId: config.id, strength: 30, homeRoomId: home.id,
      },
    }));
  }

  // 4 ordinary subjects x 5 periods = 20, leaving exactly 5 for the block
  const core = [];
  for (const name of ["Maths", "English", "Science", "Hindi"]) {
    const subject = await prisma.subject.create({ data: { schoolId: SCHOOL, name: `${P} ${name}` } });
    const teacher = await prisma.teacher.create({
      // §18 teaching scope: without it every teacher trips the aggregated
      // TEACHER_SCOPE_UNSET warning and the readiness assertion below would be
      // measuring that instead of the block.
      data: {
        schoolId: SCHOOL, employeeCode: `${P}-${name}`, name: `${P} T.${name}`,
        maxPeriodsPerDay: 5, maxPeriodsPerWeek: 30,
        eligibility: { create: [{ classId: cls.id, schoolId: SCHOOL }] },
      },
    });
    await prisma.classSubject.create({
      data: { schoolId: SCHOOL, classId: cls.id, academicYearId: year.id, subjectId: subject.id, periodsPerWeek: 5, maxPeriodsPerDay: 2 },
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
        data: {
          schoolId: SCHOOL, employeeCode: `${P}-${name}`, name: `${P} T.${name}`,
          maxPeriodsPerDay: 5, maxPeriodsPerWeek: 30,
          // §20: these three run one block at one period a day, so a
          // three-period day is arithmetically impossible for them and the
          // default minimum of 3 would (correctly) raise MIN_DAY_RELAXED — the
          // readiness assertion below would then be measuring that rather than
          // the block. A school with a single-class language teacher sets this
          // to 1 for exactly the same reason.
          minPeriodsPerDay: 1,
          eligibility: { create: [{ classId: cls.id, schoolId: SCHOOL }] },
        },
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
  const draftId = await liveDraft(prisma, config.id);
  const slots = await prisma.timetableSlot.findMany({
    where: { schoolId: SCHOOL, status: "draft", OR: [{ draftId }, { source: "extra" }] },
  });
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
        schoolId: SCHOOL, timetableConfigId: config.id, status: "draft", draftId,
        classSectionId: sections[0].id, dayOfWeek: anyOption.dayOfWeek, periodNumber: anyOption.periodNumber + 100,
        subjectId: anyOption.subjectId, teacherId: anyOption.teacherId, roomId: null,
        teacherOccupancyKey: anyOption.teacherOccupancyKey, source: "manual",
      },
    });
    // different period, so this one is allowed — now try the SAME cell
    await prisma.timetableSlot.create({
      data: {
        schoolId: SCHOOL, timetableConfigId: config.id, status: "draft", draftId,
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

  // ------------------------------------------ 5b. THE TEACHER'S OWN SCHEDULE
  //
  // These three teach NOTHING but their elective option — the real shape of a
  // third-language teacher. Their lessons are option rows with no section, so
  // any screen that builds a teacher's week out of *section* cells shows them
  // as entirely unscheduled. That is what the Allocation Matrix's By Teacher
  // grid and the Draft Board's By Teacher view both did: the `/slots` payload
  // dropped option rows server-side, and both dimensions read the same
  // payload. Asserted here at the payload, because that is where it was lost.
  //
  // Before the publish in step 6, deliberately: publishing turns every draft
  // row into a published one, so `?status=draft` afterwards is empty and this
  // would pass or fail for a reason that has nothing to do with electives.
  console.log("\nA teacher who ONLY takes an elective option is still scheduled:");
  const onlyElective = langs[0].teacher.id;
  const mine = await prisma.teacherSubjectClassSection.count({ where: { teacherId: onlyElective } });
  check(mine === 0, "the fixture teacher really has no ordinary mapping", `${mine} mapping(s)`);

  const payload = await call("GET", `/timetable-configs/${config.id}/slots?status=draft`, token);
  const tuples = payload.json?.slots ?? [];
  const theirs = tuples.filter((t) => t[4] === onlyElective);
  check(theirs.length === 5, "their five lessons are in the slots payload",
    `${theirs.length} tuple(s) — By Teacher renders from these`);
  // `every` on an empty array is true, so this must require the rows exist —
  // otherwise it passes for exactly the bug it is here to catch.
  check(theirs.length > 0 && theirs.every((t) => t[0] === null && t[9] !== null && t[3] !== null && t[5] !== null),
    "carried as option rows: no section, but a block, a subject and a room",
    theirs.length ? `subject ${theirs[0][3]}, room ${theirs[0][5]}, block ${theirs[0][9]}` : "none");
  check(Boolean(payload.json?.teachers?.[String(onlyElective)]),
    "and they are named in the payload, so the By Teacher picker offers them");

  // The other half of the same rule: an option row must NOT become a cell in
  // a section's grid. Both dimensions read this one payload, so a fix that
  // simply stopped filtering would put a phantom card in every section.
  const sectionCells = tuples.filter((t) => t[0] !== null);
  check(sectionCells.every((t) => t[3] !== null || t[9] !== null),
    "every section-grid tuple is a real cell — no option row leaked into one");

  // ------------------------------------------------- 5c. DRAGGING THE BLOCK
  //
  // Phase 16. A block used to be an immovable "reserved" cell on the Draft
  // Board — the board knew it was taken and refused every drag. It is a card
  // now, and it moves as ONE unit: every member row and every option row
  // together, or not at all.
  //
  // Before the publish in step 6, for the same reason as 5b: publishing
  // turns every draft row into a published one, and there is no draft left
  // to drag.
  //
  // Asserted against the stored rows, not the endpoint's reply: a response
  // saying "ok" while half the rows stayed behind is exactly the failure that
  // matters, and `uq_teacher_slot` would only catch some of it.
  console.log("\nThe whole block moves as one card:");
  const blockCellsBefore = await prisma.timetableSlot.findMany({
    where: { schoolId: SCHOOL, status: "draft", draftId, electiveBlockId: blockId },
    orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
  });
  const srcCell = { day: blockCellsBefore[0].dayOfWeek, period: blockCellsBefore[0].periodNumber };
  const rowsAtFirst = blockCellsBefore.filter(
    (r) => r.dayOfWeek === srcCell.day && r.periodNumber === srcCell.period,
  );
  const optionIds = rowsAtFirst
    .map((r) => r.electiveOptionId)
    .filter((x) => x !== null)
    .sort((a, b) => a - b);
  check(rowsAtFirst.length === 5, "the source cell holds 2 member + 3 option rows", `${rowsAtFirst.length}`);

  // Every cell of the week the block does not already occupy, so the target is
  // a genuine group swap: this school is 100% full, nothing is free.
  const taken = new Set(blockCellsBefore.map((r) => `${r.dayOfWeek}:${r.periodNumber}`));
  const target = [1, 2, 3, 4, 5]
    .flatMap((d) => [1, 2, 3, 4, 5].map((pp) => ({ day: d, period: pp })))
    .find((c) => !taken.has(`${c.day}:${c.period}`));

  const dragged = await call("POST", `/timetable-configs/${config.id}/board/swap-group`, token, {
    from: { electiveBlockId: blockId, day: srcCell.day, period: srcCell.period },
    expect: { electiveOptionIds: optionIds },
    to: target,
  });
  check(dragged.status === 201, "the drag was accepted", `${dragged.status} ${dragged.text.slice(0, 110)}`);

  const atTarget = await prisma.timetableSlot.findMany({
    where: {
      schoolId: SCHOOL, status: "draft", draftId, electiveBlockId: blockId,
      dayOfWeek: target.day, periodNumber: target.period,
    },
  });
  check(atTarget.length === 5, "all five rows landed on the target together",
    `${atTarget.length} row(s) at ${target.day}:${target.period}`);
  check(atTarget.filter((r) => r.classSectionId !== null).length === 2
     && atTarget.filter((r) => r.electiveOptionId !== null).length === 3,
    "still 2 member rows and 3 option rows — the shape survived the move");
  check(atTarget.filter((r) => r.electiveOptionId !== null).every((r) => r.roomId !== null),
    "each option kept its own room — three languages did not collapse into one");

  const leftBehind = await prisma.timetableSlot.count({
    where: {
      schoolId: SCHOOL, status: "draft", draftId, electiveBlockId: blockId,
      dayOfWeek: srcCell.day, periodNumber: srcCell.period,
    },
  });
  check(leftBehind === 0, "and nothing was left behind at the source", `${leftBehind} orphan row(s)`);

  // The other half of a swap: what was at the target came back.
  const displaced = await prisma.timetableSlot.findMany({
    where: {
      schoolId: SCHOOL, status: "draft", draftId, electiveBlockId: null,
      dayOfWeek: srcCell.day, periodNumber: srcCell.period,
    },
  });
  check(displaced.length === 2, "the lessons it displaced moved the other way",
    `${displaced.length} lesson(s) now at the block's old cell`);

  // The school was 100% full and every section must still be exactly full —
  // a swap that dropped or duplicated a lesson shows up here and nowhere else.
  const total = await prisma.timetableSlot.count({
    where: { schoolId: SCHOOL, status: "draft", draftId, classSectionId: { not: null }, source: { not: "extra" } },
  });
  check(total === 50, "every section is still exactly full — nothing lost or duplicated",
    `${total} section cells, expected 2 sections x 25`);

  // An impossible drag must be refused with a reason, not half-applied. The
  // block is capped at 1/day, so any cell on a day it already runs is illegal
  // — the rule that belongs to the BLOCK rather than to any of its subjects.
  const nowAt = await prisma.timetableSlot.findMany({
    where: { schoolId: SCHOOL, status: "draft", draftId, electiveBlockId: blockId, classSectionId: null },
    distinct: ["dayOfWeek", "periodNumber"],
  });
  const busyDay = nowAt.find((r) => r.dayOfWeek !== target.day);
  const sameDayCell = [1, 2, 3, 4, 5]
    .map((pp) => ({ day: busyDay.dayOfWeek, period: pp }))
    .find((c) => !nowAt.some((r) => r.dayOfWeek === c.day && r.periodNumber === c.period));
  const capped = await call("POST", `/timetable-configs/${config.id}/board/swap-group`, token, {
    from: { electiveBlockId: blockId, day: target.day, period: target.period },
    expect: { electiveOptionIds: optionIds },
    to: sameDayCell,
  });
  check(capped.status === 400, "a second occurrence on one day is refused — the block is capped at 1/day",
    `${capped.status} ${(capped.json?.message ?? capped.text).slice(0, 100)}`);

  // and the refusal changed nothing
  const stillThere = await prisma.timetableSlot.count({
    where: {
      schoolId: SCHOOL, status: "draft", draftId, electiveBlockId: blockId,
      dayOfWeek: target.day, periodNumber: target.period,
    },
  });
  check(stillThere === 5, "the refused drag left the board exactly as it was", `${stillThere} row(s)`);

  // The two controls the block card deliberately does not show must also be
  // refused by the SERVER — a guard only in the UI is not a guard, and one of
  // these deletes rows.
  const pinned2 = await call("POST", `/timetable-configs/${config.id}/board/lock`, token, {
    from: { electiveBlockId: blockId, day: target.day, period: target.period }, locked: true,
  });
  check(pinned2.status === 400 && /Fixed slots/.test(pinned2.json?.message ?? ""),
    "pinning a block is refused, pointing at Fixed slots instead of silently doing nothing",
    `${pinned2.status} ${(pinned2.json?.message ?? "").slice(0, 80)}`);

  const removed = await call("POST", `/timetable-configs/${config.id}/board/remove`, token, {
    from: { electiveBlockId: blockId, day: target.day, period: target.period },
    expect: { electiveOptionIds: optionIds },
  });
  const survived = await prisma.timetableSlot.count({
    where: {
      schoolId: SCHOOL, status: "draft", draftId, electiveBlockId: blockId,
      dayOfWeek: target.day, periodNumber: target.period,
    },
  });
  check(removed.status === 400 && survived === 5,
    "removing a block is refused — the tray is mapping demand, and it would have no way back",
    `${removed.status}, ${survived} row(s) still there`);

  // A stale expectation must 409 rather than move somebody else's block.
  const stale = await call("POST", `/timetable-configs/${config.id}/board/swap-group`, token, {
    from: { electiveBlockId: blockId, day: target.day, period: target.period },
    expect: { electiveOptionIds: [999999] },
    to: { day: srcCell.day, period: srcCell.period },
  });
  check(stale.status === 409, "a stale option list is refused as stale", `${stale.status}`);

  // ------------------------------------------------------------- 6. REPORT
  console.log("\nThe language teacher's own timetable shows the lesson:");
  await call("POST", `/timetable-configs/${config.id}/board/publish`, token);
  const report = await call("GET", `/reports/teacher/${langs[0].teacher.id}`, token);
  const grid = JSON.stringify(report.json ?? {});
  check(report.status === 200 && grid.includes(`${P} Third Language`),
    "named by its block, since it belongs to no single section",
    report.status === 200 ? "block name present in the grid" : `${report.status}`);

  // ------------------------------------------------- 7. THE CLASS'S OWN GRID
  //
  // Phase 15. The member row carries no subject, teacher or room by design
  // (invariant 9) — so before this the class timetable showed the language
  // period as an empty cell, on the report, on My Classes, in the printed
  // week and to the AI assistant. What a parent has to be able to read is
  // every option: which language, whose class, which room.
  console.log("\nThe CLASS timetable names every option, not an empty cell:");
  const classReport = await call("GET", `/reports/class-section/${members[0]}`, token);
  const classCells = Object.entries(classReport.json?.grid ?? {}).filter(([, c]) => c.blockName);
  check(classCells.length === 5, "the block's five periods are elective cells, not free periods",
    `${classCells.length} cell(s) carry a block name`);

  const firstCell = classCells[0]?.[1];
  const named = (firstCell?.electiveOptions ?? []).map((o) => `${o.subject} — ${o.teacher} (${o.room})`);
  check(named.length === 3, "each shows all three lessons running inside it", named.join(" | "));
  check(new Set((firstCell?.electiveOptions ?? []).map((o) => o.teacher)).size === 3
     && new Set((firstCell?.electiveOptions ?? []).map((o) => o.room)).size === 3,
    "three subjects, three teachers, three rooms");

  // Every member section sees the SAME slot with the SAME options — that is
  // what "5-A, 5-B and 5-C take it together" means, and the thing a per-section
  // read would quietly get wrong.
  const otherReport = await call("GET", `/reports/class-section/${members[1]}`, token);
  const otherCells = Object.entries(otherReport.json?.grid ?? {}).filter(([, c]) => c.blockName);
  check(
    JSON.stringify(classCells.map(([k]) => k).sort()) === JSON.stringify(otherCells.map(([k]) => k).sort()),
    "every member section shows it in the same slots",
    otherCells.map(([k]) => k).join(", "),
  );

  // ------------------------------------------------------ 8. FIXED PLACEMENT
  //
  // The other half of Phase 15: a school that runs its language slot at a
  // known time so a whole grade changes rooms at once. Asserted against the
  // written slots, not the solver's own report of what it did.
  console.log("\nA pinned block lands exactly where the school said:");
  const pins = [
    { day: 1, period: 2 },
    { day: 2, period: 2 },
    { day: 3, period: 2 },
    { day: 4, period: 2 },
    { day: 5, period: 2 },
  ];
  const pinned = await call("PUT", `/elective-blocks/${blockId}`, token, { placement: "fixed", fixedSlots: pins });
  check(pinned.status === 200, "the block was pinned", `${pinned.status} ${pinned.text.slice(0, 90)}`);

  const pinnedReadiness = await call("GET", `/timetable-configs/${config.id}/readiness`, token);
  check(pinnedReadiness.json?.ready === true,
    "a well-formed pin keeps the school feasible",
    `score ${pinnedReadiness.json?.score}${
      pinnedReadiness.json?.blockers?.length ? ` — ${pinnedReadiness.json.blockers[0].message}` : ""
    }`);

  await call("POST", `/timetable-configs/${config.id}/generate`, token, { mode: "fast" });
  state = null;
  for (let i = 0; i < 60 && state !== "completed" && state !== "failed"; i++) {
    await sleep(500);
    state = (await call("GET", `/timetable-configs/${config.id}/generate/latest`, token)).json?.state ?? null;
  }
  check(state === "completed", "it still generates", `${state}`);

  const after = await prisma.timetableSlot.findMany({
    where: { schoolId: SCHOOL, status: "draft", draftId: await liveDraft(prisma, config.id), electiveBlockId: blockId },
  });
  const where = [...new Set(after.map((s) => `${s.dayOfWeek}:${s.periodNumber}`))].sort();
  check(JSON.stringify(where) === JSON.stringify(["1:2", "2:2", "3:2", "4:2", "5:2"]),
    "every occurrence is on the pinned cell — P2, Monday to Friday",
    where.join(", "));

  // And a pin nobody can teach is refused by Phase A with the row named,
  // rather than becoming a block the solver silently fails to place.
  console.log("\nAn impossible pin is named before Generate, not discovered by it:");
  const badDay = await call("PUT", `/elective-blocks/${blockId}`, token, {
    placement: "fixed",
    fixedSlots: [...pins.slice(0, 4), { day: 5, period: 99 }],
  });
  check(badDay.status === 200, "the API stores it — the engine is the authority on feasibility", `${badDay.status}`);
  const badReadiness = await call("GET", `/timetable-configs/${config.id}/readiness`, token);
  const pinIssue = (badReadiness.json?.blockers ?? []).find((b) => b.code === "ELECTIVE_PIN_INVALID");
  check(Boolean(pinIssue), "the Readiness Dashboard names it", pinIssue?.message ?? "no ELECTIVE_PIN_INVALID raised");
  check(pinIssue?.remedy?.kind === "relax" && pinIssue?.remedy?.changes?.[0]?.field === "placement",
    "and auto-resolve offers to hand it back to the solver — never to move it somewhere nobody chose",
    pinIssue?.remedy?.summary ?? "no remedy");

  // ------------------------------------------------------------------ cleanup
  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { id: SCHOOL } })) === 0, "test school removed");

  await prisma.$disconnect();
  console.log(failed ? "\nSOME ELECTIVE CHECKS FAILED" : "\nALL ELECTIVE CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
