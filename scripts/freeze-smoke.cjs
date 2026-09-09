/**
 * §29.1 — a frozen timetable, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/freeze-smoke.cjs
 *
 * `FreezeService` is one definition of the rule called at every write path, and
 * the cost of that shape — as opposed to §17's Prisma extension, which no call
 * site can forget — is that a NEW write path can simply not ask. THIS FILE IS
 * WHAT MAKES THAT SAFE. It drives every allocation-writing route against a
 * frozen timetable and requires each one to refuse, so a route added without
 * the guard fails the build rather than being found by a school whose published
 * week quietly stopped matching the copy on the wall.
 *
 * Three things it therefore has to assert, and the third is the one that is
 * easy to leave out:
 *
 *   1. every guarded route refuses while frozen, and says why;
 *   2. every one of them WORKS again after unfreezing — a guard that refuses
 *      permanently would pass test 1 and have broken the product;
 *   3. reading is untouched, and so is anything that cannot contradict the
 *      published week (adding a teacher, a room, next year's session).
 *
 * Everything it creates uses @zzfrz.test / "ZZFRZ " and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzfrz.test";
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

/** A refusal that came from the freeze, not from something else going wrong. */
const frozenRefusal = (r) =>
  r.status === 400 && /is frozen, so /.test(r.json?.message ?? "");

async function main() {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZFRZ " } }, select: { id: true, code: true },
    });
    const ids = mine.map((s) => s.id);
    /*
      Every model that carries `school_id`, in dependency order.

      Longer than the guided suite's list on purpose: section 5 below RE-RUNS
      every refused route after the thaw, so by the end this school really does
      have an elective block, a merged group, a second draft and a pinned cell.
      A purge written for what the setup creates would leave those behind and
      the school would refuse to delete on a foreign key.
    */
    for (const m of [
      "onboardingSession", "timetableSlot", "substitutionLog", "teacherAbsence",
      "timetableDraft", "timetablePublication", "extraClass",
      "electiveOption", "electiveBlockMember", "electiveBlock",
      "mergedTeachingGroupMember", "mergedTeachingGroup",
      "teacherSubjectClassSection", "teacherClassEligibility", "teacherSubject",
      "subjectClass", "roomSubject",
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
    const keys = await redis.keys("throttle:*:ip:*");
    if (keys.length) await redis.del(...keys);
  };
  await purge();

  // ───────────────────────────────────────── 1. A SMALL PUBLISHED SCHOOL
  //
  // Deliberately tiny. This suite is about refusals, not about generation —
  // `guided-setup-smoke.cjs` already proves a school can be built and solved,
  // and repeating it here would make a fast test slow for no extra coverage.
  console.log("\nA school with one published timetable:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZFRZ Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZFRZ School" });
  check(made.status < 300, "school created", `school ${made.json?.schoolId}`);
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;

  const year = (await call("POST", "/academic-years", S, {
    name: "ZZFRZ 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  })).json;
  const cfg = (await call("POST", "/timetable-configs", S, {
    name: "ZZFRZ Wing", academicYearId: year.id,
  })).json;
  await call("PUT", `/timetable-configs/${cfg.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 4, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
  });

  const klass = (await call("POST", "/classes", S, { name: "Class 1", sequence: 5 })).json;
  const added = await call("POST", `/classes/${klass.id}/sections`, S, {
    name: "A", academicYearId: year.id,
  });
  const section = added.json.classSection;
  check(section?.id != null, "a class-section exists", `${added.status}`);
  // Attaching it to the wing is its own act (§3.10) — and one of the routes
  // section 3 below expects to be refused once the week is frozen.
  await call("PUT", `/timetable-configs/${cfg.id}/class-sections`, S, { classSectionIds: [section.id] });
  const subject = (await call("POST", "/subjects", S, { name: "ZZFRZ Maths" })).json;
  const other = (await call("POST", "/subjects", S, { name: "ZZFRZ Art" })).json;
  const teacher = (await call("POST", "/teachers", S, {
    name: "ZZFRZ Teacher", employeeCode: "ZZFRZ-T1", maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6,
  })).json;
  const room = (await call("POST", "/rooms", S, { name: "ZZFRZ Room 1", roomType: "classroom", capacity: 40 })).json;
  // A §4.9 block's options run at the SAME TIME, so they need distinct teachers
  // and distinct rooms. Built here rather than inside the refusal list, so the
  // list stays a list of routes.
  const teacher2 = (await call("POST", "/teachers", S, {
    name: "ZZFRZ Teacher 2", employeeCode: "ZZFRZ-T9", maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6,
  })).json;
  const room2 = (await call("POST", "/rooms", S, { name: "ZZFRZ Room 9", roomType: "classroom", capacity: 40 })).json;
  await call("PUT", `/class-sections/${section.id}`, S, { homeRoomId: room.id });

  const curriculum = (await call("POST", "/class-subjects", S, {
    classId: klass.id, academicYearId: year.id, subjectId: subject.id, periodsPerWeek: 4,
  })).json;
  // `POST /mappings` is a BULK create (one teacher, one subject, N sections),
  // so it answers with what it created and skipped rather than with one row.
  // The id the update/delete routes need is read back.
  await call("POST", "/mappings", S, {
    teacherId: teacher.id, subjectId: subject.id, classSectionIds: [section.id], periodsPerWeek: 4,
  });
  const mapping = (await call("GET", "/mappings", S)).json[0];
  check(mapping?.id != null, "the mapping is readable by id", `${mapping?.id}`);

  const gen = await call("POST", `/timetable-configs/${cfg.id}/generate`, S, {});
  check(gen.status < 300, "it generates", `${gen.status}`);
  let done = null;
  for (let i = 0; i < 60 && !done; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = await call("GET", `/timetable-configs/${cfg.id}/generate/latest`, S);
    if (r.json?.state === "completed" || r.json?.state === "failed") done = r.json;
  }
  check(done?.state === "completed", "generation completed", `${done?.state}`);
  const published = await call("POST", `/timetable-configs/${cfg.id}/board/publish`, S, {});
  check(published.status < 300, "and publishes", `${published.status}`);

  // ────────────────────────────────────────────────── 2. THE PRECONDITION
  console.log("\nFreezing is about the published week, and says so:");
  const bare = (await call("POST", "/timetable-configs", S, { name: "ZZFRZ Empty", academicYearId: year.id })).json;
  const noPub = await call("POST", `/timetable-configs/${bare.id}/freeze`, S);
  check(noPub.status === 400 && /nothing published/.test(noPub.json?.message ?? ""),
    "a timetable with nothing published cannot be frozen, and is told why",
    (noPub.json?.message ?? `${noPub.status}`).slice(0, 90));

  const frozen = await call("POST", `/timetable-configs/${cfg.id}/freeze`, S);
  check(frozen.status < 300 && frozen.json?.frozenAt, "the published one freezes", `v${frozen.json?.version}`);
  const again = await call("POST", `/timetable-configs/${cfg.id}/freeze`, S);
  check(again.json?.alreadyFrozen === true && again.json?.frozenAt === frozen.json?.frozenAt,
    "pressing it twice keeps the original timestamp rather than rewriting it",
    `${again.json?.frozenAt}`);

  // ─────────────────────────────────────── 3. EVERY WRITE PATH REFUSES
  //
  // The list is the point of this file. A route added to the app without the
  // guard shows up here as a missing PASS — which is why each entry names the
  // route rather than describing the behaviour.
  console.log("\nEvery route that could contradict the published week refuses:");

  const GUARDED = [
    ["curriculum: add", () => call("POST", "/class-subjects", S, {
      classId: klass.id, academicYearId: year.id, subjectId: other.id, periodsPerWeek: 2,
    })],
    ["curriculum: change", () => call("PUT", `/class-subjects/${curriculum.id}`, S, { periodsPerWeek: 3 })],
    ["curriculum: delete", () => call("DELETE", `/class-subjects/${curriculum.id}`, S)],
    ["mapping: add", () => call("POST", "/mappings", S, {
      teacherId: teacher.id, subjectId: other.id, classSectionIds: [section.id], periodsPerWeek: 2,
    })],
    ["mapping: change", () => call("PUT", `/mappings/${mapping.id}`, S, { periodsPerWeek: 3 })],
    ["mapping: delete", () => call("DELETE", `/mappings/${mapping.id}`, S)],
    ["merged group: add", () => call("POST", "/merged-groups", S, {
      teacherId: teacher.id, subjectId: other.id, periodsPerWeek: 1, classSectionIds: [section.id, section.id],
    })],
    // Two options, because a block with one is not a choice and the controller
    // says so — a fixture that trips a different validation would prove
    // nothing about the freeze.
    ["elective block: add", () => call("POST", "/elective-blocks", S, {
      name: "ZZFRZ Block", periodsPerWeek: 1, classSectionIds: [section.id],
      options: [
        { subjectId: other.id, teacherId: teacher.id, roomId: room.id },
        { subjectId: subject.id, teacherId: teacher2.id, roomId: room2.id },
      ],
    })],
    ["class teacher", () => call("PUT", `/class-sections/${section.id}/class-teacher`, S, { teacherId: teacher.id })],
    ["class-section: change", () => call("PUT", `/class-sections/${section.id}`, S, { strength: 41 })],
    ["class-section: delete", () => call("DELETE", `/class-sections/${section.id}`, S)],
    ["the week's structure", () => call("PUT", `/timetable-configs/${cfg.id}/structure`, S, {
      startTime: "09:00", periodsPerDay: 4, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
    })],
    ["daily activities", () => call("PUT", `/timetable-configs/${cfg.id}/activities`, S, { activities: [] })],
    ["which classes the wing covers", () => call("PUT", `/timetable-configs/${cfg.id}/class-sections`, S, {
      classSectionIds: [],
    })],
    ["allocation reset", () => call("POST", `/timetable-configs/${cfg.id}/allocation-reset`, S)],
    ["taking a subject off a class", () => call("POST", `/timetable-configs/${cfg.id}/allocation-cell/delete`, S, {
      className: "Class 1", subjectName: "ZZFRZ Maths",
    })],
    ["generate", () => call("POST", `/timetable-configs/${cfg.id}/generate`, S, {})],
    ["board: move", () => call("POST", `/timetable-configs/${cfg.id}/board/move`, S, {
      from: { classSectionId: section.id, day: 1, period: 1 },
      expect: { subjectId: subject.id, teacherId: teacher.id },
      to: { day: 2, period: 2 },
    })],
    ["board: swap", () => call("POST", `/timetable-configs/${cfg.id}/board/swap`, S, {
      a: { classSectionId: section.id, day: 1, period: 1 },
      expectA: { subjectId: subject.id, teacherId: teacher.id },
      b: { classSectionId: section.id, day: 1, period: 2 },
      expectB: { subjectId: subject.id, teacherId: teacher.id },
    })],
    ["board: place", () => call("POST", `/timetable-configs/${cfg.id}/board/place`, S, {
      classSectionId: section.id, subjectId: subject.id, teacherId: teacher.id, day: 3, period: 3,
    })],
    ["board: remove", () => call("POST", `/timetable-configs/${cfg.id}/board/remove`, S, {
      from: { classSectionId: section.id, day: 1, period: 1 },
      expect: { subjectId: subject.id, teacherId: teacher.id },
    })],
    ["board: pin", () => call("POST", `/timetable-configs/${cfg.id}/board/lock`, S, {
      from: { classSectionId: section.id, day: 1, period: 1 }, locked: true,
    })],
    ["publish", () => call("POST", `/timetable-configs/${cfg.id}/board/publish`, S, {})],
    ["withdraw", () => call("POST", `/timetable-configs/${cfg.id}/board/publish/unpublish`, S)],
    ["draft from published", () => call("POST", `/timetable-configs/${cfg.id}/board/draft-from-published`, S)],
    ["draft: create", () => call("POST", `/timetable-configs/${cfg.id}/drafts`, S, { label: "ZZFRZ D" })],
    ["delete the timetable", () => call("DELETE", `/timetable-configs/${cfg.id}`, S)],
    ["guided setup commit", () => call("POST", "/onboarding/commit/6", S)],
  ];

  for (const [label, run] of GUARDED) {
    const r = await run();
    check(frozenRefusal(r), label, (r.json?.message ?? r.text ?? `${r.status}`).slice(0, 70));
  }

  // ──────────────────────────────────── 4. WHAT IS DELIBERATELY NOT FROZEN
  //
  // The other half of the design. A freeze that blocked hiring would be a
  // freeze people work around, and a freeze that blocked READING would be one
  // nobody could use.
  console.log("\nAnd what a freeze deliberately does not touch:");

  const newTeacher = await call("POST", "/teachers", S, {
    name: "ZZFRZ Newcomer", employeeCode: "ZZFRZ-T2", maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6,
  });
  check(newTeacher.status < 300, "a new teacher can still be added — you cannot freeze hiring",
    `${newTeacher.status}`);

  const newRoom = await call("POST", "/rooms", S, { name: "ZZFRZ Room 2", roomType: "classroom", capacity: 40 });
  check(newRoom.status < 300, "and a new room", `${newRoom.status}`);

  const nextYear = await call("POST", "/academic-years", S, {
    name: "ZZFRZ 2027-28", startDate: "2027-04-01", endDate: "2028-03-31",
  });
  check(nextYear.status < 300, "and next year's session — freezing one week is not freezing the school",
    `${nextYear.status}`);

  /*
    §4.7a/§4.7b availability, and this one is a decision rather than an
    oversight. "Mrs Rao now leaves at 1pm" is a fact about a person, and it is
    exactly the fact a school records BEFORE re-staffing. Refusing it would
    leave them unable to write down the thing that prompted the change.
  */
  const timeOff = await call("PUT", `/availability/teacher/${teacher.id}`, S, {
    rows: [{ dayOfWeek: 5, periodNumber: null, reason: "ZZFRZ" }],
  });
  check(timeOff.status < 300,
    "time off can still be recorded — it is a fact about a person, not an allocation",
    `${timeOff.status}`);

  const readBack = await call("GET", `/timetable-configs/${cfg.id}/board/context`, S);
  check(readBack.status < 300, "the board still reads — a frozen week is exactly what people look at",
    `${readBack.status}`);
  const previewReset = await call("GET", `/timetable-configs/${cfg.id}/allocation-reset`, S);
  check(previewReset.status < 300,
    "and a preview still previews: seeing what a change would cost is not making one",
    `${previewReset.status}`);

  // ─────────────────────────────────────────────── 5. THE THAW RESTORES
  //
  // The assertion that separates a guard from a wall. Every check above would
  // also pass if the freeze were permanent, which would mean the product had
  // been broken rather than protected.
  console.log("\nUnfreezing gives all of it back:");
  const thawed = await call("POST", `/timetable-configs/${cfg.id}/unfreeze`, S);
  check(thawed.status < 300 && thawed.json?.frozenAt === null, "it unfreezes", `${thawed.status}`);
  const thawedAgain = await call("POST", `/timetable-configs/${cfg.id}/unfreeze`, S);
  check(thawedAgain.status < 300 && thawedAgain.json?.alreadyThawed === true,
    "asking twice is the same answer, never an error", `${thawedAgain.status}`);

  let restored = 0;
  const stillRefused = [];
  for (const [label, run] of GUARDED) {
    const r = await run();
    if (frozenRefusal(r)) stillRefused.push(label);
    else restored++;
  }
  check(stillRefused.length === 0,
    "every one of those routes stops refusing once the timetable is thawed",
    stillRefused.length ? stillRefused.join(", ") : `${restored} route(s)`);

  // ───────────────────────────────────────────────── 6. SCOPE IS PER WING
  console.log("\nA freeze belongs to one timetable, not to the school:");
  const wing2 = (await call("POST", "/timetable-configs", S, { name: "ZZFRZ Wing 2", academicYearId: year.id })).json;
  await call("POST", `/timetable-configs/${cfg.id}/freeze`, S);
  const otherWing = await call("PUT", `/timetable-configs/${wing2.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 4, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
  });
  check(otherWing.status < 300,
    "another wing's week is still editable while this one is frozen", `${otherWing.status}`);
  info("the §16 importer and the guided setup are the exception",
    "they resolve names inside one transaction and so refuse while ANY wing is frozen");

  console.log("\nCleanup:");
  await purge();
  check(true, "test school removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
  console.log(failed ? "\nSOME FREEZE CHECKS FAILED" : "\nALL FREEZE CHECKS PASSED");
  process.exit(failed);
}

main().catch((e) => { console.error(e); process.exit(1); });
