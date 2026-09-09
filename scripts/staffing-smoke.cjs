/**
 * §29.2 — the staffing-change record and the scoped thaw, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/staffing-smoke.cjs
 *
 * Step 2 of §29 is deliberately a PLAN and nothing else, so the assertion that
 * matters most here is the negative one: after opening a change, naming the
 * teachers, reading everything they carry and editing it twice, **not one
 * mapping, slot, class teacher or elective option has moved**. That is checked
 * by hashing the whole published week before and after and requiring the two to
 * be identical — the same shape §29.4's "no other timetable is impacted" proof
 * will take, built here where it is cheap.
 *
 * The other half is the enumeration. Four things carry "who teaches" (§29.2),
 * and three of them are easy to miss: a merged group has no section of its own,
 * an elective option has `class_section_id = NULL` by design, and a class
 * teacher is not a lesson at all. The fixture holds all four on purpose.
 *
 * Everything it creates uses @zzstf.test / "ZZSTF " and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");
const { createHash } = require("node:crypto");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzstf.test";
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
  "staffingChangeItem", "staffingChangeTeacher", "staffingChange",
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

async function main() {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZSTF " } }, select: { id: true, code: true },
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

  // ────────────────────────── 1. A SCHOOL HOLDING ALL FOUR KINDS OF UNIT
  console.log("\nA published school where one teacher carries all four kinds of work:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZSTF Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZSTF School" });
  check(made.status < 300, "school created", `school ${made.json?.schoolId}`);
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;

  const year = (await call("POST", "/academic-years", S, {
    name: "ZZSTF 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  })).json;
  const cfg = (await call("POST", "/timetable-configs", S, { name: "ZZSTF Wing", academicYearId: year.id })).json;
  // A second wing, so "a change is scoped to ONE timetable" can be asserted
  // rather than assumed — a teacher working in two wings is ordinary.
  const cfg2 = (await call("POST", "/timetable-configs", S, { name: "ZZSTF Wing 2", academicYearId: year.id })).json;
  for (const c of [cfg, cfg2]) {
    await call("PUT", `/timetable-configs/${c.id}/structure`, S, {
      startTime: "08:00", periodsPerDay: 6, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
    });
  }

  const klass = (await call("POST", "/classes", S, { name: "Class 5", sequence: 9 })).json;
  const klass2 = (await call("POST", "/classes", S, { name: "Class 6", sequence: 10 })).json;
  const secA = (await call("POST", `/classes/${klass.id}/sections`, S, { name: "A", academicYearId: year.id })).json.classSection;
  const secB = (await call("POST", `/classes/${klass.id}/sections`, S, { name: "B", academicYearId: year.id })).json.classSection;
  const secC = (await call("POST", `/classes/${klass2.id}/sections`, S, { name: "A", academicYearId: year.id })).json.classSection;
  await call("PUT", `/timetable-configs/${cfg.id}/class-sections`, S, { classSectionIds: [secA.id, secB.id] });
  await call("PUT", `/timetable-configs/${cfg2.id}/class-sections`, S, { classSectionIds: [secC.id] });

  const subj = {};
  for (const n of ["Maths", "Science", "French", "German", "Music"]) {
    subj[n] = (await call("POST", "/subjects", S, { name: `ZZSTF ${n}` })).json;
  }
  const rooms = {};
  for (const n of ["5-A", "5-B", "6-A", "Lang 1", "Lang 2"]) {
    rooms[n] = (await call("POST", "/rooms", S, { name: `ZZSTF ${n}`, roomType: "classroom", capacity: 40 })).json;
  }
  await call("PUT", `/class-sections/${secA.id}`, S, { homeRoomId: rooms["5-A"].id });
  await call("PUT", `/class-sections/${secB.id}`, S, { homeRoomId: rooms["5-B"].id });
  await call("PUT", `/class-sections/${secC.id}`, S, { homeRoomId: rooms["6-A"].id });

  const T = {};
  for (const [key, name] of [["leaver", "Leaver"], ["other", "Other"], ["lang", "Lang"], ["newbie", "Newbie"], ["guest", "Guest"]]) {
    T[key] = (await call("POST", "/teachers", S, {
      name: `ZZSTF ${name}`, employeeCode: `ZZSTF-${key.toUpperCase()}`,
      maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6, minPeriodsPerDay: 0,
      ...(key === "guest" ? { employmentType: "guest" } : {}),
    })).json;
  }

  // Curriculum: 5 periods of Maths + 3 Science + 2 Music for Class 5;
  // 4 Maths for Class 6. The elective block takes the remaining 2.
  for (const [cls, sname, n] of [
    [klass.id, "Maths", 5], [klass.id, "Science", 3], [klass.id, "Music", 2],
    [klass2.id, "Maths", 4],
  ]) {
    await call("POST", "/class-subjects", S, {
      classId: cls, academicYearId: year.id, subjectId: subj[sname].id, periodsPerWeek: n,
    });
  }

  // 1. an ordinary mapping, in each section — the leaver's Maths.
  await call("POST", "/mappings", S, {
    teacherId: T.leaver.id, subjectId: subj.Maths.id, classSectionIds: [secA.id, secB.id], periodsPerWeek: 5,
  });
  // …and the same teacher in the OTHER wing, which the change must not touch.
  await call("POST", "/mappings", S, {
    teacherId: T.leaver.id, subjectId: subj.Maths.id, classSectionIds: [secC.id], periodsPerWeek: 4,
  });
  // Science, so somebody else is in the wing too.
  await call("POST", "/mappings", S, {
    teacherId: T.other.id, subjectId: subj.Science.id, classSectionIds: [secA.id, secB.id], periodsPerWeek: 3,
  });
  // 2. a merged group (§4.10) — the leaver teaching both sections at once.
  const group = await call("POST", "/merged-groups", S, {
    teacherId: T.leaver.id, subjectId: subj.Music.id, periodsPerWeek: 2,
    classSectionIds: [secA.id, secB.id], roomId: rooms["5-A"].id,
  });
  check(group.status < 300, "a merged group exists", `${group.status}`);
  // 3. a §4.9 elective block, with the leaver on one of its options.
  const block = await call("POST", "/elective-blocks", S, {
    name: "ZZSTF Third Language", periodsPerWeek: 2, classSectionIds: [secA.id, secB.id],
    options: [
      { subjectId: subj.French.id, teacherId: T.leaver.id, roomId: rooms["Lang 1"].id },
      { subjectId: subj.German.id, teacherId: T.lang.id, roomId: rooms["Lang 2"].id },
    ],
  });
  check(block.status < 300, "an elective block exists", (block.json?.message ?? `${block.status}`).slice(0, 70));
  // 4. class teacher.
  await call("PUT", `/class-sections/${secA.id}/class-teacher`, S, { teacherId: T.leaver.id });

  const gen = await call("POST", `/timetable-configs/${cfg.id}/generate`, S, {});
  check(gen.status < 300, "it generates", (gen.json?.message ?? `${gen.status}`).slice(0, 90));
  let done = null;
  for (let i = 0; i < 90 && !done; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = await call("GET", `/timetable-configs/${cfg.id}/generate/latest`, S);
    if (r.json?.state === "completed" || r.json?.state === "failed") done = r.json;
  }
  check(done?.state === "completed" && (done?.result?.unplaced?.length ?? -1) === 0,
    "with nothing unplaced", `${done?.state} · ${done?.result?.unplaced?.length ?? "?"} unplaced`);
  const pub = await call("POST", `/timetable-configs/${cfg.id}/board/publish`, S, {});
  check(pub.status < 300, "and publishes", `${pub.status}`);
  await call("POST", `/timetable-configs/${cfg.id}/freeze`, S);

  /*
    The fingerprint everything below is measured against.

    Every published row of the school, ordered and hashed. §29 step 2 writes no
    allocation at all, so this number must be identical at the end — and the
    same device is what §29.4 will use to prove "no other teacher's week moved".
  */
  const weekHash = async () => {
    const rows = await prisma.timetableSlot.findMany({
      where: { schoolId, status: "published" },
      orderBy: { id: "asc" },
      select: {
        id: true, classSectionId: true, dayOfWeek: true, periodNumber: true,
        subjectId: true, teacherId: true, roomId: true, mergedGroupId: true, electiveOptionId: true,
      },
    });
    const mappings = await prisma.teacherSubjectClassSection.findMany({
      where: { schoolId }, orderBy: { id: "asc" },
      select: { id: true, teacherId: true, subjectId: true, classSectionId: true, periodsPerWeek: true },
    });
    const owners = await prisma.classSection.findMany({
      where: { schoolId }, orderBy: { id: "asc" }, select: { id: true, classTeacherId: true },
    });
    const groups = await prisma.mergedTeachingGroup.findMany({
      where: { schoolId }, orderBy: { id: "asc" }, select: { id: true, teacherId: true },
    });
    const options = await prisma.electiveOption.findMany({
      where: { schoolId }, orderBy: { id: "asc" }, select: { id: true, teacherId: true },
    });
    return createHash("sha256")
      .update(JSON.stringify({ rows, mappings, owners, groups, options }, (_k, v) => (typeof v === "bigint" ? String(v) : v)))
      .digest("hex");
  };
  const before = await weekHash();

  // ───────────────────────────────────── 2. OPENING A CHANGE, AND ITS REFUSALS
  console.log("\nOpening a staffing change, and what it refuses:");

  const nobody = await call("POST", `/timetable-configs/${cfg.id}/staffing-changes`, S, {
    reason: "resigned", releasing: [],
  });
  check(nobody.status === 400 && /at least one teacher/.test(nobody.json?.message ?? ""),
    "a change with nobody leaving has nothing to move, and says so",
    (nobody.json?.message ?? `${nobody.status}`).slice(0, 80));

  const badReason = await call("POST", `/timetable-configs/${cfg.id}/staffing-changes`, S, {
    reason: "quit", releasing: [T.leaver.id],
  });
  check(badReason.status === 400 && /reason must be one of/.test(badReason.json?.message ?? ""),
    "the reason is a closed set, because it chooses the shape of the change",
    (badReason.json?.message ?? `${badReason.status}`).slice(0, 70));

  const bothSides = await call("POST", `/timetable-configs/${cfg.id}/staffing-changes`, S, {
    reason: "adjustment", releasing: [T.leaver.id], receiving: [T.leaver.id, T.other.id],
  });
  check(bothSides.status === 400 && /both releasing and receiving/.test(bothSides.json?.message ?? ""),
    "a teacher cannot be on both sides — they would have two answers to 'how full are they?'",
    (bothSides.json?.message ?? `${bothSides.status}`).slice(0, 80));

  const guestReceives = await call("POST", `/timetable-configs/${cfg.id}/staffing-changes`, S, {
    reason: "resigned", releasing: [T.leaver.id], receiving: [T.guest.id],
  });
  check(guestReceives.status === 400 && /guest teacher/.test(guestReceives.json?.message ?? ""),
    "§18 — a guest is never given the regular curriculum",
    (guestReceives.json?.message ?? `${guestReceives.status}`).slice(0, 70));

  const opened = await call("POST", `/timetable-configs/${cfg.id}/staffing-changes`, S, {
    reason: "resigned", effectiveFrom: "2026-09-01", note: "ZZSTF resignation",
    releasing: [T.leaver.id], receiving: [T.other.id, T.newbie.id],
  });
  check(opened.status < 300 && opened.json?.status === "planning",
    "a valid change opens in 'planning'", `#${opened.json?.id}`);
  const changeId = opened.json.id;

  const second = await call("POST", `/timetable-configs/${cfg.id}/staffing-changes`, S, {
    reason: "leave", releasing: [T.leaver.id],
  });
  check(second.status === 400 && /already named in staffing change/.test(second.json?.message ?? ""),
    "a second open change over the same teacher is refused, naming the first",
    (second.json?.message ?? `${second.status}`).slice(0, 80));

  // ──────────────────────────── 3. WHAT THE LEAVER ACTUALLY CARRIES
  console.log("\nEverything the leaver carries — all four kinds:");
  const view = (await call("GET", `/staffing-changes/${changeId}`, S)).json;
  const byType = (t) => (view.units ?? []).filter((u) => u.type === t);

  check(byType("mapping").length === 2,
    "the two ordinary mappings — and NOT the one in the other wing",
    `${byType("mapping").length} · ${byType("mapping").map((u) => u.label).join(" | ")}`);
  check(byType("merged_group").length === 1 && byType("merged_group")[0].classSectionIds.length === 2,
    "the merged group, named by its members rather than by its id",
    byType("merged_group")[0]?.label ?? "missing");
  check(byType("elective_option").length === 1,
    "the elective option — the one with no class-section of its own (§4.9)",
    byType("elective_option")[0]?.label ?? "missing");
  check(byType("class_teacher").length === 1,
    "and the class-teacher role, which is not a lesson but is the thing a school notices first",
    byType("class_teacher")[0]?.label ?? "missing");

  const lessons = view.totals?.lessons ?? 0;
  const actual = await prisma.timetableSlot.count({
    where: { timetableConfigId: cfg.id, status: "published", teacherId: T.leaver.id },
  });
  /*
    §4.10 — a merged group is ONE occupancy event however many sections attend,
    so the unit's cells are deduplicated by day/period. Its published rows are
    one per member section, so the raw row count is higher by exactly the number
    of extra members — 2 periods x 1 extra section here.
  */
  check(lessons === actual - 2,
    "the lesson count matches the published week, with a merged group counted once (§4.10)",
    `${lessons} counted · ${actual} rows`);

  check((view.units ?? []).every((u) => !u.unpublished),
    "every unit has published lessons, so none is reported as 'not published yet'",
    `${(view.units ?? []).filter((u) => u.unpublished).map((u) => u.label).join(", ") || "none"}`);

  const otherWing = await call("POST", `/timetable-configs/${cfg2.id}/staffing-changes`, S, {
    reason: "adjustment", releasing: [T.other.id],
  });
  check(otherWing.status < 300 && (otherWing.json?.units ?? []).length === 0,
    "a change in the other wing sees nothing — the scope is one timetable, not the school",
    `${(otherWing.json?.units ?? []).length} unit(s)`);

  // ──────────────────────────────────────── 4. EDITING, AND THE LIFECYCLE
  console.log("\nEditing an open plan:");
  const edited = await call("PUT", `/staffing-changes/${changeId}`, S, {
    reason: "leave", note: "ZZSTF maternity", receiving: [T.other.id],
  });
  check(edited.status < 300 && edited.json?.reason === "leave" && edited.json?.receiving?.length === 1,
    "the reason, the note and the receiving list can all be changed while planning",
    `${edited.json?.reason} · ${edited.json?.receiving?.length} receiving`);
  check((edited.json?.releasing ?? []).length === 1,
    "and a list that was not sent is not a change — the releasing side is untouched",
    `${(edited.json?.releasing ?? []).map((t) => t.name).join(", ")}`);

  const listed = await call("GET", `/timetable-configs/${cfg.id}/staffing-changes`, S);
  check(listed.status < 300 && listed.json.some((c) => c.id === changeId),
    "it appears in the timetable's own list", `${listed.json?.length} change(s)`);

  // ────────────────────────────────── 4a. §29.3 THE PLAN: REPLACE
  //
  // One named teacher takes everything. The assertions are about the shape of
  // the ANSWER as much as its content: a flat yes/no would be useless, so what
  // has to come back is unit by unit, with a reason on every refusal.
  console.log("\nPlanning a replacement:");

  const noTeacher = await call("GET", `/staffing-changes/${changeId}/plan?mode=replace`, S);
  check(noTeacher.status === 400 && /Name the teacher/.test(noTeacher.json?.message ?? ""),
    "replace without naming anybody is refused",
    (noTeacher.json?.message ?? `${noTeacher.status}`).slice(0, 60));

  const itself = await call("GET", `/staffing-changes/${changeId}/plan?mode=replace&toTeacherId=${T.leaver.id}`, S);
  check(itself.status === 400 && /from themselves/.test(itself.json?.message ?? ""),
    "and so is taking over from yourself",
    (itself.json?.message ?? `${itself.status}`).slice(0, 60));

  const fresh = await call("GET", `/staffing-changes/${changeId}/plan?mode=replace&toTeacherId=${T.newbie.id}`, S);
  check(fresh.status < 300, "a new teacher with an empty week can be planned", `${fresh.status}`);
  const freshPlan = fresh.json?.plan;
  check(freshPlan?.uncovered === 0 && freshPlan?.covered === 5,
    "and takes all five units — the leaver's whole load fits an empty week",
    `${freshPlan?.covered} covered · ${freshPlan?.uncovered} uncovered`);
  const load = (freshPlan?.loads ?? [])[0];
  check(load && load.before === 0 && load.after === 14,
    "their load is reported before and after, so the cost is visible before anything is written",
    `${load?.before} → ${load?.after} of ${load?.cap}`);

  /*
    The claim that separates this from a substitute lookup.

    ZZSTF Other already teaches Science in both sections, at cells the leaver's
    Maths does not use — but they cannot be free at ALL of it, and what has to
    come back is which units fit and which do not, each with a reason.
  */
  const busy = await call("GET", `/staffing-changes/${changeId}/plan?mode=replace&toTeacherId=${T.other.id}`, S);
  const busyPlan = busy.json?.plan;
  check(busy.status < 300 && busyPlan?.uncovered > 0,
    "a teacher who already has a week cannot absorb all of it, and the plan says which parts",
    `${busyPlan?.covered} covered · ${busyPlan?.uncovered} uncovered`);
  const refusedUnits = (busyPlan?.assignments ?? []).filter((a) => a.toTeacherId === null);
  check(refusedUnits.length > 0 && refusedUnits.every((a) => (a.candidates?.[0]?.reasons ?? []).length > 0),
    "and every refusal names itself — an uncovered class is actionable, not mysterious",
    (refusedUnits[0]?.candidates?.[0]?.reasons ?? []).join("; ").slice(0, 90));

  const guestPlan = await call("GET", `/staffing-changes/${changeId}/plan?mode=replace&toTeacherId=${T.guest.id}`, S);
  check((guestPlan.json?.plan?.uncovered ?? 0) === 5
    && /guest/.test(JSON.stringify(guestPlan.json?.plan?.assignments?.[0]?.candidates ?? [])),
    "§18 — a guest is refused every unit, by name",
    `${guestPlan.json?.plan?.uncovered} uncovered`);

  // ────────────────────────────────── 4b. §29.3 THE PLAN: REDISTRIBUTE
  console.log("\nPlanning a redistribution across the receiving list:");
  await call("PUT", `/staffing-changes/${changeId}`, S, { receiving: [T.other.id, T.newbie.id, T.lang.id] });
  const spread = await call("GET", `/staffing-changes/${changeId}/plan?mode=redistribute`, S);
  const spreadPlan = spread.json?.plan;
  check(spread.status < 300 && spreadPlan?.uncovered === 0,
    "three teachers between them cover everything one of them could not",
    `${spreadPlan?.covered} covered · ${spreadPlan?.uncovered} uncovered`);
  const receivers = new Set((spreadPlan?.assignments ?? []).map((a) => a.toTeacherId).filter(Boolean));
  check(receivers.size > 1,
    "and it really is spread — more than one teacher takes a share",
    `${receivers.size} teacher(s)`);
  check((spreadPlan?.loads ?? []).every((l) => l.after <= l.cap),
    "nobody is pushed past their weekly limit",
    (spreadPlan?.loads ?? []).map((l) => `${l.teacherName} ${l.after}/${l.cap}`).join(" · "));

  /*
    §4.7a — availability is a hard filter here exactly as it is for the solver.

    Blocking the newcomer's whole Monday must remove them from every Monday
    unit, and the reason must name the cell rather than saying "unavailable".
  */
  await call("PUT", `/availability/teacher/${T.newbie.id}`, S, {
    rows: [{ dayOfWeek: 1, periodNumber: null, reason: "ZZSTF" }],
  });
  const blocked = await call("GET", `/staffing-changes/${changeId}/plan?mode=replace&toTeacherId=${T.newbie.id}`, S);
  const mondayUnits = (blocked.json?.plan?.assignments ?? [])
    .filter((a) => (a.unit.cells ?? []).some?.((c) => c.dayOfWeek === 1));
  check((blocked.json?.plan?.uncovered ?? 0) > 0
    && /not available at Mon/.test(JSON.stringify(blocked.json?.plan?.assignments ?? [])),
    "a whole day of time off removes them from every unit that touches it, naming the cell",
    `${blocked.json?.plan?.uncovered} uncovered`);
  await call("PUT", `/availability/teacher/${T.newbie.id}`, S, { rows: [] });

  // ────────────────────── 4c. §29.3 MOVING ONLY PART OF SOMEBODY'S WORK
  //
  // A resignation releases everything; an ADJUSTMENT releases what somebody
  // picks. Without this the two reasons would differ only in the word printed
  // on the record.
  console.log("\nMoving only part of it:");

  const full = (await call("GET", `/staffing-changes/${changeId}/plan?mode=replace&toTeacherId=${T.newbie.id}`, S)).json;
  const someKey = `${full.plan.assignments[0].unit.type}:${full.plan.assignments[0].unit.id}`;
  const part = await call(
    "GET",
    `/staffing-changes/${changeId}/plan?mode=replace&toTeacherId=${T.newbie.id}&units=${encodeURIComponent(someKey)}`,
    S,
  );
  check(part.status < 300
    && part.json?.plan?.assignments?.length === 1
    && part.json?.scope?.selected === 1
    && part.json?.scope?.available === 5,
    "a subset of the release can be planned on its own, and the scope is reported",
    `${part.json?.scope?.selected} of ${part.json?.scope?.available}`);

  const nothing = await call(
    "GET",
    `/staffing-changes/${changeId}/plan?mode=replace&toTeacherId=${T.newbie.id}&units=mapping:999999`,
    S,
  );
  check(nothing.status === 400 && /pick at least one/.test(nothing.json?.message ?? ""),
    "and choosing nothing that is actually in the release is refused, not silently emptied",
    (nothing.json?.message ?? `${nothing.status}`).slice(0, 70));

  // ───────────────────────── 4d. §28.1 WHOSE WEEK GETS HEAVIER
  //
  // What a school is really deciding here is whose week gets heavier and by how
  // much, so the load report is not a footnote. The alert line is a WARNING —
  // the same rule Check 12 follows — and must never turn into a refusal.
  console.log("\nThe load report, and the line the school drew itself:");

  await call("PUT", `/timetable-configs/${cfg.id}`, S, { loadAlertPct: 50 });
  await call("PUT", `/teachers/${T.newbie.id}`, S, {
    name: "ZZSTF Newbie", employeeCode: "ZZSTF-NEWBIE", maxPeriodsPerWeek: 16, maxPeriodsPerDay: 6,
  });
  const heavy = await call("GET", `/staffing-changes/${changeId}/plan?mode=replace&toTeacherId=${T.newbie.id}`, S);
  const heavyLoad = (heavy.json?.plan?.loads ?? [])[0];
  check(heavyLoad?.after === 14 && heavyLoad?.cap === 16 && heavyLoad?.alert === true,
    "a receiver crossing the school's alert line is flagged",
    `${heavyLoad?.before} → ${heavyLoad?.after} of ${heavyLoad?.cap} · alert ${heavyLoad?.alert}`);
  check((heavy.json?.plan?.uncovered ?? -1) === 0,
    "…and it is a warning, never a refusal — everything is still covered",
    `${heavy.json?.plan?.covered} covered`);

  // Over the cap is a different thing entirely, and IS a refusal.
  await call("PUT", `/teachers/${T.newbie.id}`, S, {
    name: "ZZSTF Newbie", employeeCode: "ZZSTF-NEWBIE", maxPeriodsPerWeek: 6, maxPeriodsPerDay: 6,
  });
  const over = await call("GET", `/staffing-changes/${changeId}/plan?mode=replace&toTeacherId=${T.newbie.id}`, S);
  check((over.json?.plan?.uncovered ?? 0) > 0
    && /over their limit of 6/.test(JSON.stringify(over.json?.plan?.assignments ?? [])),
    "while going over the cap is refused, naming the limit",
    `${over.json?.plan?.uncovered} uncovered`);
  await call("PUT", `/teachers/${T.newbie.id}`, S, {
    name: "ZZSTF Newbie", employeeCode: "ZZSTF-NEWBIE", maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6,
  });
  await call("PUT", `/timetable-configs/${cfg.id}`, S, { loadAlertPct: 75 });

  // ─────────────────── 4e. AN UNCOVERABLE CLASS EXPLAINS ITSELF FULLY
  //
  // The §4 promise applied to staffing: a vacancy nobody can fill has to name
  // what stopped EACH candidate, not just the best of them — three teachers
  // blocked for three different reasons is three different remedies, and only
  // one of them is usually worth doing.
  console.log("\nA vacancy nobody can fill:");
  await call("PUT", `/staffing-changes/${changeId}`, S, { receiving: [T.other.id, T.lang.id] });
  await call("PUT", `/availability/teacher/${T.lang.id}`, S, {
    rows: [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, periodNumber: null, reason: "ZZSTF" })),
  });
  const walled = await call("GET", `/staffing-changes/${changeId}/plan?mode=redistribute`, S);
  const stuck = (walled.json?.plan?.assignments ?? []).find((a) => a.toTeacherId === null);
  check(stuck !== undefined && (stuck.candidates ?? []).length === 2
    && stuck.candidates.every((c) => !c.ok && (c.reasons ?? []).length > 0),
    "every candidate is listed, each with its own reason",
    (stuck?.candidates ?? []).map((c) => `${c.teacherName}: ${c.reasons.join(", ")}`).join(" | ").slice(0, 130));
  await call("PUT", `/availability/teacher/${T.lang.id}`, S, { rows: [] });

  // ─────────────────────────────── 5. THE ASSERTION THIS STEP EXISTS FOR
  console.log("\nAnd after all of that — including every plan — not one lesson has moved:");
  const after = await weekHash();
  check(before === after,
    "the published week, every mapping, every group, every option and every class teacher are byte-identical",
    before === after ? "unchanged" : `${before.slice(0, 12)} → ${after.slice(0, 12)}`);
  const items = await prisma.staffingChangeItem.count({ where: { schoolId } });
  check(items === 0, "and nothing has been written to the undo record — there is nothing to undo yet",
    `${items} item(s)`);

  // ══════════════════════════ 6. §29.4 APPLYING IT
  //
  // The only part of §29 that writes to a published week, and the assertions
  // are almost entirely about what it does NOT touch.
  console.log("\nApplying the change:");

  const gapsRefused = await call("POST", `/staffing-changes/${changeId}/apply`, S, {
    mode: "replace", toTeacherId: T.other.id,
  });
  check(gapsRefused.status === 400 && /cannot be covered/.test(gapsRefused.json?.message ?? ""),
    "a plan with uncovered classes is refused unless the gaps are accepted, and names them",
    (gapsRefused.json?.message ?? `${gapsRefused.status}`).slice(0, 100));

  /*
    The fingerprint of everybody ELSE'S week.

    Every published row that does not belong to the leaver, hashed. This is the
    "no other timetable will get impacted" promise, and it is the reason the
    whole design reassigns rather than regenerates: the number below is checked
    before and after a real write.
  */
  const othersHash = async () => {
    const rows = await prisma.timetableSlot.findMany({
      where: { schoolId, status: "published", NOT: { teacherId: { in: [T.leaver.id, T.newbie.id] } } },
      orderBy: { id: "asc" },
      select: {
        id: true, classSectionId: true, dayOfWeek: true, periodNumber: true,
        subjectId: true, teacherId: true, roomId: true,
      },
    });
    return createHash("sha256")
      .update(JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? String(v) : v)))
      .digest("hex");
  };
  const othersBefore = await othersHash();
  const cellsBefore = await prisma.timetableSlot.findMany({
    where: { schoolId, status: "published" },
    orderBy: { id: "asc" },
    select: { id: true, classSectionId: true, dayOfWeek: true, periodNumber: true, subjectId: true, roomId: true },
  });
  const leaverSlotIds = (await prisma.timetableSlot.findMany({
    where: { timetableConfigId: cfg.id, status: "published", teacherId: T.leaver.id },
    select: { id: true },
  })).map((r) => String(r.id));

  const applied = await call("POST", `/staffing-changes/${changeId}/apply`, S, {
    mode: "replace", toTeacherId: T.newbie.id,
  });
  check(applied.status < 300 && applied.json?.moved === 5 && applied.json?.gaps === 0,
    "a complete plan applies",
    `${applied.json?.moved} unit(s) · ${applied.json?.slots} lesson(s)`);

  // ── the promise ──────────────────────────────────────────────────────────
  check((await othersHash()) === othersBefore,
    "EVERY other teacher's published week is byte-identical — nothing else moved",
    "unchanged");

  const cellsAfter = await prisma.timetableSlot.findMany({
    where: { schoolId, status: "published" },
    orderBy: { id: "asc" },
    select: { id: true, classSectionId: true, dayOfWeek: true, periodNumber: true, subjectId: true, roomId: true },
  });
  check(JSON.stringify(cellsBefore, (k, v) => (typeof v === "bigint" ? String(v) : v))
    === JSON.stringify(cellsAfter, (k, v) => (typeof v === "bigint" ? String(v) : v)),
    "and no CELL moved at all — same rows, same class, same period, same room (§29.0)",
    `${cellsAfter.length} lesson(s)`);

  const survived = await prisma.timetableSlot.count({
    where: { id: { in: leaverSlotIds.map((x) => BigInt(x)) }, teacherId: T.newbie.id },
  });
  check(survived === leaverSlotIds.length,
    "the SAME slot rows changed hands — updated in place, so no recorded substitution is orphaned",
    `${survived} of ${leaverSlotIds.length} ids survived`);

  // ── and the carriers, not only the lessons ──────────────────────────────
  const [mapLeft, groupLeft, optLeft, ctLeft] = await Promise.all([
    prisma.teacherSubjectClassSection.count({
      where: { teacherId: T.leaver.id, classSection: { timetableConfigId: cfg.id } },
    }),
    prisma.mergedTeachingGroup.count({ where: { teacherId: T.leaver.id } }),
    prisma.electiveOption.count({ where: { teacherId: T.leaver.id } }),
    prisma.classSection.count({ where: { classTeacherId: T.leaver.id } }),
  ]);
  check(mapLeft === 0 && groupLeft === 0 && optLeft === 0 && ctLeft === 0,
    "all FOUR carriers moved, not just the lessons — the next Generate cannot put the leaver back",
    `${mapLeft} mappings · ${groupLeft} groups · ${optLeft} options · ${ctLeft} class-teacher`);
  const stillElsewhere = await prisma.teacherSubjectClassSection.count({
    where: { teacherId: T.leaver.id, classSection: { timetableConfigId: cfg2.id } },
  });
  check(stillElsewhere === 1,
    "…while their work in the OTHER wing is untouched — a change is scoped to one timetable",
    `${stillElsewhere} mapping(s) still in ZZSTF Wing 2`);

  const record = await prisma.staffingChangeItem.findMany({ where: { changeId }, orderBy: { id: "asc" } });
  check(record.length === 5 && record.every((i) => i.toTeacherId === T.newbie.id && i.label.length > 0),
    "and the undo record names every unit, in English, with both teachers",
    record.map((i) => i.label).join(" | ").slice(0, 110));

  const reapply = await call("POST", `/staffing-changes/${changeId}/apply`, S, {
    mode: "replace", toTeacherId: T.newbie.id,
  });
  check(reapply.status === 400 && /already been applied/.test(reapply.json?.message ?? ""),
    "applying twice is refused — the record is of one change, not of a button",
    (reapply.json?.message ?? `${reapply.status}`).slice(0, 70));

  const editApplied = await call("PUT", `/staffing-changes/${changeId}`, S, { note: "ZZSTF edited" });
  check(editApplied.status === 400 && /no longer be edited/.test(editApplied.json?.message ?? ""),
    "and an applied change can no longer be edited — a record that can be rewritten is not one",
    (editApplied.json?.message ?? `${editApplied.status}`).slice(0, 70));

  // ══════════════════════════ 7. §29.5 PUTTING IT BACK
  console.log("\nReverting it:");
  const reverted = await call("POST", `/staffing-changes/${changeId}/revert`, S);
  check(reverted.status < 300 && reverted.json?.units === 5 && (reverted.json?.skipped ?? []).length === 0,
    "every unit goes back",
    `${reverted.json?.units} unit(s) · ${reverted.json?.slots} lesson(s)`);

  const [mapBack, groupBack, optBack, ctBack] = await Promise.all([
    prisma.teacherSubjectClassSection.count({
      where: { teacherId: T.leaver.id, classSection: { timetableConfigId: cfg.id } },
    }),
    prisma.mergedTeachingGroup.count({ where: { teacherId: T.leaver.id } }),
    prisma.electiveOption.count({ where: { teacherId: T.leaver.id } }),
    prisma.classSection.count({ where: { classTeacherId: T.leaver.id } }),
  ]);
  check(mapBack === 2 && groupBack === 1 && optBack === 1 && ctBack === 1,
    "all four carriers are back where they were",
    `${mapBack} mappings · ${groupBack} group · ${optBack} option · ${ctBack} class-teacher`);
  check((await weekHash()) === before,
    "and the whole published week is byte-identical to before the change — a genuine round trip",
    "unchanged");

  const changeRow = await prisma.staffingChange.findFirst({ where: { id: changeId } });
  check(changeRow?.status === "reverted" && changeRow?.revertedAt !== null && changeRow?.appliedAt !== null,
    "the change is KEPT and marked reverted, with when it was applied still on it (§3.14's rule)",
    `${changeRow?.status}`);
  const itemsKept = await prisma.staffingChangeItem.count({ where: { changeId } });
  check(itemsKept === 5, "and its items are kept too — this is the school's record of what happened",
    `${itemsKept} item(s)`);

  const revertTwice = await call("POST", `/staffing-changes/${changeId}/revert`, S);
  check(revertTwice.status === 400 && /nothing to put back/.test(revertTwice.json?.message ?? ""),
    "reverting twice is refused rather than quietly moving things a second time",
    (revertTwice.json?.message ?? `${revertTwice.status}`).slice(0, 70));

  // ══════════════════════════ 8. A GAP THE SCHOOL CHOSE
  console.log("\nApplying with a gap the school accepted:");
  const partial = (await call("POST", `/timetable-configs/${cfg.id}/staffing-changes`, S, {
    reason: "resigned", releasing: [T.leaver.id],
  })).json;
  const withGaps = await call("POST", `/staffing-changes/${partial.id}/apply`, S, {
    mode: "replace", toTeacherId: T.other.id, acceptGaps: true,
  });
  check(withGaps.status < 300 && withGaps.json?.gaps > 0 && withGaps.json?.moved > 0,
    "what can move, moves; the rest is left alone",
    `${withGaps.json?.moved} moved · ${withGaps.json?.gaps} left`);
  const gapItems = await prisma.staffingChangeItem.findMany({
    where: { changeId: partial.id, toTeacherId: null },
  });
  check(gapItems.length === withGaps.json?.gaps,
    "…and every gap is RECORDED with no destination, rather than silently skipped",
    `${gapItems.length} recorded · e.g. ${gapItems[0]?.label ?? "—"}`);
  const stillLeavers = await prisma.timetableSlot.count({
    where: { timetableConfigId: cfg.id, status: "published", teacherId: T.leaver.id },
  });
  check(stillLeavers > 0,
    "the uncovered lessons keep their teacher rather than being emptied — nothing is damaged to make the change look complete",
    `${stillLeavers} lesson(s) still name them`);
  await call("POST", `/staffing-changes/${partial.id}/revert`, S);
  check((await weekHash()) === before, "and that one reverts cleanly too", "unchanged");

  console.log("\nDiscarding it leaves no trace:");
  // A fresh plan: the one above has been applied and reverted, and an applied
  // change is deliberately not deletable.
  const spare = (await call("POST", `/timetable-configs/${cfg.id}/staffing-changes`, S, {
    reason: "adjustment", releasing: [T.leaver.id],
  })).json;
  const notDeletable = await call("DELETE", `/staffing-changes/${changeId}`, S);
  check(notDeletable.status === 400 && /no longer be edited/.test(notDeletable.json?.message ?? ""),
    "an applied change cannot be discarded — deleting it would rewrite the school's record",
    (notDeletable.json?.message ?? `${notDeletable.status}`).slice(0, 70));
  const discarded = await call("DELETE", `/staffing-changes/${spare.id}`, S);
  check(discarded.status < 300, "an open plan can be discarded", `${discarded.status}`);
  const gone = await call("GET", `/staffing-changes/${spare.id}`, S);
  check(gone.status === 404, "and is then simply not found", `${gone.status}`);
  check((await weekHash()) === before, "the week is still untouched", "unchanged");

  const reopened = await call("POST", `/timetable-configs/${cfg.id}/staffing-changes`, S, {
    reason: "resigned", releasing: [T.leaver.id],
  });
  check(reopened.status < 300,
    "and the teacher is free to be named in a new change once the old one is gone",
    `#${reopened.json?.id}`);

  console.log("\nCleanup:");
  await purge();
  check(true, "test school removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
  console.log(failed ? "\nSOME STAFFING CHECKS FAILED" : "\nALL STAFFING CHECKS PASSED");
  process.exit(failed);
}

main().catch((e) => { console.error(e); process.exit(1); });
