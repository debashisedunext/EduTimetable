/**
 * §31 stage 1 — the Master Grid's data, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/master-grid-smoke.cjs
 *
 * The screen itself is a pivot of a payload that already existed, so almost
 * nothing here is new code — which is exactly why it needs a test that runs
 * against real generated rows rather than a fixture built by hand. Three
 * claims, in the order they can break:
 *
 *  1. **`teacherInitials` is on `/slots`, and the school's own answer wins.**
 *     A 27-pixel cell has room for nothing else, so a wrong or missing value
 *     here is a grid that names the wrong person. `initialsOf` returns a stored
 *     value untouched; the fixture gives one teacher `S.-PE` — which no
 *     derivation would ever produce — and checks it survives.
 *
 *  2. **`pivotSlots` run over the real payload reproduces the database.** The
 *     unit test in `packages/shared` proves the arithmetic against a synthetic
 *     week; this proves the payload is actually the shape that function expects,
 *     which is the half a unit test cannot see. The load-bearing assertion is
 *     the §4.9 one: a teacher who ONLY takes an elective option must have a
 *     non-empty week, because dropping option rows is the exact regression
 *     invariant 9 exists to prevent and it is invisible on a small fixture.
 *
 *  3. **`/lessons` is the curriculum, keyed by CLASS.** Two sections of one
 *     class must show identical rows — periods are a class fact (§27) — and
 *     another school's config id must 404 rather than return an empty grid,
 *     which would read as "this timetable teaches nothing" (§17.8).
 *
 * Everything it creates uses @zzmg.test / "ZZMG " and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const { cellEvents, initialsOf, pivotSlots, pivotCellKey, SLOT } = req("@edutimetable/shared");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzmg.test";
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
      where: { name: { startsWith: "ZZMG " } }, select: { id: true, code: true },
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

  // ───────────────────────── one wing, with the two shapes that break pivots
  console.log("\nA wing with a merged group and a split elective:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZMG Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZMG School" });
  check(made.status < 300, "school created", `school ${made.json?.schoolId}`);
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;

  const year = (await call("POST", "/academic-years", S, {
    name: "ZZMG 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  })).json;
  const cfg = (await call("POST", "/timetable-configs", S, { name: "ZZMG Wing", academicYearId: year.id })).json;
  await call("PUT", `/timetable-configs/${cfg.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 6, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
  });

  const c5 = (await call("POST", "/classes", S, { name: "Class 5", sequence: 9 })).json;
  const a = (await call("POST", `/classes/${c5.id}/sections`, S, { name: "A", academicYearId: year.id })).json.classSection;
  const b = (await call("POST", `/classes/${c5.id}/sections`, S, { name: "B", academicYearId: year.id })).json.classSection;
  await call("PUT", `/timetable-configs/${cfg.id}/class-sections`, S, { classSectionIds: [a.id, b.id] });

  const subj = {};
  for (const n of ["Maths", "Science", "Music", "French", "German"]) {
    subj[n] = (await call("POST", "/subjects", S, { name: `ZZMG ${n}` })).json;
  }
  const rooms = {};
  for (const n of ["5-A", "5-B", "Lang 1", "Lang 2", "Hall"]) {
    rooms[n] = (await call("POST", "/rooms", S, { name: `ZZMG ${n}`, roomType: "classroom", capacity: 40 })).json;
  }
  await call("PUT", `/class-sections/${a.id}`, S, { homeRoomId: rooms["5-A"].id });
  await call("PUT", `/class-sections/${b.id}`, S, { homeRoomId: rooms["5-B"].id });

  const T = {};
  for (const [k, n, initials] of [
    ["maths", "Maths", null],
    // The school's own answer, and one no derivation of "ZZMG Games" would
    // ever produce. If the payload ever starts deriving instead of reading,
    // this is the assertion that says so.
    ["games", "Games", "S.-PE"],
    // Takes NOTHING but a §4.9 option. Their whole week lives in option rows,
    // which is what makes them the witness for invariant 9.
    ["lang", "Lang", null],
    ["other", "Other", null],
  ]) {
    T[k] = (await call("POST", "/teachers", S, {
      name: `ZZMG ${n}`, employeeCode: `ZZMG-${k.toUpperCase()}`, initials,
      maxPeriodsPerWeek: 40, maxPeriodsPerDay: 6, minPeriodsPerDay: 0,
    })).json;
  }
  check(T.games.initials === "S.-PE", "a teacher carries the school's own initials", T.games.initials ?? "(none)");

  for (const [sname, n, perDay] of [["Maths", 6, 2], ["Science", 6, 2], ["Music", 4, 1]]) {
    const r = await call("POST", "/class-subjects", S, {
      classId: c5.id, academicYearId: year.id, subjectId: subj[sname].id,
      periodsPerWeek: n, maxPeriodsPerDay: perDay,
    });
    if (r.status >= 300) check(false, `curriculum ${sname}`, (r.json?.message ?? "").slice(0, 80));
  }
  await call("POST", "/mappings", S, {
    teacherId: T.maths.id, subjectId: subj.Maths.id, classSectionIds: [a.id, b.id], periodsPerWeek: 6,
  });
  await call("POST", "/mappings", S, {
    teacherId: T.other.id, subjectId: subj.Science.id, classSectionIds: [a.id, b.id], periodsPerWeek: 6,
  });
  // §4.10 — one teacher, both sections at once: the only way to put two lessons
  // in one cell of a SUBJECT pivot by construction rather than by luck.
  const merged = await call("POST", "/merged-groups", S, {
    teacherId: T.games.id, subjectId: subj.Music.id, periodsPerWeek: 4,
    classSectionIds: [a.id, b.id], roomId: rooms.Hall.id,
  });
  check(merged.status < 300, "a merged teaching group exists", (merged.json?.message ?? `${merged.status}`).slice(0, 70));
  // §4.9 — option rows carry no class-section, so a section-shaped query misses
  // every one of them.
  const block = await call("POST", "/elective-blocks", S, {
    name: "ZZMG Third Language", periodsPerWeek: 5, classSectionIds: [a.id, b.id],
    options: [
      { subjectId: subj.French.id, teacherId: T.lang.id, roomId: rooms["Lang 1"].id },
      { subjectId: subj.German.id, teacherId: T.other.id, roomId: rooms["Lang 2"].id },
    ],
  });
  check(block.status < 300, "a split-elective block exists", (block.json?.message ?? `${block.status}`).slice(0, 70));

  const ready = await call("GET", `/timetable-configs/${cfg.id}/readiness`, S);
  const blockers = ready.json?.blockers ?? [];
  check(blockers.length === 0, "the wing is feasible before the solver runs",
    blockers.length === 0 ? `${ready.json?.score}%` : blockers.slice(0, 2).map((x) => x.message).join(" | "));
  check((await call("POST", `/timetable-configs/${cfg.id}/generate`, S, {})).status < 300, "it generates");
  let done = null;
  for (let i = 0; i < 90 && !done; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = await call("GET", `/timetable-configs/${cfg.id}/generate/latest`, S);
    if (r.json?.state === "completed" || r.json?.state === "failed") done = r.json;
  }
  check(done?.state === "completed" && (done?.result?.unplaced?.length ?? -1) === 0,
    "and places every lesson", `${done?.state} · ${done?.result?.unplaced?.length ?? "?"} unplaced`);

  // ───────────────────────── 1. INITIALS
  console.log("\nThe payload carries a name that fits in 27 pixels:");
  const slots = (await call("GET", `/timetable-configs/${cfg.id}/slots?status=draft`, S)).json;
  check(slots?.teacherInitials && typeof slots.teacherInitials === "object",
    "/slots carries teacherInitials", `${Object.keys(slots?.teacherInitials ?? {}).length} teachers`);
  check(
    Object.keys(slots.teachers).every((id) => (slots.teacherInitials[id] ?? "").length > 0),
    "every teacher in the payload has one — a blank cell would read as a free period",
  );
  check(slots.teacherInitials[String(T.games.id)] === "S.-PE",
    "the school's own answer is returned untouched, not re-derived from the name",
    slots.teacherInitials[String(T.games.id)] ?? "(none)");
  check(slots.teacherInitials[String(T.maths.id)] === initialsOf("ZZMG Maths"),
    "and a teacher who has never been given one gets the shared derivation",
    slots.teacherInitials[String(T.maths.id)] ?? "(none)");

  // ───────────────────────── 2. THE PIVOT, OVER REAL ROWS
  console.log("\nThe pivot over the real payload agrees with the database:");
  const truth = await prisma.timetableSlot.findMany({
    where: { schoolId, timetableConfigId: cfg.id, status: "draft" },
    select: { classSectionId: true, teacherId: true, roomId: true, subjectId: true, dayOfWeek: true, periodNumber: true },
  });
  check(truth.length === slots.slots.length,
    "the payload holds every draft row", `${slots.slots.length} tuples vs ${truth.length} rows`);

  const bySection = pivotSlots(slots.slots, "section");
  const cellRows = truth.filter((s) => s.classSectionId !== null);
  check([...bySection.values()].reduce((n, l) => n + l.length, 0) === cellRows.length,
    "the section pivot holds exactly the rows that ARE grid cells — §4.9 option rows are not",
    `${[...bySection.values()].reduce((n, l) => n + l.length, 0)} vs ${cellRows.length}`);
  // A class-section can hold only one lesson per cell — `uq_class_slot` says so,
  // and a pivot that produced two would mean the payload had drifted from it.
  check([...bySection.values()].every((l) => l.length === 1),
    "and no class-section cell holds two lessons, which uq_class_slot forbids");

  const byTeacher = pivotSlots(slots.slots, "teacher");
  const langCells = [...byTeacher.keys()].filter((k) => k.startsWith(`${T.lang.id}@`));
  const langRows = truth.filter((s) => s.teacherId === T.lang.id);
  check(langRows.length > 0 && langCells.length === langRows.length,
    "a teacher who ONLY takes a §4.9 elective option has a full week, not a blank one (invariant 9)",
    `${langCells.length} cells vs ${langRows.length} lessons`);
  check(langRows.every((s) => s.classSectionId === null),
    "and every one of those lessons genuinely has no class-section, so a section-shaped query would have found none of them");

  // §4.10 — the merged group is one teacher and two sections at once, so on a
  // SUBJECT row it is one cell holding two lessons. The cell renders a count.
  const bySubject = pivotSlots(slots.slots, "subject");
  const musicCells = [...bySubject.entries()].filter(([k]) => k.startsWith(`${subj.Music.id}@`));
  check(musicCells.length > 0 && musicCells.every(([, l]) => l.length === 2),
    "a merged group is ONE subject cell holding both sections, which is what the count in the cell counts",
    `${musicCells.length} cells · ${musicCells.map(([, l]) => l.length).join(",")} lessons each`);

  // ...and the SAME rows are ONE lesson in the teacher's row (§4.10). Both
  // answers are right, which is why the collapse is per pivot: drawing "2" in
  // that teacher's cell would say they are teaching two things at once.
  const gamesCells = [...pivotSlots(slots.slots, "teacher").entries()]
    .filter(([k]) => k.startsWith(`${T.games.id}@`));
  check(gamesCells.length === 4 && gamesCells.every(([, l]) => l.length === 2),
    "the merged group is two ROWS in the teacher's cell...",
    gamesCells.map(([, l]) => l.length).join(","));
  check(gamesCells.every(([, l]) => cellEvents(l, "teacher").length === 1),
    "...and ONE occupancy event, because that is what a merged group is");
  check(gamesCells.every(([, l]) => cellEvents(l, "subject").length === 2),
    "while the same rows stay two on a subject row, where the question is how many sections are doing it");

  const byRoom = pivotSlots(slots.slots, "room");
  const langRoomCells = [...byRoom.keys()].filter((k) => k.startsWith(`${rooms["Lang 1"].id}@`));
  check(langRoomCells.length === 5,
    "a room used only by an elective option is occupied, not free — a wrong answer rather than a smaller one",
    `${langRoomCells.length} periods`);

  // Every cell key the grid asks for must be one the pivot can answer. This is
  // the §10.6 lesson in its single-wing form: a key derived at the call site
  // rather than by `pivotCellKey` is a lesson nobody ever sees.
  const missing = truth.filter((s) => s.classSectionId !== null)
    .filter((s) => !bySection.has(pivotCellKey(s.classSectionId, s.dayOfWeek, s.periodNumber)));
  check(missing.length === 0,
    "and every row in the database has a cell under the key the renderer looks it up by",
    missing.length ? `${missing.length} unreachable` : `${cellRows.length} reachable`);
  check(slots.slots.every((t) => t[SLOT.day] !== null && t[SLOT.period] !== null),
    "the tuple layout the pivot indexes into is the one the controller builds");

  // ───────────────────────── 3. THE LESSON GRID
  console.log("\nThe Lesson grid is the curriculum, keyed by class:");
  const lessons = (await call("GET", `/timetable-configs/${cfg.id}/lessons`, S)).json;
  check((lessons?.sections ?? []).length === 2, "it lists the wing's class-sections", `${lessons?.sections?.length}`);
  check(lessons.sections.every((s) => s.classId === c5.id),
    "each carrying its CLASS — because periods are a class fact (§27), not a section one");
  check((lessons.subjects ?? []).length === 3,
    "and only the subjects the curriculum actually names", (lessons.subjects ?? []).map((s) => s.name).join(", "));
  // §4.9 blocks carry their own periods/week and are not curriculum rows, so
  // French and German must NOT appear here — a grid that showed them would be
  // claiming Class 5 is taught both.
  check(!lessons.subjects.some((s) => s.id === subj.French.id || s.id === subj.German.id),
    "an elective's options are not curriculum rows and do not appear as columns");

  const cell = (cls, sub) => (lessons.cells.find(([c, s]) => c === cls && s === sub) ?? [])[2] ?? 0;
  check(cell(c5.id, subj.Maths.id) === 6 && cell(c5.id, subj.Music.id) === 4,
    "the numbers are what the school entered", `Maths ${cell(c5.id, subj.Maths.id)} · Music ${cell(c5.id, subj.Music.id)}`);
  const total = lessons.cells.reduce((n, [, , p]) => n + p, 0);
  check(total === 16, "and a class's row totals its whole curriculum", `${total} periods a week`);
  check(lessons.weekCapacity === 30,
    "the row total is measured against THIS wing's week — 6 periods × 5 days", `${lessons.weekCapacity}`);

  // Two sections of one class must be two rows showing ONE curriculum. If the
  // payload ever keys its cells by section, this is where the two would be free
  // to disagree.
  const perSection = lessons.sections.map((s) =>
    lessons.subjects.map((sub) => cell(s.classId, sub.id)).join(","));
  check(perSection[0] === perSection[1],
    "5-A and 5-B show identical rows, because they are one class's curriculum shown twice",
    perSection.join("  |  "));

  // ───────────────────────── 4. §17.8
  console.log("\nAnother school cannot read either of them:");
  const email2 = `other@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email: email2, password: PW, name: "ZZMG Other" });
  const acct2 = (await call("POST", "/auth/verify", null, { token: await mailToken(email2, "verify") })).json.accountToken;
  const other = await call("POST", "/schools", acct2, { name: "ZZMG Second" });
  const S2 = other.json.sessionToken;
  const mine = await call("GET", `/timetable-configs/${cfg.id}/lessons`, S);
  const theirs = await call("GET", `/timetable-configs/${cfg.id}/lessons`, S2);
  check(mine.status === 200 && theirs.status === 404,
    "/lessons — the owner gets a grid and a stranger gets 404, never an empty one that reads as 'teaches nothing'",
    `owner ${mine.status} · stranger ${theirs.status}`);
  const strangerSlots = await call("GET", `/timetable-configs/${cfg.id}/slots`, S2);
  check(strangerSlots.status >= 400, "/slots refuses them too", `${strangerSlots.status}`);

  await purge();
  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
  console.log(failed ? "\nFAILED\n" : "\nAll good.\n");
  process.exit(failed);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
