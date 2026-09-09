/**
 * §30 stage 1 — the resource pool, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/resource-groups-smoke.cjs
 *
 * Stage 1 adds a column and changes nothing else, so almost everything here is
 * a NEGATIVE assertion: the school behaves exactly as it did. The two that are
 * not negative are the ones the rest of §30 stands on.
 *
 *   1. **The two columns never disagree.** A cohort row's pool and its
 *      timetable's pool are the same fact stored twice, and MySQL cannot keep
 *      them in step — a generated column may only read its own row, and this
 *      value lives in another table. §22's `draft_scope` had the database to
 *      compute it; this has `ResourceGroupService`, and this file is what says
 *      the service is actually being used. Checked across the WHOLE database,
 *      not just the fixture, because the drift this guards against arrives from
 *      whichever write path forgot to ask.
 *
 *   2. **The unique key gained a dimension and lost nothing.** Class 1-A is
 *      still refused twice in one pool — invariant 11, unchanged — and is now
 *      accepted once in a *different* pool, which is the whole of what stage 4
 *      will need.
 *
 * Everything it creates uses @zzrgp.test / "ZZRGP " and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");
const ExcelJS = req("exceljs");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzrgp.test";
const PW = "correct horse battery staple";

let failed = 0;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = 1;
};

async function call(method, path, token, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

const mailToken = async (to, kind) =>
  (await call("GET", `/dev/mail/token?to=${encodeURIComponent(to)}&kind=${kind}`)).json?.token ?? null;

const PURGE_MODELS = [
  "onboardingSession", "timetableSlot", "substitutionLog", "teacherAbsence",
  "timetableDraft", "timetablePublication", "extraClass",
  "electiveOption", "electiveBlockMember", "electiveBlock",
  "mergedTeachingGroupMember", "mergedTeachingGroup",
  "teacherSubjectClassSection", "teacherClassEligibility", "teacherSubject",
  "subjectClass", "roomSubject",
  "teacherUnavailability", "classSectionUnavailability", "subjectUnavailability", "roomUnavailability",
  "dailyActivity", "period", "holiday", "academicTerm", "classSubject",
  "classSection", "section", "subject", "schoolClass", "teacher",
  // `timetable_groups` is deliberately NOT listed: `tg_year_fk` cascades from
  // the session, and configs/sections point at pools with RESTRICT, so the
  // order below is the only one that can work — which is itself worth having
  // proved by this file running twice.
  "room", "timetableConfig", "academicYear",
  "notification", "aiChatLog", "aiSettings", "autoFixRun", "erpSyncRun",
  "auditLog", "user", "rolePermission", "erpRoleMapping", "role",
];

async function main() {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZRGP " } }, select: { id: true, code: true },
    });
    const ids = mine.map((s) => s.id);
    for (const m of PURGE_MODELS) {
      if (ids.length) await prisma[m].deleteMany({ where: { schoolId: { in: ids } } }).catch(() => undefined);
    }
    if (ids.length) await prisma.school.deleteMany({ where: { id: { in: ids } } });
    await control.tenant.deleteMany({ where: { schoolCode: { in: mine.map((s) => s.code) } } });
    await control.account.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
    const keys = await redis.keys("throttle:*:ip:*");
    if (keys.length) await redis.del(...keys);
  };
  await purge();

  // ─────────────────────────── 1. EVERY SESSION HAS EXACTLY ONE POOL
  console.log("\nEvery session has one shared pool, and nothing else changed:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZRGP Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZRGP School" });
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;
  check(made.status < 300, "school created", `school ${schoolId}`);

  const year = (await call("POST", "/academic-years", S, {
    name: "ZZRGP 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  })).json;
  const year2 = (await call("POST", "/academic-years", S, {
    name: "ZZRGP 2027-28", startDate: "2027-04-01", endDate: "2028-03-31", isActive: false,
  })).json;

  // A session created AFTER the migration has no pool until something needs
  // one. That is deliberate — one writer, created on demand — so the assertion
  // is that the first timetable causes it, not that it was there all along.
  const cfg = (await call("POST", "/timetable-configs", S, {
    name: "ZZRGP Main", academicYearId: year.id,
  })).json;
  check(cfg.resourceGroupId > 0, "a new timetable is put in a pool", `pool ${cfg.resourceGroupId}`);

  const pools = await prisma.timetableGroup.findMany({ where: { schoolId } });
  check(pools.length === 1 && pools[0].academicYearId === year.id && pools[0].mode === "grouped",
    "one pool, for the session that needed it, in grouped mode",
    pools.map((p) => `${p.name}/${p.mode}`).join(", "));

  const cfg2 = (await call("POST", "/timetable-configs", S, {
    name: "ZZRGP Second", academicYearId: year.id,
  })).json;
  check(cfg2.resourceGroupId === cfg.resourceGroupId,
    "a second timetable in the same session joins the SAME pool — which is today's behaviour, unchanged");

  const cfgNext = (await call("POST", "/timetable-configs", S, {
    name: "ZZRGP Next Year", academicYearId: year2.id,
  })).json;
  check(cfgNext.resourceGroupId !== cfg.resourceGroupId,
    "a timetable in another session gets that session's own pool — a pool cannot span two sessions (§3.11)");

  // ─────────────────────────── 2. COHORT ROWS FOLLOW THEIR TIMETABLE
  console.log("\nA cohort row belongs to the pool of the timetable that teaches it:");
  const cls = (await call("POST", "/classes", S, { name: "Class 1", sequence: 5 })).json;
  const secA = (await call("POST", `/classes/${cls.id}/sections`, S, {
    name: "A", academicYearId: year.id,
  })).json.classSection;
  check(secA.resourceGroupId === cfg.resourceGroupId,
    "created unattached, it lands in its session's shared pool",
    `pool ${secA.resourceGroupId}`);

  await call("PUT", `/timetable-configs/${cfg.id}/class-sections`, S, { classSectionIds: [secA.id] });
  const attached = await prisma.classSection.findUnique({ where: { id: secA.id } });
  check(attached.timetableConfigId === cfg.id && attached.resourceGroupId === cfg.resourceGroupId,
    "and attaching it to a timetable in that pool leaves the pool alone");

  // ─────────────────────────── 3. THE KEY GAINED A DIMENSION, LOST NOTHING
  console.log("\nClass 1-A exists once per pool — no more, and no fewer:");
  const dupSameGroup = await prisma.classSection
    .create({
      data: {
        schoolId, classId: cls.id, sectionId: attached.sectionId,
        academicYearId: year.id, resourceGroupId: attached.resourceGroupId,
      },
    })
    .then(() => null)
    .catch((e) => e);
  check(dupSameGroup && /unique/i.test(String(dupSameGroup.message ?? "")),
    "a second Class 1-A in the SAME pool is still refused — invariant 11, untouched",
    dupSameGroup ? String(dupSameGroup.message ?? "").slice(0, 46).replace(/\n/g, " ") : "IT WAS ALLOWED");

  /*
    And the half that is new. A second pool is created by hand here because
    nothing in the product makes one yet — that is stage 4 — but the KEY has to
    admit it now, or stage 4 would arrive to find the schema still refusing the
    only thing it needs.
  */
  const solo = await prisma.timetableGroup.create({
    data: { schoolId, academicYearId: year.id, name: "ZZRGP Solo", mode: "individual" },
  });
  const twin = await prisma.classSection
    .create({
      data: {
        schoolId, classId: cls.id, sectionId: attached.sectionId,
        academicYearId: year.id, resourceGroupId: solo.id,
      },
    })
    .then((r) => r)
    .catch(() => null);
  check(!!twin && twin.id !== attached.id,
    "the same Class 1-A in a DIFFERENT pool is accepted — which is the whole of what stage 4 needs",
    twin ? `rows ${attached.id} and ${twin.id}` : "REFUSED");
  check(twin && twin.classId === attached.classId && twin.sectionId === attached.sectionId,
    "same class, same section, same children — a separate allocation of them");
  if (twin) await prisma.classSection.delete({ where: { id: twin.id } });
  await prisma.timetableGroup.delete({ where: { id: solo.id } });

  // ─────────────────────────── 4. THE IMPORTER
  console.log("\nThe §16 importer files a row in the pool of the timetable its sheet names:");
  // A real .xlsx through the real endpoint: §16 only accepts an upload, and
  // hand-feeding `commitSheets` would test a function rather than the path a
  // school uses.
  const book = new ExcelJS.Workbook();
  const cSheet = book.addWorksheet("Classes");
  cSheet.addRow(["Class Name", "Sequence"]);
  cSheet.addRow(["Class 2", 6]);
  const sSheet = book.addWorksheet("Class Sections");
  sSheet.addRow(["Class Name", "Section Name", "Academic Year", "Timetable"]);
  sSheet.addRow(["Class 2", "A", "ZZRGP 2026-27", "ZZRGP Second"]);
  const buf = await book.xlsx.writeBuffer();

  const form = new FormData();
  form.append("file", new Blob([buf]), "groups.xlsx");
  const impRes = await fetch(`${API}/api/import/commit`, {
    method: "POST", headers: { Authorization: `Bearer ${S}` }, body: form,
  });
  const impText = await impRes.text();
  let impJson = null;
  try { impJson = JSON.parse(impText); } catch { /* non-JSON */ }
  const imp = { status: impRes.status, json: impJson };
  check(imp.status < 300, "the sheet commits", (imp.json?.message ?? impText).slice(0, 70));
  const imported = await prisma.classSection.findFirst({
    where: { schoolId, class: { name: "Class 2" } },
  });
  check(imported && imported.timetableConfigId === cfg2.id && imported.resourceGroupId === cfg2.resourceGroupId,
    "and it lands in that timetable's pool, not merely in the session's",
    imported ? `config ${imported.timetableConfigId} · pool ${imported.resourceGroupId}` : "not created");

  // ─────────────────────────── 5. STAGE 2 — EVERY CROSS-TIMETABLE QUESTION
  //
  // Stage 2 points the one cross-timetable calculation at the pool instead of
  // the academic year. With one pool per session the two answers are identical,
  // so what is asserted is that they ARE identical — and that the guards which
  // will matter once a second pool exists are already refusing.
  console.log("\nCross-timetable questions ask the pool, and answer the same while there is one:");

  // A teacher in two timetables of one session: their load must still be summed
  // across both, because both are in the same pool. This is Check 2, unchanged.
  const sub = (await call("POST", "/subjects", S, { name: "ZZRGP Maths" })).json;
  const teacher = (await call("POST", "/teachers", S, {
    name: "ZZRGP Shared", employeeCode: "ZZRGP-SH",
    maxPeriodsPerWeek: 40, maxPeriodsPerDay: 8, minPeriodsPerDay: 0,
  })).json;
  const secB = (await call("POST", `/classes/${cls.id}/sections`, S, {
    name: "B", academicYearId: year.id,
  })).json.classSection;
  await call("PUT", `/timetable-configs/${cfg2.id}/class-sections`, S, { classSectionIds: [secB.id] });
  await call("POST", "/class-subjects", S, {
    classId: cls.id, academicYearId: year.id, subjectId: sub.id, periodsPerWeek: 4, maxPeriodsPerDay: 2,
  });
  await call("POST", "/mappings", S, {
    teacherId: teacher.id, subjectId: sub.id, classSectionIds: [secA.id], periodsPerWeek: 4,
  });
  await call("POST", "/mappings", S, {
    teacherId: teacher.id, subjectId: sub.id, classSectionIds: [secB.id], periodsPerWeek: 4,
  });
  /*
    Made observable rather than asserted. 4 + 4 periods is fine on its own in
    either timetable and over the cap only when SUMMED, so a weekly limit of 6
    can be met by one timetable alone and cannot be met by both — which makes
    the blocker below proof that the other timetable is still being counted.
  */
  await call("PUT", `/teachers/${teacher.id}`, S, {
    employeeCode: "ZZRGP-SH", name: "ZZRGP Shared", maxPeriodsPerDay: 8, maxPeriodsPerWeek: 6,
  });
  const ready = await call("GET", `/timetable-configs/${cfg.id}/readiness`, S);
  check(ready.status === 200, "readiness still computes for a teacher in two timetables", `${ready.status}`);
  const overload = [...(ready.json?.blockers ?? []), ...(ready.json?.warnings ?? [])]
    .find((b) => /ZZRGP Shared/.test(b.message ?? ""));
  check(!!overload && /ZZRGP Second/.test(`${overload.message} ${overload.fix ?? ""}`),
    "and 4 + 4 periods over a cap of 6 is reported, NAMING the other timetable in the pool — Check 2 unchanged",
    overload ? overload.message.slice(0, 84) : "no overload reported at all");

  // The guard that cannot fire yet, and is written for exactly that reason.
  const otherPool = await prisma.timetableGroup.create({
    data: { schoolId, academicYearId: year.id, name: "ZZRGP Other", mode: "grouped" },
  });
  const strayId = (await prisma.classSection.create({
    data: {
      schoolId, classId: cls.id, sectionId: attached.sectionId,
      academicYearId: year.id, resourceGroupId: otherPool.id,
    },
  })).id;
  const attachForeign = await call("PUT", `/timetable-configs/${cfg.id}/class-sections`, S, {
    classSectionIds: [secA.id, strayId],
  });
  check(attachForeign.status === 400 && /resource group/i.test(attachForeign.json?.message ?? ""),
    "a cohort row from ANOTHER pool cannot be attached — it has no timetable, so the old check let it through",
    (attachForeign.json?.message ?? "").slice(0, 72));
  const stillMine = await prisma.classSection.findUnique({ where: { id: secA.id } });
  check(stillMine.timetableConfigId === cfg.id,
    "and the refusal left the legitimate section in the request alone — no half-applied write");

  // The optional filter the screens will use once "Class 1-A" appears twice.
  const allRows = (await call("GET", "/class-sections", S)).json ?? [];
  const mineOnly = (await call("GET", `/class-sections?timetableConfigId=${cfg.id}`, S)).json ?? [];
  check(allRows.length === mineOnly.length + 1,
    "?timetableConfigId= narrows the list to that timetable's pool",
    `${allRows.length} in the school, ${mineOnly.length} in the pool`);
  check(mineOnly.every((r) => r.resourceGroupId === cfg.resourceGroupId),
    "and every row it returns really is in that pool");

  await prisma.classSection.delete({ where: { id: strayId } });
  await prisma.timetableGroup.delete({ where: { id: otherPool.id } });

  // ─────────────────────────── 6. STAGE 3 — WHEN A TIMETABLE APPLIES
  //
  // The rule that makes individual timetables safe: two PUBLISHED timetables
  // whose windows overlap may not share a class. Everything here is new
  // behaviour, so unlike stages 1 and 2 these are positive assertions.
  console.log("\nA timetable says when it applies, and two live ones cannot share a class:");

  const badOrder = await call("PUT", `/timetable-configs/${cfg.id}`, S, {
    effectiveFrom: "2026-09-01", effectiveTo: "2026-06-30",
  });
  check(badOrder.status === 400 && /end .* before it starts/i.test(badOrder.json?.message ?? ""),
    "a window that ends before it starts is refused, with both dates named",
    (badOrder.json?.message ?? "").slice(0, 62));

  const outside = await call("PUT", `/timetable-configs/${cfg.id}`, S, {
    effectiveFrom: "2025-01-01", effectiveTo: "2026-06-30",
  });
  check(outside.status === 400 && /inside its session/i.test(outside.json?.message ?? ""),
    "and one reaching outside its session is refused, naming the session's own dates",
    (outside.json?.message ?? "").slice(0, 62));

  const dated = await call("PUT", `/timetable-configs/${cfg.id}`, S, {
    effectiveFrom: "2026-04-01", effectiveTo: "2026-06-30",
  });
  check(dated.status < 300, "a window inside the session is accepted", `${dated.status}`);
  const readBack = (await call("GET", "/timetable-configs", S)).json.find((c) => c.id === cfg.id);
  check(readBack?.effectiveFrom === "2026-04-01" && readBack?.effectiveTo === "2026-06-30",
    "and comes back on the config summary — which is how eighteen screens get it",
    `${readBack?.effectiveFrom} → ${readBack?.effectiveTo}`);

  // Clearing it means "the whole session" again, not "unchanged".
  await call("PUT", `/timetable-configs/${cfg.id}`, S, { effectiveFrom: null, effectiveTo: null });
  const cleared = (await call("GET", "/timetable-configs", S)).json.find((c) => c.id === cfg.id);
  check(cleared?.effectiveFrom === null && cleared?.effectiveTo === null,
    "clearing both dates restores 'the whole session' — null is a value here, not an omission");

  /*
    The rule itself. Both timetables are in the SAME pool here, so they cannot
    share a class-section — but they can share a CLASS once each has a section
    of it, which is exactly what stage 4 will make ordinary and what the check
    has to catch. `secA` is Class 1 in cfg; `secB` is Class 1 in cfg2.
  */
  const shareClass = await prisma.classSection.findMany({
    where: { id: { in: [secA.id, secB.id] } }, select: { classId: true, timetableConfigId: true },
  });
  check(new Set(shareClass.map((r) => r.classId)).size === 1,
    "the fixture really does put one CLASS in two timetables",
    `class ${shareClass[0]?.classId} in ${shareClass.map((r) => r.timetableConfigId).join(" and ")}`);

  // Publish the first one by hand: the solver is not what is under test here.
  const draftRow = await prisma.timetableDraft.findFirst({ where: { timetableConfigId: cfg.id } });
  await prisma.timetablePublication.create({
    data: {
      schoolId, timetableConfigId: cfg.id, version: 1,
      slotCount: 0, changedCount: 0, unallocatedCount: 0,
    },
  });
  void draftRow;

  const clash = await call("POST", `/timetable-configs/${cfg2.id}/board/publish`, S, {});
  check(clash.status === 400 && /one live timetable at a time/i.test(clash.json?.message ?? ""),
    "publishing a second timetable over the same class is refused",
    (clash.json?.message ?? "").slice(0, 70));
  check(/Class 1/.test(clash.json?.message ?? "") && /ZZRGP Main/.test(clash.json?.message ?? ""),
    "and the refusal names the CLASS and the timetable already live — not just 'conflict'",
    (clash.json?.message ?? "").slice(0, 96));

  // Disjoint windows: both may be live, which is the whole point of the dates.
  await call("PUT", `/timetable-configs/${cfg.id}`, S, {
    effectiveFrom: "2026-04-01", effectiveTo: "2026-06-30",
  });
  await call("PUT", `/timetable-configs/${cfg2.id}`, S, {
    effectiveFrom: "2026-07-01", effectiveTo: "2026-08-31",
  });
  const apart = await call("POST", `/timetable-configs/${cfg2.id}/board/publish`, S, {});
  check(apart.status !== 400 || !/one live timetable at a time/i.test(apart.json?.message ?? ""),
    // It reaches the empty-draft refusal, which is PAST the validity rule —
    // this fixture never runs the solver, so that is as far as publish can get
    // and it is exactly the evidence wanted: the rule let it through.
    "with different date ranges the same two timetables get PAST the rule — it is about overlap, not about sharing a class",
    (apart.json?.message ?? `${apart.status}`).slice(0, 62));

  // And re-dating back into the overlap is refused too — the other way in.
  const redate = await call("PUT", `/timetable-configs/${cfg2.id}`, S, {
    effectiveFrom: "2026-04-01", effectiveTo: "2026-08-31",
  });
  const cfg2Now = (await call("GET", "/timetable-configs", S)).json.find((c) => c.id === cfg2.id);
  check(redate.status === 400 || cfg2Now?.effectiveFrom === "2026-07-01",
    "re-dating a timetable back into the overlap is refused by the same rule",
    `${redate.status} · window still ${cfg2Now?.effectiveFrom}`);

  // §3.14 — withdrawing frees the window. That is what makes "withdraw this
  // one, publish that one" an ordinary Tuesday rather than a dead end.
  await prisma.timetablePublication.updateMany({
    where: { timetableConfigId: cfg.id }, data: { withdrawnAt: new Date() },
  });
  await call("PUT", `/timetable-configs/${cfg2.id}`, S, {
    effectiveFrom: "2026-04-01", effectiveTo: "2026-08-31",
  });
  const freed = (await call("GET", "/timetable-configs", S)).json.find((c) => c.id === cfg2.id);
  check(freed?.effectiveFrom === "2026-04-01",
    "once the other is WITHDRAWN the window is free — a withdrawn publication is history, not a claim");

  await prisma.timetablePublication.deleteMany({ where: { timetableConfigId: cfg.id } });
  await call("PUT", `/timetable-configs/${cfg.id}`, S, { effectiveFrom: null, effectiveTo: null });
  await call("PUT", `/timetable-configs/${cfg2.id}`, S, { effectiveFrom: null, effectiveTo: null });

  // ─────────────────────────── 7. STAGE 4 — INDIVIDUAL TIMETABLES
  //
  // The feature. Everything before this made it possible; this is a school
  // actually creating one and getting its own Class 1-A.
  console.log("\nAn individual timetable stands on its own:");

  const solo2 = (await call("POST", "/timetable-configs", S, {
    name: "ZZRGP Evening", academicYearId: year.id, mode: "individual",
  })).json;
  check(solo2?.id > 0 && solo2.resourceGroupId !== cfg.resourceGroupId,
    "it is created in a pool of its own, not the session's shared one",
    `pool ${solo2?.resourceGroupId} vs ${cfg.resourceGroupId}`);
  const soloList = (await call("GET", "/timetable-configs", S)).json.find((c) => c.id === solo2.id);
  check(soloList?.resourceMode === "individual",
    "and says so on the config summary — which is what puts the badge on its card",
    soloList?.resourceMode);
  check((await call("GET", "/timetable-configs", S)).json.find((c) => c.id === cfg.id)?.resourceMode === "grouped",
    "while every other timetable is still grouped — the default is unchanged");

  /*
    The §16 importer giving it its OWN Class 1-A. This is the assertion the
    whole of stages 1–3 was for: without the pool in the existence key the
    importer finds the main wing's Class 1-A, calls the row existing, skips it,
    and the timetable opens with no classes and no error.
  */
  const book2 = new ExcelJS.Workbook();
  const sh2 = book2.addWorksheet("Class Sections");
  sh2.addRow(["Class Name", "Section Name", "Academic Year", "Timetable"]);
  sh2.addRow(["Class 1", "A", "ZZRGP 2026-27", "ZZRGP Evening"]);
  const buf2 = await book2.xlsx.writeBuffer();
  const form2 = new FormData();
  form2.append("file", new Blob([buf2]), "solo.xlsx");
  const impRes2 = await fetch(`${API}/api/import/commit`, {
    method: "POST", headers: { Authorization: `Bearer ${S}` }, body: form2,
  });
  check(impRes2.status < 300, "importing Class 1-A into it commits", `${impRes2.status}`);
  const bothRows = await prisma.classSection.findMany({
    where: { schoolId, classId: cls.id, sectionId: attached.sectionId },
    select: { id: true, resourceGroupId: true, timetableConfigId: true },
  });
  check(bothRows.length === 2,
    "and creates a SECOND Class 1-A rather than skipping it — the existence key carries the pool",
    `${bothRows.length} rows`);
  check(bothRows.some((r) => r.timetableConfigId === solo2.id),
    "the new one belongs to the individual timetable");
  check(new Set(bothRows.map((r) => r.resourceGroupId)).size === 2,
    "and the two sit in different pools — same children, separate allocations");

  // Re-importing the same sheet must skip, or every commit doubles the school.
  const form3 = new FormData();
  form3.append("file", new Blob([buf2]), "solo.xlsx");
  await fetch(`${API}/api/import/commit`, {
    method: "POST", headers: { Authorization: `Bearer ${S}` }, body: form3,
  });
  const afterTwice = await prisma.classSection.count({
    where: { schoolId, classId: cls.id, sectionId: attached.sectionId },
  });
  check(afterTwice === 2,
    "importing the same sheet twice creates nothing extra — idempotent, as §16 requires",
    `${afterTwice} rows`);

  // "One wing only", expressed as a property of the pool.
  const secondWing = await call("POST", "/timetable-configs", S, {
    name: "ZZRGP Evening 2", academicYearId: year.id,
    resourceGroupId: solo2.resourceGroupId, mode: "grouped",
  });
  check(secondWing.status === 400 && /individual timetable/i.test(secondWing.json?.message ?? ""),
    "a second timetable cannot JOIN an individual pool — refused by name, not silently redirected",
    (secondWing.json?.message ?? `${secondWing.status}`).slice(0, 74));
  const soloConfigs = await prisma.timetableConfig.count({ where: { resourceGroupId: solo2.resourceGroupId } });
  check(soloConfigs === 1,
    "and the pool still holds exactly one — 'one wing only', held by the pool rather than remembered by a screen",
    `${soloConfigs} timetable in that pool`);

  // And the picker narrows, which is what stops "Class 1-A" appearing twice.
  const soloPicker = (await call("GET", `/class-sections?timetableConfigId=${solo2.id}`, S)).json ?? [];
  const mainPicker = (await call("GET", `/class-sections?timetableConfigId=${cfg.id}`, S)).json ?? [];
  check(soloPicker.length === 1 && soloPicker[0].label === "Class 1-A",
    "the individual timetable's picker offers its own Class 1-A and nothing else",
    soloPicker.map((r) => r.label).join(", "));
  check(!mainPicker.some((r) => r.id === soloPicker[0]?.id),
    "and the main timetable's picker does not offer it — same label, different children's allocation");

  // ─────────────────────────── 8. STAGE 6 — CLASHES BETWEEN LIVE TIMETABLES
  //
  // §30.5 made the case that matters impossible: a class cannot be in two live
  // timetables. What is left is two timetables over DIFFERENT classes sharing a
  // teacher or a room — and that is a real-world collision the app has never
  // reported, in schools' data today.
  console.log("\nTwo live timetables sharing a teacher at the same moment are reported:");

  // Two wings that keep different hours, so the clash is only visible on the
  // clock: Junior P2 08:40–09:20 against Senior P3 09:00–09:35.
  const wingA = (await call("POST", "/timetable-configs", S, {
    name: "ZZRGP Clash A", academicYearId: year.id,
  })).json;
  const wingB = (await call("POST", "/timetable-configs", S, {
    name: "ZZRGP Clash B", academicYearId: year.id,
  })).json;
  for (const [c, start, dur] of [[wingA, "08:00", 40], [wingB, "07:30", 35]]) {
    await call("PUT", `/timetable-configs/${c.id}/structure`, S, {
      startTime: start, periodsPerDay: 6, periodDurationMins: dur,
      workingDays: [1, 2, 3, 4, 5], breaks: [],
    });
  }
  const pA = await prisma.period.findFirst({ where: { timetableConfigId: wingA.id, periodNumber: 2 } });
  const pB = await prisma.period.findFirst({ where: { timetableConfigId: wingB.id, periodNumber: 3 } });
  check(pA && pB && pA.periodNumber !== pB.periodNumber
    && pA.startTime < pB.endTime && pB.startTime < pA.endTime,
    "the fixture's two periods overlap on the CLOCK while having different numbers",
    `A P${pA?.periodNumber} ${pA?.startTime}-${pA?.endTime} vs B P${pB?.periodNumber} ${pB?.startTime}-${pB?.endTime}`);

  /*
    wingA is made genuinely feasible — its own class, curriculum and staffing —
    so its Readiness score is a real number rather than the floor. Without that
    the "the score does not move" assertion below compares 0 with 0 and would
    pass even if the clash warnings were being counted against it.
  */
  const clashCls = (await call("POST", "/classes", S, { name: "Class 3", sequence: 7 })).json;
  const clashSec = (await call("POST", `/classes/${clashCls.id}/sections`, S, {
    name: "A", academicYearId: year.id,
  })).json.classSection;
  await call("PUT", `/timetable-configs/${wingA.id}/class-sections`, S, { classSectionIds: [clashSec.id] });
  const clashTeacher = (await call("POST", "/teachers", S, {
    name: "ZZRGP Clasher", employeeCode: "ZZRGP-CL",
    maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6, minPeriodsPerDay: 0,
  })).json;
  await call("POST", "/class-subjects", S, {
    classId: clashCls.id, academicYearId: year.id, subjectId: sub.id,
    periodsPerWeek: 4, maxPeriodsPerDay: 2,
  });
  await call("POST", "/mappings", S, {
    teacherId: clashTeacher.id, subjectId: sub.id, classSectionIds: [clashSec.id], periodsPerWeek: 4,
  });
  const baseline = await call("GET", `/timetable-configs/${wingA.id}/readiness`, S);
  check((baseline.json?.score ?? 0) > 0,
    "with a class, a curriculum and a teacher, wingA scores above the floor — so the score below can actually move",
    `${baseline.json?.score}%`);

  // One published lesson each, same teacher, same day, overlapping minutes.
  const clashRoom = (await call("POST", "/rooms", S, { name: "ZZRGP Hall", roomType: "classroom", capacity: 40 })).json;
  for (const [c, p] of [[wingA, pA], [wingB, pB]]) {
    await prisma.timetableSlot.create({
      data: {
        schoolId, timetableConfigId: c.id, status: "published", source: "auto",
        dayOfWeek: 1, periodNumber: p.periodNumber,
        teacherId: clashTeacher.id, subjectId: sub.id, roomId: clashRoom.id,
        teacherOccupancyKey: `zzrgp-${c.id}-1-${p.periodNumber}`,
      },
    });
    await prisma.timetablePublication.create({
      data: { schoolId, timetableConfigId: c.id, version: 1, slotCount: 1, changedCount: 0, unallocatedCount: 0 },
    });
  }

  const rA = await call("GET", `/timetable-configs/${wingA.id}/readiness`, S);
  const clashes = (rA.json?.warnings ?? []).filter((w) => w.code === "CROSS_TIMETABLE_CLASH");
  check(clashes.length > 0,
    "the clash is reported — a collision no unique key can see, because they are different period NUMBERS",
    clashes[0]?.message?.slice(0, 84) ?? "nothing reported");
  check(clashes.some((w) => /ZZRGP Clash A/.test(w.message) && /ZZRGP Clash B/.test(w.message)),
    "naming BOTH timetables, since the fix is a decision about the pair");
  check(clashes.every((w) => w.severity === "warning" && !w.remedy),
    "as a warning with no remedy — only the school knows whether the two really run at once");
  check(clashes.some((w) => w.entity?.type === "teacher") && clashes.some((w) => w.entity?.type === "room"),
    "for the teacher AND the room, which are two different collisions in one cell",
    clashes.map((w) => w.entity?.type).join(", "));

  /*
    And it must not move the score. §28.1 settled this for Check 12: a school
    that asks to be told something has not become less able to generate by
    asking, and a dashboard falling for answering reads as the warning having
    broken something.
  */
  const scoreWith = rA.json?.score;
  await prisma.timetablePublication.updateMany({
    where: { timetableConfigId: wingB.id }, data: { withdrawnAt: new Date() },
  });
  const stale = await redis.keys(`s${schoolId}:readiness:*`);
  if (stale.length) await redis.del(...stale);
  const rAfter = await call("GET", `/timetable-configs/${wingA.id}/readiness`, S);
  check(rAfter.json?.score === scoreWith && (scoreWith ?? 0) > 0,
    "and the score is the same with the clash and without it — readiness is 'can this generate?', which a clash does not change",
    `${scoreWith}% → ${rAfter.json?.score}% (not the floor, so it could have moved)`);
  check((rAfter.json?.warnings ?? []).every((w) => w.code !== "CROSS_TIMETABLE_CLASH"),
    "withdrawing the other timetable clears it — a draft cannot collide with anything, because nobody is in a room because of it");

  // Disjoint windows: they never run together, so they are not in conflict.
  await prisma.timetablePublication.updateMany({
    where: { timetableConfigId: wingB.id }, data: { withdrawnAt: null },
  });
  await call("PUT", `/timetable-configs/${wingA.id}`, S, { effectiveFrom: "2026-04-01", effectiveTo: "2026-06-30" });
  await call("PUT", `/timetable-configs/${wingB.id}`, S, { effectiveFrom: "2026-07-01", effectiveTo: "2026-08-31" });
  const rApart = await call("GET", `/timetable-configs/${wingA.id}/readiness`, S);
  check((rApart.json?.warnings ?? []).every((w) => w.code !== "CROSS_TIMETABLE_CLASH"),
    "and two timetables that never run at the same time are not in conflict, however much they share");

  await prisma.timetableSlot.deleteMany({ where: { timetableConfigId: { in: [wingA.id, wingB.id] } } });
  await prisma.timetablePublication.deleteMany({ where: { timetableConfigId: { in: [wingA.id, wingB.id] } } });

  // ─────────────────────────── 9. THE DRIFT GUARD
  //
  // The assertion stage 1 exists for. Two columns hold one fact and no database
  // constraint can tie them together, so the only thing standing between them
  // is that every write path asks `ResourceGroupService`. This is what says
  // they all do — across every school in the database, not just this fixture,
  // because the write path that forgot is by definition the one not under test.
  console.log("\nThe two columns that hold one fact have not drifted — anywhere:");
  const drifted = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) AS n FROM class_sections cs
      JOIN timetable_config c ON c.id = cs.timetable_config_id
     WHERE cs.resource_group_id <> c.resource_group_id`);
  check(Number(drifted[0].n) === 0,
    "no cohort row sits in a pool its own timetable is not in",
    `${drifted[0].n} drifted`);

  const orphanYear = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) AS n FROM timetable_groups g
      JOIN timetable_config c ON c.resource_group_id = g.id
     WHERE c.academic_year_id <> g.academic_year_id`);
  check(Number(orphanYear[0].n) === 0,
    "and no timetable is in a pool belonging to a different session",
    `${orphanYear[0].n} crossed`);

  const crossSchool = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) AS n FROM timetable_groups g
      JOIN class_sections cs ON cs.resource_group_id = g.id
     WHERE cs.school_id <> g.school_id`);
  check(Number(crossSchool[0].n) === 0,
    "and no pool is shared across schools (§17)", `${crossSchool[0].n} crossed`);

  const everyYear = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) AS n FROM academic_years y
     WHERE EXISTS (SELECT 1 FROM timetable_config c WHERE c.academic_year_id = y.id)
       AND NOT EXISTS (SELECT 1 FROM timetable_groups g WHERE g.academic_year_id = y.id)`);
  check(Number(everyYear[0].n) === 0,
    "and every session that holds a timetable has a pool for it",
    `${everyYear[0].n} without`);

  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { name: { startsWith: "ZZRGP " } } })) === 0, "test school removed");
  check((await prisma.timetableGroup.count({ where: { schoolId } })) === 0,
    "and its pools went with its sessions — the cascade, not a delete somebody remembered");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
  console.log(failed ? "\nSOME RESOURCE GROUP CHECKS FAILED" : "\nALL RESOURCE GROUP CHECKS PASSED");
  process.exit(failed);
}

main().catch((e) => { console.error(e); process.exit(1); });
