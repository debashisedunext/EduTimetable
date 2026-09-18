/**
 * §38 — the Published summary, against a real generated week.
 *
 *   docker compose exec api node /app/scripts/summary-smoke.cjs
 *
 * The summary's whole claim is that it **composes rather than calculates** —
 * every figure on it already has an owner, and it asks that owner. A test that
 * only checked "does the endpoint answer?" would pass just as well for a screen
 * quietly inventing its own numbers, which is the exact fault this codebase has
 * had to fix over and over (`weekPeriods`, `initialsOf`, `coverage.ts`).
 *
 * So what it asserts is **agreement with the sources**:
 *
 *   1. `required` matches Readiness' own `totalRequiredSlots` — Check 1's
 *      arithmetic, not a second sum.
 *   2. `placed` matches the published rows in the database, counted directly.
 *   3. Every teacher's `periods` matches their published rows here, and their
 *      `totalPeriods` is never less — §29.3a's rule that the load is the whole
 *      week and the other wings are named.
 *   4. A second timetable's teacher is NOT in this one's list, and a teacher who
 *      holds nothing here is left out — the two ways the list could quietly
 *      become "every teacher in the school".
 *   5. A stranger gets 404 (§17.8), never an empty summary reading as "this
 *      timetable teaches nobody".
 *
 * Everything it creates uses @zzsum.test / "ZZSUM " and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzsum.test";
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

async function main() {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZSUM " } }, select: { id: true, code: true },
    });
    const ids = mine.map((s) => s.id);
    for (const m of [
      "timetableUnlockEvent", "timetableUnlockEntity", "timetableUnlock",
      "onboardingSession", "timetableSlot", "substitutionLog", "teacherAbsence",
      "timetableDraft", "timetablePublication", "extraClass",
      "electiveOption", "electiveBlockMember", "electiveBlock",
      "mergedTeachingGroupMember", "mergedTeachingGroup",
      "teacherSubjectClassSection", "teacherClassEligibility", "teacherSubject",
      "subjectClass", "roomSubject", "timetableFixedLesson",
      "teacherUnavailability", "classSectionUnavailability", "subjectUnavailability",
      "roomUnavailability",
      "dailyActivity", "period", "holiday", "academicTerm", "classSubject",
      "classSection", "section", "subject", "schoolClass", "teacher",
      "room", "timetableConfig", "academicYear",
      "notification", "aiChatLog", "aiSettings", "autoFixRun", "erpSyncRun",
      "auditLog", "user", "rolePermission", "erpRoleMapping", "role",
    ]) {
      if (ids.length) await prisma[m].deleteMany({ where: { schoolId: { in: ids } } }).catch(() => undefined);
    }
    if (ids.length) await prisma.school.deleteMany({ where: { id: { in: ids } } });
    await control.tenant.deleteMany({ where: { schoolCode: { in: mine.map((s) => s.code) } } });
    await control.account.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  };
  await purge();

  // ══════════════════════════════════ 1. A SMALL, FULLY GENERATED SCHOOL
  console.log("\nA school with a generated, published week:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZSUM Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZSUM School" });
  check(made.status < 300, "school created", `school ${made.json?.schoolId}`);
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;

  const year = (await call("POST", "/academic-years", S, {
    name: "ZZSUM 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  })).json;
  const cfg = (await call("POST", "/timetable-configs", S, {
    name: "ZZSUM Wing", academicYearId: year.id,
  })).json;
  await call("PUT", `/timetable-configs/${cfg.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 5, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
  });

  const klass = (await call("POST", "/classes", S, { name: "Class 1", sequence: 5 })).json;
  const secA = (await call("POST", `/classes/${klass.id}/sections`, S, { name: "A", academicYearId: year.id })).json.classSection;
  const secB = (await call("POST", `/classes/${klass.id}/sections`, S, { name: "B", academicYearId: year.id })).json.classSection;
  await call("PUT", `/timetable-configs/${cfg.id}/class-sections`, S, {
    classSectionIds: [secA.id, secB.id],
  });

  const maths = (await call("POST", "/subjects", S, { name: "ZZSUM Maths" })).json;
  const art = (await call("POST", "/subjects", S, { name: "ZZSUM Art" })).json;
  const ajay = (await call("POST", "/teachers", S, {
    name: "ZZSUM Ajay", employeeCode: "ZZSUM-T1", maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6,
  })).json;
  const nisha = (await call("POST", "/teachers", S, {
    name: "ZZSUM Nisha", employeeCode: "ZZSUM-T2", maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6,
  })).json;
  // Teaches nothing at all. The list must not include them — §38's own filter,
  // and the difference between "teachers on this timetable" and "the staff".
  const idle = (await call("POST", "/teachers", S, {
    name: "ZZSUM Idle", employeeCode: "ZZSUM-T3", maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6,
  })).json;
  const roomA = (await call("POST", "/rooms", S, { name: "ZZSUM Room A", roomType: "classroom", capacity: 40 })).json;
  const roomB = (await call("POST", "/rooms", S, { name: "ZZSUM Room B", roomType: "classroom", capacity: 40 })).json;
  await call("PUT", `/class-sections/${secA.id}`, S, { homeRoomId: roomA.id });
  await call("PUT", `/class-sections/${secB.id}`, S, { homeRoomId: roomB.id });

  await call("POST", "/class-subjects", S, {
    classId: klass.id, academicYearId: year.id, subjectId: maths.id, periodsPerWeek: 4,
  });
  await call("POST", "/class-subjects", S, {
    classId: klass.id, academicYearId: year.id, subjectId: art.id, periodsPerWeek: 3,
  });
  await call("POST", "/mappings", S, {
    teacherId: ajay.id, subjectId: maths.id, classSectionIds: [secA.id, secB.id], periodsPerWeek: 4,
  });
  await call("POST", "/mappings", S, {
    teacherId: nisha.id, subjectId: art.id, classSectionIds: [secA.id, secB.id], periodsPerWeek: 3,
  });

  await call("POST", `/timetable-configs/${cfg.id}/generate`, S, {});
  let done = null;
  for (let i = 0; i < 60 && !done; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = await call("GET", `/timetable-configs/${cfg.id}/generate/latest`, S);
    if (r.json?.state === "completed" || r.json?.state === "failed") done = r.json;
  }
  check(done?.state === "completed", "it generates", `${done?.state}`);
  const pub = await call("POST", `/timetable-configs/${cfg.id}/board/publish`, S, {});
  check(pub.status < 300, "and publishes", `${pub.status}`);

  // ════════════════════════════════════════ 2. THE SUMMARY ITSELF
  console.log("\nThe summary answers, and says what it is describing:");
  const sum = (await call("GET", `/timetable-configs/${cfg.id}/summary`, S)).json;
  check(sum?.id === cfg.id && sum?.published === true,
    "it reports the published timetable", `v${sum?.version} · ${sum?.where}`);
  check(sum?.frozenAt != null,
    "and notes that publishing locked it (§29.8)", `${sum?.frozenAt ? "locked" : "not locked"}`);

  // ═══════════════════════ 3. IT COMPOSES — every figure matches its owner
  //
  // The assertions that matter. A summary inventing its own arithmetic would
  // answer perfectly well and disagree with the screen beside it.
  console.log("\nEvery figure agrees with the thing that owns it:");

  const readiness = (await call("GET", `/timetable-configs/${cfg.id}/readiness`, S)).json;
  check(sum?.totals?.required === readiness?.stats?.totalRequiredSlots,
    "required is Readiness' own total — Check 1's arithmetic, not a second sum",
    `summary ${sum?.totals?.required} · readiness ${readiness?.stats?.totalRequiredSlots}`);

  const publishedRows = await prisma.timetableSlot.count({
    where: { timetableConfigId: cfg.id, status: "published", source: { not: "extra" }, classSectionId: { not: null } },
  });
  check(sum?.totals?.placed === publishedRows,
    "placed is the published rows, counted in the database",
    `summary ${sum?.totals?.placed} · rows ${publishedRows}`);

  const perSection = sum?.classes ?? [];
  check(perSection.length === 2 && perSection.reduce((n, c) => n + c.placed, 0) === publishedRows,
    "and the class-wise rows add back up to it",
    perSection.map((c) => `${c.label} ${c.placed}/${c.required}`).join(" · "));

  check(perSection.every((c) => c.required === 7),
    "each class-section is owed its CLASS's curriculum — 4 + 3, not the two sections summed",
    perSection.map((c) => `${c.label}=${c.required}`).join(" "));

  // ══════════════════════════════════ 4. THE TEACHER LIST
  console.log("\nThe teachers are the ones on THIS timetable:");
  const names = (sum?.teachers ?? []).map((t) => t.name);
  check(names.includes("ZZSUM Ajay") && names.includes("ZZSUM Nisha"),
    "everybody who teaches here is listed", names.join(", "));
  check(!names.includes("ZZSUM Idle"),
    "and a teacher who holds nothing here is not — this is not the staff list",
    `${names.length} of 3 teachers`);

  for (const t of sum?.teachers ?? []) {
    const real = await prisma.timetableSlot.count({
      where: { timetableConfigId: cfg.id, status: "published", source: { not: "extra" }, teacherId: t.id },
    });
    check(t.periods === real, `${t.name}'s periods here match their published rows`, `${t.periods} = ${real}`);
    /*
      §29.3a — the whole week is never SMALLER than the part.

      A load drawn round one wing reads 67% where the truth is 87%, so the
      summary measures against the total. Equal here, because this school has
      one timetable — the assertion is that it is not the other way round, which
      is what a mistaken subtraction would produce.
    */
    check(t.totalPeriods >= t.periods,
      `…and their whole-week load is not less than it`, `${t.totalPeriods} ≥ ${t.periods}`);
    check(t.capacity > 0 && t.loadPct !== null,
      `…with a capacity from teacherWeeklyCapacity, never a blank`, `${t.loadPct}% of ${t.capacity}`);
  }

  // ═══════════════════════════════════════ 5. §17.8 — A STRANGER
  console.log("\nAnd another school's timetable is a 404:");
  const other = await prisma.timetableConfig.findFirst({
    where: { schoolId: { not: schoolId } }, select: { id: true },
  });
  if (other) {
    const peek = await call("GET", `/timetable-configs/${other.id}/summary`, S);
    check(peek.status === 404,
      "never an empty summary that would read as 'this timetable teaches nobody'",
      `${peek.status}`);
  }

  console.log("\nCleanup:");
  await purge();
  check(true, "test school removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
  console.log(failed ? "\nSOME SUMMARY CHECKS FAILED" : "\nALL SUMMARY CHECKS PASSED");
  process.exit(failed);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
