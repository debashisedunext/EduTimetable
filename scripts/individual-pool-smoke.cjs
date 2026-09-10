/**
 * §30.9 — an individual timetable shares nothing, and the guided setup knows it.
 *
 * ## What was wrong
 *
 * §30 gave a timetable a **resource pool**: a grouped one competes with the
 * rest of the school for classes, rooms and a teacher's week; an individual one
 * stands alone and competes with nobody. The solver, the feasibility engine and
 * the §16 importer were all built that way — `crossConfigTeacherLoad` filters
 * by `resource_group_id`, and `classSectionsInPool` matches a class-section by
 * label AND pool.
 *
 * The guided setup was not. It read every `timetable_config` into one flat list
 * of wings sharing one class namespace, so a school that added an individual
 * timetable running Class 1–6 was told, six times over:
 *
 *   "Class 1 is in both Main Timetable 2026-27 and Weekly Timetable. A class
 *    belongs to one wing — narrow one of the two ranges, or remove Class 1
 *    from one of them."
 *
 * Both offered fixes are changes the school must not make. The two timetables
 * cannot see each other; that is the entire point of an individual one.
 *
 * ## What this proves, in order
 *
 *  1. The pool mode reaches the wizard (`wings[].individual`).
 *  2. `planClasses` reports **no** issue across pools — the message above.
 *  3. ...and still reports one **within** a pool, which is the rule §30 kept.
 *  4. The same class-section label exists in both pools as two different rows,
 *     which is the database half of "all assets are free".
 *  5. A teacher's cross-timetable load in the individual timetable is **zero**
 *     however much they teach in the main school — the assertion that makes
 *     "shares nothing" true of capacity and not only of classes.
 *  6. Another school still cannot read any of it (§17.8).
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const { planClasses, wingScope, GROUPED_SCOPE } = req("@edutimetable/shared");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzip.test";
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
      where: { name: { startsWith: "ZZIP " } }, select: { id: true, code: true },
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

  console.log("\nA school with two grouped wings and one individual timetable:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZIP Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZIP School" });
  check(made.status < 300, "school created", `school ${made.json?.schoolId}`);
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;

  const year = (await call("POST", "/academic-years", S, {
    name: "ZZIP 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  })).json;

  // Two wings of the main school, and one timetable that stands on its own.
  const main = (await call("POST", "/timetable-configs", S, {
    name: "ZZIP Main", academicYearId: year.id,
  })).json;
  const second = (await call("POST", "/timetable-configs", S, {
    name: "ZZIP Second", academicYearId: year.id,
  })).json;
  const weekly = (await call("POST", "/timetable-configs", S, {
    name: "ZZIP Weekly", academicYearId: year.id, mode: "individual",
  })).json;
  for (const c of [main, second, weekly]) {
    await call("PUT", `/timetable-configs/${c.id}/structure`, S, {
      startTime: "08:00", periodsPerDay: 6, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
    });
  }
  const pools = (await call("GET", "/timetable-configs", S)).json;
  const modeOf = (name) => pools.find((c) => c.name === name)?.resourceMode;
  check(modeOf("ZZIP Main") === "grouped" && modeOf("ZZIP Second") === "grouped",
    "the two wings share the session's pool", `${modeOf("ZZIP Main")}/${modeOf("ZZIP Second")}`);
  check(modeOf("ZZIP Weekly") === "individual",
    "and the third stands on its own", modeOf("ZZIP Weekly") ?? "(none)");

  // ── 4. the same class-section label in two pools, as two rows
  console.log("\nThe same class-section exists in both pools, as different children:");
  const c5 = (await call("POST", "/classes", S, { name: "Class 5" })).json;
  const secA = (await call("POST", `/classes/${c5.id}/sections`, S, {
    name: "A", academicYearId: year.id,
  })).json.classSection;
  await call("PUT", `/timetable-configs/${main.id}/class-sections`, S, { classSectionIds: [secA.id] });

  /*
    Written straight to the database with the pool the service would resolve —
    `PUT /class-sections` attaches an EXISTING row, and the point here is that a
    SECOND row with the same label may exist in another pool. The unique key is
    `(class, section, academic_year, resource_group_id)`, so this insert is the
    proof: it succeeds only because the pool is part of the key.
  */
  const weeklyPool = (await prisma.timetableConfig.findUnique({
    where: { id: weekly.id }, select: { resourceGroupId: true },
  })).resourceGroupId;
  const secB = await prisma.section.create({
    data: { schoolId, classId: c5.id, name: "A2" },
  });
  const twin = await prisma.classSection.create({
    data: {
      schoolId, classId: c5.id, sectionId: secB.id, academicYearId: year.id,
      timetableConfigId: weekly.id, resourceGroupId: weeklyPool,
    },
  });
  check(twin.resourceGroupId !== null && twin.resourceGroupId !== undefined,
    "a cohort in the individual timetable is filed in ITS pool", `pool ${twin.resourceGroupId}`);
  const mainPool = (await prisma.classSection.findUnique({
    where: { id: secA.id }, select: { resourceGroupId: true },
  })).resourceGroupId;
  check(mainPool !== twin.resourceGroupId,
    "which is not the pool the main school's cohorts are in", `${mainPool} vs ${twin.resourceGroupId}`);

  // ── 1. the pool mode reaches the wizard
  console.log("\nThe guided setup can tell them apart:");
  const session = (await call("GET", "/onboarding/session", S)).json;
  const wings = session?.answers?.wings ?? [];
  const byName = (n) => wings.find((w) => w.name === n);
  check(wings.length >= 3, "every timetable is offered as a wing", `${wings.length} wings`);
  check(byName("ZZIP Weekly")?.individual === true,
    "and the individual one says so", JSON.stringify(byName("ZZIP Weekly")?.individual));
  check(!byName("ZZIP Main")?.individual && !byName("ZZIP Second")?.individual,
    "while the grouped ones do not — absent means grouped, which is every wing before §30.9");
  check(wingScope(byName("ZZIP Main")) === GROUPED_SCOPE
    && wingScope(byName("ZZIP Second")) === GROUPED_SCOPE,
    "the two wings resolve to one pool");
  check(wingScope(byName("ZZIP Weekly")) !== GROUPED_SCOPE,
    "and the individual one to a pool of its own", wingScope(byName("ZZIP Weekly")));

  /*
    The case every existing school is in: a draft SAVED before §30.9, whose
    stored wings carry no pool at all. `GET /onboarding/session` returns the
    stored draft in preference to a rebuild, so without re-stamping on read the
    fix would reach nobody who had already opened the guided setup.
  */
  console.log("\nA draft saved without the flag still gets it back:");
  await call("PUT", "/onboarding/session", S, {
    mode: "wizard",
    currentStep: 4,
    // Deliberately stripped — this is what every stored draft looks like today.
    answers: { wings: wings.map(({ individual, ...rest }) => rest) },
  });
  const stored = await prisma.onboardingSession.findFirst({
    where: { schoolId, completedAt: null }, select: { answers: true },
  });
  check(!(stored.answers.wings ?? []).some((w) => w.individual === true),
    "the draft really was stored with no pool on any wing");
  const reread = (await call("GET", "/onboarding/session", S)).json?.answers?.wings ?? [];
  check(reread.find((w) => w.name === "ZZIP Weekly")?.individual === true,
    "reading it back stamps the pool from the school, not from the draft",
    JSON.stringify(reread.find((w) => w.name === "ZZIP Weekly")?.individual));
  /*
    Named, not counted. The two GROUPED wings here were rebuilt with the same
    default range, so they really do both claim Class 5 — and `planClasses`
    must go on saying so. What must stop is any issue naming the individual
    timetable, which is the message the school was shown six times.
  */
  const storedIssues = planClasses(reread).issues;
  check(!storedIssues.some((i) => i.message.includes("ZZIP Weekly")),
    "so the stored draft stops naming the individual timetable in a clash",
    storedIssues.find((i) => i.message.includes("ZZIP Weekly"))?.message ?? "none do");
  check(storedIssues.some((i) => i.message.includes("ZZIP Main") && i.message.includes("ZZIP Second")),
    "while two grouped wings overlapping is still reported — the rule §30 kept",
    storedIssues[0]?.message?.slice(0, 60) ?? "nothing reported");

  // ── 2 & 3. the message that was wrong, and the one that must stay
  console.log("\nThe warning that should never have been shown:");
  const overlapping = [
    { name: "ZZIP Main", fromIndex: 4, toIndex: 9, sections: 4 },
    { name: "ZZIP Weekly", fromIndex: 4, toIndex: 9, sections: 1, individual: true },
  ];
  const across = planClasses(overlapping);
  check(across.issues.length === 0,
    "a class run by a grouped wing AND an individual timetable is not a conflict",
    across.issues[0]?.message ?? "no issues");
  check(across.classes.filter((c) => c.wing === "ZZIP Weekly").length === 6,
    "and the individual timetable keeps every class it asked for",
    `${across.classes.filter((c) => c.wing === "ZZIP Weekly").length} classes`);

  const within = planClasses([
    { name: "ZZIP Main", fromIndex: 4, toIndex: 9, sections: 2 },
    { name: "ZZIP Second", fromIndex: 9, toIndex: 12, sections: 2 },
  ]);
  check(within.issues.length === 1 && within.issues[0].message.includes("Class 6"),
    "but two GROUPED wings claiming Class 6 still is — §30 kept that rule",
    within.issues[0]?.message?.slice(0, 60) ?? "no issue");

  /*
    The reported symptom, and the half `planClasses` alone did not fix.

    `commit(4)` runs `planClasses` over the wings it is HANDED and throws on the
    first issue. The draft holds every wing, so a school setting up the
    individual timetable was refused with a real conflict between two GROUPED
    wings — a message that names two timetables the screen is not showing and
    offers two fixes it cannot make.
  */
  console.log("\nCommitting the individual timetable is not blocked by the main school's clash:");
  // Both grouped wings claim Class 5, deliberately: this is the clash.
  await call("PUT", "/onboarding/session", S, {
    mode: "wizard",
    currentStep: 4,
    answers: {
      wings: [
        { name: "ZZIP Main", fromIndex: 4, toIndex: 9, sections: 2 },
        { name: "ZZIP Second", fromIndex: 4, toIndex: 9, sections: 2 },
        { name: "ZZIP Weekly", fromIndex: 4, toIndex: 6, sections: 1, individual: true },
      ],
      session: { name: "ZZIP 2026-27", startDate: "2026-04-01", endDate: "2027-03-31" },
    },
  });
  /*
    §30.11 — the refusal is computed from the DATA, not from the request.

    An unscoped commit is a caller asking for everything, and it used to be
    refused entirely because two grouped wings clash. The individual timetable
    shares nothing with them, so its rows are built and the clash comes back as
    an issue rather than as a 400 — independence that needed the request to be
    phrased right was not independence.
  */
  const wholesale = await call("POST", "/onboarding/commit/4", S);
  check(wholesale.status < 300,
    "an UNSCOPED commit builds the pools that are fine instead of refusing everything",
    wholesale.status >= 300 ? (wholesale.json?.message ?? "").slice(0, 70)
      : `created ${JSON.stringify(wholesale.json?.created ?? {})}`);
  check((wholesale.json?.issues ?? []).some((i) => /both ZZIP Main and ZZIP Second/.test(i.message)),
    "...and still reports the grouped clash rather than swallowing it",
    JSON.stringify((wholesale.json?.issues ?? [])[0]?.message ?? "none"));
  const builtWeekly = await prisma.classSection.count({
    where: { schoolId, timetableConfigId: weekly.id },
  });
  check(builtWeekly >= 3,
    "the individual timetable's cohorts exist even though another pool clashed",
    `${builtWeekly} class-sections`);

  const scoped = await call(
    "POST",
    `/onboarding/commit/4?scope=${encodeURIComponent(wingScope({ name: "ZZIP Weekly", individual: true }))}`,
    S,
  );
  check(scoped.status < 300,
    "scoped to the individual timetable it commits — the other pool's clash is not its business",
    scoped.status >= 300 ? (scoped.json?.message ?? "").slice(0, 80) : `created ${JSON.stringify(scoped.json?.created ?? {})}`);

  const weeklyRows = await prisma.classSection.count({
    where: { schoolId, timetableConfigId: weekly.id },
  });
  check(weeklyRows >= 3, "and its cohorts really exist", `${weeklyRows} class-sections`);
  const strayed = await prisma.classSection.count({
    where: { schoolId, timetableConfigId: { in: [main.id, second.id] }, resourceGroupId: weeklyPool },
  });
  check(strayed === 0, "with nothing of the main school's filed in its pool", `${strayed} strays`);

  const badScope = await call("POST", "/onboarding/commit/4?scope=individual:nothing", S);
  check(badScope.status >= 400,
    "an unknown scope is refused rather than quietly falling back to every wing",
    String(badScope.status));

  /*
    §30.11 — publishing, and the check that used to reach across pools.

    `assertPublishable` refuses a publish when another LIVE timetable already
    teaches one of the same classes over an overlapping window. That is right
    inside a pool — two wings of the main school cannot both put Class 6 on the
    wall — and wrong across them: an individual timetable is built without
    reference to any other, so a class the main school also teaches is not its
    concern. The publication row is written straight to the database because
    what is being tested is the CHECK, not the publish pipeline.
  */
  console.log("\nAn individual timetable publishes over a class the main school already teaches:");
  await prisma.timetablePublication.create({
    data: {
      schoolId, timetableConfigId: main.id, version: 1,
      slotCount: 0, changedCount: 0, unallocatedCount: 0,
    },
  });
  // Both teach Class 5 — `main` has secA, `weekly` has the twin in its own pool.
  const redateWeekly = await call("PUT", `/timetable-configs/${weekly.id}`, S, {
    name: "ZZIP Weekly", effectiveFrom: "2026-04-01", effectiveTo: "2027-03-31",
  });
  check(redateWeekly.status < 300,
    "dating it across the same window is not refused — it shares no pool with the live one",
    redateWeekly.status >= 300 ? (redateWeekly.json?.message ?? "").slice(0, 90) : "accepted");

  /*
    ...and the rule still bites inside a pool, which is the half worth keeping.

    `ZZIP Second` is given its own section of Class 5 in the SHARED pool, so it
    and the live `ZZIP Main` genuinely put the same children on the wall over
    the same dates. That must still be refused — the change was about pools, not
    about abandoning the rule.
  */
  const secC = (await call("POST", `/classes/${c5.id}/sections`, S, {
    name: "C", academicYearId: year.id,
  })).json.classSection;
  await call("PUT", `/timetable-configs/${second.id}/class-sections`, S, { classSectionIds: [secC.id] });
  const redateSecond = await call("PUT", `/timetable-configs/${second.id}`, S, {
    name: "ZZIP Second", effectiveFrom: "2026-04-01", effectiveTo: "2027-03-31",
  });
  check(redateSecond.status >= 400 && /one live timetable at a time/.test(redateSecond.json?.message ?? ""),
    "while a SIBLING WING over the same class and dates is still refused — one pool, one rule",
    redateSecond.status >= 400 ? (redateSecond.json?.message ?? "").slice(0, 70) : `accepted (${redateSecond.status})`);

  /*
    §30.7's occupancy warning follows the same rule: a teacher or a room in two
    live timetables at one wall-clock time is worth saying inside a pool and
    meaningless across them.
  */
  const ready = await call("GET", `/timetable-configs/${weekly.id}/readiness`, S);
  const crossPool = (ready.json?.warnings ?? []).filter((w) => /ZZIP Main/.test(w.message ?? ""));
  check(crossPool.length === 0,
    "and Readiness raises no occupancy clash against the other pool's live timetable",
    crossPool[0]?.message?.slice(0, 70) ?? "none");

  // ── 5. a teacher's capacity is free in the individual timetable
  console.log("\nA teacher's week is counted per pool, not per school:");
  const subject = (await call("POST", "/subjects", S, { name: "ZZIP Maths" })).json;
  const teacher = (await call("POST", "/teachers", S, {
    name: "ZZIP Rao", employeeCode: "ZZIP-1", maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6, minPeriodsPerDay: 0,
  })).json;
  await call("POST", "/class-subjects", S, {
    classId: c5.id, academicYearId: year.id, subjectId: subject.id, periodsPerWeek: 6, maxPeriodsPerDay: 2,
  });
  const mapped = await call("POST", "/mappings", S, {
    teacherId: teacher.id, subjectId: subject.id, classSectionIds: [secA.id], periodsPerWeek: 6,
  });
  check(mapped.status < 300, "the teacher takes 6 periods in the main school",
    (mapped.json?.message ?? "").slice(0, 70));

  /*
    `crossConfigTeacherLoad` is what a second timetable subtracts from a
    teacher's week before it plans. Read off the individual timetable's own
    readiness snapshot: it must be EMPTY, because nothing in the main school's
    pool is visible from here — while the second grouped wing sees all six.
  */
  const loadIn = async (configId) => {
    const r = await call("GET", `/timetable-configs/${configId}/context`, S);
    return r.json?.teachers?.[String(teacher.id)] ?? null;
  };
  const inWeekly = await loadIn(weekly.id);
  const inSecond = await loadIn(second.id);
  check(inSecond !== null && inSecond.elsewhere === 6,
    "the OTHER grouped wing sees all six — one pool, one week",
    `elsewhere ${inSecond?.elsewhere}`);
  check(inWeekly !== null && inWeekly.elsewhere === 0,
    "the individual timetable sees none of them — its assets are free",
    `elsewhere ${inWeekly?.elsewhere}`);

  // ── 6. §17.8
  console.log("\nAnother school cannot read any of it:");
  const email2 = `other@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email: email2, password: PW, name: "ZZIP Other" });
  const acct2 = (await call("POST", "/auth/verify", null, { token: await mailToken(email2, "verify") })).json.accountToken;
  const other = (await call("POST", "/schools", acct2, { name: "ZZIP Other School" })).json.sessionToken;
  const stranger = await call("GET", `/timetable-configs/${weekly.id}/context`, other);
  check(stranger.status === 404, "the individual timetable's context 404s for a stranger", String(stranger.status));

  console.log("\nCleanup:");
  await purge();
  check(true, "test schools removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
  console.log(failed ? "\nSOME CHECKS FAILED\n" : "\nALL INDIVIDUAL-POOL CHECKS PASSED\n");
  process.exit(failed);
}

main().catch((e) => { console.error(e); process.exit(1); });
