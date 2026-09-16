/**
 * §36 — a lesson pinned to a cell, and the generation that has to honour it.
 *
 * ## What it is
 *
 * A school says *"Class 1-A does Mathematics with Puja Sri on Monday period 2"*
 * before anything is generated, and the solver must place it exactly there and
 * build the rest of the week around it.
 *
 * ## What this proves, and why each one is here
 *
 * The mechanism is **domain pruning**, not a pre-written row: the variable for
 * that occurrence is handed exactly one legal cell and the solver still places
 * it. That is what keeps the room assignment, the occupancy keys and the §20
 * shape rules working — and it is also what makes the failure mode silent if
 * anything is wrong, because a pin that matches no variable simply vanishes.
 * Nearly every assertion below exists to make a silent vanish impossible.
 *
 *  1. A pin is stored, and comes back with what the screen needs to paint it.
 *  2. A **real generation** puts that lesson in that cell — and nowhere else.
 *  3. The rest of the week still generates, with nothing unplaced.
 *  4. Regenerating keeps it: a pin is the timetable's standing intention, not
 *     one draft's placement (§22 — this is the whole reason it is its own
 *     table rather than `is_locked`).
 *  5. A named ROOM binds, rather than being a preference.
 *  6. Every save-time refusal fires BY NAME.
 *  7. The lesson plan is LOCKED while pinned — the school's own rule.
 *  8. Check 14 BLOCKS when a pin cannot be honoured, so Readiness refuses the
 *     generation rather than letting it fail.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzfx.test";
const PW = "correct horse battery staple";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const PURGE = ["onboardingSession", "timetableFixedLesson", "timetableSlot", "timetableDraft",
  "timetablePublication", "teacherSubjectClassSection", "teacherClassEligibility", "teacherSubject",
  "subjectClass", "roomSubject", "timetableSubject", "timetableClassSpan", "timetableDayShape",
  "period", "classSubject", "classSection", "section", "subject", "schoolClass", "teacher", "room",
  "timetableConfig", "timetableGroup", "academicYear", "notification", "auditLog", "user",
  "rolePermission", "erpRoleMapping", "role"];

/** Build the school through the guided setup's own endpoints. */
const SUBJECTS = ["Mathematics", "English", "Hindi", "Science"];

async function main() {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZFX" } }, select: { id: true, code: true },
    });
    const ids = mine.map((s) => s.id);
    for (const m of PURGE) {
      if (ids.length) await prisma[m].deleteMany({ where: { schoolId: { in: ids } } }).catch(() => undefined);
    }
    if (ids.length) await prisma.school.deleteMany({ where: { id: { in: ids } } });
    await control.tenant.deleteMany({ where: { schoolCode: { in: mine.map((s) => s.code) } } });
    await control.account.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  };
  await purge();

  // ─────────────── A SCHOOL, BUILT THROUGH THE ORDINARY DOORS
  console.log("\nA small school with a full week:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZFX Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZFX School" });
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;
  const save = (step, answers) => call("PUT", "/onboarding/session", S, { currentStep: step, answers, mode: "wizard" });

  await save(3, {
    school: { name: "ZZFX School" },
    session: { name: "ZZFX 2026-27", startDate: "2026-04-01", endDate: "2027-03-31" },
  });
  await call("POST", "/onboarding/commit/2", S);
  const yearId = (await call("GET", "/academic-years", S)).json[0].id;
  await call("POST", "/timetable-configs", S, { name: "Main", academicYearId: yearId });
  const cfg = (await call("GET", "/timetable-configs", S)).json[0];
  /*
    `CLASS_LADDER` is 0-indexed and index 4 is "Class 1" — 5 would be Class 2.
    Named here because the first run of this file used 5..6, got Class 2 and
    Class 3, and then failed looking for "Class 1-A" three assertions later.
  */
  await save(5, { wings: [{ name: "Main", fromIndex: 4, toIndex: 5, sections: 2 }] });
  await call("POST", "/onboarding/commit/4", S);
  await call("PUT", `/timetable-configs/${cfg.id}/structure`, S, {
    periodsPerDay: 6, periodDurationMins: 40, startTime: "08:00", workingDays: [1, 2, 3, 4, 5], breaks: [],
  });
  await save(7, { subjects: SUBJECTS.map((name) => ({ name })) });
  await call("POST", "/onboarding/commit/6", S);

  const subjects = (await call("GET", "/subjects", S)).json;
  const classes = (await call("GET", "/classes", S)).json;
  const sections = (await call("GET", "/class-sections", S)).json;
  const maths = subjects.find((s) => s.name === "Mathematics");
  const c1 = classes.find((c) => c.name === "Class 1");
  const s1a = sections.find((x) => x.label === "Class 1-A");
  check(!!maths && !!c1 && !!s1a, "subjects, classes and sections exist",
    `${subjects.length} subjects · ${sections.length} sections`);

  // A curriculum that fits: 6 periods/day × 5 days = 30 a week per section.
  for (const cl of classes) {
    for (const sub of subjects) {
      await call("POST", "/class-subjects", S, {
        classId: cl.id, subjectId: sub.id, academicYearId: yearId, periodsPerWeek: 5,
      });
    }
  }
  // Two teachers, each taking two subjects across both classes.
  const teachers = [];
  for (let i = 0; i < 4; i++) {
    teachers.push((await call("POST", "/teachers", S, {
      name: `ZZFX Teacher ${i + 1}`, employeeCode: `ZZFX-${i + 1}`, maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6,
    })).json);
  }
  for (const [i, sub] of subjects.entries()) {
    for (const sec of sections) {
      await call("POST", "/mappings", S, {
        teacherId: teachers[i % teachers.length].id, subjectId: sub.id,
        classSectionId: sec.id, periodsPerWeek: 5,
      });
    }
  }
  const mathTeacher = teachers[subjects.findIndex((s) => s.name === "Mathematics") % teachers.length];
  /*
    Rooms, and a HOME room for each section.

    Without them `homeRoomId` is null and every lesson is placed with
    `room_id = null` — which is correct for a school that has entered no rooms,
    and would have made the "the solver gave it a room" assertion below pass or
    fail for a reason that has nothing to do with pinning.
  */
  for (const sec of sections) {
    const r = (await call("POST", "/rooms", S, { name: `${sec.label} room`, roomType: "classroom" })).json;
    await call("PUT", `/class-sections/${sec.id}`, S, { homeRoomId: r.id });
  }
  const rooms = (await call("GET", "/rooms", S)).json;
  check(rooms.length === sections.length, "curriculum, staffing and rooms in place",
    `${subjects.length * classes.length} curriculum rows · ${teachers.length} teachers · ${rooms.length} rooms`);

  // ─────────────── 1. A PIN IS STORED
  console.log("\nPinning Class 1-A Mathematics to Monday period 2:");
  const pin = {
    classSectionId: s1a.id, subjectId: maths.id, teacherId: mathTeacher.id,
    roomId: null, dayOfWeek: 1, periodNumber: 2,
  };
  const saved = await call("PUT", `/timetable-configs/${cfg.id}/fixed-lessons`, S, { lessons: [pin] });
  check(saved.status < 300 && saved.json?.count === 1, "it saves", `${saved.status} ${saved.text.slice(0, 80)}`);

  const read = await call("GET", `/timetable-configs/${cfg.id}/fixed-lessons`, S);
  const got = (read.json?.lessons ?? [])[0];
  check(got?.classSection === "Class 1-A" && got?.subject === "Mathematics" && got?.dayOfWeek === 1,
    "and comes back with what the grid needs to paint it",
    `${got?.classSection} ${got?.subject} ${got?.teacher} d${got?.dayOfWeek}P${got?.periodNumber}`);
  const cap = (read.json?.caps ?? []).find((c) => c.classId === c1.id && c.subjectId === maths.id);
  check(cap?.periodsPerWeek === 5, "with the curriculum cap the toolbar counts against", `${cap?.periodsPerWeek}`);

  /*
    §36 — the pickers are told what is legal, they do not work it out.

    The Whole tab's Subject and Teacher lists ARE `options`, already filtered by
    the server: only real mappings, no elective-owned subject, no §4.8
    double-period row, no guest. Asserted because a picker that can offer what
    the save refuses is a picker that teaches people to distrust the screen —
    and because it is the one part of this feature a typecheck cannot see.
  */
  const opts = (read.json?.options ?? []).filter((o) => o.classSectionId === s1a.id);
  check(opts.length === SUBJECTS.length,
    "and the options a picker may offer — one per mapped subject",
    `${opts.length} of ${SUBJECTS.length}`);
  const mathOpt = opts.find((o) => o.subjectId === maths.id);
  check(mathOpt?.teacherId === mathTeacher.id && !!mathOpt?.subject,
    "each naming its subject and the teacher who takes it",
    `${mathOpt?.subject} → ${mathOpt?.teacher}`);
  check((read.json?.rooms ?? []).length === sections.length,
    "with the rooms the third picker offers", `${(read.json?.rooms ?? []).length} rooms`);

  // ─────────────── 2 & 3. A REAL GENERATION HONOURS IT
  console.log("\nGenerating:");
  const generate = async () => {
    const started = await call("POST", `/timetable-configs/${cfg.id}/generate`, S, {});
    if (started.status >= 300) return { state: "refused", status: started.status, body: started.json };
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      const r = await call("GET", `/timetable-configs/${cfg.id}/generate/latest`, S);
      if (r.json?.state === "completed" || r.json?.state === "failed") return r.json;
    }
    return { state: "timed out" };
  };
  const run1 = await generate();
  check(run1.state === "completed", "the generation completes", run1.state);
  check((run1.result?.unplaced?.length ?? -1) === 0,
    "with NOTHING unplaced — the pin did not cost the rest of the week",
    `${run1.result?.unplaced?.length} unplaced`);

  /*
    Read from the DATABASE, not from the solver's summary.

    The summary is the engine's own account of what it did; the question here is
    what a school would see on the wall. And it is asked twice — "is it in the
    cell?" and "is it ONLY in that cell?" — because a pin that was ignored would
    still put five Mathematics lessons somewhere, and one of them could land on
    Monday P2 by luck.
  */
  /*
    Scoped to the CURRENT draft (§22).

    `status: "draft"` alone spans every draft the config has ever had, and each
    Generate fills a new one — so a second run counts the same lesson twice and
    "the pin survives" passes for the wrong reason, or fails for one. The first
    version of this file did exactly that and reported 2 lessons at Monday P2.
  */
  const currentDraft = async () => (await prisma.timetableDraft.findFirst({
    where: { timetableConfigId: cfg.id }, orderBy: { id: "desc" }, select: { id: true },
  }))?.id ?? null;
  const placed = await prisma.timetableSlot.findMany({
    where: {
      timetableConfigId: cfg.id, classSectionId: s1a.id, subjectId: maths.id,
      status: "draft", draftId: await currentDraft(),
    },
    select: { dayOfWeek: true, periodNumber: true, teacherId: true, roomId: true },
    orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
  });
  const atPin = placed.filter((p) => p.dayOfWeek === 1 && p.periodNumber === 2);
  check(atPin.length === 1, "Class 1-A Mathematics IS on Monday period 2",
    placed.map((p) => `d${p.dayOfWeek}P${p.periodNumber}`).join(" ") || "nothing placed");
  check(atPin[0]?.teacherId === mathTeacher.id, "taught by the teacher who was pinned", `${atPin[0]?.teacherId}`);
  /*
    §19 — a pinned lesson is PLACED, not inserted, so the solver gave it a room
    like any other. This is the assertion that would fail if fixed lessons had
    been written as rows behind the engine's back.
  */
  check(atPin[0]?.roomId !== null && atPin[0]?.roomId !== undefined,
    "and the solver gave it a room, as it does for every other lesson", `room ${atPin[0]?.roomId}`);

  // ─────────────── 4. AND A REGENERATION KEEPS IT
  console.log("\nGenerating again:");
  const run2 = await generate();
  check(run2.state === "completed", "the second run completes", run2.state);
  const again = await prisma.timetableSlot.count({
    where: {
      timetableConfigId: cfg.id, classSectionId: s1a.id, subjectId: maths.id,
      status: "draft", draftId: await currentDraft(), dayOfWeek: 1, periodNumber: 2,
    },
  });
  check(again === 1,
    "the pin survives — it is the timetable's intention, not one draft's placement (§22)",
    `${again} lesson(s) at Monday P2`);

  // ─────────────── 5. A NAMED ROOM BINDS
  console.log("\nNaming a room:");
  const room = rooms[0];
  if (room) {
    await call("PUT", `/timetable-configs/${cfg.id}/fixed-lessons`, S, {
      lessons: [{ ...pin, roomId: room.id }],
    });
    const run3 = await generate();
    check(run3.state === "completed", "it still generates", run3.state);
    const inRoom = await prisma.timetableSlot.findFirst({
      where: {
        timetableConfigId: cfg.id, classSectionId: s1a.id, subjectId: maths.id,
        status: "draft", draftId: await currentDraft(), dayOfWeek: 1, periodNumber: 2,
      },
      select: { roomId: true },
    });
    check(inRoom?.roomId === room.id,
      "and the lesson is in the room that was named — binding, not a preference",
      `wanted ${room.id} (${room.name}), got ${inRoom?.roomId}`);
    await call("PUT", `/timetable-configs/${cfg.id}/fixed-lessons`, S, { lessons: [pin] });
  } else {
    check(false, "a room exists to pin to", "no rooms — cannot test the room binding");
  }

  // ─────────────── 6. THE REFUSALS, EACH BY NAME
  console.log("\nWhat it refuses, and whether it says why:");
  const refuse = async (lessons, what) => {
    const r = await call("PUT", `/timetable-configs/${cfg.id}/fixed-lessons`, S, { lessons });
    return { ok: r.status >= 400, msg: (r.json?.message ?? r.text ?? "").slice(0, 92), status: r.status };
  };

  const r1 = await refuse([pin, { ...pin, dayOfWeek: 2, periodNumber: 1 },
    { ...pin, dayOfWeek: 2, periodNumber: 2 }, { ...pin, dayOfWeek: 3, periodNumber: 1 },
    { ...pin, dayOfWeek: 3, periodNumber: 2 }, { ...pin, dayOfWeek: 4, periodNumber: 1 }],
    "over the curriculum");
  check(r1.ok && /only 5 can be fixed|taught 5/.test(r1.msg),
    "six pins against five periods a week", r1.msg);

  const r2 = await refuse([{ ...pin, periodNumber: 99 }]);
  check(r2.ok && /does not exist/.test(r2.msg), "a period the day does not have", r2.msg);

  const r3 = await refuse([{ ...pin, dayOfWeek: 6 }]);
  check(r3.ok && /does not work on/.test(r3.msg), "a day the school does not work", r3.msg);

  const otherTeacher = teachers.find((t) => t.id !== mathTeacher.id);
  const r4 = await refuse([{ ...pin, teacherId: otherTeacher.id }]);
  check(r4.ok && /does not teach/.test(r4.msg),
    "a teacher with no mapping — the pin would have matched no variable and vanished", r4.msg);

  const s1b = sections.find((x) => x.label === "Class 1-B");
  const r5 = await refuse([pin, { ...pin, classSectionId: s1b.id }]);
  check(r5.ok && /at the same time/.test(r5.msg),
    "one teacher, two sections, one cell", r5.msg);

  /*
    A refusal must leave the school EXACTLY what it had. The write is a
    replace, so a validation that ran after the delete would empty the table on
    every rejected save — which is why the check runs first and why this is
    asserted rather than assumed.
  */
  const survived = await prisma.timetableFixedLesson.count({ where: { timetableConfigId: cfg.id } });
  check(survived === 1, "and a refused save leaves the existing pins untouched", `${survived} still stored`);

  // ─────────────── 7. THE LESSON PLAN LOCKS
  console.log("\nThe lesson plan, while that lesson is pinned:");
  const row = await prisma.classSubject.findFirst({
    where: { schoolId, classId: c1.id, subjectId: maths.id, academicYearId: yearId },
    select: { id: true },
  });
  const edit = await call("PUT", `/class-subjects/${row.id}`, S, { periodsPerWeek: 3 });
  check(edit.status >= 400 && /fixed to a day and period/.test(edit.json?.message ?? ""),
    "cannot be changed — it names the pins and where to remove them",
    `${edit.status} ${(edit.json?.message ?? "").slice(0, 88)}`);
  const del = await call("DELETE", `/class-subjects/${row.id}`, S);
  check(del.status >= 400, "and cannot be deleted either", `${del.status}`);
  const still = await prisma.classSubject.findUnique({ where: { id: row.id } });
  check(still?.periodsPerWeek === 5, "the row is exactly as it was", `${still?.periodsPerWeek} periods`);

  // …and unpinning releases it, or the lock would be a trap.
  await call("PUT", `/timetable-configs/${cfg.id}/fixed-lessons`, S, { lessons: [] });
  const freed = await call("PUT", `/class-subjects/${row.id}`, S, { periodsPerWeek: 4 });
  check(freed.status < 300, "removing the pin releases the lesson plan again", `${freed.status}`);
  await call("PUT", `/class-subjects/${row.id}`, S, { periodsPerWeek: 5 });

  // ─────────────── 8. CHECK 14 BLOCKS
  console.log("\nWhen a pin cannot be honoured, Readiness refuses:");
  await call("PUT", `/timetable-configs/${cfg.id}/fixed-lessons`, S, { lessons: [pin] });
  /*
    Broken BEHIND the save, which is the only way to reach Check 14: everything
    it reports is either an aggregate or a drift, and the drift is the point —
    a pin is stored once and the school goes on changing around it. Re-staffing
    the lesson is the case a school would actually hit, and the one where the
    pin would otherwise vanish in silence.
  */
  await prisma.teacherSubjectClassSection.updateMany({
    where: { classSectionId: s1a.id, subjectId: maths.id },
    data: { teacherId: otherTeacher.id },
  });
  const readiness = await call("GET", `/timetable-configs/${cfg.id}/readiness`, S);
  // `FeasibilityResult` is { score, ready, blockers, warnings } — there is no
  // `issues`, and reading one gave an empty list that looked like a silent check.
  const issues = [...(readiness.json?.blockers ?? []), ...(readiness.json?.warnings ?? [])];
  const orphan = issues.find((i) => i.code === "FIXED_LESSON_ORPHANED");
  check(!!orphan, "Check 14 reports the pin whose lesson has moved",
    orphan ? orphan.message.slice(0, 92) : `codes: ${issues.map((i) => i.code).join(", ").slice(0, 80)}`);
  check(orphan?.severity === "blocker", "as a BLOCKER — the generation does not run", orphan?.severity);
  const refused = await call("POST", `/timetable-configs/${cfg.id}/generate`, S, {});
  check(refused.status >= 400, "and Generate is refused", `${refused.status} ${(refused.json?.message ?? "").slice(0, 70)}`);

  await call("PUT", `/timetable-configs/${cfg.id}/fixed-lessons`, S, { lessons: [] });
  const clear = await call("GET", `/timetable-configs/${cfg.id}/readiness`, S);
  const left = [...(clear.json?.blockers ?? []), ...(clear.json?.warnings ?? [])];
  check(!left.some((i) => String(i.code).startsWith("FIXED_LESSON")),
    "removing it clears the block — the refusal is not permanent",
    `${clear.json?.blockers?.length ?? 0} blocker(s) left`);

  console.log("\nCleanup:");
  await purge();
  check(true, "test school removed");

  await prisma.$disconnect();
  await control.$disconnect();
  console.log(failed ? "\nSOME FIXED-LESSON CHECKS FAILED" : "\nALL FIXED-LESSON CHECKS PASSED");
  process.exit(failed);
}

main().catch((e) => { console.error(e); process.exit(1); });
