/**
 * §32 — a timetable teaches the subjects it has DECLARED, and only those.
 *
 * ## What was wrong
 *
 * `subjects` is school-wide and there was no way to narrow it. Every timetable
 * saw every subject the school had ever entered — a Junior wing that does not
 * teach Chemistry, an individual timetable set up for a handful of languages,
 * a school that added a subject for one wing only. The guided setup's Subjects
 * step offered a red ✕ that looked like the answer and was not: it removed the
 * row from the *draft*, while the §16 importer creates subjects and never
 * deletes one, so the subject stayed in the database, kept its curriculum and
 * its mappings, and went on being taught by a timetable that had stopped
 * listing it.
 *
 * ## The rule
 *
 * `timetable_subjects` is a declaration per `timetable_config`, and **empty
 * means "not stated", never "teaches nothing"** (invariant 7). That is what
 * makes the migration a bare CREATE TABLE: every timetable that exists today
 * has no rows and keeps seeing every subject.
 *
 * Per config rather than per §30 pool, because two grouped wings share a pool
 * and are the case that motivates it.
 *
 * ## Where it is enforced
 *
 * In ONE place — `buildFeasibilitySnapshot`, applied to the CURRICULUM rather
 * than to the subject list. A subject this timetable does not teach simply has
 * no demand: the solver never sees it, Check 1 never counts its periods, and
 * Readiness never reports it missing. The rows themselves are untouched,
 * because another timetable may teach the same class the same subject and
 * deselecting is not a deletion. Everything downstream — `/context`, the
 * Lesson Grid, the Readiness score, generation — reads that snapshot.
 *
 * ## What this proves, in order
 *
 *  1. A timetable that has stated nothing sees every subject (the migration's
 *     whole safety argument).
 *  2. Narrowing it removes the subject from `/context` — the Lesson Grid's
 *     columns — and from the demand Readiness counts.
 *  3. **A real generation places none of it**, which is the assertion that
 *     proves the feature rather than the screen.
 *  4. Deselecting DELETES NOTHING: the subject, its curriculum rows and its
 *     mappings all survive, and re-selecting brings it straight back.
 *  5. Another timetable in the same school is unaffected — including one in
 *     the same §30 pool, which is the case a pool-level answer could not have
 *     expressed.
 *  6. "All of them" is stored as nothing, so a subject added later is included
 *     rather than silently orphaned.
 *  7. Another school's config id is a 404, and its subject ids cannot be
 *     written into our selection (§17.8).
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzts.test";
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
  "subjectClass", "roomSubject", "timetableSubject",
  "teacherUnavailability", "classSectionUnavailability", "subjectUnavailability", "roomUnavailability",
  "dailyActivity", "period", "holiday", "academicTerm", "classSubject",
  "classSection", "section", "subject", "schoolClass", "teacher",
  "room", "timetableConfig", "timetableGroup", "academicYear",
  "notification", "aiChatLog", "aiSettings", "autoFixRun", "erpSyncRun",
  "auditLog", "user", "rolePermission", "erpRoleMapping", "role",
];

/** The subject names `/context` offers as Lesson Grid columns. */
const columnsOf = async (token, configId) =>
  ((await call("GET", `/timetable-configs/${configId}/context`, token)).json?.subjects ?? [])
    .map((s) => s.name).sort();

async function main() {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZTS " } }, select: { id: true, code: true },
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

  console.log("\nA school with two wings in ONE pool, teaching four subjects:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZTS Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZTS School" });
  check(made.status < 300, "school created", `school ${made.json?.schoolId}`);
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;

  const year = (await call("POST", "/academic-years", S, {
    name: "ZZTS 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  })).json;

  // Two GROUPED wings — the case a pool-level answer could not express.
  const junior = (await call("POST", "/timetable-configs", S, {
    name: "ZZTS Junior", academicYearId: year.id,
  })).json;
  const senior = (await call("POST", "/timetable-configs", S, {
    name: "ZZTS Senior", academicYearId: year.id,
  })).json;
  for (const c of [junior, senior]) {
    await call("PUT", `/timetable-configs/${c.id}/structure`, S, {
      startTime: "08:00", periodsPerDay: 6, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
    });
  }
  check(junior.resourceGroupId === senior.resourceGroupId,
    "and they share a §30 resource pool", `pool ${junior.resourceGroupId}`);

  const SUBJECTS = ["ZZTS Chemistry", "ZZTS English", "ZZTS Maths", "ZZTS Music"];
  const subjectId = {};
  for (const name of SUBJECTS) {
    const r = await call("POST", "/subjects", S, { name, code: name.slice(5, 8).toUpperCase() });
    subjectId[name] = r.json.id;
  }

  // Class 1-A in Junior, Class 9-A in Senior. Both classes take all four.
  const mk = async (cls, seq, cfg) => {
    const c = (await call("POST", "/classes", S, { name: cls, sequence: seq })).json;
    // A section is created UNATTACHED and then claimed by a timetable — two
    // calls, which is what the §30 pool check needs in order to exist.
    const made = await call("POST", `/classes/${c.id}/sections`, S, {
      name: "A", academicYearId: year.id,
    });
    const csId = made.json?.classSection?.id ?? made.json?.id;
    const claim = await call("PUT", `/timetable-configs/${cfg.id}/class-sections`, S, {
      classSectionIds: [csId],
    });
    check(made.status < 300 && claim.status < 300,
      `${cls}-A exists and belongs to ${cfg.name}`, `${made.status} · ${claim.status}`);
    for (const name of SUBJECTS) {
      await call("POST", "/class-subjects", S, {
        classId: c.id, subjectId: subjectId[name], academicYearId: year.id, periodsPerWeek: 4,
      });
    }
    return { class: c, sectionId: csId };
  };
  const j = await mk("ZZTS Class 1", 5, junior);
  await mk("ZZTS Class 9", 13, senior);

  // Teachers, so a generation is actually possible. `periodsPerWeek` is
  // required on a mapping — without it the POST 400s and the school looks
  // staffed while being entirely unstaffed.
  for (const name of SUBJECTS) {
    const t = (await call("POST", "/teachers", S, {
      name: `ZZTS ${name.slice(5)} Teacher`, employeeCode: `ZZTS-${name.slice(5, 8).toUpperCase()}`,
      maxPeriodsPerWeek: 40, minPeriodsPerDay: 0,
    })).json;
    const m = await call("POST", "/mappings", S, {
      teacherId: t.id, subjectId: subjectId[name], classSectionId: j.sectionId, periodsPerWeek: 4,
    });
    check(m.status < 300, `${name} is staffed in Junior`, `${m.status}${m.status >= 300 ? ` ${m.text.slice(0, 90)}` : ""}`);
  }

  // ─────────────── 1. NOT STATED MEANS ALL
  console.log("\nA timetable that has stated nothing:");
  const fresh = (await call("GET", `/timetable-configs/${junior.id}/subjects`, S)).json;
  check(fresh?.selected === null,
    "reports `selected: null` — not stated, which is not the same as []",
    JSON.stringify(fresh?.selected));
  check((fresh?.subjects ?? []).length === 4,
    "beside every subject the school has, so the screen cannot disagree about what exists",
    `${(fresh?.subjects ?? []).length} subjects`);
  const before = await columnsOf(S, junior.id);
  check(before.length === 4, "and the Lesson Grid offers all four columns", before.join(", "));

  // ─────────────── 2. NARROWING
  console.log("\nTaking Chemistry and Music out of Junior:");
  const keep = [subjectId["ZZTS English"], subjectId["ZZTS Maths"]];
  const put = await call("PUT", `/timetable-configs/${junior.id}/subjects`, S, { subjectIds: keep });
  check(put.status < 300 && (put.json?.selected ?? []).length === 2,
    "the selection is stored", `${(put.json?.selected ?? []).length} subjects`);

  const after = await columnsOf(S, junior.id);
  check(after.length === 2 && !after.includes("ZZTS Chemistry"),
    "the Lesson Grid drops their columns", after.join(", "));

  const ready = (await call("GET", `/timetable-configs/${junior.id}/readiness`, S)).json;
  const required = ready?.stats?.totalRequiredSlots;
  check(required === 8,
    "and Readiness needs 8 periods, not 16 — the demand is gone, not merely hidden",
    `${required} required`);

  // ─────────────── 3. THE ASSERTION THAT PROVES THE FEATURE
  console.log("\nGenerating Junior:");
  const gen = await call("POST", `/timetable-configs/${junior.id}/generate`, S, {});
  check(gen.status < 300, "generation starts", `${gen.status}`);
  let placed = [];
  for (let i = 0; i < 60; i++) {
    const rows = await prisma.timetableSlot.findMany({
      where: { timetableConfigId: junior.id }, select: { subjectId: true },
    });
    if (rows.length > 0) { placed = rows; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const names = new Set(placed.map((r) => r.subjectId));
  check(placed.length > 0, "and produces a timetable", `${placed.length} lessons`);
  /*
    `placed.length > 0` is IN this assertion, not merely before it.

    Without it the check passes on an empty timetable — which it did the first
    time the worker failed to come back after a restart: "no Chemistry was
    placed" is trivially true when nothing was placed at all, and the run
    reported the feature working while the queue was dead. An assertion that
    cannot fail is worse than no assertion.

    8 = two subjects x four periods. The unfiltered answer is 16.
  */
  check(placed.length === 8
      && !names.has(subjectId["ZZTS Chemistry"]) && !names.has(subjectId["ZZTS Music"]),
    "with NO Chemistry and NO Music in it — the rule reaches the solver, not just the screen",
    `${placed.length} lessons · ${names.size} distinct subjects placed`);

  // ─────────────── 4. DESELECTING DELETES NOTHING
  console.log("\nWhat deselecting did NOT do:");
  const stillThere = await prisma.subject.count({ where: { schoolId } });
  const stillTaught = await prisma.classSubject.count({
    where: { schoolId, subjectId: subjectId["ZZTS Chemistry"] },
  });
  const stillMapped = await prisma.teacherSubjectClassSection.count({
    where: { schoolId, subjectId: subjectId["ZZTS Chemistry"] },
  });
  check(stillThere === 4 && stillTaught > 0 && stillMapped > 0,
    "the subject, its curriculum and its mapping all survive",
    `${stillThere} subjects · ${stillTaught} curriculum · ${stillMapped} mappings`);

  await call("PUT", `/timetable-configs/${junior.id}/subjects`, S, {
    subjectIds: SUBJECTS.map((n) => subjectId[n]),
  });
  const restored = await columnsOf(S, junior.id);
  check(restored.length === 4, "and re-selecting brings it straight back", restored.join(", "));

  // ─────────────── 5. THE SIBLING WING IN THE SAME POOL
  console.log("\nThe other wing, which shares its pool:");
  await call("PUT", `/timetable-configs/${junior.id}/subjects`, S, { subjectIds: keep });
  const seniorCols = await columnsOf(S, senior.id);
  check(seniorCols.length === 4,
    "still teaches all four — a pool-level answer could not have said this",
    seniorCols.join(", "));

  // ─────────────── 6. "ALL OF THEM" IS STORED AS NOTHING
  console.log("\nTicking every subject:");
  await call("PUT", `/timetable-configs/${junior.id}/subjects`, S, {
    subjectIds: SUBJECTS.map((n) => subjectId[n]),
  });
  const rows = await prisma.timetableSubject.count({ where: { timetableConfigId: junior.id } });
  check(rows === 0,
    "stores no rows at all — 'all' and 'not stated' are the same answer, and the absence ages better",
    `${rows} rows`);
  const added = (await call("POST", "/subjects", S, { name: "ZZTS Art", code: "ART" })).json;
  const withNew = await columnsOf(S, junior.id);
  check(withNew.length === 4 && !withNew.includes("ZZTS Art"),
    "a subject added afterwards is not yet in anybody's curriculum, so no column yet",
    withNew.join(", "));
  const back = (await call("GET", `/timetable-configs/${junior.id}/subjects`, S)).json;
  check(back?.selected === null && (back?.subjects ?? []).length === 5,
    "but it IS offered on the screen, because nothing was narrowed",
    `${(back?.subjects ?? []).length} offered`);

  // ─────────────── 7. §17.8
  console.log("\nAnother school:");
  const email2 = `stranger@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email: email2, password: PW, name: "ZZTS Stranger" });
  const acct2 = (await call("POST", "/auth/verify", null, { token: await mailToken(email2, "verify") })).json.accountToken;
  const other = await call("POST", "/schools", acct2, { name: "ZZTS Other" });
  const T = other.json.sessionToken;

  const peek = await call("GET", `/timetable-configs/${junior.id}/subjects`, T);
  check(peek.status === 404, "cannot read our timetable's selection", `${peek.status}`);
  const poke = await call("PUT", `/timetable-configs/${junior.id}/subjects`, T, {
    subjectIds: [subjectId["ZZTS Maths"]],
  });
  check(poke.status === 404, "and cannot write it", `${poke.status}`);

  /*
    The half that a 404 does not cover: OUR config with THEIR subject id. The
    route is ours, the permission is ours, and only the id is foreign — so
    nothing refuses the request. What must not happen is the row being stored,
    because the snapshot would read it back as a subject we teach.
  */
  const theirSubject = (await call("POST", "/subjects", T, { name: "ZZTS Their Subject", code: "TS" })).json;
  await call("PUT", `/timetable-configs/${junior.id}/subjects`, S, {
    subjectIds: [subjectId["ZZTS Maths"], theirSubject.id],
  });
  const stored = await prisma.timetableSubject.findMany({
    where: { timetableConfigId: junior.id }, select: { subjectId: true },
  });
  check(stored.length === 1 && stored[0].subjectId === subjectId["ZZTS Maths"],
    "a foreign subject id is dropped, not stored against our timetable",
    stored.map((r) => r.subjectId).join(", "));

  console.log("\nCleanup:");
  await purge();
  check(true, "test schools removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();

  console.log(failed ? "\nSOME TIMETABLE-SUBJECT CHECKS FAILED" : "\nALL TIMETABLE-SUBJECT CHECKS PASSED");
  process.exit(failed);
}

main().catch((e) => { console.error(e); process.exit(1); });
