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
 *  3. **`/context` is the curriculum keyed by CLASS, plus what the strip needs.**
 *     Two sections of one class must show identical rows — periods are a class
 *     fact (§27) — and another school's config id must 404 rather than return
 *     an empty grid, which would read as "this timetable teaches nothing".
 *
 *  4. **Nothing is reported as missing on a school where nothing is.** §31.7
 *     draws two numbers where the week does not match the curriculum, and the
 *     first thing a false one costs is the reader's trust in the other 500
 *     cells. So the test is the negative first — a 100%-generated week produces
 *     ZERO differences — and only then the positive, by deleting one lesson and
 *     requiring exactly one cell to move.
 *
 *  5. **A teacher's load in the pool's OTHER timetables is reported, never
 *     folded in.** The fixture puts one teacher in two wings on purpose.
 *     CLAUDE.md records exactly what a single blended figure costs — "a line
 *     round one wing reads 67% where the truth is 87%" — so the strip states
 *     the wing's number and names the rest, and the number it names comes off
 *     `crossConfigTeacherLoad`, the codebase's one cross-timetable calculation.
 *
 *  6. **A consecutive block goes where the school said it may** (§31.10). The
 *     fixture puts a break in the middle of the day and asks for a 2-period
 *     block. With `blockMayCrossBreak` off, BOTH periods must land on the same
 *     side of it; with it on, the solver is ALLOWED to cross — and the proof is
 *     placed rows, not a stored column, because the column has existed since
 *     §4.8 and it was the placement that never honoured a choice.
 *
 * Everything it creates uses @zzmg.test / "ZZMG " and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const {
  blockSections, buildCoverage, cellEvents, initialsOf, pivotSlots, pivotCellKey, SLOT,
} = req("@edutimetable/shared");
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

  // ───────────────────────── 3. THE CONTEXT PAYLOAD
  console.log("\nThe Lesson grid is the curriculum, keyed by class:");
  const ctx = (await call("GET", `/timetable-configs/${cfg.id}/context`, S)).json;
  check((ctx?.sections ?? []).length === 2, "it lists the wing's class-sections", `${ctx?.sections?.length}`);
  check(ctx.sections.every((x) => x.classId === c5.id),
    "each carrying its CLASS — because periods are a class fact (§27), not a section one");
  check((ctx.subjects ?? []).length === 3,
    "and only the subjects the curriculum actually names", (ctx.subjects ?? []).map((x) => x.name).join(", "));
  // §4.9 blocks carry their own periods/week and are not curriculum rows, so
  // French and German must NOT appear here — a grid that showed them would be
  // claiming Class 5 is taught both.
  check(!ctx.subjects.some((x) => x.id === subj.French.id || x.id === subj.German.id),
    "an elective's options are not curriculum rows and do not appear as columns");

  const cell = (cls, sub) => (ctx.cells.find(([c, x]) => c === cls && x === sub) ?? [])[2] ?? 0;
  check(cell(c5.id, subj.Maths.id) === 6 && cell(c5.id, subj.Music.id) === 4,
    "the numbers are what the school entered", `Maths ${cell(c5.id, subj.Maths.id)} · Music ${cell(c5.id, subj.Music.id)}`);
  const total = ctx.cells.reduce((n, [, , p]) => n + p, 0);
  check(total === 16, "and a class's row totals its whole curriculum", `${total} periods a week`);
  check(ctx.weekCapacity === 30,
    "the row total is measured against THIS wing's week — 6 periods × 5 days", `${ctx.weekCapacity}`);

  // Two sections of one class must be two rows showing ONE curriculum. If the
  // payload ever keys its cells by section, this is where the two would be free
  // to disagree.
  const perSection = ctx.sections.map((x) =>
    ctx.subjects.map((sub) => cell(x.classId, sub.id)).join(","));
  check(perSection[0] === perSection[1],
    "5-A and 5-B show identical rows, because they are one class's curriculum shown twice",
    perSection.join("  |  "));

  // ───────────────────────── 3b. WHAT THE STRIP READS
  console.log("\nAnd it carries the four facts a placement does not (§31.6):");
  const secA = ctx.sections.find((x) => x.id === a.id);
  check(secA?.homeRoom === "ZZMG 5-A", "a class-section names its home room (§19)", secA?.homeRoom ?? "(none)");
  await call("PUT", `/class-sections/${a.id}/class-teacher`, S, { teacherId: T.maths.id });
  const ctx2 = (await call("GET", `/timetable-configs/${cfg.id}/context`, S)).json;
  check(ctx2.sections.find((x) => x.id === a.id)?.classTeacher === "ZZMG Maths",
    "and its class teacher — and the cached payload was swept when the teacher was set",
    ctx2.sections.find((x) => x.id === a.id)?.classTeacher ?? "(none)");
  check(ctx2.teachers[String(T.maths.id)]?.cap === 40,
    "every teacher's weekly cap is there, so the strip's '22 of 30' has a denominator",
    `${ctx2.teachers[String(T.maths.id)]?.cap}`);
  check((ctx2.teachers[String(T.maths.id)]?.elsewhere ?? -1) === 0,
    "and a single-wing school reports nothing elsewhere",
    `${ctx2.teachers[String(T.maths.id)]?.elsewhere}`);

  // The §4.9 group the strip could otherwise not fill: an option row belongs to
  // no class-section, so "The class" would read "—" for a lesson forty children
  // are sitting in.
  const blockId = (await prisma.electiveBlock.findFirst({ where: { schoolId, name: "ZZMG Third Language" } }))?.id;
  check(blockSections(slots.slots, blockId).sort((x, y) => x - y).join(",") === [a.id, b.id].sort((x, y) => x - y).join(","),
    "a block's attending sections are derivable from the tuples alone — the option rows contribute none",
    blockSections(slots.slots, blockId).join(","));

  // ───────────────────────── 3c. THE SECOND WING
  console.log("\nA teacher in two wings of one pool (§29.3's 67%-vs-87% trap):");
  const cfg2 = (await call("POST", "/timetable-configs", S, { name: "ZZMG Wing 2", academicYearId: year.id })).json;
  await call("PUT", `/timetable-configs/${cfg2.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 6, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
  });
  const c9 = (await call("POST", "/classes", S, { name: "Class 9", sequence: 13 })).json;
  const n9 = (await call("POST", `/classes/${c9.id}/sections`, S, { name: "A", academicYearId: year.id })).json.classSection;
  await call("PUT", `/timetable-configs/${cfg2.id}/class-sections`, S, { classSectionIds: [n9.id] });
  await call("POST", "/class-subjects", S, {
    classId: c9.id, academicYearId: year.id, subjectId: subj.Maths.id, periodsPerWeek: 8, maxPeriodsPerDay: 2,
  });
  const cross = await call("POST", "/mappings", S, {
    teacherId: T.maths.id, subjectId: subj.Maths.id, classSectionIds: [n9.id], periodsPerWeek: 8,
  });
  check(cross.status < 300, "the maths teacher is given Class 9 in the second wing", `${cross.status}`);

  const ctx3 = (await call("GET", `/timetable-configs/${cfg.id}/context`, S)).json;
  check(ctx3.teachers[String(T.maths.id)]?.elsewhere === 8,
    "the FIRST wing's payload now reports their 8 periods in the other timetable — the number the strip names rather than folds in",
    `${ctx3.teachers[String(T.maths.id)]?.elsewhere}`);
  check((ctx3.teachers[String(T.maths.id)]?.elsewhereIn ?? []).includes("ZZMG Wing 2"),
    "and names which timetable they are in, so the reader knows what the wing's own number leaves out",
    (ctx3.teachers[String(T.maths.id)]?.elsewhereIn ?? []).join(", "));
  check((ctx3.teachers[String(T.games.id)]?.elsewhere ?? -1) === 0,
    "while a teacher who works in one wing still reports nothing elsewhere",
    `${ctx3.teachers[String(T.games.id)]?.elsewhere}`);
  // The cells above must be unchanged by any of it: the second wing teaches
  // Class 9, and Class 9 must not appear in this wing's Lesson grid.
  check(ctx3.cells.every(([c]) => c === c5.id) && ctx3.cells.length === 3,
    "and the Lesson grid still shows only THIS wing's classes",
    `${new Set(ctx3.cells.map(([c]) => c)).size} class(es), ${ctx3.cells.length} rows`);

  // The payload is built from a full feasibility snapshot, which is not cheap.
  // Caching it is what makes that acceptable, so the cache is asserted rather
  // than assumed — and it lives under the config's own slot prefix, which is
  // what `invalidateTimetable` sweeps.
  const cacheKeys = await redis.keys(`s${schoolId}:slots:${cfg.id}:context`);
  check(cacheKeys.length === 1,
    "the payload is cached under the config's slot prefix, so invalidateTimetable sweeps it",
    cacheKeys.join(", ") || "(not cached)");

  // ───────────────────────── 3d. PLACED AGAINST REQUIRED (§31.7)
  console.log("\nA fully generated week reports nothing missing:");
  const teachingPeriods = new Set(
    slots.periods
      .filter((p) => !p.isBreak && !p.isExtra && !p.isActivity && p.periodNumber !== null && p.periodNumber !== 0)
      .map((p) => p.periodNumber),
  );
  const cov = buildCoverage({ slots: slots.slots, teachingPeriods });
  const requiredFor = (sectionId, subjectId) => {
    const cls = ctx3.sections.find((x) => x.id === sectionId)?.classId;
    return (ctx3.cells.find(([c, sid]) => c === cls && sid === subjectId) ?? [])[2] ?? 0;
  };
  const differences = (coverage, payload) => {
    const out = [];
    for (const sec of ctx3.sections) {
      for (const sub of ctx3.subjects) {
        const req = requiredFor(sec.id, sub.id);
        if (req === 0 || !coverage.comparable(sec.id, sub.id)) continue;
        const got = coverage.placedAt(sec.id, sub.id);
        if (got !== req) out.push(`${sec.label} ${sub.name} ${got}/${req}`);
      }
    }
    return out;
  };
  const clean = differences(cov, slots);
  check(clean.length === 0,
    "every class-section has exactly the periods its curriculum asks for — no cell shows two numbers",
    clean.length ? clean.join(" | ") : `${ctx3.sections.length} sections × ${ctx3.subjects.length} subjects checked`);
  // ...and the check above is only worth anything if it CAN fail, so the
  // fixture is asked for a number it has to have got right by counting.
  check(cov.placedAt(a.id, subj.Maths.id) === 6 && cov.placedAt(b.id, subj.Music.id) === 4,
    "and the counts are the real ones, not zero on both sides",
    `5-A Maths ${cov.placedAt(a.id, subj.Maths.id)} · 5-B Music ${cov.placedAt(b.id, subj.Music.id)}`);
  // §4.10 — a merged group is one lesson for the teacher and a period for EACH
  // class, so both sections must be credited or every merged subject in the
  // school reads as half-taught.
  check(cov.placedAt(a.id, subj.Music.id) === 4 && cov.placedAt(b.id, subj.Music.id) === 4,
    "a merged group credits both of its sections, not one",
    `${cov.placedAt(a.id, subj.Music.id)} · ${cov.placedAt(b.id, subj.Music.id)}`);
  // §4.9 — an option row belongs to no section, so no honest per-section count
  // exists. Marked not-comparable rather than reported as zero.
  check(cov.electiveSubjects.has(subj.French.id) && !cov.comparable(a.id, subj.French.id),
    "a subject running as a split-elective option is not compared — a confident 0 would be worse than nothing");

  console.log("\nDelete one lesson and exactly one cell says so:");
  const victim = await prisma.timetableSlot.findFirst({
    where: { schoolId, timetableConfigId: cfg.id, status: "draft", classSectionId: a.id, subjectId: subj.Maths.id },
  });
  await prisma.timetableSlot.delete({ where: { id: victim.id } });
  const stale = await redis.keys(`s${schoolId}:slots:${cfg.id}:*`);
  if (stale.length) await redis.del(...stale);
  const after = (await call("GET", `/timetable-configs/${cfg.id}/slots?status=draft`, S)).json;
  const covAfter = buildCoverage({ slots: after.slots, teachingPeriods });
  const moved = differences(covAfter, after);
  check(moved.length === 1 && moved[0] === "Class 5-A ZZMG Maths 5/6",
    "exactly one cell differs, and it is the one whose lesson was removed",
    moved.join(" | ") || "(none — the comparison is not working)");
  check(covAfter.placedAt(b.id, subj.Maths.id) === 6,
    "the other section of the same class is untouched — required is a CLASS fact, placed is a SECTION fact",
    `${covAfter.placedAt(b.id, subj.Maths.id)}`);

  console.log("\nAn ungenerated wing is not 'everything missing':");
  const empty = (await call("GET", `/timetable-configs/${cfg2.id}/slots?status=draft`, S)).json;
  const covEmpty = buildCoverage({ slots: empty.slots, teachingPeriods });
  check(empty.slots.length === 0, "the second wing has never been generated", `${empty.slots.length} slots`);
  check(!covEmpty.comparable(n9.id, subj.Maths.id),
    "so its 8 periods of Maths are not reported as 8 missing — 'not generated' and 'nothing placed' are different facts");

  // ───────────────────────── 3e. CONSECUTIVE BLOCKS AND THE BREAK (§31.10)
  console.log("\nA consecutive block, and the break it may or may not cross:");
  const email3 = `blocks@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email: email3, password: PW, name: "ZZMG Blocks" });
  const acct3 = (await call("POST", "/auth/verify", null, { token: await mailToken(email3, "verify") })).json.accountToken;
  const bs = await call("POST", "/schools", acct3, { name: "ZZMG Blocks" });
  const S3 = bs.json.sessionToken;
  const schoolId3 = bs.json.schoolId;

  const yr3 = (await call("POST", "/academic-years", S3, {
    name: "ZZMG B 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  })).json;
  const cfg3 = (await call("POST", "/timetable-configs", S3, { name: "ZZMG Blocks Wing", academicYearId: yr3.id })).json;
  /*
    Six periods with a break after P3, so the day is two runs of three. A
    2-period block therefore has exactly one illegal start — P3, which would
    put P3 before the break and P4 after it. That single cell is the whole
    experiment.
  */
  await call("PUT", `/timetable-configs/${cfg3.id}/structure`, S3, {
    startTime: "08:00", periodsPerDay: 6, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5],
    breaks: [{ afterPeriod: 3, name: "Lunch", durationMins: 30 }],
  });
  const bc = (await call("POST", "/classes", S3, { name: "Class 7", sequence: 11 })).json;
  const bsec = (await call("POST", `/classes/${bc.id}/sections`, S3, { name: "A", academicYearId: yr3.id })).json.classSection;
  await call("PUT", `/timetable-configs/${cfg3.id}/class-sections`, S3, { classSectionIds: [bsec.id] });
  const bsub = (await call("POST", "/subjects", S3, { name: "ZZMG Practical" })).json;
  const broom = (await call("POST", "/rooms", S3, { name: "ZZMG 7-A", roomType: "classroom", capacity: 40 })).json;
  await call("PUT", `/class-sections/${bsec.id}`, S3, { homeRoomId: broom.id });
  const bt = (await call("POST", "/teachers", S3, {
    name: "ZZMG Prac", employeeCode: "ZZMG-PRAC",
    maxPeriodsPerWeek: 40, maxPeriodsPerDay: 6, minPeriodsPerDay: 0,
  })).json;

  const curRow = await call("POST", "/class-subjects", S3, {
    classId: bc.id, academicYearId: yr3.id, subjectId: bsub.id,
    periodsPerWeek: 4, maxPeriodsPerDay: 2,
    consecutiveBlockSize: 2, consecutiveBlocksPerWeek: 2,
  });
  check(curRow.status < 300 && curRow.json?.consecutiveBlockSize === 2,
    "a curriculum row can ask for 2-period blocks", `${curRow.json?.consecutiveBlockSize}`);
  check(curRow.json?.blockMayCrossBreak === false,
    "and defaults to NOT crossing a break — every school before this flag existed",
    `${curRow.json?.blockMayCrossBreak}`);
  await call("POST", "/mappings", S3, {
    teacherId: bt.id, subjectId: bsub.id, classSectionIds: [bsec.id], periodsPerWeek: 4,
  });

  /** Generate, then report which period each block started at. */
  const blockStarts = async () => {
    const stale = await redis.keys(`s${schoolId3}:slots:${cfg3.id}:*`);
    if (stale.length) await redis.del(...stale);
    await call("POST", `/timetable-configs/${cfg3.id}/generate`, S3, {});
    let done = null;
    for (let i = 0; i < 90 && !done; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const r = await call("GET", `/timetable-configs/${cfg3.id}/generate/latest`, S3);
      if (r.json?.state === "completed" || r.json?.state === "failed") done = r.json;
    }
    /*
      Read through `/slots`, not straight from the table.

      §22: every Generate writes into a NEW draft, and the rows of the previous
      one are still `status: "draft"` — a raw query returns both and the second
      run appears to have placed twice as much. `/slots` resolves the config's
      CURRENT draft, which is also what the screen shows.
    */
    const payload = (await call("GET", `/timetable-configs/${cfg3.id}/slots?status=draft`, S3)).json;
    const rows = (payload?.slots ?? [])
      .filter((t) => t[3] === bsub.id)
      .map((t) => ({ dayOfWeek: t[1], periodNumber: t[2] }))
      .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.periodNumber - b.periodNumber);
    const byDay = new Map();
    for (const r of rows) {
      if (!byDay.has(r.dayOfWeek)) byDay.set(r.dayOfWeek, []);
      byDay.get(r.dayOfWeek).push(r.periodNumber);
    }
    return { state: done?.state, rows, byDay };
  };

  const off = await blockStarts();
  check(off.state === "completed" && off.rows.length === 4,
    "it generates, placing all four periods", `${off.state} · ${off.rows.length} rows`);
  /*
    The claim: with the flag off, no PAIR of adjacent periods straddles the
    break. P3 and P4 are adjacent numbers but sit either side of lunch, so a
    block starting at P3 is exactly what §4.8 forbids.
  */
  const straddles = (byDay) => [...byDay.values()].some((ps) => ps.includes(3) && ps.includes(4));
  check(!straddles(off.byDay),
    "and no block sits either side of the break — §4.8's rule, unchanged",
    [...off.byDay.entries()].map(([d, ps]) => `${d}:${ps.join("+")}`).join(" "));

  // Now allow it. The domain GAINS the crossing start; it does not require it.
  const rowId = (await prisma.classSubject.findFirst({
    where: { schoolId: schoolId3, classId: bc.id, subjectId: bsub.id },
  })).id;
  const upd = await call("PUT", `/class-subjects/${rowId}`, S3, {
    periodsPerWeek: 4, maxPeriodsPerDay: 2,
    consecutiveBlockSize: 2, consecutiveBlocksPerWeek: 2, blockMayCrossBreak: true,
  });
  check(upd.status < 300 && upd.json?.blockMayCrossBreak === true,
    "the school turns crossing ON for that row", `${upd.json?.blockMayCrossBreak}`);

  const on = await blockStarts();
  check(on.state === "completed" && on.rows.length === 4,
    "it still generates every period — widening a domain must not break the search",
    `${on.state} · ${on.rows.length} rows`);

  // The solver is free to cross now, and free not to; asserting that it DID
  // would be asserting a heuristic. What is checkable is that the placement is
  // still legal and that the engine no longer refuses the shape outright.
  const readyOn = await call("GET", `/timetable-configs/${cfg3.id}/readiness`, S3);
  check((readyOn.json?.blockers ?? []).length === 0,
    "and Readiness has no blocker for it", `${readyOn.json?.score}%`);

  /*
    The refusal that has to become conditional. Three periods a block in a day
    whose runs are three long fits; make the runs shorter than the block and
    Check 3 says "no block can ever fit" — which stops being true the moment
    the row may cross.
  */
  await call("PUT", `/timetable-configs/${cfg3.id}/structure`, S3, {
    startTime: "08:00", periodsPerDay: 6, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5],
    breaks: [
      { afterPeriod: 2, name: "Short break", durationMins: 10 },
      { afterPeriod: 4, name: "Lunch", durationMins: 30 },
    ],
  });
  await call("PUT", `/class-subjects/${rowId}`, S3, {
    periodsPerWeek: 6, maxPeriodsPerDay: 3,
    consecutiveBlockSize: 3, consecutiveBlocksPerWeek: 2, blockMayCrossBreak: false,
  });
  const refused = await call("GET", `/timetable-configs/${cfg3.id}/readiness`, S3);
  const fragmented = (refused.json?.blockers ?? []).find((b) => b.code === "BLOCK_FRAGMENTED");
  check(!!fragmented,
    "a 3-period block in a day of 2-period runs is refused BEFORE Generate",
    (fragmented?.message ?? "(no blocker)").slice(0, 90));

  await call("PUT", `/class-subjects/${rowId}`, S3, {
    periodsPerWeek: 6, maxPeriodsPerDay: 3,
    consecutiveBlockSize: 3, consecutiveBlocksPerWeek: 2, blockMayCrossBreak: true,
  });
  const allowed = await call("GET", `/timetable-configs/${cfg3.id}/readiness`, S3);
  check(!(allowed.json?.blockers ?? []).some((b) => b.code === "BLOCK_FRAGMENTED"),
    "...and NOT refused once the school says the block may cross a break — the blocker learned the setting, not just the domain",
    // Named, not counted: a bare "1 blocker" leaves the reader unable to tell a
    // clean pass from one that merely traded this refusal for another.
    (allowed.json?.blockers ?? []).map((b) => b.code).join(", ") || "no blockers at all");

  /*
    And now the strongest form of the claim: a day of 2-period runs and a
    3-period block leave the solver NO choice but to cross. If the domain change
    never reached real placement, this cannot generate at all — so the rows
    themselves are the proof, rather than the absence of a refusal.
  */
  const bmap = await prisma.teacherSubjectClassSection.findFirst({
    where: { schoolId: schoolId3, subjectId: bsub.id },
  });
  await call("PUT", `/mappings/${bmap.id}`, S3, { periodsPerWeek: 6 });
  const feasible = await call("GET", `/timetable-configs/${cfg3.id}/readiness`, S3);
  check((feasible.json?.blockers ?? []).length === 0,
    "with the mapping matched to the curriculum the wing is feasible",
    (feasible.json?.blockers ?? []).map((b) => b.code).join(", ") || `${feasible.json?.score}%`);

  const forced = await blockStarts();
  check(forced.state === "completed" && forced.rows.length === 6,
    "and it generates — which is only possible by crossing a break",
    `${forced.state} · ${forced.rows.length} rows`);
  // Segments are P1-P2 | P3-P4 | P5-P6, so any three consecutive periods must
  // span a boundary. Asserted on the periods actually written.
  const triples = [...forced.byDay.values()].filter((ps) => ps.length >= 3);
  const spansABreak = (ps) => ps.some((x) => ps.includes(x + 1) && [2, 4].includes(x));
  check(triples.length > 0 && triples.every(spansABreak),
    "every placed block really does sit across a break, in the rows themselves",
    [...forced.byDay.entries()].map(([d, ps]) => `${d}:${ps.join("+")}`).join(" "));

  // ───────────────────────── 4. §17.8
  console.log("\nAnother school cannot read either of them:");
  const email2 = `other@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email: email2, password: PW, name: "ZZMG Other" });
  const acct2 = (await call("POST", "/auth/verify", null, { token: await mailToken(email2, "verify") })).json.accountToken;
  const other = await call("POST", "/schools", acct2, { name: "ZZMG Second" });
  const S2 = other.json.sessionToken;
  const mine = await call("GET", `/timetable-configs/${cfg.id}/context`, S);
  const theirs = await call("GET", `/timetable-configs/${cfg.id}/context`, S2);
  check(mine.status === 200 && theirs.status === 404,
    "/context — the owner gets a payload and a stranger gets 404, never an empty one that reads as 'teaches nothing'",
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
