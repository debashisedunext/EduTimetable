/**
 * §33 — a longer lesson is a DOUBLE PERIOD, not a second clock.
 *
 * ## The request
 *
 * "Class 1 has 8 periods of 30 minutes, Class 10 has 4 periods of 60 minutes,
 * the start time and end time are the same."
 *
 * ## Why this is allowed where §28.5 is refused
 *
 * §28.5 refuses two *unaligned* period lengths in one timetable, and the reason
 * is invariant 1: `uq_teacher_slot` compares period NUMBERS, so a teacher in
 * Class 9 P3 (09:00–09:30 on a 30-minute grid) and Class 11 P2 (08:40–09:20 on
 * a 40-minute one) overlaps in wall clock while the database sees 3 against 2
 * and accepts it. The guard silently stops guarding.
 *
 * 60 is exactly two 30s, so nothing is unaligned. There is ONE grid of eight
 * 30-minute periods, and Class 10's hour is a lesson that occupies two of them
 * — which this system has placed atomically since the solver was written.
 *
 * The load-bearing fact is in `apps/api/src/solver/writer.ts`: a placement of
 * span N emits **N slot rows, one per period number**. So Class 10's 08:00–09:00
 * hour holds period 1 *and* period 2, and a teacher who also has Class 1's
 * 08:30–09:00 lesson collides on period 2 — refused by the same unique index
 * that protects every other school. Nothing is switched off, and this is
 * STRICTER than the §30 wings route, where a shared teacher's cross-wing
 * overlap is only a warning.
 *
 * ## What this proves, in order
 *
 *  1. A class with no span row behaves exactly as it does today (invariant 7).
 *  2. Setting a span reaches the solver, and a generation places that class's
 *     lessons as ADJACENT PAIRS — the assertion that proves the feature.
 *  3. Every pair starts on an even boundary, so Class 10's hours line up with
 *     Class 1's half-hours instead of drifting across them.
 *  4. **The database refuses a teacher across the boundary** — the whole
 *     safety argument, tested by trying the write directly rather than by
 *     trusting the solver not to attempt it.
 *  5. A class's own double-period curriculum row is not multiplied away.
 *  6. Span 1 stores nothing; an out-of-range span and another school's class
 *     are refused (§17.8).
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzcp.test";
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
  "subjectClass", "roomSubject", "timetableSubject", "timetableClassSpan",
  "teacherUnavailability", "classSectionUnavailability", "subjectUnavailability", "roomUnavailability",
  "dailyActivity", "period", "holiday", "academicTerm", "classSubject",
  "classSection", "section", "subject", "schoolClass", "teacher",
  "room", "timetableConfig", "timetableGroup", "academicYear",
  "notification", "aiChatLog", "aiSettings", "autoFixRun", "erpSyncRun",
  "auditLog", "user", "rolePermission", "erpRoleMapping", "role",
];

/** Wait for the worker to fill this config, then return its draft rows. */
async function generated(prisma, configId, token) {
  await call("POST", `/timetable-configs/${configId}/generate`, token, {});
  for (let i = 0; i < 90; i++) {
    const rows = await prisma.timetableSlot.findMany({
      where: { timetableConfigId: configId, status: "draft" },
      select: { classSectionId: true, subjectId: true, teacherId: true, dayOfWeek: true, periodNumber: true, draftId: true },
      orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
    });
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return [];
}

async function main() {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZCP " } }, select: { id: true, code: true },
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

  console.log("\nA school on a 30-minute grid, eight periods a day:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZCP Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZCP School" });
  check(made.status < 300, "school created", `school ${made.json?.schoolId}`);
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;

  const year = (await call("POST", "/academic-years", S, {
    name: "ZZCP 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  })).json;
  const cfg = (await call("POST", "/timetable-configs", S, {
    name: "ZZCP Main", academicYearId: year.id,
  })).json;
  await call("PUT", `/timetable-configs/${cfg.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 8, periodDurationMins: 30, workingDays: [1, 2, 3, 4, 5], breaks: [],
  });

  // Class 1 stays on single periods; Class 10 is the one that wants hours.
  const mk = async (name, sequence) => {
    const c = (await call("POST", "/classes", S, { name, sequence })).json;
    // The route returns the Section AND the ClassSection; `.id` alone is the
    // wrong one, and claiming it attaches nothing while reporting 200.
    const r = await call("POST", `/classes/${c.id}/sections`, S, { name: "A", academicYearId: year.id });
    // The route returns the Section AND the ClassSection; `.id` alone is the
    // wrong one, and claiming it attaches nothing while reporting 200.
    return { id: c.id, name, secId: r.json?.classSection?.id ?? r.json?.id, ok: r.status < 300 };
  };
  const one = await mk("ZZCP Class 1", 5);
  const ten = await mk("ZZCP Class 10", 14);
  /*
    BOTH in one call. `PUT /class-sections` REPLACES the set rather than adding
    to it, so claiming them one at a time leaves only the last — and the
    timetable then teaches one class while every check still reads as if it
    taught two.
  */
  const claim = await call("PUT", `/timetable-configs/${cfg.id}/class-sections`, S, {
    classSectionIds: [one.secId, ten.secId],
  });
  const attached = await prisma.classSection.count({ where: { timetableConfigId: cfg.id } });
  check(one.ok && ten.ok && claim.status < 300 && attached === 2,
    "Class 1-A and Class 10-A both belong to the timetable", `${attached} attached`);

  const subject = (await call("POST", "/subjects", S, { name: "ZZCP Maths", code: "ZMAT" })).json;
  // One teacher for BOTH classes, deliberately: that is the person the
  // boundary collision would put in two rooms at once.
  const teacher = (await call("POST", "/teachers", S, {
    name: "ZZCP Shared", employeeCode: "ZZCP-1", maxPeriodsPerWeek: 40, minPeriodsPerDay: 0,
  })).json;
  for (const k of [one, ten]) {
    await call("POST", "/class-subjects", S, {
      classId: k.id, subjectId: subject.id, academicYearId: year.id, periodsPerWeek: 4, maxPeriodsPerDay: 2,
    });
    await call("POST", "/mappings", S, {
      teacherId: teacher.id, subjectId: subject.id, classSectionId: k.secId, periodsPerWeek: 4,
    });
  }

  // ─────────────── 1. NOT STATED IS SPAN 1
  console.log("\nBefore anybody says otherwise:");
  const fresh = (await call("GET", `/timetable-configs/${cfg.id}/class-periods`, S)).json;
  check(fresh?.baseDurationMins === 30 && fresh?.periodsPerDay === 8,
    "the grid is eight 30-minute periods", `${fresh?.periodsPerDay} × ${fresh?.baseDurationMins}`);
  // `length === 2` is IN the assertion: `every()` is true of an empty array, so
  // without it this passes on a timetable that teaches nobody — which is
  // exactly what a mis-attached section produces.
  check((fresh?.classes ?? []).length === 2
      && fresh.classes.every((c) => c.span === 1 && c.durationMins === 30),
    "both classes are on single 30-minute lessons — no rows, no change",
    (fresh?.classes ?? []).map((c) => `${c.name} ${c.durationMins}m`).join(" · ") || "no classes");
  const stored = await prisma.timetableClassSpan.count({ where: { timetableConfigId: cfg.id } });
  check(stored === 0, "and nothing is stored for them", `${stored} rows`);

  // ─────────────── 2. CLASS 10 GOES TO HOURS
  console.log("\nClass 10 moves to 60-minute lessons:");
  const put = await call("PUT", `/timetable-configs/${cfg.id}/class-periods`, S, { classId: ten.id, span: 2 });
  check(put.status < 300, "the span is accepted", `${put.status}`);
  const after = (await call("GET", `/timetable-configs/${cfg.id}/class-periods`, S)).json;
  const ten10 = (after?.classes ?? []).find((c) => c.id === ten.id);
  const one1 = (after?.classes ?? []).find((c) => c.id === one.id);
  check(ten10?.durationMins === 60 && ten10?.lessonsPerDay === 4,
    "Class 10 now has four 60-minute lessons a day",
    `${ten10?.lessonsPerDay} × ${ten10?.durationMins}m`);
  check(one1?.durationMins === 30 && one1?.lessonsPerDay === 8,
    "while Class 1 still has eight of 30 — same start, same finish",
    `${one1?.lessonsPerDay} × ${one1?.durationMins}m`);

  // ─────────────── 3. THE ASSERTION THAT PROVES THE FEATURE
  console.log("\nGenerating:");
  const rows = await generated(prisma, cfg.id, S);
  check(rows.length > 0, "it generates", `${rows.length} slot rows`);

  const bySection = (id) => rows.filter((r) => r.classSectionId === id);
  const tenRows = bySection(ten.secId);
  const oneRows = bySection(one.secId);
  check(tenRows.length === 4 && oneRows.length === 4,
    "four base periods each — 2 hours for Class 10, 4 half-hours for Class 1",
    `Class 10 ${tenRows.length} · Class 1 ${oneRows.length}`);

  /*
    The real assertion: Class 10's rows come in ADJACENT PAIRS on the same day.
    Counting rows alone would pass on four scattered singles, which is exactly
    what a span that never reached the solver would produce.
  */
  const pairs = [];
  const byDay = new Map();
  for (const r of tenRows) {
    if (!byDay.has(r.dayOfWeek)) byDay.set(r.dayOfWeek, []);
    byDay.get(r.dayOfWeek).push(r.periodNumber);
  }
  let paired = true;
  for (const [day, ps] of byDay) {
    ps.sort((a, b) => a - b);
    if (ps.length % 2 !== 0) { paired = false; continue; }
    for (let i = 0; i < ps.length; i += 2) {
      if (ps[i + 1] !== ps[i] + 1) paired = false;
      pairs.push(`${day}:${ps[i]}-${ps[i + 1]}`);
    }
  }
  check(paired && pairs.length === 2,
    "and every Class 10 lesson is two ADJACENT periods — the span reached the solver",
    pairs.join(" · ") || "none");

  /*
    §33.6 — the STORED unit is unchanged, and that is the point of converting
    in the cell rather than in the column.

    The curriculum row still says 4 base periods; the Lesson Grid reads that
    back as 2 lessons because Class 10's span is 2, and typing 2 stores 4
    again. Were the column ever switched to lessons, every school with an
    existing double period would silently halve — `writer.ts` counts base
    periods and `uq_teacher_slot` protects them.
  */
  const stored10 = await prisma.classSubject.findFirst({
    where: { classId: ten.id, subjectId: subject.id }, select: { periodsPerWeek: true },
  });
  check(stored10?.periodsPerWeek === 4,
    "while the curriculum row still stores BASE periods — 4, read back as 2 lessons of an hour",
    `periods_per_week ${stored10?.periodsPerWeek}`);
  check(tenRows.length === 4 && pairs.length === 2,
    "...so 4 base periods became 2 lessons on the timetable, not 4",
    `${tenRows.length} base periods · ${pairs.length} lessons`);

  // ─────────────── 4. HOURS START ON AN HOUR
  check(pairs.length === 2 && pairs.every((p) => Number(p.split(":")[1].split("-")[0]) % 2 === 1),
    "each hour starts on an odd period, so it lines up with the clock rather than straddling",
    pairs.join(" · ") || "no pairs");

  // ─────────────── 5. THE SAFETY ARGUMENT, TESTED DIRECTLY
  //
  // Not "the solver did not do it" — that is a property of the search. This
  // asks the DATABASE, which is what invariant 1 actually rests on.
  console.log("\nThe guarantee underneath:");
  if (tenRows.length === 0) {
    check(false, "STOPPING — nothing was generated, so the rest would assert nothing");
    await purge();
    process.exit(1);
  }
  const hour = tenRows[0];
  /*
    In the SAME draft as the generated rows, which is not a detail.

    §22 puts a stored generated `draft_scope` inside all three unique keys — 0
    for published rows, the draft id otherwise — precisely so two named drafts
    may hold alternative placements. A clash row written with `draftId: null`
    therefore lands in scope 0, collides with nothing, and is accepted: the
    test would report the guard broken when the guard was never asked.
  */
  const clash = await prisma.timetableSlot.create({
    data: {
      schoolId, timetableConfigId: cfg.id, classSectionId: one.secId,
      dayOfWeek: hour.dayOfWeek, periodNumber: hour.periodNumber,
      subjectId: subject.id, teacherId: teacher.id, roomId: null,
      status: "draft", source: "auto", draftId: hour.draftId,
      /*
        And `teacher_occupancy_key` set the way `writer.ts` sets it.

        It is a plain nullable column written from CODE, not a database
        generated one like `draft_scope` — and MySQL permits any number of
        NULLs in a unique index. So a hand-written row that leaves it out is
        accepted no matter what else is in the cell, and the test would report
        the guard broken when the guard was simply never consulted.
      */
      teacherOccupancyKey: `T-${teacher.id}`,
    },
  }).then(() => "accepted").catch((e) => (e.code === "P2002" ? "refused" : `error ${e.code}`));
  check(clash === "refused",
    "the same teacher cannot be put in Class 1 at a period Class 10's hour covers",
    clash);

  const second = tenRows.find((r) => r.dayOfWeek === hour.dayOfWeek && r.periodNumber === hour.periodNumber + 1);
  check(!!second,
    "...and the second half of that hour is a slot row of its own — which is WHY the index can see it",
    second ? `period ${second.periodNumber} is present` : "MISSING — the guard would have a hole");

  // ─────────────── 6. A CLASS'S OWN DOUBLE IS NOT MULTIPLIED AWAY
  console.log("\nA lab that was already a double period:");
  await call("PUT", "/class-subjects", S, {}).catch(() => undefined);
  const cs = await prisma.classSubject.findFirst({ where: { classId: ten.id, subjectId: subject.id } });
  await prisma.classSubject.update({ where: { id: cs.id }, data: { consecutiveBlockSize: 2 } });
  // The class span is 2 and the row says 2. Taking the larger keeps both true;
  // multiplying would make it 4 and quietly turn an hour into two.
  const snap = (await call("GET", `/timetable-configs/${cfg.id}/readiness`, S)).json;
  check(snap?.stats?.totalRequiredSlots === 8,
    "the requirement is still 8 base periods, not 16 — spans are a floor, never a multiplier",
    `${snap?.stats?.totalRequiredSlots}`);

  // ─────────────── 7. REFUSALS
  console.log("\nWhat is refused:");
  const tooLong = await call("PUT", `/timetable-configs/${cfg.id}/class-periods`, S, { classId: ten.id, span: 9 });
  check(tooLong.status >= 400, "a lesson longer than the day", `${tooLong.status}`);
  const back = await call("PUT", `/timetable-configs/${cfg.id}/class-periods`, S, { classId: ten.id, span: 1 });
  const left = await prisma.timetableClassSpan.count({ where: { timetableConfigId: cfg.id } });
  check(back.status < 300 && left === 0,
    "going back to single periods stores nothing — 'not stated' and 1 are the same answer",
    `${left} rows`);

  const email2 = `stranger@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email: email2, password: PW, name: "ZZCP Stranger" });
  const acct2 = (await call("POST", "/auth/verify", null, { token: await mailToken(email2, "verify") })).json.accountToken;
  const T = (await call("POST", "/schools", acct2, { name: "ZZCP Other" })).json.sessionToken;
  const peek = await call("GET", `/timetable-configs/${cfg.id}/class-periods`, T);
  check(peek.status === 404, "another school cannot read it", `${peek.status}`);
  const poke = await call("PUT", `/timetable-configs/${cfg.id}/class-periods`, T, { classId: ten.id, span: 2 });
  check(poke.status === 404, "nor write it", `${poke.status}`);

  console.log("\nCleanup:");
  await purge();
  check(true, "test schools removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();

  console.log(failed ? "\nSOME CLASS-PERIOD CHECKS FAILED" : "\nALL CLASS-PERIOD CHECKS PASSED");
  process.exit(failed);
}

main().catch((e) => { console.error(e); process.exit(1); });
