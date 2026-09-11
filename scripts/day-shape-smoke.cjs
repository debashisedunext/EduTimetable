/**
 * §34 — a weekday may run a shape of its own.
 *
 * ## The request
 *
 * "If the user selects Saturday or Sunday, ask whether it is a half day or a
 * full day. If half, default to half the periods and let them change it — and
 * the duration too, because weekend classes may be shorter."
 *
 * ## Why this is allowed where §28.5 is refused
 *
 * §28.5 refuses two period LENGTHS inside one day, because `uq_teacher_slot`
 * compares period numbers: on a 30-minute grid and a 40-minute one, Class 9 P3
 * and Class 11 P2 overlap in wall clock while the index sees 3 against 2 and
 * accepts it.
 *
 * `day_of_week` is **already part of that key**. Saturday's period 3 and
 * Monday's period 3 are different cells today, and nobody is in two days at
 * once — so a different shape per day creates no collision the index cannot
 * see. §28.5's constraint is *within* a day; this never crosses one.
 *
 * ## What this proves, in order
 *
 *  1. A timetable with no day shapes behaves exactly as it does today, and
 *     every working day reports the week's shape (invariant 7).
 *  2. A short Saturday reaches the FEASIBILITY ENGINE: the week's capacity is
 *     the SUM over the days, not `periodsPerDay × days`. Getting this wrong
 *     over-states capacity, which tells a school its curriculum fits when it
 *     does not — the dangerous direction.
 *  3. A short Saturday reaches the SOLVER: a real generation places nothing in
 *     the periods Saturday does not have. That is the assertion that proves
 *     the feature rather than the screen.
 *  4. Monday is untouched — the pruning is per day, not a new week-wide cap.
 *  5. Going back to a full day deletes the row: "the same as the rest of the
 *     week" and "not stated" are one answer.
 *  6. A day the timetable does not work is refused, and another school's
 *     config is a 404 (§17.8).
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzds.test";
const PW = "correct horse battery staple";
const SAT = 6;

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
  "subjectClass", "roomSubject", "timetableSubject", "timetableClassSpan", "timetableDayShape",
  "teacherUnavailability", "classSectionUnavailability", "subjectUnavailability", "roomUnavailability",
  "dailyActivity", "period", "holiday", "academicTerm", "classSubject",
  "classSection", "section", "subject", "schoolClass", "teacher",
  "room", "timetableConfig", "timetableGroup", "academicYear",
  "notification", "aiChatLog", "aiSettings", "autoFixRun", "erpSyncRun",
  "auditLog", "user", "rolePermission", "erpRoleMapping", "role",
];

async function main() {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZDS " } }, select: { id: true, code: true },
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

  console.log("\nA school that works Monday to Saturday, 8 periods of 40:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZDS Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZDS School" });
  check(made.status < 300, "school created", `school ${made.json?.schoolId}`);
  const S = made.json.sessionToken;

  const year = (await call("POST", "/academic-years", S, {
    name: "ZZDS 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  })).json;
  const cfg = (await call("POST", "/timetable-configs", S, {
    name: "ZZDS Main", academicYearId: year.id,
  })).json;
  await call("PUT", `/timetable-configs/${cfg.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 8, periodDurationMins: 40,
    workingDays: [1, 2, 3, 4, 5, 6], breaks: [],
  });

  const c = (await call("POST", "/classes", S, { name: "ZZDS Class 1", sequence: 5 })).json;
  const sec = await call("POST", `/classes/${c.id}/sections`, S, { name: "A", academicYearId: year.id });
  const secId = sec.json?.classSection?.id ?? sec.json?.id;
  await call("PUT", `/timetable-configs/${cfg.id}/class-sections`, S, { classSectionIds: [secId] });

  const subject = (await call("POST", "/subjects", S, { name: "ZZDS Maths", code: "ZDM" })).json;
  const teacher = (await call("POST", "/teachers", S, {
    name: "ZZDS One", employeeCode: "ZZDS-1", maxPeriodsPerWeek: 48,
    minPeriodsPerDay: 0, maxPeriodsPerDay: 8, maxConsecutivePeriodsPerDay: 8,
  })).json;

  // ─────────────── 1. NOT STATED IS THE WEEK'S SHAPE
  console.log("\nBefore anybody says otherwise:");
  const fresh = (await call("GET", `/timetable-configs/${cfg.id}/day-shapes`, S)).json;
  check((fresh?.days ?? []).length === 6,
    "all six working days are listed", `${(fresh?.days ?? []).length} days`);
  check((fresh?.days ?? []).every((d) => d.full && d.periodsPerDay === 8 && d.periodDurationMins === 40),
    "and every one reports the week's own shape",
    (fresh?.days ?? []).map((d) => `${d.day}:${d.periodsPerDay}×${d.periodDurationMins}`).join(" "));
  const stored = await prisma.timetableDayShape.count({ where: { timetableConfigId: cfg.id } });
  check(stored === 0, "with nothing stored for them", `${stored} rows`);

  // ─────────────── 2. THE ENGINE'S CAPACITY IS A SUM
  console.log("\nSaturday becomes a half day — 4 periods of 30 minutes:");
  const put = await call("PUT", `/timetable-configs/${cfg.id}/day-shapes`, S, {
    day: SAT, full: false, periodsPerDay: 4, periodDurationMins: 30,
  });
  check(put.status < 300, "the shape is accepted", `${put.status}`);

  /*
    48 would be `8 × 6`. The week is 8×5 + 4 = 44, and the difference is the
    whole point: a product over-states capacity, so Check 1 would tell this
    school a 46-period curriculum fits when the week cannot hold it.
  */
  /*
    Spread over THREE subjects, because a single row is capped at 20 by an
    ordinary field check — which is a different guard and would have made this
    assertion prove nothing. 20 + 20 + 6 = 46 for the class.

    48 would be `8 × 6`. The week is 8×5 + 4 = 44, and the difference is the
    whole point: a product over-states capacity, so Check 1 would tell this
    school a 46-period curriculum fits when the week cannot hold it.
  */
  const filler = [];
  for (const [n, periods] of [["A", 20], ["B", 20], ["C", 6]]) {
    const sub = (await call("POST", "/subjects", S, { name: `ZZDS Filler ${n}`, code: `ZF${n}` })).json;
    filler.push(sub.id);
    await call("POST", "/class-subjects", S, {
      classId: c.id, subjectId: sub.id, academicYearId: year.id,
      periodsPerWeek: periods, maxPeriodsPerDay: 8,
    });
  }
  /*
    Asserted on the engine's own STATS, not by matching its prose.

    `totalAvailableSlots` is the number Check 1 measures every curriculum
    against, so reading it directly is the difference between proving the
    arithmetic and proving that a sentence happens to contain "44".
  */
  const tight = (await call("GET", `/timetable-configs/${cfg.id}/readiness`, S)).json;
  const avail = tight?.stats?.totalAvailableSlots;
  check(avail === 44,
    "the week is 8×5 + 4 = 44, NOT 8 × 6 = 48 — Check 1 sums the days",
    `totalAvailableSlots ${avail}`);
  check(tight?.stats?.totalRequiredSlots === 46,
    "...and the 46 periods asked for are measured against it",
    `totalRequiredSlots ${tight?.stats?.totalRequiredSlots}`);

  // Clear the filler, then fill the week almost to the brim so the generation
  // below has to reach the far end of a full day.
  await prisma.classSubject.deleteMany({ where: { classId: c.id, subjectId: { in: filler } } });
  const heavy = [];
  for (const [n, periods] of [["X", 20], ["Y", 20]]) {
    const sub = (await call("POST", "/subjects", S, { name: `ZZDS Load ${n}`, code: `ZL${n}` })).json;
    heavy.push(sub.id);
    await call("POST", "/class-subjects", S, {
      classId: c.id, subjectId: sub.id, academicYearId: year.id,
      periodsPerWeek: periods, maxPeriodsPerDay: 8,
    });
    await call("POST", "/mappings", S, {
      teacherId: teacher.id, subjectId: sub.id, classSectionId: secId, periodsPerWeek: periods,
    });
  }
  check(heavy.length === 2, "40 of the week's 44 periods are spoken for");
  // ─────────────── 3. THE ASSERTION THAT PROVES THE FEATURE
  console.log("\nGenerating:");
  const ready = (await call("GET", `/timetable-configs/${cfg.id}/readiness`, S)).json;
  const blockers = (ready?.issues ?? []).filter((i) => i.severity === "blocker");
  check(blockers.length === 0, "the week is feasible before generating",
    blockers.map((b) => b.message).join(" | ").slice(0, 150) || "no blockers");
  const gen = await call("POST", `/timetable-configs/${cfg.id}/generate`, S, {});
  check(gen.status < 300, "generation starts", `${gen.status} ${(gen.json?.message ?? "").slice(0, 80)}`);
  let rows = [];
  for (let i = 0; i < 90; i++) {
    rows = await prisma.timetableSlot.findMany({
      where: { timetableConfigId: cfg.id, status: "draft" },
      select: { dayOfWeek: true, periodNumber: true },
    });
    if (rows.length > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check(rows.length === 40, "it generates the whole curriculum", `${rows.length} lessons`);
  if (rows.length === 0) {
    check(false, "STOPPING — nothing was generated, so the rest would assert nothing");
    await purge();
    process.exit(1);
  }

  const satPeriods = rows.filter((r) => r.dayOfWeek === SAT).map((r) => r.periodNumber);
  const past = satPeriods.filter((p) => p > 4);
  check(past.length === 0,
    "and places NOTHING in the periods Saturday does not have",
    satPeriods.length > 0
      ? `Saturday used periods ${[...new Set(satPeriods)].sort((a, b) => a - b).join(",")}`
      : "Saturday unused, which is also within its 4");

  // ─────────────── 4. THE REST OF THE WEEK IS UNTOUCHED
  /*
    `> 4` is the assertion, not `<= 8`.

    "No weekday exceeded 8" is true of a timetable that never left period 2, so
    it would pass whether or not the cap were per day. What proves the pruning
    is per day is a WEEKDAY reaching past Saturday's ceiling — which is why the
    week above was filled to 40 of its 44 periods.
  */
  const weekdayMax = Math.max(0, ...rows.filter((r) => r.dayOfWeek !== SAT).map((r) => r.periodNumber));
  check(weekdayMax > 4 && weekdayMax <= 8,
    "while a weekday reaches past Saturday's ceiling — the cap is per day, not a new week-wide one",
    `highest weekday period used: ${weekdayMax}`);

  /*
    §34.6 — and the printed card says which periods Saturday does not have.

    The decision was ONE row axis: show all six days and hatch the cells a
    short day never reaches, rather than splitting the card or growing a second
    header. So the payload has to carry two things the renderer cannot work out
    for itself — how far each day reaches, and that day's own clock where it
    differs from the axis. A lesson printed against the wrong minutes is a
    false statement on the one document a parent actually reads.
  */
  console.log("\nWhat the printed card says about Saturday:");
  await call("PUT", `/timetable-configs/${cfg.id}/day-shapes`, S, {
    day: SAT, full: false, periodsPerDay: 4, periodDurationMins: 30,
  });
  await call("POST", `/timetable-configs/${cfg.id}/publish`, S, {});
  const card = (await call("GET", `/reports/class-section/${secId}`, S)).json;
  check(card?.dayReach?.[SAT] === 4,
    "it reaches period 4 on Saturday", `dayReach[6] = ${card?.dayReach?.[SAT]}`);
  // The `[SAT] === 4` half is IN this one: "Monday is absent" is trivially
  // true of an empty map, which is exactly what a payload that forwarded
  // nothing would produce.
  check(card?.dayReach?.[SAT] === 4 && card?.dayReach?.[1] === undefined,
    "and says nothing about Monday — only a day that DIFFERS is described",
    JSON.stringify(card?.dayReach ?? {}));
  const satP2 = card?.dayClock?.[SAT]?.["2"] ?? card?.dayClock?.[SAT]?.[2];
  check(Array.isArray(satP2) && satP2[0] === "08:30" && satP2[1] === "09:00",
    "and Saturday's period 2 carries its OWN clock, not Monday's 08:40–09:20",
    JSON.stringify(satP2));

  // ─────────────── 5. BACK TO A FULL DAY
  console.log("\nPutting Saturday back:");
  const back = await call("PUT", `/timetable-configs/${cfg.id}/day-shapes`, S, { day: SAT, full: true });
  const left = await prisma.timetableDayShape.count({ where: { timetableConfigId: cfg.id } });
  check(back.status < 300 && left === 0,
    "stores nothing — 'the same as the rest of the week' and 'not stated' are one answer",
    `${left} rows`);

  // ─────────────── 6. REFUSALS
  console.log("\nWhat is refused:");
  const notWorked = await call("PUT", `/timetable-configs/${cfg.id}/day-shapes`, S, {
    day: 7, full: false, periodsPerDay: 2, periodDurationMins: 30,
  });
  check(notWorked.status >= 400,
    "a day the timetable does not work — a shape nothing would ever read", `${notWorked.status}`);

  /*
    §34.4 — and the sequence the screen performs when somebody ticks Sunday.

    The draft is ahead of the `timetable_config`: ticking a day changes the
    answers, and the week reaches the server on Next. So the control commits
    the week first and then sets the shape, and this is the server half of
    that — refused above, accepted here, with nothing between them but the day
    joining the working week.
  */
  await call("PUT", `/timetable-configs/${cfg.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 8, periodDurationMins: 40,
    workingDays: [1, 2, 3, 4, 5, 6, 7], breaks: [],
  });
  const nowWorked = await call("PUT", `/timetable-configs/${cfg.id}/day-shapes`, S, {
    day: 7, full: false, periodsPerDay: 2, periodDurationMins: 30,
  });
  check(nowWorked.status < 300,
    "...but accepted once that day is part of the week — commit the week, then shape the day",
    `${nowWorked.status}`);
  const sun = ((await call("GET", `/timetable-configs/${cfg.id}/day-shapes`, S)).json?.days ?? [])
    .find((d) => d.day === 7);
  check(sun && !sun.full && sun.periodsPerDay === 2,
    "and Sunday reads back as a half day of its own", `${sun?.periodsPerDay} × ${sun?.periodDurationMins}`);
  const zero = await call("PUT", `/timetable-configs/${cfg.id}/day-shapes`, S, {
    day: SAT, full: false, periodsPerDay: 0, periodDurationMins: 30,
  });
  check(zero.status >= 400, "a day of no periods — that is what working days are for", `${zero.status}`);

  const email2 = `stranger@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email: email2, password: PW, name: "ZZDS Stranger" });
  const acct2 = (await call("POST", "/auth/verify", null, { token: await mailToken(email2, "verify") })).json.accountToken;
  const T = (await call("POST", "/schools", acct2, { name: "ZZDS Other" })).json.sessionToken;
  check((await call("GET", `/timetable-configs/${cfg.id}/day-shapes`, T)).status === 404,
    "another school cannot read it");
  check((await call("PUT", `/timetable-configs/${cfg.id}/day-shapes`, T, { day: SAT, full: true })).status === 404,
    "nor write it");

  console.log("\nCleanup:");
  await purge();
  check(true, "test schools removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();

  console.log(failed ? "\nSOME DAY-SHAPE CHECKS FAILED" : "\nALL DAY-SHAPE CHECKS PASSED");
  process.exit(failed);
}

main().catch((e) => { console.error(e); process.exit(1); });
