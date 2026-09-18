/**
 * §29.8 — a SCOPED unlock on a locked timetable, against the live stack.
 *
 *   docker compose exec api node /app/scripts/locks-smoke.cjs
 *
 * `freeze-smoke.cjs` proves that a locked timetable refuses everything and that
 * a full unfreeze gives it all back. That test would still pass if §29.8 did
 * nothing at all — a grant that silently opened nothing, or one that silently
 * opened everything, both look identical from there.
 *
 * So this file asserts the four things that are actually the feature, and each
 * of them is a way the design could be wrong while looking right:
 *
 *   1. **Publishing locks.** Not a button somebody presses afterwards.
 *   2. **A grant opens exactly what it names.** The board edit for the unlocked
 *      class-section succeeds, and THE IDENTICAL CALL for the locked one still
 *      refuses — naming it. One without the other proves nothing: a grant that
 *      opened everything passes the first half, and one that opened nothing
 *      passes the second.
 *   3. **A teacher grant reaches into locked classes.** The headline case: a
 *      resignation moves one person's whole load across classes nobody
 *      unlocked, because requiring those classes would mean unlocking the
 *      twelve a real teacher covers.
 *   4. **A narrow permission never becomes a wide one.** Every
 *      whole-timetable route stays refused WHILE GRANTS ARE LIVE. This is the
 *      assertion the whole design rests on, and the only one that catches
 *      "generate quietly became scopeable".
 *
 * Plus §29.8b — a master in a live week cannot be deleted, and the same delete
 * succeeds once its lessons have moved. That arc is the point: the refusal is
 * about the rows, never about authority, so no grant opens it and none is
 * needed afterwards.
 *
 * Everything it creates uses @zzlck.test / "ZZLCK " and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzlck.test";
const PW = "correct horse battery staple";

let failed = 0;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = 1;
};
const info = (label, extra = "") => console.log(`  INFO  ${label}${extra ? ` — ${extra}` : ""}`);

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

const msg = (r) => r.json?.message ?? r.text ?? `${r.status}`;
/** A refusal that came from the lock — either wording. */
const lockRefusal = (r) => r.status === 400 && /(is|are) locked(,| and)/.test(msg(r));
/** The SCOPED refusal specifically: it names what is shut. */
const namesShut = (r, name) => r.status === 400 && msg(r).includes(name) && /not unlocked/.test(msg(r));

async function main() {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZLCK " } }, select: { id: true, code: true },
    });
    const ids = mine.map((s) => s.id);
    for (const m of [
      "timetableUnlockEvent", "timetableUnlockEntity", "timetableUnlock",
      "staffingChangeItem", "staffingChangeTeacher", "staffingChange",
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

  // ══════════════════════════════════ 1. A PUBLISHED SCHOOL, TWO CLASSES
  //
  // Two class-sections and two teachers is the minimum that can tell "opened
  // what it named" from "opened everything": with one of each, every grant
  // looks the same as a full unfreeze.
  console.log("\nA school with two classes and a published week:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZLCK Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZLCK School" });
  check(made.status < 300, "school created", `school ${made.json?.schoolId}`);
  const S = made.json.sessionToken;

  const year = (await call("POST", "/academic-years", S, {
    name: "ZZLCK 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  })).json;
  const cfg = (await call("POST", "/timetable-configs", S, {
    name: "ZZLCK Wing", academicYearId: year.id,
  })).json;
  await call("PUT", `/timetable-configs/${cfg.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 5, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
  });

  const klass = (await call("POST", "/classes", S, { name: "Class 1", sequence: 5 })).json;
  const secA = (await call("POST", `/classes/${klass.id}/sections`, S, { name: "A", academicYearId: year.id })).json.classSection;
  const secB = (await call("POST", `/classes/${klass.id}/sections`, S, { name: "B", academicYearId: year.id })).json.classSection;
  check(secA?.id && secB?.id, "two class-sections exist", `${secA?.id}, ${secB?.id}`);
  await call("PUT", `/timetable-configs/${cfg.id}/class-sections`, S, {
    classSectionIds: [secA.id, secB.id],
  });

  const maths = (await call("POST", "/subjects", S, { name: "ZZLCK Maths" })).json;
  const art = (await call("POST", "/subjects", S, { name: "ZZLCK Art" })).json;
  const ajay = (await call("POST", "/teachers", S, {
    name: "ZZLCK Ajay", employeeCode: "ZZLCK-T1", maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6,
  })).json;
  const nisha = (await call("POST", "/teachers", S, {
    name: "ZZLCK Nisha", employeeCode: "ZZLCK-T2", maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6,
  })).json;
  // Prakriti teaches nothing, so she is free at every cell — the receiver a
  // §29.3 plan will pick, and the proof that a receiver needs no grant.
  const prakriti = (await call("POST", "/teachers", S, {
    name: "ZZLCK Prakriti", employeeCode: "ZZLCK-T3", maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6,
  })).json;
  const roomA = (await call("POST", "/rooms", S, { name: "ZZLCK Room A", roomType: "classroom", capacity: 40 })).json;
  const roomB = (await call("POST", "/rooms", S, { name: "ZZLCK Room B", roomType: "classroom", capacity: 40 })).json;
  await call("PUT", `/class-sections/${secA.id}`, S, { homeRoomId: roomA.id });
  await call("PUT", `/class-sections/${secB.id}`, S, { homeRoomId: roomB.id });

  await call("POST", "/class-subjects", S, {
    classId: klass.id, academicYearId: year.id, subjectId: maths.id, periodsPerWeek: 4,
  });
  await call("POST", "/class-subjects", S, {
    classId: klass.id, academicYearId: year.id, subjectId: art.id, periodsPerWeek: 3,
  });
  // Ajay teaches BOTH sections — so unlocking him has to reach into two classes.
  await call("POST", "/mappings", S, {
    teacherId: ajay.id, subjectId: maths.id, classSectionIds: [secA.id, secB.id], periodsPerWeek: 4,
  });
  await call("POST", "/mappings", S, {
    teacherId: nisha.id, subjectId: art.id, classSectionIds: [secA.id, secB.id], periodsPerWeek: 3,
  });

  const gen = await call("POST", `/timetable-configs/${cfg.id}/generate`, S, {});
  check(gen.status < 300, "it generates", `${gen.status}`);
  let done = null;
  for (let i = 0; i < 60 && !done; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = await call("GET", `/timetable-configs/${cfg.id}/generate/latest`, S);
    if (r.json?.state === "completed" || r.json?.state === "failed") done = r.json;
  }
  check(done?.state === "completed", "generation completed", `${done?.state}`);

  // ══════════════════════════════════════════ 2. PUBLISHING IS THE LOCK
  //
  // §29.1 said the opposite in as many words. This is the reversal, asserted
  // rather than described — and asserted through the API, because a school's
  // experience of it is "I pressed Publish and now it is protected", not a
  // column value.
  console.log("\nPublishing locks the timetable, with nobody pressing anything else:");
  const published = await call("POST", `/timetable-configs/${cfg.id}/board/publish`, S, {});
  check(published.status < 300, "it publishes", `${published.status}`);
  const afterPublish = await prisma.timetableConfig.findFirst({
    where: { id: cfg.id }, select: { frozenAt: true },
  });
  check(afterPublish?.frozenAt != null, "and it is locked in the same act", `${afterPublish?.frozenAt}`);

  const moveOf = (sectionId, day, period, subjectId, teacherId, to) => () =>
    call("POST", `/timetable-configs/${cfg.id}/board/move`, S, {
      from: { classSectionId: sectionId, day, period },
      expect: { subjectId, teacherId },
      to,
    });

  // A real published cell for each section, read from the database so the test
  // moves something that is actually there rather than something it assumed.
  const cellsOf = async (sectionId) =>
    prisma.timetableSlot.findMany({
      where: { timetableConfigId: cfg.id, classSectionId: sectionId, status: "published" },
      select: { dayOfWeek: true, periodNumber: true, subjectId: true, teacherId: true },
      orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
    });
  const cellsA = await cellsOf(secA.id);
  const cellsB = await cellsOf(secB.id);
  check(cellsA.length > 0 && cellsB.length > 0, "both sections have published lessons",
    `${cellsA.length} / ${cellsB.length}`);

  /*
    A board edit works on DRAFT rows, so the draft has to exist before any of
    the board assertions mean anything. `draft-from-published` is itself a
    guarded route, so this needs the timetable open — which is exactly the
    order a school would do it in: unlock, work, relock.
  */
  await call("POST", `/timetable-configs/${cfg.id}/unfreeze`, S);
  const seeded = await call("POST", `/timetable-configs/${cfg.id}/board/draft-from-published`, S);
  check(seeded.status < 300, "a working draft is seeded from the published week", `${seeded.status}`);
  const draftCell = async (sectionId) =>
    prisma.timetableSlot.findFirst({
      where: { timetableConfigId: cfg.id, classSectionId: sectionId, status: "draft", teacherId: { not: null } },
      select: { dayOfWeek: true, periodNumber: true, subjectId: true, teacherId: true },
      orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
    });
  const cellA = await draftCell(secA.id);
  const cellB = await draftCell(secB.id);
  /*
    A destination that is free for the SECTION *and* for its TEACHER.

    The section alone is not enough, and the first version of this test found
    out the hard way: the solver had put Ajay in 1-B at the only cell 1-A had
    spare, so the move was refused by `uq_teacher_slot` and the lock assertion
    read as a lock failure. Generation carries seeded jitter, so that was a test
    that passed or failed depending on the run — exactly the kind of noise that
    teaches people to re-run a suite instead of reading it.
  */
  const freeCell = async (sectionId, teacherId) => {
    const rows = await prisma.timetableSlot.findMany({
      where: { timetableConfigId: cfg.id, status: "draft" },
      select: { dayOfWeek: true, periodNumber: true, classSectionId: true, teacherId: true },
    });
    const busy = new Set(
      rows
        .filter((r) => r.classSectionId === sectionId || r.teacherId === teacherId)
        .map((r) => `${r.dayOfWeek}:${r.periodNumber}`),
    );
    for (let d = 1; d <= 5; d++) for (let p = 1; p <= 5; p++) {
      if (!busy.has(`${d}:${p}`)) return { day: d, period: p };
    }
    return null;
  };
  const freeA = await freeCell(secA.id, cellA?.teacherId);
  const freeB = await freeCell(secB.id, cellB?.teacherId);
  check(cellA && cellB && freeA && freeB, "a movable cell and a free cell in each section",
    `A ${cellA?.dayOfWeek}/${cellA?.periodNumber} → ${freeA?.day}/${freeA?.period}`);

  // Re-lock by hand, so the rest of the suite starts from the state a school is
  // actually in the day after publishing.
  await call("POST", `/timetable-configs/${cfg.id}/freeze`, S);

  // ═══════════════════════════════════ 3. A GRANT NEEDS A REASON, AND SCOPE
  console.log("\nOpening a grant:");
  const noReason = await call("POST", `/timetable-configs/${cfg.id}/unlocks`, S, {
    classSectionIds: [secA.id], teacherIds: [],
  });
  check(noReason.status === 400 && /why this is being unlocked/i.test(msg(noReason)),
    "a grant with no reason is refused — the record is the point", msg(noReason).slice(0, 60));

  const noEntities = await call("POST", `/timetable-configs/${cfg.id}/unlocks`, S, {
    reason: "nothing in particular", classSectionIds: [], teacherIds: [],
  });
  check(noEntities.status === 400 && /at least one/i.test(msg(noEntities)),
    "and a grant that names nothing is refused too", msg(noEntities).slice(0, 60));

  const priced = await call("GET", `/timetable-configs/${cfg.id}/unlocks/options`, S);
  const pricedA = priced.json?.classSections?.find((c) => c.id === secA.id);
  check(pricedA?.lessons > 0,
    "the options endpoint PRICES each entity before anybody ticks it (§21's rule)",
    `${pricedA?.label} opens ${pricedA?.lessons} lessons`);

  const grantA = await call("POST", `/timetable-configs/${cfg.id}/unlocks`, S, {
    reason: "Class 1-A morning has to be rebuilt before Monday",
    classSectionIds: [secA.id], teacherIds: [],
  });
  check(grantA.status < 300 && grantA.json?.id, "a grant on one class-section opens",
    `#${grantA.json?.id}, ${grantA.json?.opens} lessons`);

  // ══════════════ 4. THE ASSERTION PAIR — opened what it named, and no more
  //
  // Neither half means anything alone. A grant that opened the whole timetable
  // passes the first; a grant that opened nothing passes the second.
  console.log("\nThe grant opens exactly what it names:");
  const movedA = await moveOf(secA.id, cellA.dayOfWeek, cellA.periodNumber, cellA.subjectId, cellA.teacherId, freeA)();
  check(movedA.status < 300, "the unlocked class-section's lesson moves", msg(movedA).slice(0, 70));

  const movedB = await moveOf(secB.id, cellB.dayOfWeek, cellB.periodNumber, cellB.subjectId, cellB.teacherId, freeB)();
  check(lockRefusal(movedB), "the IDENTICAL call for the locked one is refused", msg(movedB).slice(0, 80));
  check(namesShut(movedB, "Class 1-B"),
    "and the refusal NAMES it, rather than saying the timetable is locked",
    msg(movedB).slice(0, 90));

  // ═════════════════════ 5. A NARROW PERMISSION NEVER BECOMES A WIDE ONE
  //
  // The assertion the whole design rests on. Every one of these is classified
  // `whole`, and a grant — any grant, however many entities — must not reach
  // them. If `generate` ever quietly became scopeable, this is what says so.
  console.log("\nWhole-timetable writes stay refused WHILE the grant is live:");
  const WHOLE = [
    ["generate", () => call("POST", `/timetable-configs/${cfg.id}/generate`, S, {})],
    ["the week's structure", () => call("PUT", `/timetable-configs/${cfg.id}/structure`, S, {
      startTime: "09:00", periodsPerDay: 4, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
    })],
    ["daily activities", () => call("PUT", `/timetable-configs/${cfg.id}/activities`, S, { activities: [] })],
    ["which classes the wing covers", () => call("PUT", `/timetable-configs/${cfg.id}/class-sections`, S, { classSectionIds: [] })],
    ["allocation reset", () => call("POST", `/timetable-configs/${cfg.id}/allocation-reset`, S)],
    ["publish", () => call("POST", `/timetable-configs/${cfg.id}/board/publish`, S, {})],
    ["withdraw", () => call("POST", `/timetable-configs/${cfg.id}/board/publish/unpublish`, S)],
    ["draft: create", () => call("POST", `/timetable-configs/${cfg.id}/drafts`, S, { label: "ZZLCK D" })],
    ["draft from published", () => call("POST", `/timetable-configs/${cfg.id}/board/draft-from-published`, S)],
    ["delete the timetable", () => call("DELETE", `/timetable-configs/${cfg.id}`, S)],
    /*
      The guided setup is asserted in section 12 instead, with a real draft.

      §29.8 moved its guard out of the controller and into the service, where
      `answers.wings` names the timetables the commit is building. That put it
      AFTER the "is there anything saved?" check — so with no draft the honest
      answer is now "there is nothing saved to commit", not a lock refusal.
      Asserting it here would be asserting the order of two messages about a
      request that writes nothing either way.
    */
  ];
  for (const [label, run] of WHOLE) {
    const r = await run();
    check(lockRefusal(r), label, msg(r).slice(0, 62));
  }

  // Withdrawal gets its own sentence, because auto-lock creates a trap the
  // generic wording would walk somebody into: unlocking a class does not help.
  const withdrew = await call("POST", `/timetable-configs/${cfg.id}/board/publish/unpublish`, S);
  check(/whole timetable first/.test(msg(withdrew)),
    "and withdrawal says so in its own words — unlocking a class cannot reach it",
    msg(withdrew).slice(0, 95));

  // ════════════════════════════════════════ 6. THE AUDIT IS WRITTEN
  console.log("\nWhat the grant was used for is recorded, not just what it permitted:");
  const events = await call("GET", `/timetable-configs/${cfg.id}/unlocks/${grantA.json.id}/events`, S);
  check((events.json?.events?.length ?? 0) > 0, "the board move landed in the audit",
    events.json?.events?.[0]?.summary ?? "none");
  check(/moved/.test(events.json?.events?.[0]?.summary ?? ""),
    "in words, naming the class and both cells", (events.json?.events?.[0]?.summary ?? "").slice(0, 80));
  check(events.json?.events?.[0]?.alsoAffected != null,
    "with the teacher it dragged along recorded as also-affected",
    JSON.stringify(events.json?.events?.[0]?.alsoAffected ?? null).slice(0, 60));

  // ═══════════════════════════ 7. CLOSING THE GRANT RELOCKS WHAT IT OPENED
  console.log("\nClosing the grant relocks:");
  const closed = await call("POST", `/timetable-configs/${cfg.id}/unlocks/${grantA.json.id}/close`, S);
  check(closed.status < 300 && closed.json?.closedAt, "it closes", `${closed.status}`);
  const closedAgain = await call("POST", `/timetable-configs/${cfg.id}/unlocks/${grantA.json.id}/close`, S);
  check(closedAgain.json?.alreadyClosed === true,
    "asking twice is the same answer, never an error", `${closedAgain.status}`);

  const afterClose = await moveOf(secA.id, freeA.day, freeA.period, cellA.subjectId, cellA.teacherId,
    { day: cellA.dayOfWeek, period: cellA.periodNumber })();
  check(lockRefusal(afterClose), "and the class it opened refuses again", msg(afterClose).slice(0, 70));

  const kept = await call("GET", `/timetable-configs/${cfg.id}/unlocks`, S);
  const rec = kept.json?.unlocks?.find((u) => u.id === grantA.json.id);
  check(rec?.state === "closed" && rec?.writes > 0,
    "the closed grant is KEPT with its record (§3.14's rule), never deleted",
    `${rec?.writes} write(s) under “${(rec?.reason ?? "").slice(0, 34)}…”`);

  // ══════════════════ 8. THE HEADLINE CASE — a teacher, across locked classes
  //
  // What §29.8 exists for. Ajay teaches both sections; neither is unlocked, and
  // requiring them would mean unlocking every class a real teacher covers.
  console.log("\nA teacher grant reaches into classes nobody unlocked:");
  const change = await call("POST", `/timetable-configs/${cfg.id}/staffing-changes`, S, {
    reason: "resigned",
    releasing: [ajay.id],
    receiving: [prakriti.id],
    effectiveFrom: "2026-10-01",
  });
  check(change.status < 300, "a staffing change opens", `#${change.json?.id ?? msg(change).slice(0, 50)}`);

  const planned = await call(
    "GET", `/staffing-changes/${change.json.id}/plan?mode=replace&toTeacherId=${prakriti.id}`, S);
  check(planned.status < 300, "the PLAN still reads while locked — a preview writes nothing",
    `${planned.json?.plan?.assignments?.length ?? 0} unit(s)`);

  const appliedLocked = await call("POST", `/staffing-changes/${change.json.id}/apply`, S, {
    mode: "replace", toTeacherId: prakriti.id, acceptGaps: true,
  });
  check(lockRefusal(appliedLocked), "but applying it is refused while Ajay is locked",
    msg(appliedLocked).slice(0, 80));

  const grantT = await call("POST", `/timetable-configs/${cfg.id}/unlocks`, S, {
    reason: "Ajay Verma has resigned; his load moves to Prakriti",
    classSectionIds: [], teacherIds: [ajay.id],
  });
  check(grantT.status < 300, "a grant naming only the teacher opens",
    `#${grantT.json?.id}, ${grantT.json?.opens} lessons`);

  const applied = await call("POST", `/staffing-changes/${change.json.id}/apply`, S, {
    mode: "replace", toTeacherId: prakriti.id, acceptGaps: true,
  });
  check(applied.status < 300, "and now the whole load moves",
    `${applied.json?.slots ?? 0} lesson(s), ${applied.json?.moved ?? 0} unit(s)`);

  const stillAjay = await prisma.timetableSlot.count({
    where: { timetableConfigId: cfg.id, teacherId: ajay.id, status: "published" },
  });
  const nowPrakriti = await prisma.timetableSlot.count({
    where: { timetableConfigId: cfg.id, teacherId: prakriti.id, status: "published" },
  });
  check(stillAjay === 0 && nowPrakriti > 0,
    "every published lesson changed hands", `Ajay ${stillAjay}, Prakriti ${nowPrakriti}`);

  const sectionsStillLocked = await call("PUT", `/class-sections/${secA.id}`, S, { strength: 41 });
  check(lockRefusal(sectionsStillLocked),
    "while BOTH class-sections stayed locked throughout — the grant named neither",
    msg(sectionsStillLocked).slice(0, 70));

  const nishaUntouched = await prisma.timetableSlot.count({
    where: { timetableConfigId: cfg.id, teacherId: nisha.id, status: "published" },
  });
  check(nishaUntouched > 0, "and the teacher nobody unlocked kept every lesson",
    `${nishaUntouched} lesson(s)`);

  // ══════════════════════════ 9. §29.8b — MASTERS IN A LIVE WEEK
  //
  // The arc, not just the refusal: Nisha is refused because of her LESSONS, and
  // Ajay — whose lessons have just moved — is deleted with no grant at all.
  console.log("\nA master used by a live week cannot be deleted:");
  const delNisha = await call("DELETE", `/teachers/${nisha.id}`, S);
  check(delNisha.status === 400 && /published lesson/.test(msg(delNisha)),
    "the teacher who still teaches is refused, and counted", msg(delNisha).slice(0, 88));

  const delSubject = await call("DELETE", `/subjects/${maths.id}`, S);
  check(delSubject.status === 400 && /published lesson/.test(msg(delSubject)),
    "so is a subject the published week teaches", msg(delSubject).slice(0, 70));

  const delRoom = await call("DELETE", `/rooms/${roomA.id}`, S);
  check(delRoom.status === 400 && /published lesson/.test(msg(delRoom)),
    "and a room it puts classes in", msg(delRoom).slice(0, 70));

  const delAjay = await call("DELETE", `/teachers/${ajay.id}`, S);
  check(delAjay.status < 300,
    "but the teacher whose lessons just moved deletes — with no unlock at all",
    `${delAjay.status}: the guard is about the rows, never about authority`);

  // ════════════════════════════ 10. A FULL UNLOCK SUPERSEDES THE NARROW ONES
  //
  // A grant left open across a thaw would say nothing while the timetable was
  // open and start admitting writes again the moment somebody re-locked —
  // silently, with nobody deciding it should.
  console.log("\nUnfreezing the whole timetable closes every live grant:");
  const thaw = await call("POST", `/timetable-configs/${cfg.id}/unfreeze`, S);
  check((thaw.json?.grantsClosed ?? 0) > 0, "the live grant is closed by the wide unlock",
    `${thaw.json?.grantsClosed} closed`);
  const live = await prisma.timetableUnlock.count({
    where: { timetableConfigId: cfg.id, closedAt: null },
  });
  check(live === 0, "nothing is left that could reactivate on the next lock", `${live} live`);

  const relocked = await call("POST", `/timetable-configs/${cfg.id}/freeze`, S);
  check(relocked.status < 300, "re-locking works", `${relocked.status}`);
  const afterRelock = await moveOf(secA.id, freeA.day, freeA.period, cellA.subjectId, prakriti.id,
    { day: cellA.dayOfWeek, period: cellA.periodNumber })();
  check(lockRefusal(afterRelock),
    "and the class the old grant had opened is refused again", msg(afterRelock).slice(0, 70));

  // ═══════════════════════════════════════ 11. §17.8 — ANOTHER SCHOOL'S ID
  console.log("\nAnd a stranger's timetable is a 404, never an empty list:");
  const other = await prisma.timetableConfig.findFirst({
    where: { schoolId: { not: made.json.schoolId } }, select: { id: true },
  });
  if (other) {
    const peek = await call("GET", `/timetable-configs/${other.id}/unlocks`, S);
    check(peek.status === 404, "reading another school's grants is refused", `${peek.status}`);
    const grab = await call("POST", `/timetable-configs/${other.id}/unlocks`, S, {
      reason: "trying it on", classSectionIds: [], teacherIds: [ajay.id],
    });
    check(grab.status === 404, "and so is opening one on it", `${grab.status}`);
  } else {
    info("no other school in this database to compare against — run test:isolation for the real sweep");
  }

  // ══════════ 12. A LOCK BELONGS TO ONE TIMETABLE, NOT TO THE SCHOOL
  //
  // Reported directly: *"the freezing will happen only for that particular
  // timetable which is being published; this rule is not applicable to other
  // timetables."*
  //
  // §29.1 guarded the guided setup bluntly — refuse while ANY wing in the
  // school is frozen — which was tolerable while freezing was a rare deliberate
  // press and became the normal state the moment publishing did it. A school
  // with one timetable published could no longer run the wizard for another.
  console.log("\nA locked timetable does not block the guided setup for a different one:");
  await call("POST", `/timetable-configs/${cfg.id}/freeze`, S);

  const solo = await call("POST", "/timetable-configs", S, {
    name: "ZZLCK Solo", academicYearId: year.id, mode: "individual",
  });
  check(solo.status < 300, "a second timetable exists, in its own §30 pool", `${solo.status}`);

  /*
    A draft naming both. The guided setup commits from the STORED draft, so this
    is what the server will actually read — asserting against anything else
    would be asserting about a request rather than about the product.
  */
  await call("PUT", "/onboarding/session", S, {
    mode: "wizard",
    answers: {
      session: { name: "ZZLCK 2026-27" },
      wings: [
        { name: "ZZLCK Wing", fromIndex: 5, toIndex: 5, sections: 2 },
        { name: "ZZLCK Solo", fromIndex: 5, toIndex: 5, sections: 1, individual: true },
      ],
      subjects: [{ name: "ZZLCK Drama" }],
    },
  });

  // §30.9 — a grouped wing's pool is the literal string "grouped"; only an
  // individual one is named. Using `individual:zzlck wing` here matched nothing
  // and got "that timetable is not part of this setup any more", which is a
  // real refusal for a different reason — and would have passed a looser check.
  const lockedWing = await call("POST", "/onboarding/commit/6?scope=grouped", S);
  const soloWing = await call("POST", "/onboarding/commit/6?scope=" + encodeURIComponent("individual:zzlck solo"), S);
  /*
    The pair is the assertion, not either half. A guard that refused both would
    pass the first line; one that refused neither would pass the second.
  */
  check(lockedWing.status === 400 && /is locked/.test(msg(lockedWing)),
    "the LOCKED timetable's own step is still refused", msg(lockedWing).slice(0, 72));
  check(!/is locked/.test(msg(soloWing)),
    "and the OTHER timetable's step is not — the lock belongs to one timetable",
    msg(soloWing).slice(0, 72));

  /*
    Steps 1–3 stay open even for the locked one: the school, the session and the
    wings themselves cannot change a published week, and `commitWings` skips an
    existing wing by name. Guarding them would refuse exactly the case this
    narrowing exists to allow — adding a second wing to a published school.
  */
  const wingsStep = await call("POST", "/onboarding/commit/3", S);
  check(!/is locked/.test(msg(wingsStep)),
    "and step 3 is open, so a published school can still add a wing",
    msg(wingsStep).slice(0, 72));

  console.log("\nCleanup:");
  await purge();
  check(true, "test school removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
  console.log(failed ? "\nSOME LOCK CHECKS FAILED" : "\nALL LOCK CHECKS PASSED");
  process.exit(failed);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
