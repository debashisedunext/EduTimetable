/**
 * Phase 25.2 (§15.3) — the welcome screen and the resumable wizard, live.
 *
 *   docker compose exec api node /app/scripts/onboarding-smoke.cjs
 *
 *   1. NEW        — an empty school prompts; one with a timetable does not
 *   2. DISMISS    — "later" is remembered per USER, not per school
 *   3. DRAFT      — answers save, and a step merges rather than replaces
 *   4. RESUME     — sign in again and everything comes back
 *   5. NO WRITES  — an abandoned wizard leaves NOTHING in the masters
 *   6. SCOPED     — one school's draft is invisible to another
 *   7. DISCARD    — throwing it away leaves no half-answer behind
 *   8. PERMISSION — a teacher can read the state and cannot touch a draft
 *
 * Everything it creates uses @zzob.test and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzob.test";
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

/** A verified self-serve account holding one brand-new school. */
async function newOwnerWithSchool(email, schoolName) {
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZ Onboarder" });
  const vt = await mailToken(email, "verify");
  const acct = (await call("POST", "/auth/verify", null, { token: vt })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: schoolName });
  return { acct, session: made.json.sessionToken, schoolId: made.json.schoolId };
}

(async () => {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZOB " } }, select: { id: true, code: true },
    });
    const ids = mine.map((s) => s.id);
    if (ids.length) {
      // FK-safe order. 25.3 creates real structure, so this is no longer a
      // three-table purge — a suite that cannot clean up after itself is one
      // you can only run once.
      await prisma.onboardingSession.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.period.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.classSubject.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.classSection.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.section.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.subject.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.schoolClass.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.timetableConfig.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.academicYear.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.user.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.rolePermission.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.erpRoleMapping.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.role.deleteMany({ where: { schoolId: { in: ids } } });
      await prisma.school.deleteMany({ where: { id: { in: ids } } });
    }
    await control.tenant.deleteMany({ where: { schoolCode: { in: mine.map((s) => s.code) } } });
    await control.account.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
    const keys = await redis.keys("throttle:*:ip:*");
    if (keys.length) await redis.del(...keys);
  };
  await purge();

  // ────────────────────────────────────────────────────────────── 1. NEW
  console.log("\nAn empty school is offered the wizard; a set-up one is not:");
  const a = await newOwnerWithSchool(`a@${DOMAIN}`, "ZZOB Nalanda");
  const fresh = await call("GET", "/me/onboarding", a.session);
  check(fresh.json?.isNew === true && fresh.json?.shouldPrompt === true,
    "a school with no timetable prompts", JSON.stringify(fresh.json?.isNew));
  check(fresh.json?.hasConfig === false && fresh.json?.hasPublished === false,
    "and reports why — no config, nothing published");

  // The seeded school HAS a timetable, so it must not be pestered.
  const erpSession = await (async () => {
    const t = await call("POST", "/dev/erp-token", null, {
      erpUserId: `ZZOB-ERP`, erpRole: "ADMIN", name: "ZZ ERP Admin", email: `erp@${DOMAIN}`,
      school: { code: "SCHOOL-1", name: "School 1" },
    });
    const cb = await fetch(`${API}/api/sso/callback?token=${t.json.token}`, { redirect: "manual" });
    return (cb.headers.get("location") || "").split("#token=")[1];
  })();
  const settled = await call("GET", "/me/onboarding", erpSession);
  check(settled.json?.hasConfig === true && settled.json?.shouldPrompt === false,
    "a school that already has a timetable is left alone",
    `hasConfig ${settled.json?.hasConfig}`);

  // ────────────────────────────────────────────────────────── 2. DISMISS
  console.log("\n'I'll do this later' is recorded, per person — and means later, not never:");
  const dismissed = await call("POST", "/me/onboarding/dismiss", a.session);
  check(dismissed.status < 300, "dismissal accepted");
  const after = await call("GET", "/me/onboarding", a.session);
  check(after.json?.dismissedAt !== null, "and remembered against this user",
    after.json?.dismissedAt?.slice(0, 19));
  /**
   * The rule this asserts is the one that changed: a school with NO TIMETABLE
   * is offered the setup again at the next sign-in. An offer that appears once
   * and never returns leaves a school that has not started with the app's one
   * job behind a button nobody has a reason to look for. What keeps it from
   * being a nag is the client, which opens it once per sitting — so this is
   * deliberately the opposite of what it asserted before.
   */
  check(after.json?.shouldPrompt === true,
    "it still offers itself — the school has no timetable, and that is what the offer is FOR");
  check(after.json?.isNew === true,
    "and the school is still new — dismissing a prompt is not setting anything up");

  // A colleague in the SAME school has never seen it, and must still be shown.
  const roleId = (await prisma.role.findFirst({ where: { schoolId: a.schoolId, name: "Super Admin" } })).id;
  const colleague = await prisma.user.create({
    data: {
      schoolId: a.schoolId, erpUserId: "local:colleague", roleId,
      name: "ZZ Colleague", email: `colleague@${DOMAIN}`,
    },
  });
  const colleagueState = await prisma.user.findUnique({ where: { id: colleague.id } });
  check(colleagueState.onboardingDismissedAt === null,
    "a colleague's own dismissal is untouched — one admin waving it away must not hide it from everyone");

  // ──────────────────────────────────────────────────────────── 3. DRAFT
  console.log("\nAnswers are saved a step at a time, and merged:");
  const s1 = await call("PUT", "/onboarding/session", a.session, {
    currentStep: 2, answers: { school: { name: "ZZOB Nalanda" } },
  });
  check(s1.status < 300 && s1.json?.currentStep === 2, "step 1 saved", `now on step ${s1.json?.currentStep}`);
  const s2 = await call("PUT", "/onboarding/session", a.session, {
    currentStep: 3, answers: { session: { name: "2026-27", startDate: "2026-04-01" } },
  });
  check(s2.json?.answers?.school?.name === "ZZOB Nalanda" && s2.json?.answers?.session?.name === "2026-27",
    "step 2 kept step 1's answers — a save MERGES, so Back-then-Next cannot blank what is behind you",
    Object.keys(s2.json?.answers ?? {}).join(", "));

  // ─────────────────────────────────────────────────────────── 4. RESUME
  console.log("\nAbandon it, sign in again, and it is all still there:");
  const again = await call("POST", "/auth/login", null, { email: `a@${DOMAIN}`, password: PW });
  const reSession = (await call("POST", `/schools/${a.schoolId}/enter`, again.json.accountToken)).json.sessionToken;
  const resumed = await call("GET", "/onboarding/session", reSession);
  check(resumed.json?.currentStep === 3, "it resumes on the step they left", `step ${resumed.json?.currentStep}`);
  check(resumed.json?.answers?.school?.name === "ZZOB Nalanda"
    && resumed.json?.answers?.session?.startDate === "2026-04-01",
    "with every answer intact — a fresh sign-in, on what may be a different machine");
  const prompt = await call("GET", "/me/onboarding", reSession);
  check(prompt.json?.resumeStep === 3 && prompt.json?.shouldPrompt === true,
    "and it re-offers itself despite the earlier dismissal — an unfinished draft outranks a 'later'",
    `resume ${prompt.json?.resumeStep}`);

  // The case that only starts existing in 25.3, when step 5 creates the
  // timetable config: a school that is no longer "new" but whose setup is
  // unfinished must STILL be offered its draft. Simulated by giving the school
  // a config while a draft is open — otherwise this regresses silently the day
  // step 5 lands.
  const cfgYear = await prisma.academicYear.create({
    data: { schoolId: a.schoolId, name: "ZZOB 2026-27", startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31") },
  });
  const cfg = await prisma.timetableConfig.create({
    data: {
      schoolId: a.schoolId, academicYearId: cfgYear.id, name: "ZZOB Wing",
      periodsPerDay: 8, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5],
    },
  });
  const midway = await call("GET", "/me/onboarding", reSession);
  check(midway.json?.isNew === false && midway.json?.shouldPrompt === true,
    "a school that has a config but an UNFINISHED draft is still offered it — the point at which somebody has most to lose",
    `isNew ${midway.json?.isNew}, prompt ${midway.json?.shouldPrompt}`);
  await prisma.timetableConfig.delete({ where: { id: cfg.id } });
  await prisma.academicYear.delete({ where: { id: cfgYear.id } });

  // ─────────────────────────────────────────────────────── 5. NO WRITES
  console.log("\nA half-finished wizard has written nothing anywhere:");
  const counts = {
    years: await prisma.academicYear.count({ where: { schoolId: a.schoolId } }),
    classes: await prisma.schoolClass.count({ where: { schoolId: a.schoolId } }),
    sections: await prisma.classSection.count({ where: { schoolId: a.schoolId } }),
    rooms: await prisma.room.count({ where: { schoolId: a.schoolId } }),
    subjects: await prisma.subject.count({ where: { schoolId: a.schoolId } }),
    teachers: await prisma.teacher.count({ where: { schoolId: a.schoolId } }),
    configs: await prisma.timetableConfig.count({ where: { schoolId: a.schoolId } }),
  };
  check(Object.values(counts).every((n) => n === 0),
    "no master row of any kind exists — answers are not data, and the masters are written at the end",
    JSON.stringify(counts));

  // ─────────────────────────────────────────────────────────── 6. SCOPED
  console.log("\nOne school's draft is invisible to another:");
  const b = await newOwnerWithSchool(`b@${DOMAIN}`, "ZZOB Sunrise");
  const bDraft = await call("GET", "/onboarding/session", b.session);
  check(bDraft.json?.empty === true,
    "a different school and a different account starts with nothing", JSON.stringify(bDraft.json));
  await call("PUT", "/onboarding/session", b.session, { currentStep: 2, answers: { school: { name: "ZZOB Sunrise" } } });
  const aStill = await call("GET", "/onboarding/session", reSession);
  check(aStill.json?.answers?.school?.name === "ZZOB Nalanda" && aStill.json?.currentStep === 3,
    "and writing B's draft left A's exactly as it was");
  // The same account owning both is the interesting case: scoping is by school,
  // not by who is holding the token.
  const aSecond = await call("POST", "/schools", a.acct, { name: "ZZOB Second Of A" });
  const aSecondSession = aSecond.json.sessionToken;
  const secondDraft = await call("GET", "/onboarding/session", aSecondSession);
  check(secondDraft.json?.empty === true,
    "even a SECOND school of the same owner starts fresh — the draft belongs to the school, not the person");

  // ────────────────────────────────────────────────────────── 7. DISCARD
  console.log("\nThrowing a draft away leaves nothing behind:");
  const gone = await call("DELETE", "/onboarding/session", reSession);
  check(gone.status < 300, "discarded", `${gone.status}`);
  check((await call("GET", "/onboarding/session", reSession)).json?.empty === true, "and it is really gone");
  check((await call("GET", "/me/onboarding", reSession)).json?.resumeStep === null,
    "so nothing offers to resume it");
  check((await prisma.onboardingSession.count({ where: { schoolId: a.schoolId } })) === 0,
    "no half-answered row is left as history — an abandoned draft is not a finished one");

  // ────────────────────────────────────── 7b. RUNNING IT A SECOND TIME
  //
  // The regression this exists for. `finish` marks the row `completed_at`
  // rather than deleting it, and every READ filters to unfinished drafts — so
  // starting again found nothing, tried to INSERT, and hit the unique key that
  // says one row per person per school, forever. The first Next of anybody who
  // had ever completed the guided setup answered "Internal server error".
  console.log("\nSomebody who has finished the setup can start it again:");
  await call("PUT", "/onboarding/session", reSession, {
    currentStep: 3, answers: { school: { name: "ZZOB First Run" } },
  });
  const finished = await call("POST", "/onboarding/finish", reSession);
  check(finished.status < 300, "the first run is finished", `${finished.status}`);
  check((await call("GET", "/me/onboarding", reSession)).json?.resumeStep === null,
    "and stops offering to resume");

  const restarted = await call("PUT", "/onboarding/session", reSession, {
    currentStep: 1, answers: { school: { name: "ZZOB Second Run" } },
  });
  check(restarted.status < 300, "starting again does not 500 on the unique key", `${restarted.status}`);
  check(restarted.json?.answers?.school?.name === "ZZOB Second Run",
    "and it starts FRESH rather than merging into the finished one — last year's answers must not\n        reappear inside a setup somebody believes they are starting clean",
    JSON.stringify(restarted.json?.answers));
  check((await prisma.onboardingSession.count({ where: { schoolId: a.schoolId } })) === 1,
    "one row per person per school, as the unique key says");
  // Put the school back as this suite found it.
  await call("DELETE", "/onboarding/session", reSession);

  // ────────────────────────────── 7d. WHICH WINGS THE SETUP IS BUILDING
  //
  // A guided setup is ONE draft for the whole school — step 3 names every wing
  // at once — so "which wing is this progress for?" answers "all of them", and
  // the useful form of that answer is the list. `weekReady` is the one
  // genuinely per-wing fact: step 5 is filled in wing by wing, so a two-wing
  // school can be half-way through a single step with nothing else showing it.
  console.log("\nThe progress card knows which wings it is building:");
  await call("PUT", "/onboarding/session", reSession, {
    currentStep: 5,
    answers: {
      wings: [
        { name: "ZZOB Primary", fromIndex: 4, toIndex: 8, sections: 2 },
        { name: "ZZOB Senior", fromIndex: 12, toIndex: 13, sections: 2 },
      ],
    },
  });
  const both = (await call("GET", "/me/onboarding", reSession)).json?.resumeWings ?? [];
  check(both.length === 2 && both.every((w) => w.weekReady === false),
    "both wings are named, neither with a week yet",
    both.map((w) => `${w.name}:${w.weekReady}`).join(" "));

  await call("PUT", "/onboarding/session", reSession, {
    currentStep: 5,
    answers: { weeks: { "ZZOB Primary": { workingDays: [1, 2, 3, 4, 5], periodsPerDay: 8 } } },
  });
  const half = (await call("GET", "/me/onboarding", reSession)).json?.resumeWings ?? [];
  check(half.find((w) => w.name === "ZZOB Primary")?.weekReady === true
    && half.find((w) => w.name === "ZZOB Senior")?.weekReady === false,
    "and a step finished for one wing and not the other SHOWS as that",
    half.map((w) => `${w.weekReady ? "✓" : "–"} ${w.name}`).join(" · "));
  await call("DELETE", "/onboarding/session", reSession);

  // ────────────────────── 7c. LOOKING AT THE AI DOOR STARTS NOTHING
  //
  // The regression this exists for: opening the conversational setup used to
  // create a draft on mount, and a draft makes the welcome screen re-offer
  // itself. Somebody who opened that door and closed it again then met a modal
  // across the screen on every page load afterwards — a prompt that cannot be
  // got past stops being an offer.
  console.log("\nOpening the AI door is not starting a setup:");
  await call("DELETE", "/onboarding/session", reSession);
  const quiet = await call("GET", "/me/onboarding", reSession);
  check(quiet.json?.shouldPrompt === false || quiet.json?.resumeStep === null,
    "nothing is offered when there is no draft", `resume ${quiet.json?.resumeStep}`);

  // Exactly what the chat screen does when it mounts, and nothing more.
  await call("GET", "/onboarding/session", reSession);
  await call("GET", "/onboarding/interview", reSession);
  check((await prisma.onboardingSession.count({ where: { schoolId: a.schoolId } })) === 0,
    "and reading it writes nothing — opening a door is not walking through it");
  check((await call("GET", "/me/onboarding", reSession)).json?.resumeStep === null,
    "so it still offers nothing to resume");

  // ─────────────────────────────────────────────────────── 8. PERMISSION
  console.log("\nA teacher can be told the state, and cannot touch a draft:");
  const teacherRole = await prisma.role.findFirst({ where: { schoolId: a.schoolId, name: "Teacher" } });
  const tUser = await prisma.user.create({
    data: {
      schoolId: a.schoolId, erpUserId: "local:teacher-ob", roleId: teacherRole.id,
      name: "ZZ Teacher", email: `t@${DOMAIN}`,
    },
  });
  const tSession = await (async () => {
    const t = await call("POST", "/dev/erp-token", null, {
      erpUserId: "local:teacher-ob", erpRole: "TEACHER", name: "ZZ Teacher", email: `t@${DOMAIN}`,
      school: { code: (await prisma.school.findUnique({ where: { id: a.schoolId } })).code, name: "ZZOB Nalanda" },
    });
    const cb = await fetch(`${API}/api/sso/callback?token=${t.json.token}`, { redirect: "manual" });
    return (cb.headers.get("location") || "").split("#token=")[1];
  })();
  if (tSession) {
    const tState = await call("GET", "/me/onboarding", tSession);
    check(tState.status === 200,
      "the state is readable — it is on every page load, and a teacher must be able to load the app",
      `${tState.status}`);
    const tDraft = await call("PUT", "/onboarding/session", tSession, { currentStep: 5 });
    check(tDraft.status === 403,
      "but writing a draft needs masters.manage", `${tDraft.status}`);
  } else {
    check(false, "could not mint a teacher session");
  }
  void tUser;

  // ──────────────────────────────────────────── 9. STRUCTURE (25.3)
  //
  // The exit criterion: three wings and a class set produce the right
  // timetable_config, classes, sections, class_sections and periods rows —
  // created through the endpoints that already exist, never a second writer.
  console.log("\nSteps 3-5 build the school's structure through the existing pipeline:");
  const c = await newOwnerWithSchool(`c@${DOMAIN}`, "ZZOB Structure");
  const S = c.session;

  // Step 2 — the session, committed through the §16 importer.
  await call("PUT", "/onboarding/session", S, {
    currentStep: 3,
    answers: { session: { name: "ZZOB 2026-27", startDate: "2026-04-01", endDate: "2027-03-31" } },
  });
  const yearCommit = await call("POST", "/onboarding/commit/2", S);
  check(yearCommit.json?.created?.academicYears === 1, "the session is created",
    JSON.stringify(yearCommit.json?.created));
  const twice = await call("POST", "/onboarding/commit/2", S);
  check(Object.keys(twice.json?.created ?? {}).length === 0,
    "committing the same step AGAIN creates nothing — the importer skips what exists, so the wizard needs no bookkeeping of its own",
    twice.json?.message);

  // Step 3 — one timetable_config per wing, via POST /timetable-configs.
  const years = await call("GET", "/academic-years", S);
  const yearId = years.json.find((y) => y.name === "ZZOB 2026-27").id;
  const WINGS = ["ZZOB Primary", "ZZOB Middle", "ZZOB Senior"];
  for (const name of WINGS) {
    await call("POST", "/timetable-configs", S, { name, academicYearId: yearId });
  }
  const configs = await call("GET", "/timetable-configs", S);
  check(configs.json.length === 3, "three wings, three timetable configs", `${configs.json.length}`);

  // Step 4 — the class ladder, committed through the importer.
  await call("PUT", "/onboarding/session", S, {
    currentStep: 5,
    answers: {
      wings: [
        { name: "ZZOB Primary", fromIndex: 0, toIndex: 8, sections: 4 },
        { name: "ZZOB Middle", fromIndex: 9, toIndex: 11, sections: 3 },
        { name: "ZZOB Senior", fromIndex: 12, toIndex: 15, sections: 2 },
      ],
    },
  });
  const preview = await call("GET", "/onboarding/preview/4", S);
  check(preview.json?.ok === true && preview.json?.totals?.create > 0,
    "the dry run says what it would create, before anything is written",
    JSON.stringify(preview.json?.totals));
  const before = await prisma.schoolClass.count({ where: { schoolId: c.schoolId } });
  check(before === 0, "and writes nothing while previewing");

  const built = await call("POST", "/onboarding/commit/4", S);
  // Pre-Nur..Class 5 = 9 classes x 4; Class 6-8 = 3 x 3; Class 9-12 = 4 x 2.
  check(built.json?.created?.classes === 16, "16 classes across the three wings",
    `${built.json?.created?.classes}`);
  check(built.json?.created?.classSections === 9 * 4 + 3 * 3 + 4 * 2,
    "and 53 class-sections — one per section, not one per class",
    `${built.json?.created?.classSections}`);

  const seq = await prisma.schoolClass.findMany({
    where: { schoolId: c.schoolId }, orderBy: { sequence: "asc" }, select: { name: true, sequence: true },
  });
  check(seq[0].name === "Pre-Nursery" && seq[seq.length - 1].name === "Class 12",
    "sequence comes from the ladder position, so every later screen sorts in SCHOOL order — not 'Class 10' before 'Class 2'",
    `${seq[0].name} … ${seq[seq.length - 1].name}`);

  // The Timetable column on the Class Sections sheet did the attaching.
  const attached = await prisma.classSection.groupBy({
    by: ["timetableConfigId"], where: { schoolId: c.schoolId }, _count: true,
  });
  check(attached.every((g) => g.timetableConfigId !== null) && attached.length === 3,
    "every class-section is attached to its own wing — done by the importer's Timetable column, with no attach step of its own",
    attached.map((g) => g._count).join(" / "));

  const dup = await call("POST", "/onboarding/commit/4", S);
  check(Object.keys(dup.json?.created ?? {}).length === 0,
    "re-running step 4 creates no duplicate classes — the property that makes Back-and-Next safe");

  // Step 5 — the week, via PUT /:id/structure.
  const primary = configs.json.find((x) => x.name === "ZZOB Primary");
  const week = await call("PUT", `/timetable-configs/${primary.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 8, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5],
    breaks: [{ afterPeriod: 2, name: "Short Break", durationMins: 15 },
             { afterPeriod: 5, name: "Lunch", durationMins: 30 }],
  });
  check(week.status < 300, "the week is written", `${week.status}`);
  const periods = await prisma.period.findMany({ where: { timetableConfigId: primary.id } });
  check(periods.filter((x) => !x.isBreak).length === 8 && periods.filter((x) => x.isBreak).length === 2,
    "8 teaching periods and 2 breaks", `${periods.length} rows`);

  // The capacity the screen shows must be the number the SERVER enforces.
  // The capacity the screen shows must be the number the SERVER enforces.
  //
  // Asserted against a SHORT week on purpose. With 8 x 5 = 40 the obvious probe
  // is 41 — but the Curriculum sheet's own bound is 1-20, so 41 is refused by
  // the field before the capacity guard is ever reached, and the check passes
  // while proving nothing. A 3 x 5 = 15 week makes 16 legal as a field value
  // and illegal as a load, which is the rule actually under test.
  const shortWing = configs.json.find((x) => x.name === "ZZOB Senior");
  await call("PUT", `/timetable-configs/${shortWing.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 3, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
  });
  const shortCfg = await prisma.timetableConfig.findUnique({ where: { id: shortWing.id } });
  const shown = shortCfg.periodsPerDay * shortCfg.workingDays.length;
  const probeSubject = await prisma.subject.create({ data: { schoolId: c.schoolId, name: "ZZOB Probe" } });
  const class9 = await prisma.schoolClass.findFirst({ where: { schoolId: c.schoolId, name: "Class 9" } });
  const within = await call("POST", "/class-subjects", S, {
    classId: class9.id, subjectId: probeSubject.id, academicYearId: yearId, periodsPerWeek: shown,
  });
  check(within.status < 300, `a load of exactly ${shown} is accepted`, `${within.status}`);
  const over = await call("POST", "/class-subjects", S, {
    classId: class9.id, subjectId: probeSubject.id, academicYearId: yearId, periodsPerWeek: shown + 1,
  });
  check(over.status === 400 && /exceeds/i.test(over.json?.message ?? ""),
    `and ${shown + 1} is refused BY THE CAPACITY GUARD, not by a field bound — so the number on screen is the number enforced`,
    (over.json?.message ?? "").slice(0, 60));

  // Re-running step 5 must be safe too: PUT /structure rewrites wholesale.
  await call("PUT", `/timetable-configs/${primary.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 8, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5],
    breaks: [{ afterPeriod: 2, name: "Short Break", durationMins: 15 },
             { afterPeriod: 5, name: "Lunch", durationMins: 30 }],
  });
  check((await prisma.period.count({ where: { timetableConfigId: primary.id } })) === 10,
    "and writing the week twice leaves ten period rows, not twenty");

  // ─────────────────────────────────────────────────────────────── cleanup
  // ──────────────────────── 9. CARRYING ON WITH A SCHOOL THAT EXISTS
  //
  // Placed here, after the three-wing school is built: adoption reconstructs
  // a draft FROM a school, so it needs one with wings, classes and a week —
  // and run earlier it read a session that did not exist yet.
  //
  // The way back into the guided flow for a half-built school. "Edit" has
  // always meant the step-by-step Setup Wizard, which is the wrong tool for
  // somebody who built the school through the guided steps.
  //
  // The plan put "editing an existing school through the wizard" out of scope,
  // and its reason still holds — pointing a first-run flow at a published
  // timetable needs a diff-and-merge story. This is the narrower thing that is
  // safe: it FILLS GAPS and never edits, because every commit goes through the
  // §16 importer, which skips rows that already exist and cannot update or
  // delete them. The assertion below is that claim, tested rather than stated.
  console.log("\nA school that already exists can be carried on in the guided setup:");
  await call("DELETE", "/onboarding/session", S);

  // A wing with nothing in it yet — the case that was being dropped.
  const emptyWing = await call("POST", "/timetable-configs", S, {
    name: "ZZOB Empty", academicYearId: yearId,
  });
  check(emptyWing.status < 300, "a fourth wing with no classes in it");

  // Snapshot AFTER that, so what is being compared is the effect of ADOPTING
  // rather than the effect of this suite's own setup.
  const wasThere = {
    classes: await prisma.schoolClass.count({ where: { schoolId: c.schoolId } }),
    sections: await prisma.classSection.count({ where: { schoolId: c.schoolId } }),
    configs: await prisma.timetableConfig.count({ where: { schoolId: c.schoolId } }),
  };

  const adopted = await call("POST", "/onboarding/session/adopt", S);
  check(adopted.status < 300 && adopted.json?.adopted === true, "the school is reconstructed as a draft",
    `${adopted.status}`);
  const got = adopted.json?.answers ?? {};
  check((got.wings ?? []).length === 4,
    "with every wing it already has, as a range on the ladder",
    (got.wings ?? []).map((w) => w.name).join(", "));
  /**
   * An empty wing must be CARRIED, not dropped. It was being skipped for having
   * no classes to derive a range from, and the effect on screen was a wing list
   * missing wings the school plainly has — which reads as the setup having lost
   * them. It appears with the default range and the person adjusts it.
   */
  check((got.wings ?? []).some((w) => w.name === "ZZOB Empty"),
    "including one that has no classes yet — it exists, so it is listed");

  /**
   * And it opens where there is something to DO. An adopted draft has no
   * "where I left off", and starting at question one meant walking back through
   * the school's own name and being asked to add wings that were already
   * listed on the screen the button was pressed from.
   */
  check(adopted.json?.currentStep > 3,
    "opening past the steps that are already answered, not at question one",
    `step ${adopted.json?.currentStep}`);
  check(got.school?.name && got.session?.name,
    "and its name and session", `${got.school?.name} · ${got.session?.name}`);

  // The claim: re-walking those steps adds nothing and changes nothing.
  const recommit = await call("POST", "/onboarding/commit/4", S);
  check(Object.keys(recommit.json?.created ?? {}).length === 0,
    "re-committing a step it already has creates NOTHING — it fills gaps, it does not edit",
    JSON.stringify(recommit.json?.created ?? {}));
  const stillThere = {
    classes: await prisma.schoolClass.count({ where: { schoolId: c.schoolId } }),
    sections: await prisma.classSection.count({ where: { schoolId: c.schoolId } }),
    configs: await prisma.timetableConfig.count({ where: { schoolId: c.schoolId } }),
  };
  check(JSON.stringify(wasThere) === JSON.stringify(stillThere),
    "and the school is byte-for-byte the school it was",
    `${JSON.stringify(wasThere)} → ${JSON.stringify(stillThere)}`);

  // Somebody's unfinished typing is not ours to throw away.
  const secondAdopt = await call("POST", "/onboarding/session/adopt", S);
  check(secondAdopt.json?.adopted === false,
    "adopting again returns the LIVE draft rather than rebuilding over it");
  await call("DELETE", "/onboarding/session", S);


  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { name: { startsWith: "ZZOB " } } })) === 0, "test schools removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
  console.log(failed ? "\nSOME ONBOARDING CHECKS FAILED" : "\nALL ONBOARDING CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
