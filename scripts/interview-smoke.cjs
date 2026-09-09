/**
 * §24.6 Phase 25.5 — the conversational setup, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/interview-smoke.cjs
 *
 * Drives the interview WITHOUT an LLM in the loop, for the same reason
 * `/dev/ai-tool` exists (§17.8): the property under test is not a property of
 * the model. What is being asserted is that a model's report becomes **exactly
 * the draft the wizard would have produced**, and then commits through the same
 * §16 pipeline to the same rows. A test that needed a provider key would be a
 * test nobody runs, and it would fail for reasons that have nothing to do with
 * this code.
 *
 *   1. SCRIPT     — eight turns of a conversation, through /dev/interview-turn
 *   2. EQUALITY   — the resulting answers equal the wizard's, field for field
 *   3. ACCUMULATE — a later turn ADDS teachers rather than replacing them
 *   4. REFUSAL    — a hallucinated class and an unknown field are named, not taken
 *   5. HANDOVER   — the draft is at step 8 and the wizard opens there
 *   6. COMMIT     — the same commit endpoints write the same school
 *
 * Everything it creates uses @zzin.test / "ZZIN " and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzin.test";
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

/**
 * The conversation, as the model would report it — one entry per turn.
 *
 * Deliberately messy in the ways a transcription is messy: class names rather
 * than ladder indices, "yes" for a boolean, a bare list of subject names, and
 * the staff arriving in two batches.
 */
const TURNS = [
  { school: { name: "ZZIN Guided School" } },
  { session: { name: "ZZIN 2026-27", startDate: "2026-04-01", endDate: "2027-03-31" } },
  { wings: [
    { name: "ZZIN Primary", fromClass: "Class 1", toClass: "Class 5", sections: 2 },
    { name: "ZZIN Senior", fromClass: "class 9", toClass: "10", sections: 2 },
  ] },
  { weeks: { "ZZIN Primary": { workingDays: [1, 2, 3, 4, 5], periodsPerDay: 8, startTime: "08:00",
    periodDurationMins: 40, breaks: [{ name: "Lunch", afterPeriod: 4, durationMins: 30 }] } } },
  { weeks: { "ZZIN Senior": { workingDays: [1, 2, 3, 4, 5], periodsPerDay: 8, startTime: "08:00",
    periodDurationMins: 40, breaks: [{ name: "Lunch", afterPeriod: 4, durationMins: 30 }] } } },
  { subjects: ["ZZIN English", "ZZIN Hindi", "ZZIN Mathematics",
    { name: "ZZIN Science", isLab: "yes" }, "ZZIN Social Science"] },
  { teachers: [] },   // filled in below — the staff list is generated
  { teachers: [] },
];

/**
 * Enough staff that both wings are covered; delivered in two batches.
 *
 * FIVE per subject per wing at a 30-period cap, and the arithmetic is the
 * reason. Five subjects sharing a 40-period week means about nine periods each,
 * and a section's nine periods cannot be split between two teachers — so one
 * teacher covers `floor(30/9) = 3` sections and the primary wing's ten need
 * four. Five leaves room for the curriculum to shift by a period.
 *
 * The same lesson the guided-setup smoke learned: a fixture describing an
 * unstaffable school makes the suggester look broken when it is being honest.
 */
function staff() {
  const subjects = ["ZZIN English", "ZZIN Hindi", "ZZIN Mathematics", "ZZIN Science", "ZZIN Social Science"];
  const out = [];
  let n = 0;
  for (const wing of ["ZZIN Primary", "ZZIN Senior"]) {
    for (const s of subjects) {
      for (let i = 0; i < 5; i++) {
        n++;
        out.push({
          name: `ZZIN Teacher ${n}`, employeeCode: `ZZIN-T${String(n).padStart(3, "0")}`,
          subjects: [s], wing, maxPeriodsPerDay: 7, maxPeriodsPerWeek: 30,
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
      where: { name: { startsWith: "ZZIN " } }, select: { id: true, code: true },
    });
    const ids = mine.map((s) => s.id);
    for (const m of [
      "onboardingSession", "aiChatLog", "timetableSlot", "timetableDraft", "timetablePublication",
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

  const people = staff();
  TURNS[6].teachers = people.slice(0, 20);
  TURNS[7].teachers = people.slice(20);

  // ──────────────────────────────────────────────── a stranger, a school
  console.log("\nAn account, a school, and a conversation instead of a form:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZIN Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZIN Guided School" });
  check(made.status < 300, "school created", `school ${made.json?.schoolId}`);
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;

  // ───────────────────────────────────────────── 1. the scripted interview
  const say = (learned, replace) => call("POST", "/dev/interview-turn", S, { learned, ...(replace ? { replace } : {}) });

  let last = null;
  for (const turn of TURNS) {
    last = await say(turn);
    if (last.status >= 300) { check(false, "a turn was refused outright", last.text.slice(0, 120)); break; }
    if ((last.json?.rejected ?? []).length > 0) {
      check(false, "a turn was partly refused", last.json.rejected[0]);
    }
  }
  check(last?.status < 300, "eight turns recorded", `step ${last?.json?.step}`);

  const answers = last?.json?.answers ?? {};

  // ─────────────────────────────────── 2. the same answers the wizard makes
  check(answers.school?.name === "ZZIN Guided School", "the school name",
    String(answers.school?.name));
  check(answers.wings?.length === 2 && answers.wings[0].fromIndex === 4 && answers.wings[0].toIndex === 8,
    "class NAMES became ladder positions — nobody dictates an array index",
    JSON.stringify(answers.wings?.[0]));
  check(answers.wings?.[1]?.fromIndex === 12 && answers.wings[1].toIndex === 13,
    "…including 'class 9' and a bare '10'", JSON.stringify(answers.wings?.[1]));
  check(Object.keys(answers.weeks ?? {}).length === 2,
    "BOTH wings kept their week, though they were given two turns apart",
    Object.keys(answers.weeks ?? {}).join(", "));
  check(answers.subjects?.length === 5 && answers.subjects[3].isLab === true,
    "a bare list of subject names, and 'yes' as a boolean",
    JSON.stringify(answers.subjects?.[3]));

  // ────────────────────────────────────────────────── 3. accumulation
  check(answers.teachers?.length === people.length,
    "the staff list ACCUMULATED across two turns rather than being replaced",
    `${answers.teachers?.length} of ${people.length}`);

  // ────────────────────────────────────────────────── 4. what it refuses
  const bad = await say({
    wings: [{ name: "ZZIN Foundation", fromClass: "Reception", toClass: "Year 2", sections: 2 }],
    principal: "Mrs Rao",
  });
  const ladderRefusal = (bad.json?.rejected ?? []).find((r) => r.includes("Class 1"));
  check(Boolean(ladderRefusal), "a class it does not know is refused WITH the vocabulary",
    ladderRefusal?.slice(0, 80));
  check((bad.json?.rejected ?? []).some((r) => r.includes("principal")),
    "and an unknown field is NAMED, never silently dropped");
  check((bad.json?.answers?.wings ?? []).length === 2,
    "…and neither of them changed the draft", `${bad.json?.answers?.wings?.length} wings`);

  // ────────────────────────────────────────────────── 5. the handover
  check(bad.json?.step === 8, "the draft reaches the handover step", `step ${bad.json?.step}`);
  const resumed = await call("GET", "/onboarding/session", S);
  check(resumed.json?.mode === "ai" && resumed.json?.currentStep === 8,
    "and the wizard would open there, on the same draft",
    `${resumed.json?.mode} @ ${resumed.json?.currentStep}`);

  // ─────────────────────────── 6. the same commit, through the same pipeline
  console.log("\nThe conversation's draft commits exactly as the wizard's does:");
  const commit = (step) => call("POST", `/onboarding/commit/${step}`, S);
  check((await commit(2)).json?.created?.academicYears === 1, "step 2 — the session");

  const yearId = (await call("GET", "/academic-years", S)).json.find((y) => y.name === "ZZIN 2026-27").id;
  for (const w of answers.wings) await call("POST", "/timetable-configs", S, { name: w.name, academicYearId: yearId });
  const configs = (await call("GET", "/timetable-configs", S)).json;
  check(configs.length === 2, "step 3 — a timetable per wing", `${configs.length}`);

  const classes = await commit(4);
  check(classes.json?.created?.classes === 7 && classes.json?.created?.classSections === 14,
    "step 4 — 7 classes, 14 sections", JSON.stringify(classes.json?.created));

  for (const cfg of configs) {
    const week = answers.weeks[cfg.name];
    await call("PUT", `/timetable-configs/${cfg.id}/structure`, S, {
      startTime: week.startTime, periodsPerDay: week.periodsPerDay,
      periodDurationMins: week.periodDurationMins, workingDays: week.workingDays, breaks: week.breaks,
    });
  }
  check((await prisma.period.count({ where: { schoolId } })) === 18, "step 5 — the week, per wing", "18 rows");

  check((await commit(6)).json?.created?.subjects === 5, "step 6 — the subjects");
  const teachers = await commit(7);
  check(teachers.json?.created?.teachers === people.length, "step 7 — the teachers",
    JSON.stringify(teachers.json?.created));

  const rooms = await commit(8);
  check(rooms.json?.created?.rooms > 0, "step 8 — rooms, proposed from what was said",
    JSON.stringify(rooms.json?.created));
  const cur = await commit(9);
  check(cur.json?.created?.curriculum > 0, "step 9 — a curriculum", JSON.stringify(cur.json?.created));
  const map = await commit(10);
  check((map.json?.issues ?? []).length === 0, "step 10 — every subject covered",
    (map.json?.issues ?? [])[0]?.message ?? "all covered");
  check((await call("POST", "/onboarding/finish", S)).status < 300, "step 11 — settings written");

  // The only question that matters, asked of a school nobody typed.
  console.log("\nAnd the school it described can generate:");
  for (const cfg of configs) {
    const r = await call("GET", `/timetable-configs/${cfg.id}/readiness`, S);
    check(r.json?.score === 100 && (r.json?.blockers ?? []).length === 0,
      `${cfg.name} is at 100% readiness`,
      `${r.json?.score}% · ${(r.json?.blockers ?? []).length} blocker(s)` +
      ((r.json?.blockers ?? [])[0] ? `: ${r.json.blockers[0].message.slice(0, 80)}` : ""));
  }

  // ──────────────────────── 7. THE CONVERSATION SURVIVES LEAVING
  //
  // Deliberately LAST: it finishes the setup and starts a fresh one, which
  // supersedes the draft everything above was built from. Run earlier it
  // quietly emptied the answers and the commit steps failed several checks
  // later, naming the wrong cause.
  console.log("\nThe conversation survives leaving and coming back:");
  //
  // Half a setup is twenty minutes of somebody's afternoon. The answers always
  // survived a refresh; the transcript did not, so coming back showed an empty
  // thread beside a panel full of collected facts.
  //
  // Read through the real endpoint rather than the dev seam, because what is
  // under test is the STORED conversation — and the assistant's own questions
  // were being written to it empty (they arrive in the tool call, not in the
  // streamed prose), so the record held one side of a conversation.
  // Two turns SEEDED straight into the audit log, because this suite has no
  // model in it: what is under test is the reader — the window, the ordering,
  // the empty-row filter — and that is not a property of the model either. The
  // live path was verified by hand against the real provider; asserting on an
  // empty list here would have been a check that passes by having nothing to
  // check.
  // A live run to read: section 6 ended with `finish`, and a finished setup
  // deliberately shows no live conversation. Beginning one here is also what
  // stamps the boundary the rows below have to fall after.
  await call("PUT", "/onboarding/session", S, { currentStep: 1, mode: "ai" });
  const me = await prisma.user.findFirst({ where: { schoolId }, orderBy: { id: "asc" } });
  const cid = `setup-${schoolId}-${me.id}`;
  await prisma.aiChatLog.createMany({
    data: [
      { schoolId, userId: me.id, conversationId: cid, role: "user", content: "The school is ZZIN Guided School" },
      { schoolId, userId: me.id, conversationId: cid, role: "assistant", content: "Which session are we setting up?" },
      // An assistant row logged EMPTY is what the bug looked like: the question
      // arrives in the tool call, not in the streamed prose, so the record held
      // one side of a conversation. It must not be rendered as a blank bubble.
      { schoolId, userId: me.id, conversationId: cid, role: "assistant", content: "" },
      // Tool traffic is audit, not conversation, and belongs to neither side.
      { schoolId, userId: me.id, conversationId: cid, role: "tool", content: "{\"recorded\":[]}" },
    ],
  });

  const stored = await call("GET", "/onboarding/interview", S);
  check(stored.status < 300, "the conversation can be read back", `${stored.status}`);
  const lines = stored.json?.lines ?? [];
  check(lines.length === 2, "with both sides of it, and nothing else",
    lines.map((l) => l.who).join(" → ") || "empty");
  check(lines[0]?.who === "you" && lines[1]?.who === "assistant",
    "in the order it happened");
  check(lines.every((l) => typeof l.text === "string" && l.text.trim() !== ""),
    "and no blank bubbles — an assistant row logged empty is half a conversation");

  // A finished setup is not a live conversation, and starting again begins a
  // clean thread — without deleting anything, because the monthly AI token
  // budget is summed from `ai_chat_log` and clearing it would refund the cost.
  const rowsNow = async () => Number((await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM ai_chat_log WHERE school_id = ${schoolId}`))[0].n);
  const beforeRows = await rowsNow();
  await call("POST", "/onboarding/finish", S);
  check(((await call("GET", "/onboarding/interview", S)).json?.lines ?? []).length === 0,
    "a finished setup shows no live conversation");
  await call("PUT", "/onboarding/session", S, { currentStep: 1, mode: "ai" });
  check(((await call("GET", "/onboarding/interview", S)).json?.lines ?? []).length === 0,
    "and starting again begins a clean thread rather than replaying the last one");
  check((await rowsNow()) >= beforeRows,
    "…while the audit log keeps every row — deleting it would refund the tokens it cost",
    `${beforeRows} rows kept`);


  // ───────────────────────────────────────────────────────────── cleanup
  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { name: { startsWith: "ZZIN " } } })) === 0, "test school removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
  console.log(failed ? "\nSOME INTERVIEW CHECKS FAILED" : "\nALL INTERVIEW CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
