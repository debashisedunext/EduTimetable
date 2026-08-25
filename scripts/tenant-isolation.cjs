/**
 * Phase 9.1 (§17) — the multi-school isolation suite, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/tenant-isolation.cjs
 *
 * This is the test that makes 9.1 mean anything. It stands up a real second
 * school alongside the existing one and then tries, from School B's session, to
 * do every bad thing the pre-9.1 code would have allowed:
 *
 *   1. LIST    — does B's directory show any of A's rows?
 *   2. READ    — can B fetch A's row by its id?
 *   3. UPDATE  — can B edit A's row by its id?  (the pre-9.1 IDOR)
 *   4. DELETE  — can B delete A's row by its id?
 *   5. NESTED  — do child rows (sections, curriculum) leak the same way?
 *   6. STAMP   — do B's writes actually land as B's, on every child table?
 *   7. CACHE   — are Redis keys per-school, and does B's invalidation spare A?
 *   8. SCOPE   — is A's data byte-identical after everything B attempted?
 *
 * Everything it creates is prefixed ZZTEN and removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const SCHOOL_A = 1;
const SCHOOL_B = 99001; // far outside any real id, so cleanup can be exact
const P = "ZZTEN";

let failed = 0;
const pass = (l, x = "") => console.log(`  PASS  ${l}${x ? ` — ${x}` : ""}`);
const fail = (l, x = "") => { console.log(`  FAIL  ${l}${x ? ` — ${x}` : ""}`); failed = 1; };
const check = (ok, l, x = "") => (ok ? pass(l, x) : fail(l, x));

async function sessionFor(payload) {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const { token } = await r.json();
  const cb = await fetch(`${API}/api/sso/callback?token=${token}`, { redirect: "manual" });
  return (cb.headers.get("location") || "").split("#token=")[1];
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

/** A cross-school attempt must not succeed. 404/403/400 are all acceptable refusals. */
const refused = (status) => status === 404 || status === 403 || status === 400;

(async () => {
  const prisma = new PrismaClient(); // raw + unscoped: the oracle, not the subject
  const redis = new Redis({ host: process.env.REDIS_HOST ?? "redis", port: 6379 });

  // ---------------------------------------------------- stand up school B
  console.log("Standing up a second school:");
  // 9.2: school_id now has a real foreign key, so School B has to exist as a
  // row before anything can belong to it.
  await prisma.school.upsert({
    where: { id: SCHOOL_B },
    create: { id: SCHOOL_B, code: `${P}-SCHOOL-B`, name: `${P} Test School B` },
    update: {},
  });
  const roleB = await prisma.role.upsert({
    where: { schoolId_name: { schoolId: SCHOOL_B, name: "Super Admin" } },
    create: { schoolId: SCHOOL_B, name: "Super Admin", isSystem: true },
    update: {},
  });
  const permsA = await prisma.rolePermission.findMany({
    where: { role: { schoolId: SCHOOL_A, name: "Super Admin" } },
    select: { permission: true },
  });
  await prisma.rolePermission.createMany({
    data: permsA.map((p) => ({ roleId: roleB.id, permission: p.permission, schoolId: SCHOOL_B })),
    skipDuplicates: true,
  });
  await prisma.erpRoleMapping.upsert({
    where: { schoolId_erpRole: { schoolId: SCHOOL_B, erpRole: "ADMIN" } },
    create: { schoolId: SCHOOL_B, erpRole: "ADMIN", roleId: roleB.id },
    update: {},
  });
  const admA = await sessionFor({ erpUserId: "ERP-1", erpRole: "ADMIN", name: "Admin A", email: "a@a.test" });
  const admB = await sessionFor({ erpUserId: `${P}-B1`, erpRole: "ADMIN", name: "Admin B", email: "b@b.test", schoolId: SCHOOL_B });
  check(Boolean(admA && admB), "both schools have an admin session");
  const userB = await prisma.user.findFirst({ where: { schoolId: SCHOOL_B } });
  check(userB?.schoolId === SCHOOL_B, "SSO provisioned B's user into B", `user ${userB?.id}`);

  // Snapshot A, to prove later that nothing B did touched it.
  const snapshotA = async () => {
    const [rooms, subjects, classes, sections, curriculum, slots] = await Promise.all([
      prisma.room.findMany({ where: { schoolId: SCHOOL_A }, orderBy: { id: "asc" } }),
      prisma.subject.findMany({ where: { schoolId: SCHOOL_A }, orderBy: { id: "asc" } }),
      prisma.schoolClass.findMany({ where: { schoolId: SCHOOL_A }, orderBy: { id: "asc" } }),
      prisma.section.findMany({ where: { schoolId: SCHOOL_A }, orderBy: { id: "asc" } }),
      prisma.classSubject.findMany({ where: { schoolId: SCHOOL_A }, orderBy: { id: "asc" } }),
      prisma.timetableSlot.count({ where: { schoolId: SCHOOL_A } }),
    ]);
    return JSON.stringify({ rooms, subjects, classes, sections, curriculum, slots });
  };
  const beforeA = await snapshotA();

  // Pick real School A rows for B to go after.
  const roomA = await prisma.room.findFirst({ where: { schoolId: SCHOOL_A } });
  const subjectA = await prisma.subject.findFirst({ where: { schoolId: SCHOOL_A } });
  const classA = await prisma.schoolClass.findFirst({ where: { schoolId: SCHOOL_A } });
  const csubA = await prisma.classSubject.findFirst({ where: { schoolId: SCHOOL_A } });
  const csA = await prisma.classSection.findFirst({ where: { schoolId: SCHOOL_A } });
  const cfgA = await prisma.timetableConfig.findFirst({ where: { schoolId: SCHOOL_A } });

  // ------------------------------------------------------------ 1. LIST
  console.log("\nB's directories contain none of A's rows:");
  for (const [label, path, idOfA] of [
    ["rooms", "/rooms", roomA?.id],
    ["subjects", "/subjects", subjectA?.id],
    ["classes", "/classes", classA?.id],
    ["teachers", "/teachers", null],
  ]) {
    const r = await call("GET", path, admB);
    const rows = Array.isArray(r.json) ? r.json : (r.json?.rows ?? r.json?.items ?? []);
    const leaked = idOfA != null && rows.some((x) => x.id === idOfA);
    check(r.status === 200 && !leaked, `GET ${path} as B`, `${rows.length} row(s), none of A's`);
  }

  // ------------------------------------------------- 2/3/4. READ, UPDATE, DELETE
  console.log("\nB cannot read, edit or delete A's rows by id (the pre-9.1 IDOR):");
  const attempts = [
    ["PUT", `/rooms/${roomA.id}`, { name: `${P} HIJACKED` }, "edit A's room"],
    ["DELETE", `/rooms/${roomA.id}`, null, "delete A's room"],
    ["PUT", `/subjects/${subjectA.id}`, { name: `${P} HIJACKED` }, "edit A's subject"],
    ["DELETE", `/subjects/${subjectA.id}`, null, "delete A's subject"],
    ["PUT", `/classes/${classA.id}`, { name: `${P} HIJACKED` }, "edit A's class"],
    ["DELETE", `/classes/${classA.id}`, null, "delete A's class"],
    ["PUT", `/class-subjects/${csubA.id}`, { periodsPerWeek: 99 }, "edit A's curriculum row"],
    ["DELETE", `/class-subjects/${csubA.id}`, null, "delete A's curriculum row"],
  ];
  for (const [method, path, body, label] of attempts) {
    const r = await call(method, path, admB, body);
    check(refused(r.status), `B: ${label}`, `${r.status}`);
  }

  // A's timetable is not readable through B's session either.
  const slotsRes = await call("GET", `/timetable-configs/${cfgA.id}/slots?status=published`, admB);
  const slotCount = Array.isArray(slotsRes.json?.slots) ? slotsRes.json.slots.length : 0;
  check(refused(slotsRes.status) || slotCount === 0, "B: read A's published matrix", `${slotsRes.status}, ${slotCount} slot(s)`);

  const readinessRes = await call("GET", `/timetable-configs/${cfgA.id}/readiness`, admB);
  check(refused(readinessRes.status), "B: read A's readiness score", `${readinessRes.status}`);

  // ------------------------------------------------------ 6. B's writes are B's
  console.log("\nB's own writes land as B's, on parent and child tables alike:");
  const mkRoom = await call("POST", "/rooms", admB, { name: `${P} Room B`, roomType: "classroom" });
  check(mkRoom.status === 201 && mkRoom.json?.schoolId === SCHOOL_B, "created room is stamped school B", `schoolId=${mkRoom.json?.schoolId}`);

  const mkSubj = await call("POST", "/subjects", admB, { name: `${P} Subject B` });
  const mkClass = await call("POST", "/classes", admB, { name: `${P} Class B`, sequence: 1 });
  const mkYear = await call("POST", "/academic-years", admB, {
    name: `${P} 26-27`, startDate: "2026-04-01", endDate: "2027-03-31",
  });
  check(mkSubj.status === 201 && mkClass.status === 201 && mkYear.status === 201,
    "B can create its own masters", `${mkSubj.status}/${mkClass.status}/${mkYear.status}`);

  // sections + class_sections: the denormalized child tables
  const mkSection = await call("POST", `/classes/${mkClass.json.id}/sections`, admB, {
    name: "A", academicYearId: mkYear.json.id,
  });
  check(mkSection.status === 201, "B can add a section", `${mkSection.status}`);
  const secRow = await prisma.section.findFirst({ where: { classId: mkClass.json.id } });
  const csRow = await prisma.classSection.findFirst({ where: { classId: mkClass.json.id } });
  check(secRow?.schoolId === SCHOOL_B, "sections.school_id stamped", `${secRow?.schoolId}`);
  check(csRow?.schoolId === SCHOOL_B, "class_sections.school_id stamped", `${csRow?.schoolId}`);

  const mkCurr = await call("POST", "/class-subjects", admB, {
    classId: mkClass.json.id, subjectId: mkSubj.json.id, periodsPerWeek: 5,
  });
  const currRow = await prisma.classSubject.findFirst({ where: { classId: mkClass.json.id } });
  check(mkCurr.status === 201 && currRow?.schoolId === SCHOOL_B, "class_subjects.school_id stamped", `${currRow?.schoolId}`);

  // ------------------------------------------- 5. cross-school FOREIGN KEYS
  // Subtler than the IDOR above and it survives row scoping on its own: B's
  // write is stamped as B's, so scoped reads look clean, but the row points
  // into A's data — and B's readiness and solver would then pull A's
  // class-section into B's timetable.
  console.log("\nB cannot point its own rows at A's data:");

  // A's class + B's OWN subject: no unique key can collide, so only an
  // ownership check can refuse this one.
  const csB = await prisma.classSection.findFirst({ where: { schoolId: SCHOOL_B } });
  const crossCurr = await call("POST", "/class-subjects", admB, {
    classId: classA.id, subjectId: mkSubj.json.id, periodsPerWeek: 2,
  });
  const crossCurrLanded = await prisma.classSubject.findFirst({
    where: { classId: classA.id, subjectId: mkSubj.json.id },
  });
  check(refused(crossCurr.status) && crossCurrLanded === null,
    "B: curriculum row on A's class", `${crossCurr.status}`);

  const mkTeacherB = await call("POST", "/teachers", admB, { employeeCode: `${P}-T1`, name: `${P} Teacher B` });
  const crossMap = await call("POST", "/mappings", admB, {
    teacherId: mkTeacherB.json.id, subjectId: mkSubj.json.id,
    classSectionIds: [csA.id], periodsPerWeek: 2,
  });
  const crossMapLanded = await prisma.teacherSubjectClassSection.findFirst({
    where: { classSectionId: csA.id, teacherId: mkTeacherB.json.id },
  });
  check(refused(crossMap.status) && crossMapLanded === null,
    "B: teacher mapping onto A's class-section", `${crossMap.status}`);

  // ...and the same reference laundered through a nested write
  const crossMerged = await call("POST", "/merged-groups", admB, {
    teacherId: mkTeacherB.json.id, subjectId: mkSubj.json.id,
    classSectionIds: [csA.id, csB.id], periodsPerWeek: 2,
  });
  const crossMergedLanded = await prisma.mergedTeachingGroupMember.findFirst({
    where: { classSectionId: csA.id, schoolId: SCHOOL_B },
  });
  check(refused(crossMerged.status) && crossMergedLanded === null,
    "B: merged group including A's class-section (nested write)", `${crossMerged.status}`);

  // The legitimate version of the same call must still work.
  const okCurr = await call("POST", "/class-subjects", admB, {
    classId: mkClass.json.id, subjectId: mkSubj.json.id, periodsPerWeek: 3,
  });
  check(okCurr.status === 409 || okCurr.status === 201,
    "B's own class + own subject is still accepted", `${okCurr.status}`);

  // ------------------------------------------------------------- 7. CACHE
  console.log("\nRedis keys are per-school and invalidation does not cross:");
  await call("GET", `/timetable-configs/${cfgA.id}/readiness`, admA); // warm A's cache
  const keysA = await redis.keys(`s${SCHOOL_A}:*`);
  check(keysA.length > 0, "A's cache entries are namespaced", `${keysA.length} key(s) under s${SCHOOL_A}:`);
  const unNamespaced = (await redis.keys("readiness:*")).concat(await redis.keys("slots:*"));
  check(unNamespaced.length === 0, "no globally-named cache keys remain", `${unNamespaced.length} found`);

  // B edits a master → invalidates. A's cache must survive.
  await call("PUT", `/rooms/${mkRoom.json.id}`, admB, { name: `${P} Room B2` });
  const keysAAfter = await redis.keys(`s${SCHOOL_A}:*`);
  check(keysAAfter.length === keysA.length,
    "B's master-data edit left A's cache intact", `${keysA.length} → ${keysAAfter.length}`);

  // ------------------------------------------------- 9. the solver worker
  // The worker is a separate process with its own Prisma client and its own
  // tenant context, opened from the job data. This runs a real generation for
  // B and checks that every slot it writes is B's, that A's grid never moves,
  // and that A cannot read B's job through the queue they share.
  console.log("\nB generates its own timetable in the background worker:");
  const slotsABefore = await prisma.timetableSlot.count({ where: { schoolId: SCHOOL_A } });
  const seeded = await call("POST", "/dev/sample-data", admB);
  const cfgB = await prisma.timetableConfig.findFirst({ where: { schoolId: SCHOOL_B } });
  check(seeded.status === 201 && cfgB != null, "B seeded a demo school of its own", `config ${cfgB?.id}`);

  if (cfgB) {
    // The demo fixture is deliberately infeasible so the Readiness Dashboard has
    // real blockers to demonstrate: Art is left unmapped in one section, and
    // Rekha Sharma is loaded to 34 periods against a 30-period week. Repair both
    // properly — raising her cap would not help, since 30 is the number of
    // periods the week physically has.
    const subjOf = async (name) =>
      (await prisma.subject.findFirst({ where: { schoolId: SCHOOL_B, name } }))?.id;
    const teacherOf = async (name) =>
      (await prisma.teacher.findFirst({ where: { schoolId: SCHOOL_B, name } }))?.id;
    const sectionOf = async (cls, sec) =>
      (await prisma.classSection.findFirst({
        where: { schoolId: SCHOOL_B, class: { name: cls }, section: { name: sec } },
      }))?.id;

    const [art, hindi, tanvi, rekha, priya, cs6B] = await Promise.all([
      subjOf("Art"), subjOf("Hindi"), teacherOf("Tanvi Das"),
      teacherOf("Rekha Sharma"), teacherOf("Priya Nair"), sectionOf("Class 6", "B"),
    ]);

    // 1. the unmapped Art section
    await prisma.teacherSubjectClassSection.create({
      data: { schoolId: SCHOOL_B, teacherId: tanvi, subjectId: art, classSectionId: cs6B, periodsPerWeek: 3 },
    });
    // 2. hand Rekha's Hindi to Tanvi — 34 → 24 for her, 12 → 22 for Tanvi
    await prisma.teacherSubjectClassSection.updateMany({
      where: { schoolId: SCHOOL_B, teacherId: rekha, subjectId: hindi },
      data: { teacherId: tanvi },
    });
    // 3. Priya teaches every period here, so her 20 fits a 30-period week
    await prisma.teacher.update({ where: { id: priya }, data: { periodPattern: "every_period" } });

    const staleB = await redis.keys(`s${SCHOOL_B}:*`);
    if (staleB.length > 0) await redis.del(...staleB);

    const ready = await call("GET", `/timetable-configs/${cfgB.id}/readiness`, admB);
    check(ready.json?.ready === true, "B's config reaches 100% readiness", `${ready.json?.score}%`);

    if (ready.json?.ready) {
      const gen = await call("POST", `/timetable-configs/${cfgB.id}/generate`, admB, { mode: "fast" });
      check(gen.status === 201, "B queued a solver job", `job ${gen.json?.jobId}`);
      let state = "waiting";
      for (let i = 0; i < 90 && state !== "completed" && state !== "failed"; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        state = (await call("GET", `/timetable-configs/${cfgB.id}/generate/latest`, admB)).json?.state ?? "none";
      }
      check(state === "completed", "the worker completed B's job", state);

      const slotsB = await prisma.timetableSlot.count({ where: { schoolId: SCHOOL_B } });
      const misStamped = await prisma.timetableSlot.count({
        where: { timetableConfigId: cfgB.id, schoolId: { not: SCHOOL_B } },
      });
      check(slotsB > 0 && misStamped === 0,
        "every slot the worker wrote is stamped school B", `${slotsB} slot(s), ${misStamped} mis-stamped`);

      const slotsAAfter = await prisma.timetableSlot.count({ where: { schoolId: SCHOOL_A } });
      check(slotsAAfter === slotsABefore, "A's timetable was not touched by B's run", `${slotsABefore} → ${slotsAAfter}`);

      // One BullMQ queue serves every school, so A must not be able to read
      // B's job summary, unplaced list or failure reason through it.
      // 9.10 tightened this from `{state: "none"}` to a 404: answering "no such
      // job" made "that timetable is not yours" and "that timetable has never
      // been generated" the same reply, and a success status for another
      // school's id is not something a caller should have to read the body to
      // interpret (§17.8).
      const aPeek = await call("GET", `/timetable-configs/${cfgB.id}/generate/latest`, admA);
      check(refused(aPeek.status), "A cannot read B's solver job", `${aPeek.status}`);
    }
  }

  // ------------------------------------------------------------- 8. SCOPE
  console.log("\nAfter everything B attempted, A is untouched:");
  const afterA = await snapshotA();
  check(beforeA === afterA, "school A is byte-identical", beforeA === afterA ? "unchanged" : "MUTATED");

  const strays = await prisma.room.count({ where: { schoolId: SCHOOL_A, name: { contains: "HIJACKED" } } });
  check(strays === 0, "no row of A's was renamed by B", `${strays} hijacked`);

  // ----------------------------------------------------------------- cleanup
  console.log("\nCleanup:");
  await prisma.timetableSlot.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.timetablePublication.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.period.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.holiday.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.timetableConfig.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.teacherSubjectClassSection.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.classSubject.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.classSection.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.mergedTeachingGroupMember.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.mergedTeachingGroup.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.teacher.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.section.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.schoolClass.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.room.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.subject.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.academicYear.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.notification.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.user.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.erpRoleMapping.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.rolePermission.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.role.deleteMany({ where: { schoolId: SCHOOL_B } });
  await prisma.school.deleteMany({ where: { id: SCHOOL_B } });
  const leftovers = await prisma.room.count({ where: { schoolId: SCHOOL_B } });
  const finalA = await snapshotA();
  check(leftovers === 0 && finalA === beforeA, "school B removed, school A restored");

  await redis.quit();
  await prisma.$disconnect();
  console.log(failed ? "\nSOME ISOLATION CHECKS FAILED" : "\nALL TENANT ISOLATION CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
