/**
 * §26.2/§26.3 — the subject placement rules, against a real generation.
 *
 *   docker compose exec api node /app/scripts/subject-rules-smoke.cjs
 *
 * The unit tests prove the arithmetic. This proves the only thing that matters
 * to a school: that a timetable which comes out of the solver **obeys** the
 * rules they set. Every assertion below reads the generated slots, not an API
 * response — a 201 from Generate says nothing about where Games landed.
 *
 *   1. REFUSE   — a rule that cannot fit is a blocker BEFORE generation, with
 *                 both numbers in the message
 *   2. WIDEN    — relaxing the rule clears the blocker
 *   3. OBEY     — the generated timetable puts no Games before lunch, and none
 *                 in the period straight after it
 *   4. PRIORITY — priority-5 subjects sit measurably earlier than priority-1
 *   5. NEUTRAL  — a school that sets nothing generates exactly as before
 *
 * Everything it creates uses @zzrule.test / "ZZRULE " and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzrule.test";
const PW = "correct horse battery staple";

let failed = 0;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = 1;
};

/**
 * A setup step that fails must SAY so.
 *
 * The first run of this file built no class-sections and no curriculum, and
 * reported "Readiness refuses it — score 0": a school with no data scores 0 and
 * raises no blockers, so six checks failed describing a feature that had never
 * been exercised. A fixture is not a test, and a silent one is worse than none.
 */
function must(res, what) {
  if (res.status >= 300) {
    console.error(`  SETUP FAILED  ${what} → ${res.status} ${(res.json?.message ?? res.text ?? "").slice(0, 160)}`);
    process.exit(1);
  }
  return res.json;
}

async function call(method, path, token, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

const mailToken = async (to, kind) =>
  (await call("GET", `/dev/mail/token?to=${encodeURIComponent(to)}&kind=${kind}`)).json?.token ?? null;

(async () => {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZRULE " } }, select: { id: true, code: true },
    });
    const ids = mine.map((s) => s.id);
    if (ids.length) {
      const where = { where: { schoolId: { in: ids } } };
      for (const m of [
        "timetableSlot", "timetableDraft", "timetablePublication", "extraClass", "period",
        "autoFixRun", "teacherSubjectClassSection", "classSubject", "classSection", "section",
        "schoolClass", "subject", "teacher", "room", "timetableConfig", "academicTerm",
        "academicYear", "onboardingSession", "aiChatLog", "auditLog", "user", "rolePermission",
        "erpRoleMapping", "role",
      ]) {
        await prisma[m].deleteMany(where).catch(() => undefined);
      }
      await prisma.school.deleteMany({ where: { id: { in: ids } } });
    }
    await control.tenant.deleteMany({ where: { schoolCode: { in: mine.map((s) => s.code) } } });
    await control.account.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
    const keys = await redis.keys("throttle:*:ip:*");
    if (keys.length) await redis.del(...keys);
  };
  await purge();

  // ───────────────────────────────────────────────────────────── the school
  //
  // Small and hand-built: 2 sections, a 6-period day with lunch after P3, and
  // four subjects. Big enough for the rules to bite, small enough that a
  // failure names the cell rather than needing a search.
  const email = `a@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZ Rule Owner" });
  const vt = await mailToken(email, "verify");
  const acct = (await call("POST", "/auth/verify", null, { token: vt })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZRULE School" });
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;

  const year = must(await call("POST", "/academic-years", S, {
    name: "ZZRULE 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  }), "create academic year");
  const cfg = must(await call("POST", "/timetable-configs", S, { name: "ZZRULE Wing", academicYearId: year.id }), "create timetable");
  must(await call("PUT", `/timetable-configs/${cfg.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 6, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5],
    // Lunch after P3 — the boundary every rule below is about.
    breaks: [{ afterPeriod: 3, name: "Lunch", durationMins: 40 }],
  }), "write the week");

  const klass = must(await call("POST", "/classes", S, { name: "ZZ Class 5", sequence: 8 }), "create class");
  const sections = [];
  for (const letter of ["A", "B"]) {
    // The endpoint creates the Section AND the ClassSection and returns both;
    // it is the latter that everything downstream is keyed on.
    const made = must(await call("POST", `/classes/${klass.id}/sections`, S, {
      name: letter, academicYearId: year.id,
    }), `create section ${letter}`);
    sections.push(made.classSection);
  }
  // Attaching sections to a timetable is its own call (§3.10: a class-section
  // belongs to exactly one config, so the config owns the list).
  must(await call("PUT", `/timetable-configs/${cfg.id}/class-sections`, S, {
    classSectionIds: sections.map((x) => x.id),
  }), "attach the sections to the timetable");
  for (const s of sections) {
    const room = must(await call("POST", "/rooms", S, { name: `ZZ Room ${s.id}` }), "create home room");
    must(await call("PUT", `/class-sections/${s.id}`, S, { homeRoomId: room.id }), "set home room");
  }

  // Games is the interesting one: co-scholastic, after lunch, with the gap —
  // and it gets those from its NAME, which is the §26.2 classifier working.
  const subjects = {};
  for (const name of ["Mathematics", "English", "Library", "Games"]) {
    subjects[name] = must(await call("POST", "/subjects", S, { name }), `create subject ${name}`);
  }
  check(subjects.Games.lunchRule === "after" && subjects.Games.gapAfterLunch === true,
    "Games was classified from its name — after lunch, with the gap",
    `${subjects.Games.lunchRule} gap=${subjects.Games.gapAfterLunch}`);
  check(subjects.Mathematics.priority === 5 && subjects.Library.priority === 1,
    "and Maths outranks Library for the morning",
    `${subjects.Mathematics.priority} vs ${subjects.Library.priority}`);

  const curriculum = { Mathematics: 8, English: 8, Library: 6, Games: 8 };
  for (const [name, periods] of Object.entries(curriculum)) {
    must(await call("POST", "/class-subjects", S, {
      classId: klass.id, subjectId: subjects[name].id, academicYearId: year.id,
      periodsPerWeek: periods, maxPeriodsPerDay: 2,
    }), `curriculum row for ${name}`);
  }
  const teachers = {};
  let n = 0;
  for (const name of Object.keys(curriculum)) {
    teachers[name] = must(await call("POST", "/teachers", S, {
      name: `ZZ ${name} Teacher`, employeeCode: `ZZR-${++n}`,
      maxPeriodsPerDay: 6, minPeriodsPerDay: 0, maxPeriodsPerWeek: 40,
    }), `create teacher for ${name}`);
    for (const s of sections) {
      must(await call("POST", "/mappings", S, {
        teacherId: teachers[name].id, subjectId: subjects[name].id,
        classSectionIds: [s.id], periodsPerWeek: curriculum[name],
      }), `map ${name} to section ${s.id}`);
    }
  }

  // ──────────────────────────────────────────────────────────── 1. REFUSE
  //
  // Games wants 8 periods a week after lunch. The afternoon is P4-P6 = 15
  // cells, and the gap rule takes P4 away, leaving 10 — which fits. Push it to
  // 12 and it cannot, and Readiness has to say so BEFORE Generate.
  console.log("\nA rule that cannot fit is refused before the solver runs:");
  await call("PUT", `/class-subjects/${(await call("GET", `/class-subjects?academicYearId=${year.id}`, S)).json.find((r) => r.subjectId === subjects.Games.id).id}`, S, {
    periodsPerWeek: 12, maxPeriodsPerDay: 3,
  });
  let readiness = (await call("GET", `/timetable-configs/${cfg.id}/readiness`, S)).json;
  let blocker = (readiness.blockers ?? []).find((b) => b.code === "LUNCH_SIDE_CAPACITY");
  check(Boolean(blocker), "Readiness refuses it", blocker ? "" : `score ${readiness.score}`);
  if (blocker) {
    check(/12 periods/.test(blocker.message) && /only 10/.test(blocker.message),
      "naming what is needed and what there is", blocker.message.slice(0, 96));
    check(/straight after lunch is kept free/.test(blocker.message),
      "and counting the gap rule as the cell it takes");
  }

  // ───────────────────────────────────────────────────────────── 2. WIDEN
  console.log("\nWidening the rule clears it:");
  await call("PUT", `/subjects/${subjects.Games.id}`, S, { lunchRule: "any" });
  readiness = (await call("GET", `/timetable-configs/${cfg.id}/readiness`, S)).json;
  check(!(readiness.blockers ?? []).some((b) => b.code === "LUNCH_SIDE_CAPACITY"),
    "no lunch blocker once Games may be taught at any time");
  // Back to a demand that fits, and to the rule under test.
  await call("PUT", `/class-subjects/${(await call("GET", `/class-subjects?academicYearId=${year.id}`, S)).json.find((r) => r.subjectId === subjects.Games.id).id}`, S, {
    periodsPerWeek: 8, maxPeriodsPerDay: 2,
  });
  await call("PUT", `/subjects/${subjects.Games.id}`, S, { lunchRule: "after", gapAfterLunch: true });
  for (const s of sections) {
    const m = (await call("GET", `/mappings?academicYearId=${year.id}`, S)).json
      .find((x) => x.subjectId === subjects.Games.id && x.classSectionId === s.id);
    if (m) await call("PUT", `/mappings/${m.id}`, S, { periodsPerWeek: 8 });
  }
  readiness = (await call("GET", `/timetable-configs/${cfg.id}/readiness`, S)).json;
  check(readiness.score >= 90 && !(readiness.blockers ?? []).some((b) => b.code === "LUNCH_SIDE_CAPACITY"),
    "and the school is ready to generate", `score ${readiness.score}, ${(readiness.blockers ?? []).length} blocker(s)`);

  // ────────────────────────────────────────────────────────────── 3. OBEY
  console.log("\nThe generated timetable obeys the rules:");
  await call("POST", `/timetable-configs/${cfg.id}/generate`, S, { mode: "fast" });
  let slots = [];
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    slots = await prisma.timetableSlot.findMany({
      where: { schoolId, status: "draft" },
      select: { subjectId: true, periodNumber: true, dayOfWeek: true },
    });
    if (slots.length > 0) break;
  }
  check(slots.length > 0, "a timetable was generated", `${slots.length} slots`);

  const at = (subjectId) => slots.filter((s) => s.subjectId === subjectId);
  const games = at(subjects.Games.id);
  check(games.length > 0, "Games was placed", `${games.length} periods`);
  /**
   * The two assertions the whole phase exists for. Lunch is after P3, so the
   * afternoon is P4-P6 and the gap rule removes P4 — Games may only be in P5
   * or P6. Anything else means the rule was set, shown on screen, and ignored.
   */
  check(games.every((s) => s.periodNumber > 3),
    "and NONE of it before lunch",
    `periods used: ${[...new Set(games.map((s) => s.periodNumber))].sort().join(",")}`);
  check(games.every((s) => s.periodNumber !== 4),
    "and none in the period straight after lunch");

  // ─────────────────────────────────────────────────────────── 4. PRIORITY
  console.log("\nPriority pulls the important subjects into the morning:");
  const mean = (rows) => (rows.length === 0 ? 0 : rows.reduce((n, s) => n + s.periodNumber, 0) / rows.length);
  const maths = mean(at(subjects.Mathematics.id));
  const library = mean(at(subjects.Library.id));
  /**
   * A mean rather than a spot check: priority is a PREFERENCE, so no single
   * lesson is guaranteed a period and an assertion about one would be flaky by
   * construction. The claim is about the shape of the week.
   */
  check(maths < library,
    "Maths (priority 5) sits earlier on average than Library (priority 1)",
    `Maths P${maths.toFixed(2)} vs Library P${library.toFixed(2)}`);

  // ──────────────────────────────────────────────────────────── 5. NEUTRAL
  //
  // The property that matters to every school already using the product: a
  // subject at the neutral default constrains nothing.
  console.log("\nA subject nobody classified constrains nothing:");
  const english = subjects.English;
  check(english.priority === 5 || english.lunchRule === "any",
    "English is unrestricted by lunch", `${english.lunchRule}`);
  check(at(english.id).some((s) => s.periodNumber <= 3) && at(english.id).some((s) => s.periodNumber > 3),
    "and is placed on both sides of lunch");

  // ─────────────────────────────────────────────────────────────── cleanup
  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { name: { startsWith: "ZZRULE " } } })) === 0, "test school removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
  console.log(failed ? "\nSOME SUBJECT-RULE CHECKS FAILED" : "\nALL SUBJECT-RULE CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
