/**
 * §14 — report caches must not outlive a publish.
 *
 * The bug this exists to catch: `classSectionTimetable` caches its grid for an
 * hour, and publishing used to drop only the `slots:*` keys. So a class-section
 * report anyone had opened while the timetable was still a draft went on being
 * served from cache after the publish — a full week of "Free" for a timetable
 * that had just gone live. Only the sections somebody happened to look at early
 * were affected, which is exactly the kind of "some pages are wrong" report
 * that is miserable to chase.
 *
 * The oracle here is the database, not a previous reading: after publishing,
 * the report must agree cell for cell with the `published` rows. A stale cache
 * cannot fake that.
 *
 * In-container:  node scripts/report-cache-smoke.cjs
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { disableAutoLock } = require("/app/scripts/auto-lock.cjs");
const { groupFor } = require("./resource-groups.cjs");

const API = process.env.API_URL || "http://localhost:3000";
const P = "ZZRPT";

let failed = 0;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(schoolCode) {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      erpUserId: `${P}-1`, erpRole: "ADMIN", name: "Report Admin",
      email: "r@zzrpt.test", school: { code: schoolCode, name: "ZZRPT School" },
    }),
  });
  const { token } = await r.json();
  const cb = await fetch(`${API}/api/sso/callback?token=${token}`, { redirect: "manual" });
  return (cb.headers.get("location") || "").split("#token=")[1] ?? null;
}
async function call(method, path, token, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { status: res.status, text }; }
}

/** One small school: 1 section, 2 subjects, 2 teachers, 5 days x 4 periods. */
async function build(prisma, schoolId) {
  const year = await prisma.academicYear.create({
    data: { schoolId, name: `${P} 2026-27`, startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"), isActive: true },
  });
  const config = await prisma.timetableConfig.create({
    data: {
      resourceGroupId: await groupFor(prisma, year.id),
      schoolId, academicYearId: year.id, name: `${P} Main`,
      workingDays: [1, 2, 3, 4, 5], periodsPerDay: 4,
      periods: {
        create: [1, 2, 3, 4].map((n) => ({
          schoolId, periodNumber: n, sortOrder: n, isBreak: false,
          startTime: `0${7 + n}:00`.slice(-5), endTime: `0${7 + n}:45`.slice(-5),
        })),
      },
    },
  });
  const cls = await prisma.schoolClass.create({ data: { schoolId, name: `${P} Class 1`, sequence: 1 } });
  const section = await prisma.section.create({ data: { schoolId, classId: cls.id, name: "A" } });
  const room = await prisma.room.create({ data: { schoolId, name: `${P} Room 1`, roomType: "classroom" } });
  const cs = await prisma.classSection.create({
    data: {
      resourceGroupId: await groupFor(prisma, year.id), schoolId, classId: cls.id, sectionId: section.id, academicYearId: year.id, timetableConfigId: config.id, homeRoomId: room.id },
  });

  const built = [];
  for (const [name, periods] of [["Maths", 10], ["English", 10]]) {
    const subject = await prisma.subject.create({ data: { schoolId, name: `${P} ${name}` } });
    const teacher = await prisma.teacher.create({
      data: {
        schoolId, employeeCode: `${P}-${name}`, name: `${P} T.${name}`,
        maxPeriodsPerDay: 4, maxPeriodsPerWeek: 30,
        // §20: 10 periods over 5 days is 2 a day — below the default minimum of
        // 3, and this fixture is about caching, not about shape.
        minPeriodsPerDay: 1,
        eligibility: { create: [{ classId: cls.id, schoolId }] },
      },
    });
    const req = await prisma.classSubject.create({
      data: { schoolId, classId: cls.id, academicYearId: year.id, subjectId: subject.id, periodsPerWeek: periods, maxPeriodsPerDay: 3 },
    });
    const mapping = await prisma.teacherSubjectClassSection.create({
      data: { schoolId, teacherId: teacher.id, subjectId: subject.id, classSectionId: cs.id, periodsPerWeek: periods },
    });
    built.push({ name, subject, teacher, req, mapping });
  }
  return { config, cs, built };
}

async function generate(configId, token) {
  await call("POST", `/timetable-configs/${configId}/generate`, token);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const job = await call("GET", `/timetable-configs/${configId}/generate/latest`, token);
    if (job.state === "completed") return true;
    if (job.state === "failed") return false;
  }
  return false;
}

/** What the database says the published week is, in the report's own shape. */
async function publishedGrid(prisma, schoolId, classSectionId) {
  // `timetable_slots` carries ids, not relations — the names come separately.
  const rows = await prisma.timetableSlot.findMany({ where: { schoolId, classSectionId, status: "published" } });
  const subjects = new Map(
    (await prisma.subject.findMany({ where: { schoolId } })).map((x) => [x.id, x.name]),
  );
  const teachers = new Map(
    (await prisma.teacher.findMany({ where: { schoolId } })).map((x) => [x.id, x.name]),
  );
  const out = {};
  for (const r of rows) {
    // §10.6 — the grid key names the wing, not just the period. A period NUMBER
    // stopped being an identity when a card could span two wings (§3.10), and
    // this helper mirrors the server's `cellKey(day, rowKey(config, period))`.
    out[`${r.dayOfWeek}:c${r.timetableConfigId}p${r.periodNumber}`] =
      `${subjects.get(r.subjectId) ?? ""}|${teachers.get(r.teacherId) ?? ""}`;
  }
  return out;
}
const reportGrid = (report) =>
  Object.fromEntries(Object.entries(report.grid ?? {}).map(([k, c]) => [k, `${c.subject ?? ""}|${c.teacher ?? ""}`]));

const sameGrid = (a, b) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);

(async () => {
  const prisma = new PrismaClient();
  const code = `${P}-${Date.now().toString(36).toUpperCase()}`;
  const token = await session(code);
  check(Boolean(token), "admin session");
  const school = await prisma.school.findFirst({ where: { code } });
  check(Boolean(school), "school provisioned by SSO", code);

  try {
    const { config, cs, built } = await build(prisma, school.id);
    /*
      §29.8 — publishing LOCKS the timetable, and this suite is about cache
      invalidation. It publishes twice with a board edit in between, so the lock
      would refuse the middle half; `locks-smoke.cjs` asserts the auto-lock
      itself. See scripts/auto-lock.cjs.
    */
    await disableAutoLock(prisma, school.id);

    console.log("\nA first timetable is generated and published:");
    check(await generate(config.id, token), "draft generated");
    let pub = await call("POST", `/timetable-configs/${config.id}/board/publish`, token);
    check(pub.ok === true, "published", `version ${pub.version}`);

    const first = reportGrid(await call("GET", `/reports/class-section/${cs.id}`, token));
    check(Object.keys(first).length === 20, "the report shows the published week", `${Object.keys(first).length} cells`);
    check(sameGrid(first, await publishedGrid(prisma, school.id, cs.id)), "and it agrees with the database");

    console.log("\nThe report is read again, then a DIFFERENT week is published over it:");
    // Reading warms the cache. This is the browser tab someone left open.
    await call("GET", `/reports/class-section/${cs.id}`, token);

    // The change has to come from the *board*, not from master data: any
    // master-data write calls readiness.invalidate(), which drops every key the
    // school owns and would hide exactly the bug under test.
    await call("POST", `/timetable-configs/${config.id}/board/draft-from-published`, token);
    const cards = await prisma.timetableSlot.findMany({
      where: { schoolId: school.id, classSectionId: cs.id, status: "draft" },
      orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
    });
    check(cards.length === 20, "the draft is back on the board", `${cards.length} cards`);

    // Swap two lessons of different subjects — a change nothing else undoes.
    const a = cards[0];
    const b = cards.find((c) => c.subjectId !== a.subjectId);
    check(Boolean(b), "two different subjects to swap");
    const swap = await call("POST", `/timetable-configs/${config.id}/board/swap`, token, {
      a: { classSectionId: cs.id, day: a.dayOfWeek, period: a.periodNumber },
      expectA: { subjectId: a.subjectId, teacherId: a.teacherId },
      b: { classSectionId: cs.id, day: b.dayOfWeek, period: b.periodNumber },
      expectB: { subjectId: b.subjectId, teacherId: b.teacherId },
    });
    check(swap.ok === true, "two lessons swapped on the board", JSON.stringify(swap).slice(0, 140));

    pub = await call("POST", `/timetable-configs/${config.id}/board/publish`, token);
    check(pub.ok === true, "published again", `version ${pub.version}`);

    const truth = await publishedGrid(prisma, school.id, cs.id);
    check(!sameGrid(truth, first), "the newly published week really is different", "otherwise this test proves nothing");
    const after = reportGrid(await call("GET", `/reports/class-section/${cs.id}`, token));
    check(
      sameGrid(after, truth),
      "the report matches the newly published week, not the copy cached before it",
      sameGrid(after, first) && !sameGrid(first, truth) ? "STALE — still serving the pre-publish cache" : `${Object.keys(after).length} cells`,
    );

    console.log("\nA substitution's dated report is not cached past the substitution:");
    const dated = await call("GET", `/reports/class-section/${cs.id}?date=2026-04-06`, token);
    check(Object.keys(dated.grid ?? {}).length === 20, "the dated view renders", `${Object.keys(dated.grid ?? {}).length} cells`);
  } catch (e) {
    check(false, "unexpected error", String(e.message).split("\n").slice(0, 3).join(" ").slice(0, 240));
  } finally {
    console.log("\nCleanup:");
    const s = school.id;
    await prisma.$transaction([
      prisma.timetableSlot.deleteMany({ where: { schoolId: s } }),
      // §22: after the slots — the draft FK is RESTRICT (generated draft_scope)
      prisma.timetableDraft.deleteMany({ where: { schoolId: s } }),
      prisma.timetablePublication.deleteMany({ where: { schoolId: s } }),
      prisma.teacherSubjectClassSection.deleteMany({ where: { schoolId: s } }),
      prisma.teacherClassEligibility.deleteMany({ where: { schoolId: s } }),
      prisma.classSubject.deleteMany({ where: { schoolId: s } }),
      prisma.teacher.deleteMany({ where: { schoolId: s } }),
      prisma.subject.deleteMany({ where: { schoolId: s } }),
      prisma.classSection.deleteMany({ where: { schoolId: s } }),
      prisma.section.deleteMany({ where: { schoolId: s } }),
      prisma.schoolClass.deleteMany({ where: { schoolId: s } }),
      prisma.room.deleteMany({ where: { schoolId: s } }),
      prisma.period.deleteMany({ where: { schoolId: s } }),
      prisma.timetableConfig.deleteMany({ where: { schoolId: s } }),
      prisma.academicYear.deleteMany({ where: { schoolId: s } }),
    ]);
    check(true, "test school's data removed");
    await prisma.$disconnect();
  }

  console.log(failed ? "\nSOME REPORT CACHE CHECKS FAILED" : "\nALL REPORT CACHE CHECKS PASSED");
  process.exit(failed);
})();
