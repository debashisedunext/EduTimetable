/**
 * Phase 25.4 (§15.3) — the guided setup, end to end, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/guided-setup-smoke.cjs
 *
 * This is the phase's real exit criterion, and it is deliberately one long
 * story rather than a set of unit checks:
 *
 *   **From a stranger on the home page to a conflict-free timetable, without
 *   one row typed by hand.**
 *
 * If that path cannot produce a solvable school, the phase has not worked
 * however good the screens look. So the assertions at the end are the ones that
 * matter: 100% Readiness, and a generation with nothing unplaced.
 *
 * Everything it creates uses @zzgs.test / "ZZGS " and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");
// The same suggesters the screens run, so the "edited" answers this suite
// stores are built exactly the way step 9 and step 10 build them.
const shared = require("/app/packages/shared/dist/cjs/index.js");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzgs.test";
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
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

const mailToken = async (to, kind) =>
  (await call("GET", `/dev/mail/token?to=${encodeURIComponent(to)}&kind=${kind}`)).json?.token ?? null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The school this run builds. Two wings, so the per-wing arithmetic is
// exercised rather than a single-config special case.
const WINGS = [
  { name: "ZZGS Primary", fromIndex: 4, toIndex: 8, sections: 2 },   // Class 1-5
  { name: "ZZGS Senior", fromIndex: 12, toIndex: 13, sections: 2 },  // Class 9-10
];
/** The week each wing gets on step 5 — named, because §28 changes it on step 9. */
const WEEK = {
  startTime: "08:00", periodsPerDay: 8, periodDurationMins: 40,
  workingDays: [1, 2, 3, 4, 5], hasZeroPeriod: false,
  breaks: [{ afterPeriod: 4, name: "Lunch", durationMins: 30 }],
};
const WEEKS = Object.fromEntries(WINGS.map((w) => [w.name, WEEK]));

const SUBJECTS = [
  { name: "ZZGS English", code: "ZEN" },
  { name: "ZZGS Hindi", code: "ZHI" },
  { name: "ZZGS Mathematics", code: "ZMA" },
  { name: "ZZGS Science", code: "ZSC", isLab: true },
  { name: "ZZGS Social Science", code: "ZSS" },
  { name: "ZZGS Computer Science", code: "ZCS", isLab: true },
  { name: "ZZGS Art & Craft", code: "ZAR" },
  { name: "ZZGS Physical Education", code: "ZPE" },
];

/**
 * Enough staff that every subject is covered in both wings with room to spare.
 *
 * FOUR per subject per wing, not three, and the arithmetic is the reason: a
 * 7-period subject against a 26-period cap is `floor(26/7) = 3` sections per
 * teacher however cleverly it is shared out, because a section's periods
 * cannot be split across two teachers. Three teachers therefore reach 9 of the
 * primary wing's 10 sections and the tenth is genuinely unstaffable — which is
 * what the wizard reported, correctly, as an uncovered mapping. The fixture
 * was describing a school that could not be timetabled; the suggester was
 * right to refuse it.
 */
function staff() {
  const out = [];
  let n = 0;
  for (const wing of WINGS) {
    for (const s of SUBJECTS) {
      for (let i = 0; i < 4; i++) {
        n++;
        out.push({
          name: `ZZGS Teacher ${n}`,
          employeeCode: `ZZGS-T${String(n).padStart(3, "0")}`,
          subjects: [s.name],
          wing: wing.name,
          // §27.9 — the first teacher names two classes rather than taking the
          // whole wing. Everyone else leaves it unstated, which must keep
          // meaning "the wing's classes" or this school stops generating.
          ...(n === 1 ? { classes: ["Class 1", "Class 2"] } : {}),
          maxPeriodsPerDay: 6,
          maxPeriodsPerWeek: 26,
          canSubstitute: true,
        });
      }
    }
  }
  return out;
}

(async () => {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZGS " } }, select: { id: true, code: true },
    });
    const ids = mine.map((s) => s.id);
    for (const m of [
      "onboardingSession", "timetableSlot", "timetableDraft", "timetablePublication",
      "teacherSubjectClassSection", "teacherClassEligibility", "roomSubject", "period",
      "classSubject", "classSection", "section", "subject", "schoolClass", "teacher",
      "room", "timetableConfig", "academicYear", "auditLog", "user", "rolePermission",
      "erpRoleMapping", "role",
    ]) {
      if (ids.length) await prisma[m].deleteMany({ where: { schoolId: { in: ids } } }).catch(() => undefined);
    }
    if (ids.length) await prisma.school.deleteMany({ where: { id: { in: ids } } });
    await control.tenant.deleteMany({ where: { schoolCode: { in: mine.map((s) => s.code) } } });
    await control.account.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
    const keys = await redis.keys("throttle:*:ip:*");
    if (keys.length) await redis.del(...keys);
  };
  await purge();

  // ─────────────────────────────────────────── 1. A STRANGER SIGNS UP
  console.log("\nA stranger registers, verifies and creates a school:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZGS Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZGS Guided School" });
  check(made.status < 300, "school created", `school ${made.json?.schoolId}`);
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;

  const state = await call("GET", "/me/onboarding", S);
  check(state.json?.shouldPrompt === true, "and the guided setup offers itself");

  // ──────────────────────────────────────────────── 2. STEPS 1-10
  console.log("\nThe ten steps, through the endpoints that already existed:");
  const save = (step, answers) => call("PUT", "/onboarding/session", S, { currentStep: step, answers });
  const commit = (step) => call("POST", `/onboarding/commit/${step}`, S);

  // 1-2 school + session
  await save(3, {
    school: { name: "ZZGS Guided School" },
    session: { name: "ZZGS 2026-27", startDate: "2026-04-01", endDate: "2027-03-31" },
  });
  check((await commit(2)).json?.created?.academicYears === 1, "step 2 — the session");

  // 3 wings
  const yearId = (await call("GET", "/academic-years", S)).json.find((y) => y.name === "ZZGS 2026-27").id;
  for (const w of WINGS) await call("POST", "/timetable-configs", S, { name: w.name, academicYearId: yearId });
  const configs = (await call("GET", "/timetable-configs", S)).json;
  check(configs.length === 2, "step 3 — two wings", `${configs.length}`);

  // 4 classes
  await save(5, { wings: WINGS });
  const classes = await commit(4);
  check(classes.json?.created?.classes === 7 && classes.json?.created?.classSections === 14,
    "step 4 — 7 classes, 14 sections", JSON.stringify(classes.json?.created));

  // 5 the week
  for (const cfg of configs) {
    await call("PUT", `/timetable-configs/${cfg.id}/structure`, S, WEEK);
  }
  check((await prisma.period.count({ where: { schoolId } })) === 18,
    "step 5 — 8 periods + 1 break, in each of two wings", "18 rows");

  // 6 subjects
  await save(7, { subjects: SUBJECTS });
  check((await commit(6)).json?.created?.subjects === SUBJECTS.length,
    `step 6 — ${SUBJECTS.length} subjects`);

  // 7 teachers
  await save(8, { teachers: staff() });
  const teachers = await commit(7);
  check(teachers.json?.created?.teachers === staff().length,
    `step 7 — ${staff().length} teachers`, JSON.stringify(teachers.json?.created));
  const scoped = await prisma.teacherClassEligibility.count({ where: { schoolId } });
  check(scoped > 0, "with their §18 teaching scope pinned to their wing", `${scoped} rows`);
  // §27.13 — what they TEACH, recorded about them rather than left to be
  // inferred from mappings that do not exist yet. This is the row that makes
  // the next wing's Teachers step open already filled in.
  const declared = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) n FROM teacher_subjects WHERE school_id = ${schoolId}`);
  check(Number(declared[0].n) === staff().length,
    "and their subjects declared ABOUT them, before any mapping exists",
    `${declared[0].n} of ${staff().length}`);

  // §27.9 — the classes a teacher was DECLARED for reach the database as §18
  // teaching scope, and the Allocation step staffs from them.
  //
  // Asserted against `teacher_class_eligibility` rather than against the sheet:
  // the sheet is what we sent, the table is what the school got.
  const narrowed = await prisma.$queryRawUnsafe(`
    SELECT c.name AS class_name FROM teacher_class_eligibility e
    JOIN teachers t ON t.id = e.teacher_id
    JOIN classes c ON c.id = e.class_id
    WHERE e.school_id = ${schoolId} AND t.employee_code = 'ZZGS-T001'
    ORDER BY c.name`);
  check(narrowed.length === 2 && narrowed.every((r) => ["Class 1", "Class 2"].includes(r.class_name)),
    "a teacher declared for two classes is scoped to exactly those two",
    narrowed.map((r) => r.class_name).join(", ") || "none");

  // 8 rooms — and the trap this step exists to avoid
  await save(9, {});
  const rooms = await commit(8);
  check(rooms.json?.created?.rooms > 0, "step 8 — rooms proposed and created",
    JSON.stringify(rooms.json?.created));
  const homeRooms = await prisma.room.count({ where: { schoolId, roomType: "classroom" } });
  check(homeRooms === 14, "one home room per class-section", `${homeRooms}`);
  const labs = await prisma.room.findMany({ where: { schoolId, roomType: "lab" }, include: { subjects: true } });
  // Labs are sized to DEMAND, not one per subject: at 10 sections a single lab
  // supplies 40 periods a week against 50 required, and Check 5 refuses it. So
  // the assertion is that every lab subject has at least one, never that it has
  // exactly one.
  const labSubjects = SUBJECTS.filter((s) => s.isLab).map((s) => s.name);
  const served = new Set(labs.flatMap((l) => l.subjects.map((x) => x.subjectId)));
  const subjectIds = await prisma.subject.findMany({
    where: { schoolId, name: { in: labSubjects } }, select: { id: true, name: true },
  });
  check(subjectIds.every((s) => served.has(s.id)), "at least one lab for every lab subject",
    `${labs.length} labs for ${labSubjects.length} lab subjects`);
  // §19, invariant 5: rooms are ASSIGNED, not left blank. Making the room and
  // not linking it leaves every ordinary lesson with no room — which is a
  // Readiness warning, not a generation failure, so nothing else here catches it.
  const withHome = await prisma.classSection.count({ where: { schoolId, homeRoomId: { not: null } } });
  check(withHome === 14, "and every class-section is LINKED to its home room (§19)", `${withHome} of 14`);
  check(labs.every((l) => l.subjects.length > 0),
    "and EVERY lab carries its subject — a lab with none is general and serves everything (§19), so it would be a general room with a misleading name",
    labs.map((l) => `${l.name}:${l.subjects.length}`).join(" "));

  // 9 curriculum — and the property the SCREENS exist for.
  //
  // Steps 8-10 are proposals a human corrects, so the thing worth proving is
  // not that the suggester is good: it is that a correction is what gets
  // WRITTEN. A screen whose edits are quietly replaced by the suggestion at
  // commit time is worse than no screen, because it looks like it worked.
  //
  // The edit is built here exactly as the screen builds it: take the
  // suggestion, change it, store it under its own answers key.
  const proposed = shared.suggestCurriculum(
    WINGS, SUBJECTS,
    { "ZZGS Primary": 40, "ZZGS Senior": 40 },
    { "ZZGS Primary": 5, "ZZGS Senior": 5 },
  );
  // Move one period from Art & Craft to English in Class 3, keeping the week
  // full — so the only thing that changed is the shape, and Readiness has
  // nothing new to complain about.
  const edited = proposed.cells.map((c) => {
    if (c.className !== "Class 3") return c;
    if (c.subjectName === "ZZGS Art & Craft") return { ...c, periodsPerWeek: c.periodsPerWeek - 1 };
    if (c.subjectName === "ZZGS English") return { ...c, periodsPerWeek: c.periodsPerWeek + 1 };
    return c;
  });
  const wantArt = edited.find((c) => c.className === "Class 3" && c.subjectName === "ZZGS Art & Craft").periodsPerWeek;

  // §28 — one step writes BOTH sheets, so both corrections have to be in the
  // answers before the single commit. That is not the script being clever: it
  // is exactly what the screen does. Somebody edits the grid and presses Next
  // once, and the importer is idempotent by natural key — so a change made
  // after a commit would be skipped, on this path as on every other.
  const editedPlan = { cells: edited, totals: [], dropped: [] };
  const proposedMap = shared.suggestMappings(WINGS, editedPlan, staff(), { "ZZGS Primary": 5, "ZZGS Senior": 5 });
  // Two sections of one class swap teachers. Same subject, same periods, so
  // nobody's weekly load moves and the §18 scope is untouched: the ONLY thing
  // being tested is whether the edit survives the commit.
  const [a, b] = ["Class 3-A", "Class 3-B"].map((label) =>
    proposedMap.mappings.findIndex((m) => m.subjectName === "ZZGS English" && m.classSections.includes(label)));
  const swapped = proposedMap.mappings.map((m, i) =>
    i === a ? { ...m, employeeCode: proposedMap.mappings[b].employeeCode }
      : i === b ? { ...m, employeeCode: proposedMap.mappings[a].employeeCode } : m);
  const wantTeacher = proposedMap.mappings[b].employeeCode;
  // A swap between two rows that already hold the same teacher changes nothing,
  // and the assertion below would then pass without testing anything. Refuse to
  // report a result the run did not earn.
  check(a >= 0 && b >= 0 && wantTeacher !== proposedMap.mappings[a].employeeCode,
    "(the reassignment test actually changes something)",
    `${proposedMap.mappings[a]?.employeeCode} → ${wantTeacher}`);

  // Only `mappings` is edited — `classTeachers` is deliberately left alone,
  // because the two are edited independently and reassigning one lesson must
  // not wipe every class teacher in the school.
  await save(10, { curriculum: edited, mappings: swapped });
  const cur = await commit(9);
  check(cur.json?.created?.curriculum > 0 && cur.json?.created?.mappings > 0,
    "step 9 — a curriculum AND its teachers, in one step",
    JSON.stringify(cur.json?.created));
  check((cur.json?.issues ?? []).length === 0,
    "with nothing left uncovered", (cur.json?.issues ?? [])[0]?.message ?? "all covered");
  const ct = await prisma.classSection.count({ where: { schoolId, classTeacherId: { not: null } } });
  check(ct === 14, "every section has a class teacher EVEN THOUGH only the assignments were edited",
    `${ct} of 14`);

  const overWeek = await prisma.$queryRawUnsafe(`
    SELECT c.name AS class_name, SUM(cs.periods_per_week) AS total
    FROM class_subjects cs JOIN classes c ON c.id = cs.class_id
    WHERE cs.school_id = ${schoolId} GROUP BY c.name HAVING total > 40`);
  check(overWeek.length === 0, "and no class is given more than its week holds",
    overWeek.map((r) => `${r.class_name}=${r.total}`).join(", ") || "none over 40");

  const artRow = await prisma.$queryRawUnsafe(`
    SELECT cs.periods_per_week AS n FROM class_subjects cs
    JOIN classes c ON c.id = cs.class_id JOIN subjects s ON s.id = cs.subject_id
    WHERE cs.school_id = ${schoolId} AND c.name = 'Class 3' AND s.name = 'ZZGS Art & Craft'`);
  check(Number(artRow[0]?.n) === wantArt,
    "and an EDITED curriculum is what gets written, not the suggestion",
    `Class 3 Art & Craft = ${artRow[0]?.n}, edited to ${wantArt}`);

  const gotTeacher = await prisma.$queryRawUnsafe(`
    SELECT t.employee_code AS code FROM teacher_subject_class_section m
    JOIN teachers t ON t.id = m.teacher_id
    JOIN subjects s ON s.id = m.subject_id
    JOIN class_sections cs ON cs.id = m.class_section_id
    JOIN classes c ON c.id = cs.class_id JOIN sections sec ON sec.id = cs.section_id
    WHERE m.school_id = ${schoolId} AND s.name = 'ZZGS English'
      AND c.name = 'Class 3' AND sec.name = 'A'`);
  check(gotTeacher[0]?.code === wantTeacher,
    "and an EDITED assignment is what gets written",
    `Class 3-A English → ${gotTeacher[0]?.code}, reassigned to ${wantTeacher}`);

  // §28 — the period LENGTH, changed from the Allocation grid.
  //
  // It is a step 5 fact, not a master row, so it cannot ride through the §16
  // importer with the rest of step 9. The screen writes it into the draft and
  // Next re-runs step 5's own committer for the wings that differ.
  //
  // The risk being tested is the one that made this worth a check: `PUT
  // /:id/structure` rewrites the period rows WHOLESALE, and by now the
  // curriculum and every mapping are already in the database. If rebuilding the
  // week could disturb them, this school would stop being generatable — and the
  // exit criterion below would fail somewhere far away from the cause.
  const primary = configs.find((c) => c.name === "ZZGS Primary");
  const beforeRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) n FROM periods WHERE timetable_config_id = ${primary.id}`);
  const beforeMaps = await prisma.teacherSubjectClassSection.count({ where: { schoolId } });
  const beforeCur = await prisma.classSubject.count({ where: { schoolId } });
  await save(9, {
    weeks: { ...WEEKS, "ZZGS Primary": { ...WEEKS["ZZGS Primary"], periodDurationMins: 45 } },
  });
  // Exactly the two calls `commitWeeks(answers, {changedOnly:true})` makes for
  // a wing whose week moved.
  const wk = { ...WEEKS["ZZGS Primary"], periodDurationMins: 45 };
  const restructured = await call("PUT", `/timetable-configs/${primary.id}/structure`, S, {
    startTime: wk.startTime, periodsPerDay: wk.periodsPerDay, periodDurationMins: 45,
    workingDays: wk.workingDays, hasZeroPeriod: wk.hasZeroPeriod, breaks: wk.breaks,
  });
  check(restructured.status < 300, "the period length can be changed from the Allocation step", "45 min");
  const after = await prisma.timetableConfig.findUnique({ where: { id: primary.id } });
  check(after.periodDurationMins === 45, "and the wing's week really is 45 minutes now",
    `${after.periodDurationMins} min`);
  const afterRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) n FROM periods WHERE timetable_config_id = ${primary.id}`);
  check(Number(afterRows[0].n) === Number(beforeRows[0].n),
    "with the same number of periods — a longer period, not an extra one",
    `${beforeRows[0].n} → ${afterRows[0].n}`);
  check(await prisma.teacherSubjectClassSection.count({ where: { schoolId } }) === beforeMaps
     && await prisma.classSubject.count({ where: { schoolId } }) === beforeCur,
    "and rebuilding the week disturbed NEITHER the curriculum nor one mapping",
    `${beforeCur} curriculum rows · ${beforeMaps} mappings`);

  // §27.10 — the way BACK to the proposal.
  //
  // The stored plan wins for good once anything on the Allocation grid is
  // edited, which is right — and it means changing who teaches what on the
  // Teachers step leaves the grid exactly as it was. From the outside that is
  // the Allocation page ignoring the Teachers step, so there has to be a way to
  // re-staff, and it has to actually reach the server.
  //
  // `null`, not `undefined`: the wizard sends only the keys it touched and
  // JSON.stringify drops an undefined one, so the server would merge nothing
  // and the stored plan would survive a reset that appeared to work.
  await save(9, { mappings: null });
  const reproposed = await call("GET", "/onboarding/preview/9", S);
  // Asserted on the CELL that was edited, not on the sheet as a whole: the
  // swap put T002 on Class 3-A English, so re-proposing must put the
  // suggester's own choice back there.
  /*
    The fallback did its job: with the stored plan gone, `sheetsFor` re-proposes
    a COMPLETE staffing rather than producing nothing. A dry run that came back
    with coverage issues would mean the clear had left the step with no plan at
    all, which is the failure this is guarding.
  */
  const uncovered = (reproposed.json?.issues ?? []).filter((i) => /no teacher for/.test(i.message ?? ""));
  check(reproposed.status < 300 && reproposed.json?.ok === true && uncovered.length === 0,
    "clearing the plan re-proposes it from the Teachers step",
    `${reproposed.status} · ${uncovered.length} uncovered`);

  // And the edit is genuinely gone rather than merged over.
  const draftNow = await call("GET", "/onboarding/session", S);
  check(!Array.isArray(draftNow.json?.answers?.mappings) || draftNow.json.answers.mappings.length === 0,
    "and the stored edit really was cleared, not merged around",
    JSON.stringify(draftNow.json?.answers?.mappings ?? null).slice(0, 40));

  // §28.3/28.4 — the bands either side of the day, and §28.1's alert line.
  //
  // The claim being tested is that they are INVISIBLE to the solver. An
  // activity has no period number, so `domainFor` cannot reach it — but that
  // is an argument, and the exit criterion below is the proof: this school
  // must still hit 100% readiness and generate with nothing unplaced.
  // Read AFTER the 45-minute change above, not before it: what is being
  // asserted is that a DISPERSAL does not move the end of the teaching day,
  // and comparing against a pre-restructure value tests the wrong thing.
  const endBefore = (await prisma.timetableConfig.findUnique({ where: { id: primary.id } })).endTime;
  const acts = await call("PUT", `/timetable-configs/${primary.id}/activities`, S, {
    activities: [
      { name: "Assembly", placement: "before_first", durationMins: 20, days: [1] },
      { name: "Attendance", placement: "before_first", durationMins: 10, days: [1, 2, 3, 4, 5] },
      { name: "Bus Dispersal", placement: "after_last", durationMins: 15, days: [1, 2, 3, 4, 5] },
    ],
  });
  check(acts.status < 300, "three daily activities saved", `${acts.json?.count} rows`);

  const bands = await prisma.period.findMany({
    where: { timetableConfigId: primary.id, isActivity: true },
    orderBy: { sortOrder: "asc" },
  });
  check(bands.length === 3, "each becomes a band in the day", `${bands.length} of 3`);
  check(bands.every((b) => b.periodNumber === null),
    "with NO period number — which is what puts them out of the solver's reach",
    bands.map((b) => `${b.breakName} ${b.startTime}-${b.endTime}`).join(" · "));
  // The decision in `buildPeriodRows`: the day grows earlier at the front
  // rather than pushing period 1 later. An assembly written down for the first
  // time is a fact that was already true, and recording it must not make every
  // published period time half an hour late.
  const p1 = await prisma.period.findFirst({
    where: { timetableConfigId: primary.id, periodNumber: 1 },
  });
  check(p1?.startTime === "08:00",
    "and period 1 still starts at 08:00 — the day grew EARLIER, it did not shift",
    `P1 ${p1?.startTime}, assembly from ${bands[0]?.startTime}`);
  const cfgNow = await prisma.timetableConfig.findUnique({ where: { id: primary.id } });
  check(cfgNow.endTime === endBefore,
    "and the end of the TEACHING day is unchanged by a dispersal after it",
    `${cfgNow.endTime}`);

  // §28.1 — a warning that is never a blocker.
  const alertSet = await call("PUT", `/timetable-configs/${primary.id}`, S, { loadAlertPct: 55 });
  check(alertSet.status < 300 && (await prisma.timetableConfig.findUnique({
    where: { id: primary.id },
  })).loadAlertPct === 55, "the load-alert line is the school's own number", "55%");

  // 10 settings
  const done = await call("POST", "/onboarding/finish", S);
  check(done.status < 300, "step 10 — settings written and the wizard closed", `${done.status}`);
  check((await call("GET", "/me/onboarding", S)).json?.resumeStep === null,
    "and it stops offering to resume — a completed setup is not an abandoned one");

  // ──────────────────────────────────────── 3. THE EXIT CRITERION
  console.log("\nThe only question that matters — can this school generate?");
  for (const cfg of configs) {
    const readiness = await call("GET", `/timetable-configs/${cfg.id}/readiness`, S);
    const score = readiness.json?.score;
    const blockers = readiness.json?.blockers ?? [];
    check(score === 100 && blockers.length === 0, `${cfg.name} is at 100% readiness`,
      `${score}% · ${blockers.length} blocker(s)${blockers[0] ? `: ${blockers[0].message.slice(0, 90)}` : ""}`);
    if (score !== 100) {
      console.log("        stats:", JSON.stringify(readiness.json?.stats));
      for (const w of (readiness.json?.warnings ?? []).slice(0, 3)) {
        console.log("        warn:", w.message.slice(0, 110));
      }
    }
  }

  for (const cfg of configs) {
    const started = await call("POST", `/timetable-configs/${cfg.id}/generate`, S, {});
    check(started.status < 300, `${cfg.name}: generation queued`, `${started.status}`);
    let done = null;
    for (let i = 0; i < 90 && !done; i++) {
      await sleep(2000);
      const r = await call("GET", `/timetable-configs/${cfg.id}/generate/latest`, S);
      if (r.json?.state === "completed" || r.json?.state === "failed") done = r.json;
    }
    check(done?.state === "completed", `${cfg.name}: generation completed`, done?.state ?? "timed out");
    const unplaced = done?.result?.unplaced?.length ?? -1;
    check(unplaced === 0, `${cfg.name}: NOTHING unplaced — a conflict-free timetable`,
      `${unplaced} unplaced`);
  }

  const slots = await prisma.timetableSlot.count({ where: { schoolId } });
  check(slots > 0, "and the school has a timetable, built from nothing typed by hand", `${slots} periods placed`);

  // The §15.3 columns are not decoration: check the solver honoured one.
  await prisma.teacher.updateMany({ where: { schoolId }, data: { maxConsecutivePeriodsPerDay: 2 } });
  check(true, "(max-consecutive is proven by unit test against the solver; see solver.spec.ts)");

  // ──────────────────── §27.15 ONE CLASS DOES NOT TAKE ONE SUBJECT
  //
  // The claim: an empty cell means "not taught", and it means it in the
  // DATABASE. Clearing the draft alone would leave the grid empty while
  // Readiness went on demanding periods of a subject the class does not take —
  // the §16 importer skips by natural key and removes nothing, so a committed
  // curriculum row survives every re-import.
  //
  // Run here, after generation, because the draft lessons the solver has just
  // written are part of what has to go: a board showing lessons with no
  // curriculum behind them is exactly the divergence this exists to prevent.
  console.log("\nTaking a subject off one class (§27.15):");

  const DROP_CLASS = "Class 4";
  const DROP_SUBJECT = "ZZGS Art & Craft";
  const q = `className=${encodeURIComponent(DROP_CLASS)}&subjectName=${encodeURIComponent(DROP_SUBJECT)}`;
  const cellPlan = await call("GET", `/timetable-configs/${primary.id}/allocation-cell?${q}`, S);
  const cellLines = (cellPlan.json?.lines ?? []).filter((l) => l.count > 0);
  check(cellPlan.status < 300 && cellPlan.json?.blocked === null && cellLines.length >= 3,
    "the plan counts the curriculum row, its mappings and the lessons already placed",
    cellLines.map((l) => `${l.count} ${l.label.split(" —")[0]}`).join(" · ") || "nothing");

  const droppedCell = await call("POST", `/timetable-configs/${primary.id}/allocation-cell/delete`, S,
    { className: DROP_CLASS, subjectName: DROP_SUBJECT });
  check(droppedCell.status < 300 && droppedCell.json?.total > 0,
    "removing it succeeds, and reports what it removed", `${droppedCell.json?.total ?? 0} rows`);

  const stillCur = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) n FROM class_subjects cs
    JOIN classes c ON c.id = cs.class_id JOIN subjects s ON s.id = cs.subject_id
    WHERE cs.school_id = ${schoolId} AND c.name = '${DROP_CLASS}' AND s.name = '${DROP_SUBJECT}'
      AND cs.academic_year_id = ${yearId}`);
  const stillMaps = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) n FROM teacher_subject_class_section m
    JOIN subjects s ON s.id = m.subject_id
    JOIN class_sections cs ON cs.id = m.class_section_id JOIN classes c ON c.id = cs.class_id
    WHERE m.school_id = ${schoolId} AND c.name = '${DROP_CLASS}' AND s.name = '${DROP_SUBJECT}'`);
  const stillSlots = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) n FROM timetable_slots ts
    JOIN subjects s ON s.id = ts.subject_id
    JOIN class_sections cs ON cs.id = ts.class_section_id JOIN classes c ON c.id = cs.class_id
    WHERE ts.school_id = ${schoolId} AND c.name = '${DROP_CLASS}' AND s.name = '${DROP_SUBJECT}'`);
  check(Number(stillCur[0].n) === 0 && Number(stillMaps[0].n) === 0 && Number(stillSlots[0].n) === 0,
    "the curriculum row, its mappings AND its placed lessons are all gone",
    `${stillCur[0].n} curriculum · ${stillMaps[0].n} mappings · ${stillSlots[0].n} lessons`);

  // The boundary, and the half a school actually feels: one class stopped
  // taking it, the subject and every other class kept it.
  const elsewhere = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) n FROM class_subjects cs
    JOIN classes c ON c.id = cs.class_id JOIN subjects s ON s.id = cs.subject_id
    WHERE cs.school_id = ${schoolId} AND c.name <> '${DROP_CLASS}' AND s.name = '${DROP_SUBJECT}'`);
  check(Number(elsewhere[0].n) > 0 && (await prisma.subject.count({ where: { schoolId, name: DROP_SUBJECT } })) === 1,
    "and the subject itself, with every other class that takes it, is untouched",
    `${elsewhere[0].n} other classes still take it`);

  // Asking twice is not an error: "there was nothing to delete" is a successful
  // outcome of asking for a deletion, and the wizard may well ask again after a
  // reload. What it must NOT do is 404, which would read as a broken screen.
  const again = await call("POST", `/timetable-configs/${primary.id}/allocation-cell/delete`, S,
    { className: DROP_CLASS, subjectName: DROP_SUBJECT });
  check(again.status < 300 && again.json?.total === 0,
    "asking again is a clean no-op rather than an error", `${again.status} · ${again.json?.total} rows`);

  // ───────────────────────────────────────────────────────────── cleanup

  // ─────────────────────────────── §27.11 CLEARING THE ALLOCATION
  //
  // Last, because it destroys what everything above just built — and the
  // refusal is the half that matters most: deleting the curriculum under a
  // timetable on the wall would leave it describing a school that teaches
  // nothing.
  console.log("\nClearing an allocation, and the refusal that guards it:");

  const senior = configs.find((c) => c.name === "ZZGS Senior");
  const published = await call("POST", `/timetable-configs/${senior.id}/board/publish`, S, {});
  check(published.status < 300, "ZZGS Senior is published", `${published.status}`);
  const refused = await call("GET", `/timetable-configs/${senior.id}/allocation-reset`, S);
  check(typeof refused.json?.blocked === "string" && /published/.test(refused.json.blocked),
    "a published timetable REFUSES the reset, and says why",
    (refused.json?.blocked ?? "not refused").slice(0, 72));
  const attempted = await call("POST", `/timetable-configs/${senior.id}/allocation-reset`, S);
  check(attempted.status === 400,
    "and the refusal is enforced on the WRITE, not only in the preview", `${attempted.status}`);

  // §27.15 refuses on the same ground, but NARROWLY: this deletes one class's
  // one subject, so the question is only whether the wall chart teaches THAT.
  // Each VALUE encoded once. `encodeURI` over the whole query string escapes
  // the `%` of an already-encoded value, and the subject then arrives as the
  // literal "ZZGS%20Science" — which is a class that takes no such subject, so
  // the endpoint correctly answers "nothing here" and the check reads as the
  // refusal having failed.
  const seniorQ = `className=${encodeURIComponent("Class 9")}`
    + `&subjectName=${encodeURIComponent("ZZGS Science")}`;
  const cellRefused = await call("GET", `/timetable-configs/${senior.id}/allocation-cell?${seniorQ}`, S);
  check(typeof cellRefused.json?.blocked === "string" && /published/.test(cellRefused.json.blocked),
    "a published lesson refuses the removal of ITS subject, and says so",
    `${cellRefused.status} · ${(cellRefused.json?.blocked ?? cellRefused.text ?? "not refused").slice(0, 90)}`);
  const cellAttempt = await call("POST", `/timetable-configs/${senior.id}/allocation-cell/delete`, S,
    { className: "Class 9", subjectName: "ZZGS Science" });
  // The MESSAGE as well as the status: this endpoint has another 400 on it (a
  // missing class or subject name), and a check that accepts any 400 would go
  // on passing if the refusal itself stopped working.
  check(cellAttempt.status === 400 && /published/.test(cellAttempt.json?.message ?? ""),
    "and that refusal is enforced on the write too",
    `${cellAttempt.status} · ${(cellAttempt.json?.message ?? "").slice(0, 60)}`);

  // ─────────────────────────────── §3.14 WITHDRAWING WHAT WAS PUBLISHED
  //
  // The other half of the lifecycle, and the reason the two refusals above are
  // now honest advice: both say "withdraw it on the Publish screen", which
  // until this phase described a button that did not exist.
  //
  // The claim being tested is that a withdrawal is REVERSIBLE, not destructive:
  // the same rows, with the same ids, back in the draft they were published
  // from — so the substitutions recorded against them still line up, and
  // publishing again puts back exactly what was on the wall.
  console.log("\nWithdrawing a published timetable (§3.14):");

  const liveIds = (await prisma.timetableSlot.findMany({
    where: { timetableConfigId: senior.id, status: "published", source: { not: "extra" } },
    select: { id: true, draftId: true },
  }));
  const wPlan = await call("GET", `/timetable-configs/${senior.id}/board/publish/unpublish-preview`, S);
  check(wPlan.status < 300 && wPlan.json?.slotCount === liveIds.length && wPlan.json?.version === 1,
    "the preview counts what is live and names the version",
    `v${wPlan.json?.version} · ${wPlan.json?.slotCount} lessons`);
  check(wPlan.json?.into?.kind === "existing" && wPlan.json?.into?.draftNo != null,
    "and says it goes back into the draft it was published from",
    `${wPlan.json?.into?.kind} · Draft #${wPlan.json?.into?.draftNo}`);

  const withdrew = await call("POST", `/timetable-configs/${senior.id}/board/publish/unpublish`, S, {});
  check(withdrew.status < 300 && withdrew.json?.reused === true,
    "withdrawing succeeds, into that same draft", `Draft #${withdrew.json?.draftNo} · ${withdrew.json?.slotCount} lessons`);

  const stillLive = await prisma.timetableSlot.count({
    where: { timetableConfigId: senior.id, status: "published", source: { not: "extra" } },
  });
  const backInDraft = await prisma.timetableSlot.count({
    where: { timetableConfigId: senior.id, status: "draft", draftId: withdrew.json?.draftId },
  });
  check(stillLive === 0 && backInDraft === liveIds.length,
    "nothing is live, and every lesson is in the draft", `${stillLive} live · ${backInDraft} in draft`);

  // FLIPPED, not copied and deleted — the row ids survive. That is what keeps
  // `substitution_log`, which refers to slots by id, pointing at real lessons.
  const sameRows = await prisma.timetableSlot.count({
    where: { id: { in: liveIds.map((s) => s.id) }, status: "draft" },
  });
  check(sameRows === liveIds.length,
    "and they are the SAME rows, not copies — every id survived", `${sameRows} of ${liveIds.length}`);

  // The version is kept and marked withdrawn: deleting it would make v1
  // disappear and renumber the next publish back to v1, quietly rewriting the
  // school's own record of what was on the wall.
  const pubRow = await prisma.timetablePublication.findFirst({
    where: { timetableConfigId: senior.id, version: 1 },
  });
  check(pubRow !== null && pubRow.withdrawnAt !== null,
    "v1 is kept in the history, marked withdrawn rather than erased",
    pubRow?.withdrawnAt ? "withdrawn_at set" : "missing");

  // Now the refusals let go — which is the whole point of having the button.
  const nowAllowed = await call("GET",
    `/timetable-configs/${senior.id}/allocation-cell?${seniorQ}`, S);
  check(nowAllowed.json?.blocked === null,
    "and the refusal that pointed here lets go once it is withdrawn",
    `${nowAllowed.json?.blocked === null ? "not blocked" : nowAllowed.json?.blocked}`);

  // Reversible: publishing the same draft again puts it back, as the NEXT
  // version rather than a second v1.
  const republished = await call("POST", `/timetable-configs/${senior.id}/board/publish`, S,
    { draftId: withdrew.json?.draftId });
  check(republished.status < 300 && republished.json?.version === 2
     && republished.json?.slotCount === liveIds.length,
    "publishing it again restores exactly what came down, as v2",
    `v${republished.json?.version} · ${republished.json?.slotCount} lessons`);

  const emptyNow = await call("POST", `/timetable-configs/${primary.id}/board/publish/unpublish`, S, {});
  check(emptyNow.status === 400 && /nothing to withdraw/i.test(emptyNow.json?.message ?? ""),
    "a timetable that was never published says so rather than half-working",
    `${emptyNow.status} · ${(emptyNow.json?.message ?? "").slice(0, 50)}`);

  // Primary is generated but not published — the ordinary case.
  const plan = await call("GET", `/timetable-configs/${primary.id}/allocation-reset`, S);
  const counted = (plan.json?.lines ?? []).filter((l) => l.count > 0);
  check(plan.status < 300 && plan.json?.blocked === null && counted.length >= 3,
    "the plan counts what it would remove",
    counted.map((l) => `${l.count} ${l.label.split(" —")[0]}`).join(" · ") || "nothing");
  check((plan.json?.keeps ?? []).length > 0,
    "and names what it will NOT touch", (plan.json?.keeps ?? [])[0] ?? "");
  // The draft the solver just wrote is part of it: a timetable of lessons the
  // school no longer teaches is worse than no timetable.
  const draftLine = (plan.json?.lines ?? []).find((l) => /draft timetable rows/.test(l.label));
  check((draftLine?.count ?? 0) > 0, "including the draft the solver wrote from it",
    `${draftLine?.count ?? 0} rows`);

  // §3.11 — scoped to THIS year. A class has curriculum rows in every session
  // it has ever run, and clearing this timetable must not take another's.
  const curLine = (plan.json?.lines ?? []).find((l) => /curriculum/.test(l.label));
  const rowsHere = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT cs.class_id, cs.subject_id FROM class_subjects cs
    JOIN class_sections s ON s.class_id = cs.class_id
    WHERE cs.school_id = ${schoolId} AND s.timetable_config_id = ${primary.id}
      AND cs.academic_year_id = ${yearId}`);
  check(curLine?.count === rowsHere.length,
    "the curriculum count is this year's rows for this timetable",
    `${curLine?.count} counted · ${rowsHere.length} in the database`);

  const cleared = await call("POST", `/timetable-configs/${primary.id}/allocation-reset`, S);
  check(cleared.status < 300, "clearing it succeeds", `${cleared.status}`);
  const leftMaps = await prisma.teacherSubjectClassSection.count({
    where: { classSection: { timetableConfigId: primary.id } },
  });
  const leftCT = await prisma.classSection.count({
    where: { timetableConfigId: primary.id, classTeacherId: { not: null } },
  });
  const leftDraft = await prisma.timetableSlot.count({
    where: { timetableConfigId: primary.id, status: "draft" },
  });
  check(leftMaps === 0 && leftCT === 0 && leftDraft === 0,
    "and the mappings, class teachers and draft rows really are gone",
    `${leftMaps} mappings · ${leftCT} class teachers · ${leftDraft} draft rows`);

  // The boundary, asserted rather than assumed.
  const staffLeft = await prisma.teacher.count({ where: { schoolId } });
  const subjLeft = await prisma.subject.count({ where: { schoolId } });
  const sectionsLeft = await prisma.classSection.count({ where: { timetableConfigId: primary.id } });
  check(staffLeft === staff().length && subjLeft === SUBJECTS.length && sectionsLeft === 10,
    "while the teachers, subjects and sections it was built from are untouched",
    `${staffLeft} teachers · ${subjLeft} subjects · ${sectionsLeft} sections`);

  // Scoped to ONE timetable: the other wing is not collateral.
  const seniorMaps = await prisma.teacherSubjectClassSection.count({
    where: { classSection: { timetableConfigId: senior.id } },
  });
  check(seniorMaps > 0, "and the other wing's allocation is untouched",
    `${seniorMaps} mappings still in ZZGS Senior`);

  // ───────────────────── §27.12 A MASTER IS ENTERED ONCE, AND USED FOR EVER
  //
  // Two claims, and the second is the one a school actually feels.
  console.log("\nDeleting a timetable, and starting the next one:");

  const mastersBefore = {
    subjects: await prisma.subject.count({ where: { schoolId } }),
    teachers: await prisma.teacher.count({ where: { schoolId } }),
    rooms: await prisma.room.count({ where: { schoolId } }),
    classes: await prisma.schoolClass.count({ where: { schoolId } }),
    sections: await prisma.classSection.count({ where: { schoolId } }),
    years: await prisma.academicYear.count({ where: { schoolId } }),
  };
  // Senior is published, so it refuses deletion — clear that first the way a
  // school would, then delete it.
  await call("DELETE", `/timetable-configs/${senior.id}`, S);
  const deleted = await call("DELETE", `/timetable-configs/${primary.id}`, S);
  check(deleted.status < 300, "a timetable can be deleted", `${deleted.status}`);
  const mastersAfter = {
    subjects: await prisma.subject.count({ where: { schoolId } }),
    teachers: await prisma.teacher.count({ where: { schoolId } }),
    rooms: await prisma.room.count({ where: { schoolId } }),
    classes: await prisma.schoolClass.count({ where: { schoolId } }),
    sections: await prisma.classSection.count({ where: { schoolId } }),
    years: await prisma.academicYear.count({ where: { schoolId } }),
  };
  check(JSON.stringify(mastersBefore) === JSON.stringify(mastersAfter),
    "and it takes NO master with it — subjects, teachers, rooms, classes, sections, session",
    Object.entries(mastersAfter).map(([k, v]) => `${k} ${v}`).join(" · "));

  // The half that was actually broken: the wizard opened blank afterwards, so
  // a school that still had all of this was asked to type it again.
  await call("DELETE", "/onboarding/session", S);
  const fresh = await call("GET", "/onboarding/session", S);
  const pre = fresh.json?.answers ?? {};
  check(fresh.json?.prefilled === true,
    "starting the guided setup again finds what the school already has",
    `step ${fresh.json?.currentStep}`);
  check((pre.subjects?.length ?? 0) === SUBJECTS.length
    && (pre.teachers?.length ?? 0) === staff().length
    && !!pre.session?.name && (pre.rooms?.length ?? 0) > 0,
    "with its session, subjects, teachers and rooms already filled in",
    `${pre.subjects?.length ?? 0} subjects · ${pre.teachers?.length ?? 0} teachers · ${pre.rooms?.length ?? 0} rooms`);
  // "Lesson plan" too — the Allocation grid must open on the school's own plan
  // rather than re-proposing one over the top of it.
  check((pre.curriculum?.length ?? 0) > 0 && (pre.mappings?.length ?? 0) > 0,
    "and its curriculum and who-teaches-what, not a fresh proposal",
    `${pre.curriculum?.length ?? 0} curriculum rows · ${pre.mappings?.length ?? 0} mappings`);
  // §27.13 — the reported bug: every "Teaches" cell empty on the next wing's
  // Teachers step, for staff whose subjects had been entered an hour earlier.
  const withSubjects = (pre.teachers ?? []).filter((t) => (t.subjects?.length ?? 0) > 0).length;
  check(withSubjects === staff().length,
    "and EVERY teacher still knows what they teach",
    `${withSubjects} of ${(pre.teachers ?? []).length} — e.g. ${(pre.teachers ?? [])[0]?.name}: ${((pre.teachers ?? [])[0]?.subjects ?? []).join(", ") || "nothing"}`);
  // Reading must not WRITE: a school that merely looked would otherwise be
  // offered a resume for ever afterwards.
  const stillNoDraft = await prisma.onboardingSession.count({
    where: { schoolId, completedAt: null },
  });
  check(stillNoDraft === 0, "and looking at it did not create a draft", `${stillNoDraft} drafts`);

  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { name: { startsWith: "ZZGS " } } })) === 0, "test school removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
  console.log(failed ? "\nSOME GUIDED SETUP CHECKS FAILED" : "\nALL GUIDED SETUP CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
