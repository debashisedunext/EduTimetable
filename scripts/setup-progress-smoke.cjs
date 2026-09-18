/**
 * §24.9 — the guided setup's progress is a fact about the timetable, not a
 * memory of where somebody clicked.
 *
 * ## What it proves, and why each one is here
 *
 * Every assertion below is one of the three faults as reported:
 *
 *  1. **It follows the data, not the cursor.** The draft's `current_step` is
 *     driven backwards and forwards between reads and the answer does not
 *     move. This is the whole bug: `current_step` is where a person last was,
 *     and a finished school that opened the wizard to look at step 3 read 20%
 *     for ever.
 *  2. **It reaches 100%, and says so.** Generating is the last milestone, so a
 *     generated timetable reports `generated: true` and nothing outstanding.
 *  3. **It is per timetable.** Two wings in one school, at different stages,
 *     report different numbers — the old bar drew one figure above both.
 *
 * Plus the one that would be silently wrong: a **published** timetable still
 * counts as generated. Its slots are `status: published` and its draft can be
 * empty, so counting drafts alone would report the most finished school in the
 * building as never having generated anything.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzpg.test";
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

const PURGE = ["onboardingSession", "timetableFixedLesson", "timetableSlot", "timetableDraft",
  "timetablePublication", "teacherSubjectClassSection", "teacherClassEligibility", "teacherSubject",
  "subjectClass", "roomSubject", "timetableSubject", "timetableClassSpan", "timetableDayShape",
  "period", "classSubject", "classSection", "section", "subject", "schoolClass", "teacher", "room",
  "timetableConfig", "timetableGroup", "academicYear", "notification", "auditLog", "user",
  "rolePermission", "erpRoleMapping", "role"];

async function main() {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZPG" } }, select: { id: true, code: true },
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

  console.log("\nA school with two wings at different stages:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZPG Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZPG School" });
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;
  const save = (step, answers) => call("PUT", "/onboarding/session", S, { currentStep: step, answers, mode: "wizard" });
  const progress = async () => (await call("GET", "/onboarding/progress", S)).json;

  await save(3, {
    school: { name: "ZZPG School" },
    session: { name: "ZZPG 2026-27", startDate: "2026-04-01", endDate: "2027-03-31" },
  });
  await call("POST", "/onboarding/commit/2", S);
  const yearId = (await call("GET", "/academic-years", S)).json[0].id;
  await call("POST", "/timetable-configs", S, { name: "Alpha", academicYearId: yearId });
  await call("POST", "/timetable-configs", S, { name: "Beta", academicYearId: yearId });
  const configs = (await call("GET", "/timetable-configs", S)).json;
  const alpha = configs.find((c) => c.name === "Alpha");
  const beta = configs.find((c) => c.name === "Beta");

  const bare = await progress();
  check(Array.isArray(bare) && bare.length === 2, "one row per timetable, not one for the school", `${bare?.length} row(s)`);
  check(
    bare.every((p) => p.done === 0 && p.pct === 0 && !p.generated),
    "a brand-new timetable is at 0 with nothing ticked",
  );
  check(
    bare[0].nextLabel === "Classes",
    "and the first thing outstanding is named",
    String(bare[0].nextLabel),
  );

  // ─────────────── ALPHA gets a whole school; BETA gets nothing
  await save(5, { wings: [{ name: "Alpha", fromIndex: 4, toIndex: 4, sections: 1 }] });
  await call("POST", "/onboarding/commit/4", S);
  await call("PUT", `/timetable-configs/${alpha.id}/structure`, S, {
    periodsPerDay: 4, periodDurationMins: 40, startTime: "08:00", workingDays: [1, 2, 3, 4, 5], breaks: [],
  });
  await save(7, { subjects: [{ name: "Mathematics" }, { name: "English" }] });
  await call("POST", "/onboarding/commit/6", S);

  const subjects = (await call("GET", "/subjects", S)).json;
  const classes = (await call("GET", "/classes", S)).json;
  const sections = (await call("GET", "/class-sections", S)).json;
  await call("POST", "/rooms", S, { name: "R1", capacity: 40 });
  await call("POST", "/teachers", S, { name: "Asha Rao", employeeCode: "T1", maxPeriodsPerWeek: 30 });
  const teacher = (await call("GET", "/teachers", S)).json[0];

  const half = await progress();
  const a1 = half.find((p) => p.id === alpha.id);
  const b1 = half.find((p) => p.id === beta.id);
  check(
    a1.done > b1.done,
    "the two wings report DIFFERENT numbers — the old bar drew one figure above both",
    `Alpha ${a1.done}/${a1.total} · Beta ${b1.done}/${b1.total}`,
  );
  check(
    b1.steps.find((s) => s.key === "subjects").done && !b1.steps.find((s) => s.key === "classes").done,
    "school-wide facts are shared, per-timetable facts are not — Beta has the subjects and none of the classes",
  );

  /*
    THE BUG, as a controlled experiment.

    The cursor is driven to step 3 and then to step 10 between two reads, with
    nothing else touched. The old bar answered 20% and then 90%; this must not
    move at all.
  */
  const before = await progress();
  await save(3, {});
  const atThree = await progress();
  await save(10, {});
  const atTen = await progress();
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  check(
    same(before, atThree) && same(before, atTen),
    "moving the wizard's cursor from 3 to 10 changes NOTHING — the bar measures the school, not the click",
    `${before.find((p) => p.id === alpha.id).pct}% throughout`,
  );

  // ─────────────── finish ALPHA and generate
  for (const c of classes) {
    for (const s of subjects) {
      await call("POST", "/class-subjects", S, {
        classId: c.id, subjectId: s.id, academicYearId: yearId, periodsPerWeek: 5,
      });
    }
  }
  for (const cs of sections) {
    for (const s of subjects) {
      await call("POST", "/mappings", S, {
        teacherId: teacher.id, subjectId: s.id, classSectionId: cs.id, periodsPerWeek: 5,
      });
    }
  }
  const ready = await progress();
  const a2 = ready.find((p) => p.id === alpha.id);
  check(
    a2.nextLabel === "Generated" && !a2.generated,
    "with everything entered, the only thing left is the generation itself",
    `${a2.done}/${a2.total} · next ${a2.nextLabel}`,
  );

  /*
    A real generation would need the worker; what the milestone actually reads
    is "are there slots for this timetable", so the slots are written directly.
    That is the fact under test — not how they got there.
  */
  const draft = await prisma.timetableDraft.create({
    data: { schoolId, timetableConfigId: alpha.id, draftNo: 1, label: "d1" },
  });
  await prisma.timetableSlot.create({
    data: {
      schoolId, timetableConfigId: alpha.id, draftId: draft.id,
      classSectionId: sections[0].id, subjectId: subjects[0].id, teacherId: teacher.id,
      dayOfWeek: 1, periodNumber: 1, status: "draft", source: "auto",
    },
  });

  const done = await progress();
  const a3 = done.find((p) => p.id === alpha.id);
  check(a3.generated && a3.pct === 100, "a generated timetable reads 100%", `${a3.done}/${a3.total} · ${a3.pct}%`);
  check(a3.nextStep === null && a3.nextRoute === null, "with nothing outstanding to point at");
  check(!a3.published, "and it is not claimed to be published, which is a different fact");

  const b3 = done.find((p) => p.id === beta.id);
  check(b3.pct < 100, "while the other wing is still where it was", `Beta ${b3.pct}%`);

  /*
    The silent one. Publishing flips those rows to `status: published` and can
    leave the draft empty — so a check that counted drafts alone would report
    the most finished timetable in the school as never generated.
  */
  await prisma.timetableSlot.updateMany({
    where: { timetableConfigId: alpha.id }, data: { status: "published", draftId: null },
  });
  await prisma.timetablePublication.create({
    data: { schoolId, timetableConfigId: alpha.id, version: 1, slotCount: 1, changedCount: 1, unallocatedCount: 0 },
  });
  const live = (await progress()).find((p) => p.id === alpha.id);
  check(live.generated && live.pct === 100, "a PUBLISHED timetable still counts as generated — its slots are not drafts");
  check(live.published, "and is reported as published");

  // §18 extras are not a generated week.
  await prisma.timetableSlot.updateMany({ where: { timetableConfigId: beta.id }, data: {} });
  await prisma.timetableSlot.create({
    data: {
      schoolId, timetableConfigId: beta.id, classSectionId: sections[0].id,
      subjectId: subjects[0].id, teacherId: teacher.id,
      dayOfWeek: 1, periodNumber: 9, status: "published", source: "extra",
    },
  });
  const withExtra = (await progress()).find((p) => p.id === beta.id);
  check(!withExtra.generated, "an §18 extra class is not a generated timetable");

  // ════════════════ §39.1 — THE WELCOME PROMPT READS THE SAME MILESTONES
  //
  // Reported against a screenshot: a school whose timetable was published and
  // 100% was met at every sign-in with "Pick up where you left off — step 3 of
  // 11". `shouldPrompt` was `draft !== null || isNew`, so the mere EXISTENCE of
  // an `onboarding_sessions` row triggered it — and `completed_at` is written
  // only by pressing "Finish setup", which a school that publishes from the
  // Generate screen never does.
  //
  // The assertions are a pair, and neither means anything alone: a rule that
  // never prompts passes the first, and one that always prompts passes the
  // second.
  console.log("\nThe welcome prompt follows the same milestones:");

  // A draft, exactly as the reporting school had: open, and parked on step 3.
  await call("PUT", "/onboarding/session", S, { mode: "wizard", currentStep: 3, answers: {} });

  const withBeta = (await call("GET", "/me/onboarding", S)).json;
  const named = (st, id) => (st.unfinished ?? []).find((u) => u.id === id);
  check(withBeta.shouldPrompt === true,
    "an unfinished timetable still offers to be carried on — the resume is not lost",
    `${withBeta.unfinished?.length ?? 0} unfinished`);
  check(typeof named(withBeta, beta.id)?.name === "string",
    "and it NAMES the timetable rather than a step number",
    (withBeta.unfinished ?? []).map((u) => `${u.name} ${u.pct}%`).join(" · "));

  /*
    Now leave the school exactly as the report described it: one timetable,
    published and complete, and a draft still sitting open on step 3.

    The half-built wing is REMOVED rather than finished, because finishing it
    means walking all eight milestones again and this file has already proved
    they work. What is under test is the prompt, and the state that produced the
    screenshot is "nothing left to do, draft still open".

    Nothing about the draft changes across this line — same row, same
    `current_step`, same `completed_at: null` — so a rule reading the draft
    answers exactly as it did above. Only the milestones moved.
  */
  const removed = await call("DELETE", `/timetable-configs/${beta.id}`, S);
  check(removed.status < 300, "the half-built wing is removed", `${removed.status}`);

  const allDone = (await call("GET", "/me/onboarding", S)).json;
  check((allDone.unfinished ?? []).length === 0,
    "with every timetable complete, nothing is outstanding",
    `${(allDone.unfinished ?? []).length} unfinished`);
  check(allDone.shouldPrompt === false,
    "so the welcome dialog stays SHUT — even though the draft is still open on step 3",
    `resumeStep still ${allDone.resumeStep}`);

  await purge();
  await prisma.$disconnect();
  await control.$disconnect();
  console.log(failed ? "\nFAILED\n" : "\nAll good.\n");
  process.exit(failed);
}

main().catch((e) => { console.error(e); process.exit(1); });
