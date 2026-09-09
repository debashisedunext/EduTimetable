/**
 * §10.6 — the week-grid payload, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/reports-grid-smoke.cjs
 *
 * The assertion this file exists for is the FIRST one, and it fails on the code
 * that came before §10.6:
 *
 *   `teacherTimetable` took its day shape from `slots[0].timetableConfigId` —
 *   whichever row the database happened to return first — and the renderer then
 *   iterated that one wing's periods. §3.10 makes a cross-wing teacher ordinary,
 *   and for every one of them the grid was wrong twice: a lesson at a period
 *   number the chosen wing does not have was **dropped entirely**, and one at a
 *   shared number was drawn on the other wing's clock row.
 *
 * So the fixture is deliberately two wings that DISAGREE about the shape of a
 * day — 6 periods from 08:00 against 8 periods from 07:30 — with one teacher in
 * both. The test is simply: does the teacher's grid hold every lesson the
 * database says they teach.
 *
 * The rest of the file covers the two new cards (room, subject) and the one
 * property the §10.6 wall is built on: a slot id appearing in two cards refers
 * to one row, which is what makes cross-highlighting true rather than a guess.
 *
 * Everything it creates uses @zzrg.test / "ZZRG " and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzrg.test";
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
  "room", "timetableConfig", "academicYear",
  "notification", "aiChatLog", "aiSettings", "autoFixRun", "erpSyncRun",
  "auditLog", "user", "rolePermission", "erpRoleMapping", "role",
];

/** Run the solver on one wing and publish it. */
async function generateAndPublish(S, cfgId, label) {
  // Readiness first, and NAMED when it is not 100: a fixture that quietly
  // stopped being feasible otherwise reports itself as a failure of the thing
  // under test, which sends the next reader to the wrong file.
  const ready = await call("GET", `/timetable-configs/${cfgId}/readiness`, S);
  const blockers = ready.json?.blockers ?? [];
  check(blockers.length === 0, `${label} is feasible before the solver runs`,
    blockers.length === 0
      ? `${ready.json?.score}% (warnings only, which block nothing)`
      : blockers.slice(0, 3).map((b) => b.message).join(" | "));
  const gen = await call("POST", `/timetable-configs/${cfgId}/generate`, S, {});
  check(gen.status < 300, `${label} generates`, (gen.json?.message ?? `${gen.status}`).slice(0, 90));
  let done = null;
  for (let i = 0; i < 90 && !done; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = await call("GET", `/timetable-configs/${cfgId}/generate/latest`, S);
    if (r.json?.state === "completed" || r.json?.state === "failed") done = r.json;
  }
  check(done?.state === "completed" && (done?.result?.unplaced?.length ?? -1) === 0,
    `${label} places every lesson`, `${done?.state} · ${done?.result?.unplaced?.length ?? "?"} unplaced`);
  const pub = await call("POST", `/timetable-configs/${cfgId}/board/publish`, S, {});
  check(pub.status < 300, `${label} publishes`, `${pub.status}`);
}

async function main() {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZRG " } }, select: { id: true, code: true },
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

  // ───────────────────────── 1. TWO WINGS THAT DISAGREE ABOUT A DAY
  console.log("\nA school whose two wings keep different hours, and one teacher in both:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZRG Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZRG School" });
  check(made.status < 300, "school created", `school ${made.json?.schoolId}`);
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;

  const year = (await call("POST", "/academic-years", S, {
    name: "ZZRG 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  })).json;

  const junior = (await call("POST", "/timetable-configs", S, { name: "ZZRG Junior", academicYearId: year.id })).json;
  const senior = (await call("POST", "/timetable-configs", S, { name: "ZZRG Senior", academicYearId: year.id })).json;
  /*
    The whole point of the fixture. Junior runs 6 periods from 08:00; Senior runs
    8 from 07:30. So Senior has a P7 and a P8 that Junior has no row for at all,
    and the two wings' P1..P6 fall at different clock times.
  */
  await call("PUT", `/timetable-configs/${junior.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 6, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
  });
  await call("PUT", `/timetable-configs/${senior.id}/structure`, S, {
    startTime: "07:30", periodsPerDay: 8, periodDurationMins: 35, workingDays: [1, 2, 3, 4, 5], breaks: [],
  });

  const c5 = (await call("POST", "/classes", S, { name: "Class 5", sequence: 9 })).json;
  const c9 = (await call("POST", "/classes", S, { name: "Class 9", sequence: 13 })).json;
  const j5 = (await call("POST", `/classes/${c5.id}/sections`, S, { name: "A", academicYearId: year.id })).json.classSection;
  const j5b = (await call("POST", `/classes/${c5.id}/sections`, S, { name: "B", academicYearId: year.id })).json.classSection;
  const s9 = (await call("POST", `/classes/${c9.id}/sections`, S, { name: "A", academicYearId: year.id })).json.classSection;
  await call("PUT", `/timetable-configs/${junior.id}/class-sections`, S, { classSectionIds: [j5.id, j5b.id] });
  await call("PUT", `/timetable-configs/${senior.id}/class-sections`, S, { classSectionIds: [s9.id] });

  const subj = {};
  for (const n of ["Maths", "Science", "Music", "French", "German"]) {
    subj[n] = (await call("POST", "/subjects", S, { name: `ZZRG ${n}` })).json;
  }
  const rooms = {};
  for (const n of ["5-A", "5-B", "9-A", "Lang 1", "Lang 2", "Hall"]) {
    rooms[n] = (await call("POST", "/rooms", S, { name: `ZZRG ${n}`, roomType: "classroom", capacity: 40 })).json;
  }
  await call("PUT", `/class-sections/${j5.id}`, S, { homeRoomId: rooms["5-A"].id });
  await call("PUT", `/class-sections/${j5b.id}`, S, { homeRoomId: rooms["5-B"].id });
  await call("PUT", `/class-sections/${s9.id}`, S, { homeRoomId: rooms["9-A"].id });

  const T = {};
  for (const [k, n] of [["cross", "Cross"], ["junior", "Junior"], ["senior", "Senior"], ["lang", "Lang"]]) {
    T[k] = (await call("POST", "/teachers", S, {
      name: `ZZRG ${n}`, employeeCode: `ZZRG-${k.toUpperCase()}`,
      maxPeriodsPerWeek: 40, maxPeriodsPerDay: 8, minPeriodsPerDay: 0,
    })).json;
  }

  /*
    Junior holds 30 periods a week (6 x 5), Senior 40 (8 x 5). Both are filled
    well short of capacity: what this fixture is testing is the SHAPE of the two
    weeks, and a tight one only adds ways for it to fail for unrelated reasons.
    §4.9's block is not a curriculum row (it carries its own periods/week), so
    French and German are deliberately absent from the list below.
  */
  // `maxPeriodsPerDay` is passed rather than left at its default of 1: at one a
  // day, 8 periods a week needs an 8-day week and Check 3 says so — correctly,
  // and it would look like this feature had broken readiness.
  for (const [cls, sname, n, perDay] of [
    [c5.id, "Maths", 6, 2], [c5.id, "Science", 6, 2], [c5.id, "Music", 4, 1],
    [c9.id, "Maths", 8, 2], [c9.id, "Science", 8, 2],
  ]) {
    const cs = await call("POST", "/class-subjects", S, {
      classId: cls, academicYearId: year.id, subjectId: subj[sname].id,
      periodsPerWeek: n, maxPeriodsPerDay: perDay,
    });
    if (cs.status >= 300) check(false, `curriculum ${sname} for class ${cls}`, (cs.json?.message ?? "").slice(0, 80));
  }

  // The cross-wing teacher — the whole reason for this fixture. Maths in BOTH
  // wings: 6 in each junior section and 8 in Class 9, so their week is drawn
  // from two period grids that do not agree about what a day looks like.
  await call("POST", "/mappings", S, {
    teacherId: T.cross.id, subjectId: subj.Maths.id, classSectionIds: [j5.id, j5b.id], periodsPerWeek: 6,
  });
  await call("POST", "/mappings", S, {
    teacherId: T.cross.id, subjectId: subj.Maths.id, classSectionIds: [s9.id], periodsPerWeek: 8,
  });
  await call("POST", "/mappings", S, {
    teacherId: T.junior.id, subjectId: subj.Science.id, classSectionIds: [j5.id, j5b.id], periodsPerWeek: 6,
  });
  await call("POST", "/mappings", S, {
    teacherId: T.senior.id, subjectId: subj.Science.id, classSectionIds: [s9.id], periodsPerWeek: 8,
  });
  /*
    §4.10 — a merged teaching group: one teacher taking 5-A and 5-B together.
    It is here because it is the only way to put two sections in ONE cell by
    construction rather than by luck. Two sections cannot otherwise share a
    period for the same subject unless two different teachers happen to be given
    the same slot, and `uq_teacher_slot` forbids the one-teacher version. The
    subject card's whole claim — that a cell is a count — needs a cell with more
    than one thing in it.
  */
  const merged = await call("POST", "/merged-groups", S, {
    teacherId: T.junior.id, subjectId: subj.Music.id, periodsPerWeek: 4,
    classSectionIds: [j5.id, j5b.id], roomId: rooms.Hall.id,
  });
  check(merged.status < 300, "a merged teaching group exists", (merged.json?.message ?? `${merged.status}`).slice(0, 70));
  // §4.9 — a language block in the junior wing, so the room card has an option
  // row (class_section_id = NULL) to find. That is invariant 9 one level out.
  const block = await call("POST", "/elective-blocks", S, {
    name: "ZZRG Third Language", periodsPerWeek: 5, classSectionIds: [j5.id, j5b.id],
    options: [
      { subjectId: subj.French.id, teacherId: T.lang.id, roomId: rooms["Lang 1"].id },
      { subjectId: subj.German.id, teacherId: T.senior.id, roomId: rooms["Lang 2"].id },
    ],
  });
  check(block.status < 300, "a split-elective block exists", (block.json?.message ?? `${block.status}`).slice(0, 70));

  await generateAndPublish(S, junior.id, "Junior");
  await generateAndPublish(S, senior.id, "Senior");

  // ───────────────────────── 2. THE DEFECT
  console.log("\nA cross-wing teacher's grid holds EVERY lesson they teach:");

  const truth = await prisma.timetableSlot.findMany({
    where: { schoolId, status: "published", teacherId: T.cross.id, teacherOccupancyKey: { not: null } },
    select: { id: true, timetableConfigId: true, dayOfWeek: true, periodNumber: true },
  });
  const wingsInTruth = new Set(truth.map((s) => s.timetableConfigId));
  check(wingsInTruth.size === 2, "the fixture really does span two wings", `${wingsInTruth.size} wings, ${truth.length} lessons`);
  const card = (await call("GET", `/reports/teacher/${T.cross.id}`, S)).json;
  const cells = Object.keys(card.grid ?? {});
  check(cells.length === truth.length,
    "every published lesson is in the grid — none lost to the other wing's numbering",
    `${cells.length} cells vs ${truth.length} lessons`);

  // Not just the right COUNT: the right cells. Rebuilt here the way the server
  // builds it, so the two cannot drift apart silently.
  const expected = new Set(truth.map((s) => `${s.dayOfWeek}:c${s.timetableConfigId}p${s.periodNumber}`));
  check(cells.length === expected.size && [...expected].every((k) => cells.includes(k)),
    "and each is under a key naming its own wing, so two wings' P3 cannot collide",
    `${expected.size} expected`);

  /*
    The defect stated exactly. `periods` is the row list the renderer walks; a
    cell whose key has no row is a lesson that is simply never drawn, which is
    what happened to every Senior P7 and P8 when the shape came from Junior.
  */
  const rowKeys = new Set((card.periods ?? []).map((p) => p.key));
  const orphans = cells.filter((k) => !rowKeys.has(k.slice(k.indexOf(":") + 1)));
  check(orphans.length === 0,
    "and has a ROW to be drawn in — a cell with no row is a lesson nobody ever sees",
    orphans.length ? orphans.slice(0, 3).join(", ") : `${cells.length} cells, all renderable`);

  const late = (card.periods ?? []).filter((p) => p.periodNumber > 6);
  check(late.length === 2 && late.every((p) => p.wing === "ZZRG Senior"),
    "including Senior's P7 and P8, which Junior has no equivalent for",
    late.map((p) => `${p.wing} P${p.periodNumber}`).join(", ") || "none");

  check((card.wings ?? []).length === 2,
    "the card says which wings it spans", (card.wings ?? []).map((w) => w.name).join(", "));

  const rowTimes = (card.periods ?? []).map((p) => p.startTime);
  check(rowTimes.every((t, i) => i === 0 || rowTimes[i - 1] <= t),
    "its rows are ordered by the clock, so the two wings interleave as the morning actually runs",
    `${rowTimes[0]} … ${rowTimes[rowTimes.length - 1]}`);
  check((card.periods ?? []).every((p) => typeof p.wing === "string" && p.wing.length > 0),
    "and every row names the wing its period number belongs to");
  check((card.periods ?? []).length === 14,
    "6 Junior rows + 8 Senior rows, none merged away", `${(card.periods ?? []).length} rows`);

  // The single-wing card must be untouched by all of this.
  const one = (await call("GET", `/reports/class-section/${j5.id}`, S)).json;
  check((one.wings ?? []).length === 1 && one.periods.length === 6,
    "a single-wing card keeps exactly the shape it always had",
    `${(one.wings ?? []).length} wing · ${one.periods.length} rows`);

  // ───────────────────────── 3. THE ROOM CARD
  console.log("\nA room's week:");
  const langRoom = (await call("GET", `/reports/room/${rooms["Lang 1"].id}`, S)).json;
  check(Object.keys(langRoom.grid ?? {}).length === 5,
    "a room used only by a §4.9 elective option is NOT empty — option rows carry no class-section, and a query by section would have missed every one",
    `${Object.keys(langRoom.grid ?? {}).length} occupied periods`);
  const anyLang = Object.values(langRoom.grid ?? {})[0];
  check(anyLang?.classSection === "ZZRG Third Language",
    "and each is labelled by its block rather than left blank", anyLang?.classSection ?? "(blank)");

  const homeRoom = (await call("GET", `/reports/room/${rooms["9-A"].id}`, S)).json;
  check((homeRoom.wings ?? []).length === 1 && homeRoom.wings[0].name === "ZZRG Senior",
    "a home room's card is scoped to the wing that uses it", (homeRoom.wings ?? []).map((w) => w.name).join(", "));
  check(Object.values(homeRoom.grid ?? {}).every((c) => c.classSection === "Class 9-A"),
    "and every cell names the class in the room");

  // ───────────────────────── 4. THE SUBJECT CARD
  console.log("\nA subject across the week, as density rather than as lessons:");
  const maths = (await call("GET", `/reports/subject/${subj.Maths.id}`, S)).json;
  const mathsSlots = await prisma.timetableSlot.count({
    where: { schoolId, status: "published", subjectId: subj.Maths.id },
  });
  const counted = Object.values(maths.grid ?? {}).reduce((n, c) => n + (c.count ?? 0), 0);
  check(counted === mathsSlots,
    "every lesson of the subject is counted, not one per cell",
    `${counted} counted vs ${mathsSlots} published`);
  check(maths.weeklyLessons === mathsSlots, "the header total agrees with the cells", `${maths.weeklyLessons}`);
  const busiest = Math.max(...Object.values(maths.grid ?? {}).map((c) => c.count ?? 0));
  check(maths.busiest === busiest,
    "and the heat scale is the server's own busiest cell, so two subject cards are comparable",
    `${maths.busiest}`);
  check(Object.values(maths.grid ?? {}).every((c) => (c.sections ?? []).length === c.count),
    "and every cell names exactly as many sections as it counts");

  // The claim itself: a cell holding several lessons keeps all of them. §4.10's
  // merged group puts 5-A and 5-B in one period by construction, so this does
  // not depend on the solver happening to line two sections up.
  const music = (await call("GET", `/reports/subject/${subj.Music.id}`, S)).json;
  const multi = Object.values(music.grid ?? {}).find((c) => (c.count ?? 0) > 1);
  check(!!multi && (multi.sections ?? []).length === multi.count && multi.count === 2,
    "a cell with two sections in it names BOTH — the one a lesson-shaped card would have discarded",
    multi ? `${multi.count}: ${(multi.sections ?? []).join(", ")}` : "none found");
  check(music.busiest === 2, "and the card's heat scale says so", `busiest ${music.busiest}`);

  // ───────────────────────── 5. ONE LESSON, SEVERAL CARDS
  //
  // The property the §10.6 wall is built on. A teacher's card, their class's
  // card and their room's card are three projections of the SAME slot row, and
  // this is what lets a wall highlight one lesson in all of them at once.
  console.log("\nThe same lesson, seen from three sides:");
  const classCard = (await call("GET", `/reports/class-section/${s9.id}`, S)).json;
  const teacherCard = (await call("GET", `/reports/teacher/${T.cross.id}`, S)).json;
  const roomCard = (await call("GET", `/reports/room/${rooms["9-A"].id}`, S)).json;
  const idsOf = (g) => new Set(Object.values(g.grid ?? {}).flatMap((c) => c.slotIds ?? []));
  const inClass = idsOf(classCard), inTeacher = idsOf(teacherCard), inRoom = idsOf(roomCard);
  const shared = [...inTeacher].filter((id) => inClass.has(id) && inRoom.has(id));
  check(shared.length > 0,
    "a slot id from the teacher's card is found in the class's and the room's",
    `${shared.length} lessons appear in all three`);
  const sample = shared.length
    ? await prisma.timetableSlot.findUnique({ where: { id: BigInt(shared[0]) } })
    : null;
  check(!!sample && sample.teacherId === T.cross.id && sample.classSectionId === s9.id && sample.roomId === rooms["9-A"].id,
    "and it really is one row — same teacher, same class-section, same room",
    sample ? `slot ${sample.id}` : "not found");

  // ───────────────────────── 6. THE WALL, IN ONE REQUEST
  console.log("\nA whole wall of cards in one request:");
  const wallQ = [
    `t:${T.cross.id}`, `cs:${s9.id}`, `cs:${j5.id}`,
    `r:${rooms["9-A"].id}`, `sub:${subj.Maths.id}`,
  ].join(",");
  const wall = await call("GET", `/reports/wall?cards=${encodeURIComponent(wallQ)}`, S);
  check(wall.status === 200 && (wall.json?.cards ?? []).length === 5,
    "five cards come back together", `${(wall.json?.cards ?? []).length} cards`);
  check((wall.json?.cards ?? []).every((c) => c.card && !c.denied), "each with its grid");
  // The saving must be round trips only: a card on the wall and the same card on
  // the Reports screen go through one function, so they cannot disagree.
  const solo = (await call("GET", `/reports/teacher/${T.cross.id}`, S)).json;
  const onWall = (wall.json.cards ?? []).find((c) => c.kind === "teacher").card;
  check(JSON.stringify(solo) === JSON.stringify(onWall),
    "and a card on the wall is byte-identical to the same card on its own — one code path, not two");

  const dup = await call("GET", `/reports/wall?cards=${encodeURIComponent(`t:${T.cross.id},t:${T.cross.id}`)}`, S);
  check((dup.json?.cards ?? []).length === 1, "the same card twice is asked for once");

  // §21's rule, same shape: an unknown key is ignored because the screen may be
  // stale. A saved wall outlives the things on it, and one deleted teacher must
  // not make the other eleven cards unreachable.
  const stale = await call("GET", `/reports/wall?cards=${encodeURIComponent(`zz:9,t:${T.cross.id},t:abc`)}`, S);
  check(stale.status === 200 && (stale.json?.cards ?? []).length === 1,
    "a stale or malformed entry is skipped, not fatal — the rest of the wall still renders",
    `${(stale.json?.cards ?? []).length} card`);

  const over = await call("GET", `/reports/wall?cards=${
    encodeURIComponent(Array.from({ length: 30 }, () => `t:${T.cross.id}`).concat(
      Array.from({ length: 30 }, (_, i) => `cs:${900000 + i}`)).join(","))}`, S);
  check(over.json?.max === 24 && (over.json?.cards ?? []).length <= 24,
    "the cap is applied", `max ${over.json?.max}, served ${(over.json?.cards ?? []).length}`);
  check(over.json?.dropped > 0,
    "and REPORTED — a truncation nobody is told about reads as 'that is everything'",
    `${over.json?.dropped} dropped`);

  // ───────────────────────── 7. SCOPE
  //
  // Room and subject cards need view.all, and that is a correction made while
  // building: everywhere else in this module scope is a row-level FILTER, but a
  // filtered room grid shows an occupied room as free, which is a wrong answer
  // rather than a smaller one.
  console.log("\nA teacher cannot open a room or a subject card:");
  const teacherRole = await prisma.role.findFirst({ where: { schoolId, name: { in: ["Teacher", "TEACHER"] } } });
  const school = await prisma.school.findUnique({ where: { id: schoolId } });
  if (teacherRole) {
    await prisma.user.create({
      data: {
        schoolId, erpUserId: "local:zzrg-teacher", roleId: teacherRole.id,
        name: "ZZRG Teacher", email: `t@${DOMAIN}`, teacherId: T.junior.id,
      },
    });
    const t = await call("POST", "/dev/erp-token", null, {
      erpUserId: "local:zzrg-teacher", erpRole: "TEACHER", name: "ZZRG Teacher", email: `t@${DOMAIN}`,
      school: { code: school.code, name: "ZZRG School" },
    });
    const cb = await fetch(`${API}/api/sso/callback?token=${t.json.token}`, { redirect: "manual" });
    const tS = (cb.headers.get("location") || "").split("#token=")[1];
    /*
      Linked AFTER the login, not before: §15's sync-on-login provisioning
      rewrites the user row from the ERP payload, which carries no teacher link,
      so a `teacher_id` set beforehand is cleared by signing in. Without this the
      user has NO view scope at all and every check below passes for the wrong
      reason — which is exactly what happened the first time.
    */
    await prisma.user.updateMany({
      where: { schoolId, erpUserId: "local:zzrg-teacher" }, data: { teacherId: T.junior.id },
    });
    if (tS) {
      const r = await call("GET", `/reports/room/${rooms["9-A"].id}`, tS);
      check(r.status === 403, "the room card is refused, and says why rather than silently emptying", `${r.status}`);
      check(/free/i.test(r.json?.message ?? ""),
        "naming the actual danger — a filtered grid would show an occupied room as free",
        (r.json?.message ?? "").slice(0, 80));
      const sub = await call("GET", `/reports/subject/${subj.Maths.id}`, tS);
      check(sub.status === 403, "and so is the subject card", `${sub.status}`);
      // Their own grid comes from `/my/timetable` (§15.3, `timetable.view.own`),
      // not from `/reports/*` — the whole Reports controller needs
      // `reports.view`, which a Teacher role does not hold and never did.
      const own = await call("GET", "/my/timetable", tS);
      check(own.status === 200 && own.json?.kind === "teacher",
        "while their own grid still opens, exactly as before", `${own.status}`);
      check((own.json?.periods ?? []).every((p) => typeof p.key === "string"),
        "and it came through the same row model — one payload shape, not two");
      const opts = (await call("GET", "/reports/options", tS)).json;
      check(opts.scope === "own" || opts.scope === "class",
        "the teacher really does have a view scope — otherwise everything below passes for the wrong reason",
        `scope ${opts.scope}`);
      check((opts.rooms ?? []).length === 0 && (opts.subjects ?? []).length === 0,
        "and the picker does not offer them cards that would 403",
        `${(opts.teachers ?? []).length} teacher(s) offered, 0 rooms, 0 subjects`);

      /*
        The property that lets a wall be shared. One refused card must not blank
        the other eleven — so a refusal comes back in its own place on the wall,
        as data, while its neighbours render.
      */
      const mixed = await call("GET", `/reports/wall?cards=${
        encodeURIComponent(`r:${rooms["9-A"].id},t:${T.junior.id}`)}`, tS);
      check(mixed.status === 200, "a wall holding one refused card is still a 200", `${mixed.status}`);
      const byKind = Object.fromEntries((mixed.json?.cards ?? []).map((c) => [c.kind, c]));
      check(byKind.room?.denied === true && typeof byKind.room?.reason === "string",
        "the room comes back refused, in its own place, saying why",
        (byKind.room?.reason ?? "").slice(0, 50));
      check(!!byKind.teacher?.card && !byKind.teacher?.denied,
        "while the card beside it renders — one refusal does not blank the wall",
        byKind.teacher?.reason ?? "");
    } else {
      check(false, "could not mint a teacher session");
    }
  } else {
    check(false, "no Teacher role to test scope with");
  }

  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { name: { startsWith: "ZZRG " } } })) === 0, "test school removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
  console.log(failed ? "\nSOME REPORT GRID CHECKS FAILED" : "\nALL REPORT GRID CHECKS PASSED");
  process.exit(failed);
}

main().catch((e) => { console.error(e); process.exit(1); });
