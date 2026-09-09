/**
 * Phase 17 (§22) — multiple named drafts, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/drafts-smoke.cjs
 *
 * The property under test is the one the unique keys made impossible until
 * this phase: **a school may hold several complete timetables at once, and
 * publishing one leaves the rest exactly as they were.**
 *
 *   1. COEXIST  — two full drafts of one config, holding the same cells
 *   2. ISOLATE  — an edit in Draft #2 does not touch Draft #1
 *   3. STATS    — the numbers the Compare table reads are right, and in the
 *                 same unit on both sides of the ratio
 *   4. GUARD    — the double-booking guarantee still bites INSIDE a draft
 *   5. CAP      — the sixth live draft is refused, not silently allowed
 *   6. PUBLISH  — publishing #2 promotes #2 and leaves #1 untouched
 *   7. EXTRAS   — §18 extra classes belong to no draft and are never copied
 *
 * Everything it creates is prefixed ZZDRF and removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { groupFor } = require("./resource-groups.cjs");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const P = "ZZDRF";
const SCHOOL = 99061;

let failed = 0;
const pass = (l, x = "") => console.log(`  PASS  ${l}${x ? ` — ${x}` : ""}`);
const fail = (l, x = "") => { console.log(`  FAIL  ${l}${x ? ` — ${x}` : ""}`); failed = 1; };
const check = (ok, l, x = "") => (ok ? pass(l, x) : fail(l, x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session() {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ erpUserId: `${P}-1`, erpRole: "ADMIN", name: "Draft Admin", email: "d@zz.test", schoolId: SCHOOL }),
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

  // ------------------------------------------------------------- fixture
  // Deliberately small — 1 section, 5 days x 4 periods, 20 lessons — so the
  // arithmetic in every assertion below can be checked by eye.
  console.log("A one-section school, 20 lessons, nothing to spare:");
  const purge = async () => {
    await prisma.$transaction([
      prisma.substitutionLog.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherAbsence.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.timetableSlot.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.timetableDraft.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.timetablePublication.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.auditLog.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.extraClass.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherUnavailability.deleteMany({ where: { schoolId: SCHOOL } }),
      prisma.teacherClassEligibility.deleteMany({ where: { schoolId: SCHOOL } }),
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

  await prisma.school.create({ data: { id: SCHOOL, code: `${P}-SCHOOL`, name: `${P} Draft School` } });
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
      resourceGroupId: await groupFor(prisma, year.id),
      schoolId: SCHOOL, name: `${P} Wing`, academicYearId: year.id,
      workingDays: [1, 2, 3, 4, 5], periodsPerDay: 4,
      // §18 extra window, so the "extras belong to no draft" claim is testable
      extraPeriodsPerDay: 1, extraPeriodDurationMins: 40,
    },
  });
  await prisma.period.createMany({
    data: [1, 2, 3, 4, 5].map((n) => ({
      schoolId: SCHOOL, timetableConfigId: config.id, sortOrder: n, periodNumber: n,
      startTime: `${String(7 + n).padStart(2, "0")}:00`, endTime: `${String(7 + n).padStart(2, "0")}:40`,
      isExtra: n === 5,
    })),
  });
  const cls = await prisma.schoolClass.create({ data: { schoolId: SCHOOL, name: `${P} V`, sequence: 5 } });
  const sec = await prisma.section.create({ data: { classId: cls.id, name: "A", schoolId: SCHOOL } });
  const home = await prisma.room.create({ data: { schoolId: SCHOOL, name: `${P} Room A`, roomType: "classroom" } });
  const classSection = await prisma.classSection.create({
    data: {
      resourceGroupId: await groupFor(prisma, year.id),
      classId: cls.id, sectionId: sec.id, academicYearId: year.id, schoolId: SCHOOL,
      timetableConfigId: config.id, strength: 30, homeRoomId: home.id,
    },
  });

  // 4 subjects x 5 periods = 20 = exactly the teaching week (5 days x 4)
  const core = [];
  for (const name of ["Maths", "English", "Science", "Hindi"]) {
    const subject = await prisma.subject.create({ data: { schoolId: SCHOOL, name: `${P} ${name}` } });
    const teacher = await prisma.teacher.create({
      data: {
        schoolId: SCHOOL, employeeCode: `${P}-${name}`, name: `${P} T.${name}`,
        maxPeriodsPerDay: 4, maxPeriodsPerWeek: 30, minPeriodsPerDay: 1,
        eligibility: { create: [{ classId: cls.id, schoolId: SCHOOL }] },
      },
    });
    await prisma.classSubject.create({
      data: { schoolId: SCHOOL, classId: cls.id, academicYearId: year.id, subjectId: subject.id, periodsPerWeek: 5, maxPeriodsPerDay: 2 },
    });
    await prisma.teacherSubjectClassSection.create({
      data: { schoolId: SCHOOL, teacherId: teacher.id, subjectId: subject.id, classSectionId: classSection.id, periodsPerWeek: 5 },
    });
    core.push({ subject, teacher });
  }
  await prisma.classSection.update({ where: { id: classSection.id }, data: { classTeacherId: core[0].teacher.id } });

  const token = await session();
  check(Boolean(token), "admin session");
  if (!token) { await prisma.$disconnect(); process.exit(1); }

  const readiness = await call("GET", `/timetable-configs/${config.id}/readiness`, token);
  check(readiness.json?.ready === true, "the school is feasible before any of this",
    `score ${readiness.json?.score}${readiness.json?.blockers?.[0] ? ` — ${readiness.json.blockers[0].message}` : ""}`);

  const generate = async () => {
    const g = await call("POST", `/timetable-configs/${config.id}/generate`, token, { mode: "fast" });
    let state = null;
    for (let i = 0; i < 60 && state !== "completed" && state !== "failed"; i++) {
      await sleep(500);
      state = (await call("GET", `/timetable-configs/${config.id}/generate/latest`, token)).json?.state ?? null;
    }
    return { draftId: g.json?.draftId, draftNo: g.json?.draftNo, state };
  };
  const drafts = async () => (await call("GET", `/timetable-configs/${config.id}/drafts`, token)).json ?? [];
  const cellsOf = (draftId) =>
    prisma.timetableSlot.findMany({
      where: { schoolId: SCHOOL, status: "draft", draftId, classSectionId: { not: null } },
      orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
    });

  // ----------------------------------------------------------- 1. COEXIST
  console.log("\nTwo complete timetables for one school, at the same time:");
  const g1 = await generate();
  check(g1.state === "completed" && g1.draftNo === 1, "Generate produced Draft #1", `#${g1.draftNo} ${g1.state}`);

  // A second generation must NOT overwrite the first — that is the whole point
  const g2 = await generate();
  check(g2.state === "completed" && g2.draftNo === 2, "Generate again produced Draft #2, not an overwrite", `#${g2.draftNo}`);

  const d1 = await cellsOf(g1.draftId);
  const d2 = await cellsOf(g2.draftId);
  check(d1.length === 20 && d2.length === 20, "both drafts are complete weeks", `${d1.length} and ${d2.length} cells`);

  // the same section+cell held by both — impossible before this phase
  const shared = d1.filter((a) => d2.some((b) => b.dayOfWeek === a.dayOfWeek && b.periodNumber === a.periodNumber));
  check(shared.length === 20, "every cell of the week is held by BOTH drafts at once",
    `${shared.length}/20 — uq_class_slot would have refused this before §22`);

  // ----------------------------------------------------------- 2. ISOLATE
  console.log("\nAn edit in one draft does not touch the other:");
  const before1 = JSON.stringify((await cellsOf(g1.draftId)).map((r) => [r.dayOfWeek, r.periodNumber, r.subjectId]));
  const target = d2[0];
  const free = [1, 2, 3, 4, 5]
    .flatMap((day) => [1, 2, 3, 4].map((p) => ({ day, period: p })))
    .find((c) => !d2.some((r) => r.dayOfWeek === c.day && r.periodNumber === c.period));
  // the week is full, so move by swapping with another cell in the same draft
  const other = d2.find((r) => r.dayOfWeek !== target.dayOfWeek || r.periodNumber !== target.periodNumber);
  const swap = await call("POST", `/timetable-configs/${config.id}/board/swap`, token, {
    a: { classSectionId: classSection.id, day: target.dayOfWeek, period: target.periodNumber },
    expectA: { subjectId: target.subjectId, teacherId: target.teacherId },
    b: { classSectionId: classSection.id, day: other.dayOfWeek, period: other.periodNumber },
    expectB: { subjectId: other.subjectId, teacherId: other.teacherId },
  });
  check(swap.status === 201 || swap.status === 200, "two lessons swapped on Draft #2",
    `${swap.status} ${swap.text.slice(0, 90)}${free ? "" : ""}`);

  const after2 = await cellsOf(g2.draftId);
  const moved = after2.find((r) => r.dayOfWeek === target.dayOfWeek && r.periodNumber === target.periodNumber);
  check(moved && moved.subjectId === other.subjectId, "Draft #2 really changed",
    `${target.dayOfWeek}:${target.periodNumber} now holds subject ${moved?.subjectId}`);

  const after1 = JSON.stringify((await cellsOf(g1.draftId)).map((r) => [r.dayOfWeek, r.periodNumber, r.subjectId]));
  check(before1 === after1, "Draft #1 is byte-identical to before the edit");
  check(
    (await prisma.timetableSlot.count({ where: { schoolId: SCHOOL, status: "draft", draftId: g2.draftId } })) === 20,
    "and the edited draft still has exactly its own 20 rows — nothing leaked to scope 0",
  );

  // ------------------------------------------------------------- 3. STATS
  console.log("\nThe numbers the Compare table is read from:");
  const list = await drafts();
  const s2 = list.find((d) => d.id === g2.draftId);
  check(s2.requiredLessons === 20 && s2.placedLessons === 20,
    "required and actual are in the SAME unit — grid cells", `${s2.placedLessons}/${s2.requiredLessons}`);
  check(s2.generationPct === 100, "so generation reads 100%, not something over it", `${s2.generationPct}%`);
  check(s2.errorCount === 0, "and no errors", `${s2.errorCount}`);

  // recompute must agree with the stamped row
  const re = await call("POST", `/timetable-configs/${config.id}/drafts/${g2.draftId}/recompute`, token);
  check(re.json?.placedLessons === 20 && re.json?.generationPct === 100,
    "a recompute from the stored grid agrees with the stamped numbers",
    JSON.stringify({ placed: re.json?.placedLessons, pct: re.json?.generationPct }));

  // ------------------------------------------------------------- 4. GUARD
  console.log("\nThe double-booking guarantee still bites INSIDE a draft:");
  let refusedInside = false;
  try {
    await prisma.timetableSlot.create({
      data: {
        schoolId: SCHOOL, timetableConfigId: config.id, status: "draft", draftId: g2.draftId,
        classSectionId: classSection.id, dayOfWeek: target.dayOfWeek, periodNumber: target.periodNumber,
        subjectId: core[0].subject.id, teacherId: core[0].teacher.id, source: "manual",
      },
    });
  } catch (e) {
    refusedInside = /uq_class_slot|Unique constraint/.test(String(e.message));
  }
  check(refusedInside, "a second lesson in one draft's cell is refused",
    "relaxing the key across drafts did not relax it within one");

  // --------------------------------------------------------------- 5. CAP
  console.log("\nThe fifth draft is the last:");
  let capMsg = "";
  for (let i = 0; i < 5; i++) {
    const made = await call("POST", `/timetable-configs/${config.id}/drafts`, token, { label: `${P} spare ${i}` });
    if (made.status >= 400) { capMsg = made.json?.message ?? made.text; break; }
  }
  check(/most that stay readable/.test(capMsg), "the sixth is refused with a reason, not silently allowed",
    capMsg.slice(0, 90) || "no refusal seen");
  // The refusal has to name BOTH ways out. It used to offer only "discard one
  // first", which reads as "throw work away to carry on" — and left a school
  // at the cap unable to press Generate at all.
  check(/generate into/i.test(capMsg) && /discard/i.test(capMsg),
    "and names both ways out — overwrite an existing draft, or discard one", capMsg.slice(0, 110));
  const live = (await drafts()).filter((d) => d.status !== "discarded");
  check(live.length === 5, "exactly five live drafts", `${live.length}`);

  // ------------------------------------------------- 5b. GENERATE AT THE CAP
  // The whole point of the picker: a school with five drafts must still be
  // able to generate, by saying which one to replace.
  console.log("\nAt the cap, Generate can still run by naming its target:");
  const blind = await call("POST", `/timetable-configs/${config.id}/generate`, token, { mode: "fast" });
  check(blind.status === 400, "generating with no target is refused at the cap", `${blind.status}`);

  const targets = (await drafts()).filter((d) => d.status === "draft");
  const victim = targets[0];
  // The bystander must be a draft that actually HOLDS a week — "still 0 rows"
  // would prove nothing at all about whether the run stayed in its lane.
  const counts = await Promise.all(
    targets.filter((d) => d.id !== victim.id)
      .map(async (d) => ({ d, n: await prisma.timetableSlot.count({ where: { schoolId: SCHOOL, draftId: d.id } }) })),
  );
  const pick = counts.sort((a, b) => b.n - a.n)[0];
  const bystander = pick.d;
  const bystanderBefore = pick.n;
  check(bystanderBefore > 0, "there is a populated draft to prove isolation against", `#${bystander.draftNo} has ${bystanderBefore} rows`);
  const aimed = await call("POST", `/timetable-configs/${config.id}/generate`, token, {
    mode: "fast", draftId: victim.id,
  });
  check(aimed.status === 201 && aimed.json?.draftId === victim.id,
    `generating INTO draft #${victim.draftNo} is accepted`, `${aimed.status} → draft ${aimed.json?.draftId}`);
  check(aimed.json?.draftStatus === "draft", "and reports which draft it took", `${aimed.json?.draftStatus}`);

  // wait for the worker, then prove it wrote where it was told and nowhere else
  let ran = false;
  for (let i = 0; i < 60 && !ran; i++) {
    await sleep(1000);
    const d = (await drafts()).find((x) => x.id === victim.id);
    ran = Boolean(d?.generatedAt);
  }
  check(ran, "the run finished and stamped that draft");
  check((await prisma.timetableSlot.count({ where: { schoolId: SCHOOL, draftId: bystander.id } })) === bystanderBefore,
    "the other drafts are untouched", `#${bystander.draftNo} still ${bystanderBefore} rows`);
  check((await drafts()).filter((d) => d.status !== "discarded").length === 5,
    "and no sixth draft was created");

  const ghost = await call("POST", `/timetable-configs/${config.id}/generate`, token, {
    mode: "fast", draftId: 99999999,
  });
  check(ghost.status === 404, "a draft that is not this timetable's is refused", `${ghost.status}`);

  // ------------------------------------------------- 5c. READING ONE DRAFT
  // What the Allocation Matrix's draft picker rides on. Every grid in the app
  // reads `GET /slots`, so if this parameter were ignored the picker would
  // change its label and nothing else — the worst kind of broken, because it
  // looks like it worked.
  console.log("\nGET /slots serves the draft it is asked for:");
  const weekOf = (payload) => {
    const cells = (payload.slots ?? []).filter((r) => r[0] !== null)
      .map((r) => `${r[0]}@${r[1]}:${r[2]}=${r[3]}`).sort().join("|");
    return cells;
  };
  const full = (await drafts()).filter((d) => d.status === "draft");
  const readA = await call("GET", `/timetable-configs/${config.id}/slots?status=draft&draftId=${full[0].id}`, token);
  const readB = await call("GET", `/timetable-configs/${config.id}/slots?status=draft&draftId=${bystander.id}`, token);
  check(readA.json?.draftId === full[0].id && readB.json?.draftId === bystander.id,
    "each request is answered by the draft it named",
    `${readA.json?.draftId} / ${readB.json?.draftId}`);
  check(weekOf(readA.json) !== weekOf(readB.json) || readA.json.slots.length !== readB.json.slots.length,
    "and two drafts return different weeks, not one cached copy of the same",
    `${readA.json.slots.length} vs ${readB.json.slots.length} rows`);

  const noId = await call("GET", `/timetable-configs/${config.id}/slots?status=draft`, token);
  check(typeof noId.json?.draftId === "number",
    "omitting it still resolves to the config's current draft", `draft ${noId.json?.draftId}`);

  const pubIgnores = await call("GET",
    `/timetable-configs/${config.id}/slots?status=published&draftId=${full[0].id}`, token);
  check(pubIgnores.json?.draftId === null,
    "the published view ignores a draft id — there is only ever one published set (§22.2)",
    `${pubIgnores.json?.draftId}`);

  // discard one, and the cap lets the next through again
  const spare = live.find((d) => (d.label ?? "").includes("spare"));
  await call("DELETE", `/timetable-configs/${config.id}/drafts/${spare.id}`, token);
  const again = await call("POST", `/timetable-configs/${config.id}/drafts`, token, { label: `${P} after discard` });
  check(again.status === 201, "discarding one makes room for another", `${again.status}`);
  await call("DELETE", `/timetable-configs/${config.id}/drafts/${again.json.id}`, token);
  check(
    (await prisma.timetableSlot.count({ where: { schoolId: SCHOOL, draftId: spare.id } })) === 0,
    "a discarded draft's lessons are gone, not orphaned",
  );

  // ------------------------------------------------------------ 7. EXTRAS
  // Placed before the publish, because publishing is what §18 says must not
  // cancel an extra class.
  console.log("\nAn §18 extra class belongs to no draft:");
  const extra = await call("POST", "/extra-classes", token, {
    classSectionId: classSection.id, subjectId: core[0].subject.id, teacherId: core[0].teacher.id,
    dayOfWeek: 1, periodNumber: 5, timetableConfigId: config.id,
  });
  check(extra.status === 201, "an extra class was scheduled in the extra window", `${extra.status} ${extra.text.slice(0, 80)}`);
  const extraRows = await prisma.timetableSlot.findMany({ where: { schoolId: SCHOOL, source: "extra" } });
  check(extraRows.length > 0 && extraRows.every((r) => r.draftId === null),
    "its rows carry no draft id at all", `${extraRows.length} row(s)`);
  check(extraRows.every((r) => r.draftScope === 0),
    "so they collapse to scope 0 — once per config, in both statuses (§18)");

  const forked = await call("POST", `/timetable-configs/${config.id}/drafts`, token, {
    label: `${P} fork`, copyFromDraftId: g2.draftId,
  });
  const forkedExtras = await prisma.timetableSlot.count({
    where: { schoolId: SCHOOL, source: "extra", draftId: forked.json.id },
  });
  check(forkedExtras === 0, "and forking a draft does not duplicate them", `${forkedExtras} copied`);
  await call("DELETE", `/timetable-configs/${config.id}/drafts/${forked.json.id}`, token);

  // ----------------------------------------------------------- 6. PUBLISH
  console.log("\nPublishing one draft leaves every other alone:");
  // The Publish screen's own question: does the preview follow the draft it is
  // given, rather than whichever the server holds as current? Ask about the
  // OTHER draft first, so a preview that ignored the parameter would answer
  // with the current one and be caught.
  const otherPrev = await call("GET", `/timetable-configs/${config.id}/board/publish/preview?draftId=${g1.draftId}`, token);
  const thisPrev = await call("GET", `/timetable-configs/${config.id}/board/publish/preview?draftId=${g2.draftId}`, token);
  check(otherPrev.json?.draftId === g1.draftId && thisPrev.json?.draftId === g2.draftId,
    "the publish preview diffs the draft it is asked about, not the current one",
    `${otherPrev.json?.draftId} / ${thisPrev.json?.draftId}`);
  const bogusPrev = await call("GET", `/timetable-configs/${config.id}/board/publish/preview?draftId=99999999`, token);
  check(bogusPrev.status === 404,
    "and a draft that is not this timetable's is refused, not silently diffed as empty",
    `${bogusPrev.status}`);

  const preview = await call("GET", `/timetable-configs/${config.id}/board/publish/preview?draftId=${g2.draftId}`, token);
  check(preview.json?.draftId === g2.draftId, "the confirmation screen previews the draft it was sent",
    `draft ${preview.json?.draftId}`);

  const pub = await call("POST", `/timetable-configs/${config.id}/board/publish`, token, { draftId: g2.draftId });
  check(pub.status === 201 && pub.json?.version === 1, "Draft #2 published", `v${pub.json?.version}`);

  const afterPublish = await drafts();
  const p2 = afterPublish.find((d) => d.id === g2.draftId);
  const p1 = afterPublish.find((d) => d.id === g1.draftId);
  check(p2?.status === "published", "Draft #2 is marked published", `${p2?.status}`);
  check(p1?.status === "draft", "Draft #1 is still an editable draft", `${p1?.status}`);
  check(
    (await cellsOf(g1.draftId)).length === 20,
    "Draft #1 still holds its complete week — the school keeps its alternative",
  );

  const publishedRows = await prisma.timetableSlot.findMany({
    where: { schoolId: SCHOOL, status: "published", classSectionId: { not: null }, source: { not: "extra" } },
  });
  check(publishedRows.length === 20, "the published set is exactly one week", `${publishedRows.length} rows`);
  check(publishedRows.every((r) => r.draftScope === 0),
    "every published row collapsed to scope 0, whichever draft it came from");
  check(publishedRows.every((r) => r.draftId === g2.draftId),
    "and each keeps Draft #2 as provenance — published FROM #2");

  const survivingExtras = await prisma.timetableSlot.count({ where: { schoolId: SCHOOL, source: "extra" } });
  check(survivingExtras === extraRows.length, "the extra class survived the publish (§18)", `${survivingExtras}`);

  // ------------------------------------------------------------------ cleanup
  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { id: SCHOOL } })) === 0, "test school removed");

  await prisma.$disconnect();
  console.log(failed ? "\nSOME DRAFT CHECKS FAILED" : "\nALL DRAFT CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
