/**
 * §29.6 — a staffing change on a timetable that has NOT been published.
 *
 * ## The bug, as reported
 *
 * *"Ajay Verma resigned, I moved his lessons to Prakarti, it says applied — and
 * the grid still shows Ajay."*
 *
 * It did. §29.2 read `status: "published"` everywhere, and that school had
 * never published: 30 draft rows, 0 published ones. The units came back with no
 * cells, the apply's `updateMany` matched nothing, and the change moved the
 * mappings and the class-teacher pointer while leaving every visible lesson
 * with the leaver's name on it. **Half-applied, and reported as done.**
 *
 * That is the worst shape a bug can take here: not a refusal, not an error, but
 * a green tick over a week that did not move.
 *
 * ## What this proves
 *
 *  1. On an unpublished timetable the change acts on the **current draft**, and
 *     the draft rows actually change hands.
 *  2. The carrier moves too, so the next Generate does not put the leaver back.
 *  3. **Another draft is left alone** — `timetable_slots` holds several named
 *     drafts at once (§22), and a filter of `status: "draft"` with no draft id
 *     would reassign lessons in drafts nobody is looking at.
 *  4. An **applied** change reports what it recorded, not a fresh look — the
 *     second half of the report, where the History card said "0 things to
 *     reassign · they teach nothing" under a change that had just moved five.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzsd.test";
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

const PURGE = ["staffingChangeItem", "staffingChangeTeacher", "staffingChange",
  "onboardingSession", "timetableFixedLesson", "timetableSlot", "timetableDraft",
  "timetablePublication", "electiveOption", "electiveBlockMember", "electiveBlock",
  "mergedTeachingGroupMember", "mergedTeachingGroup",
  "teacherSubjectClassSection", "teacherClassEligibility", "teacherSubject",
  "subjectClass", "roomSubject", "timetableSubject", "timetableClassSpan", "timetableDayShape",
  "period", "classSubject", "classSection", "section", "subject", "schoolClass", "teacher", "room",
  "timetableConfig", "timetableGroup", "academicYear", "notification", "auditLog", "user",
  "rolePermission", "erpRoleMapping", "role"];

async function main() {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZSD" } }, select: { id: true, code: true },
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

  console.log("\nA school whose timetable has never been published:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZSD Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZSD School" });
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;
  const save = (step, answers) => call("PUT", "/onboarding/session", S, { currentStep: step, answers, mode: "wizard" });

  await save(3, {
    school: { name: "ZZSD School" },
    session: { name: "ZZSD 2026-27", startDate: "2026-04-01", endDate: "2027-03-31" },
  });
  await call("POST", "/onboarding/commit/2", S);
  const yearId = (await call("GET", "/academic-years", S)).json[0].id;
  await call("POST", "/timetable-configs", S, { name: "Main", academicYearId: yearId });
  const cfg = (await call("GET", "/timetable-configs", S)).json[0];
  await save(5, { wings: [{ name: "Main", fromIndex: 4, toIndex: 4, sections: 2 }] });
  await call("POST", "/onboarding/commit/4", S);
  await call("PUT", `/timetable-configs/${cfg.id}/structure`, S, {
    periodsPerDay: 6, periodDurationMins: 40, startTime: "08:00", workingDays: [1, 2, 3, 4, 5], breaks: [],
  });
  await save(7, { subjects: [{ name: "English" }] });
  await call("POST", "/onboarding/commit/6", S);

  const english = (await call("GET", "/subjects", S)).json[0];
  const classId = (await call("GET", "/classes", S)).json[0].id;
  const sections = (await call("GET", "/class-sections", S)).json;
  await call("POST", "/class-subjects", S, {
    classId, subjectId: english.id, academicYearId: yearId, periodsPerWeek: 5,
  });
  await call("POST", "/teachers", S, { name: "Ajay Verma", employeeCode: "L1", maxPeriodsPerWeek: 30 });
  await call("POST", "/teachers", S, { name: "Prakarti Saini", employeeCode: "L2", maxPeriodsPerWeek: 30 });
  const staff = (await call("GET", "/teachers", S)).json;
  const leaver = staff.find((t) => t.employeeCode === "L1");
  const taker = staff.find((t) => t.employeeCode === "L2");
  for (const cs of sections) {
    await call("POST", "/mappings", S, {
      teacherId: leaver.id, subjectId: english.id, classSectionId: cs.id, periodsPerWeek: 5,
    });
  }

  /*
    A generated week, written directly.

    The fact under test is "does an apply move DRAFT rows", not "does the solver
    run" — and running the worker here would make this a slow test of a
    different thing.
  */
  const mkDraft = async (draftNo) => (await prisma.timetableDraft.create({
    data: { schoolId, timetableConfigId: cfg.id, draftNo, label: `d${draftNo}` },
  })).id;
  /*
    Draft numbers matter here. `currentId` is "the newest draft that has rows"
    (invariant 3), which is what the Board and the Master Grid show — so the
    week under test has to be the HIGHER number. The first version of this
    fixture made the decoy newest, and the apply correctly moved the decoy: the
    test was wrong, not the code.
  */
  const other = await mkDraft(1);
  const current = await mkDraft(2);
  const place = async (draftId, day, period, cs) => prisma.timetableSlot.create({
    data: {
      schoolId, timetableConfigId: cfg.id, draftId,
      classSectionId: cs, subjectId: english.id, teacherId: leaver.id,
      dayOfWeek: day, periodNumber: period, status: "draft", source: "auto",
    },
  });
  for (let d = 1; d <= 5; d++) await place(current, d, 1, sections[0].id);
  for (let d = 1; d <= 5; d++) await place(current, d, 2, sections[1].id);
  // An OLDER draft, which must NOT be touched (§22).
  await place(other, 1, 3, sections[0].id);

  /*
    §29.7 — a §36 pin and a class-teacher role, both held by the leaver.

    The pin is the carrier nobody added when §36 arrived: left pointing at a
    teacher who no longer teaches the lesson, Check 14 BLOCKS the next
    generation — so a staffing change that ignored it would quietly make the
    school unable to generate.
  */
  await prisma.classSection.updateMany({ where: { id: sections[0].id }, data: { classTeacherId: leaver.id } });
  await prisma.timetableFixedLesson.create({
    data: {
      schoolId, timetableConfigId: cfg.id, classSectionId: sections[0].id,
      subjectId: english.id, teacherId: leaver.id, dayOfWeek: 1, periodNumber: 1,
    },
  });

  const countIn = (draftId, teacherId) =>
    prisma.timetableSlot.count({ where: { timetableConfigId: cfg.id, draftId, teacherId } });

  check(await countIn(current, leaver.id) === 10, "the current draft holds 10 of the leaver's lessons");
  check(
    (await prisma.timetableSlot.count({ where: { timetableConfigId: cfg.id, status: "published" } })) === 0,
    "and NOTHING is published — the state every school is in before its first publish",
  );

  // ── the change ──────────────────────────────────────────────────────
  const opened = await call("POST", `/timetable-configs/${cfg.id}/staffing-changes`, S, {
    reason: "resigned", releasing: [leaver.id], receiving: [taker.id],
  });
  check(opened.status === 201, "a change opens", `HTTP ${opened.status} ${opened.text.slice(0, 80)}`);
  const changeId = opened.json.id;

  const detail = await call("GET", `/staffing-changes/${changeId}`, S);
  check(
    detail.json.scope === "draft",
    "it knows this timetable is unpublished and acts on the DRAFT",
    `scope ${detail.json.scope} · ${detail.json.scopeLabel}`,
  );
  check(
    detail.json.totals.units === 3 && detail.json.totals.lessons === 10,
    "and it SEES the lessons — this reported 0 of both, under a full grid",
    `${detail.json.totals.units} units · ${detail.json.totals.lessons} lessons`,
  );
  check(
    detail.json.totals.fixedLessons === 1,
    "the preview says the §36 pin moves too, BEFORE anything is applied",
    `${detail.json.totals.fixedLessons} pin(s)`,
  );

  const plan = await call("GET", `/staffing-changes/${changeId}/plan?mode=replace&toTeacherId=${taker.id}`, S);
  check(plan.status === 200 && plan.json.plan?.uncovered === 0, "the plan covers everything",
    `HTTP ${plan.status} · uncovered ${plan.json?.plan?.uncovered}`);

  const applied = await call("POST", `/staffing-changes/${changeId}/apply`, S, {
    mode: "replace", toTeacherId: taker.id,
  });
  check(applied.status === 201 || applied.status === 200, "and it applies", `HTTP ${applied.status} ${applied.text.slice(0, 90)}`);

  // ── §29.7 — every carrier, and the report of what moved ─────────────
  const pinNow = await prisma.timetableFixedLesson.findFirst({ where: { timetableConfigId: cfg.id } });
  check(
    pinNow?.teacherId === taker.id,
    "THE §36 PIN MOVED — left behind it is a blocking Check 14 on the next Generate",
    `pin now ${pinNow?.teacherId === taker.id ? "hers" : "still his"}`,
  );
  const ct = await prisma.classSection.findFirst({ where: { id: sections[0].id } });
  check(ct?.classTeacherId === taker.id, "and the class-teacher role moved with it");

  const c = applied.json.changed;
  check(!!c, "the apply REPORTS what it changed, rather than only that it applied");
  check(
    c && c.lessons === 10 && c.mappings === 2 && c.classTeacher === 1 && c.fixedLessons === 1,
    "and every number is counted from the writes that ran, not predicted from the plan",
    c && `${c.lessons} lessons · ${c.mappings} mappings · ${c.classTeacher} class teacher · ${c.fixedLessons} pin`,
  );
  check(c && /draft/.test(c.where), "including WHERE it wrote", c && c.where);

  // ── the assertion the whole file exists for ─────────────────────────
  check(
    await countIn(current, leaver.id) === 0,
    "THE BUG: not one of the leaver's lessons is left in the current draft",
    `${await countIn(current, leaver.id)} still his`,
  );
  check(
    await countIn(current, taker.id) === 10,
    "and all ten now show the teacher who took over",
    `${await countIn(current, taker.id)} hers`,
  );
  check(
    await countIn(other, leaver.id) === 1 && await countIn(other, taker.id) === 0,
    "while the OTHER draft is untouched — §22 holds several at once, and only one is being looked at",
  );
  check(
    (await prisma.teacherSubjectClassSection.count({ where: { teacherId: taker.id } })) === 2,
    "the carrier moved too, so the next Generate does not put the leaver back",
  );

  // ── the History card ────────────────────────────────────────────────
  const after = await call("GET", `/staffing-changes/${changeId}`, S);
  check(after.json.historical === true, "an applied change is served from its RECORD, not re-planned");
  check(
    after.json.totals.units === 3 && after.json.units.every((u) => u.movedToName === "Prakarti Saini"),
    "so it says what moved and where it went, instead of 'they teach nothing'",
    `${after.json.totals.units} items`,
  );

  // ── the revert puts the pin back too, or undoing CREATES the block ──
  const reverted = await call("POST", `/staffing-changes/${changeId}/revert`, S, {});
  check(reverted.status === 201 || reverted.status === 200, "it reverts", `HTTP ${reverted.status}`);
  const pinBack = await prisma.timetableFixedLesson.findFirst({ where: { timetableConfigId: cfg.id } });
  check(
    pinBack?.teacherId === leaver.id,
    "and the pin comes BACK — a revert that left it would create the Check 14 the move prevented",
    `pin ${pinBack?.teacherId === leaver.id ? "his again" : "still hers"}`,
  );
  check(
    await countIn(current, leaver.id) === 10,
    "with every lesson back where it started",
    `${await countIn(current, leaver.id)} his`,
  );

  await purge();
  await prisma.$disconnect();
  await control.$disconnect();
  console.log(failed ? "\nFAILED\n" : "\nAll good.\n");
  process.exit(failed);
}

main().catch((e) => { console.error(e); process.exit(1); });
