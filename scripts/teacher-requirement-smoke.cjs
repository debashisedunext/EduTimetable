/**
 * §37 — the teacher requirement, end to end against a real school.
 *
 * ## Why this exists on top of the unit tests
 *
 * `packages/shared` proves the arithmetic. What it cannot prove is that the
 * SNAPSHOT handed to it describes the school — and every one of the ways that
 * goes wrong is silent, because a wrong snapshot still produces a confident
 * number:
 *
 *  - a curriculum read for the wrong academic year (§3.11) gives zero demand
 *    and reports a fully staffed school;
 *  - a teacher's load summed over this timetable rather than the whole §30 pool
 *    reports spare capacity that is already spent;
 *  - `timetable_subjects` read as "teaches only these" when it is empty
 *    (invariant 7) reports every subject as not taught;
 *  - and the two facts the curriculum table simply does not contain — a §4.10
 *    merged group and a §4.9 elective — are the ones a naive reader misses
 *    entirely.
 *
 * So the school here is built through the ordinary endpoints and then asked.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zztr.test";
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
      where: { name: { startsWith: "ZZTR" } }, select: { id: true, code: true },
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

  console.log("\nA school with one class of three sections:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZTR Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZTR School" });
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;
  const save = (step, answers) => call("PUT", "/onboarding/session", S, { currentStep: step, answers, mode: "wizard" });

  await save(3, {
    school: { name: "ZZTR School" },
    session: { name: "ZZTR 2026-27", startDate: "2026-04-01", endDate: "2027-03-31" },
  });
  await call("POST", "/onboarding/commit/2", S);
  const yearId = (await call("GET", "/academic-years", S)).json[0].id;
  await call("POST", "/timetable-configs", S, { name: "Main", academicYearId: yearId });
  const cfg = (await call("GET", "/timetable-configs", S)).json[0];
  // CLASS_LADDER is 0-indexed and index 4 is "Class 1".
  await save(5, { wings: [{ name: "Main", fromIndex: 4, toIndex: 4, sections: 3 }] });
  await call("POST", "/onboarding/commit/4", S);
  await call("PUT", `/timetable-configs/${cfg.id}/structure`, S, {
    periodsPerDay: 8, periodDurationMins: 40, startTime: "08:00", workingDays: [1, 2, 3, 4, 5], breaks: [],
  });
  await save(7, { subjects: [{ name: "Mathematics" }, { name: "Music" }, { name: "French" }, { name: "German" }] });
  await call("POST", "/onboarding/commit/6", S);

  const subjects = Object.fromEntries((await call("GET", "/subjects", S)).json.map((s) => [s.name, s.id]));
  const classId = (await call("GET", "/classes", S)).json[0].id;
  const sections = (await call("GET", "/class-sections", S)).json;
  const report = async (q = "") => (await call("GET", `/timetable-configs/${cfg.id}/teacher-requirement${q}`, S)).json;
  const of = (r, name) => r.subjects.find((s) => s.name === name);

  // ── 1. DEMAND is a class fact × sections ────────────────────────────
  await call("POST", "/class-subjects", S, {
    classId, subjectId: subjects.Mathematics, academicYearId: yearId, periodsPerWeek: 6,
  });
  let r = await report();
  check(
    of(r, "Mathematics")?.demand === 18,
    "6 periods a week for a class of 3 sections is 18, not 6 — the class/section mistake",
    `${of(r, "Mathematics")?.demand}`,
  );
  check(
    of(r, "Mathematics")?.breakdown?.[0]?.sections === 3,
    "and the breakdown shows the multiplication, so the number can be defended",
  );
  check(
    of(r, "Mathematics")?.qualified?.length === 0 && of(r, "Mathematics")?.short === 18,
    "with nobody able to teach it, every period is short",
    `short ${of(r, "Mathematics")?.short}`,
  );

  // ── 2. A teacher, and the divisor ───────────────────────────────────
  await call("POST", "/teachers", S, { name: "Asha Rao", employeeCode: "T1", maxPeriodsPerWeek: 30 });
  const asha = (await call("GET", "/teachers", S)).json[0];
  await call("POST", "/mappings", S, {
    teacherId: asha.id, subjectId: subjects.Mathematics, classSectionId: sections[0].id, periodsPerWeek: 6,
  });
  r = await report();
  const maths = of(r, "Mathematics");
  check(maths.assigned === 6 && maths.gap === 12, "one section staffed leaves the other two", `gap ${maths.gap}`);
  check(
    maths.qualified.includes(asha.id),
    "a MAPPED teacher counts as qualified even with nothing declared — §27.13 arrived late",
  );
  check(
    maths.covered === 12 && maths.short === 0,
    "and her 24 free periods cover the rest, so no hire is implied",
    `covered ${maths.covered}`,
  );

  // ── 3. The divisor is a policy, and it is the caller's ──────────────
  await call("POST", "/class-subjects", S, {
    classId, subjectId: subjects.Music, academicYearId: yearId, periodsPerWeek: 10,
  });
  r = await report("?targetLoad=30");
  const at30 = r.totals.teachersNeeded;
  const at20 = (await report("?targetLoad=20")).totals.teachersNeeded;
  check(at30 > 0, "unstaffed teaching produces a requirement", `${at30.toFixed(2)} at 30/wk`);
  check(
    Math.abs(at20 - at30 * 1.5) < 0.001,
    "and halving nobody's work while lowering the divisor scales it exactly — the last step is a division",
    `${at20.toFixed(2)} at 20/wk`,
  );

  // ── 4. §4.10 — a merged group costs ONE lesson, not one per section ──
  const before = of(await report(), "Music").demand;
  await call("POST", "/merged-groups", S, {
    subjectId: subjects.Music, teacherId: asha.id,
    classSectionIds: sections.map((s) => s.id), periodsPerWeek: 10,
  });
  const after = of(await report(), "Music").demand;
  check(
    after < before,
    "a merged group of 3 sections is subtracted — one teacher, one lesson (§4.10)",
    `${before} → ${after}`,
  );
  check(
    of(await report(), "Music").breakdown.some((b) => b.kind === "merged" && b.periods < 0),
    "and the subtraction is shown as its own line rather than folded into the total",
  );

  // ── 5. §4.9 — an elective's options belong to no class-section ──────
  await call("POST", "/rooms", S, { name: "R1", capacity: 40 });
  const roomId = (await call("GET", "/rooms", S)).json[0].id;
  /*
    TWO teachers and TWO rooms, because the options of a block run at the same
    time — §4.9's whole point. The route refuses one teacher on two options,
    correctly, and the first version of this smoke was refused by it.
  */
  await call("POST", "/rooms", S, { name: "R2", capacity: 40 });
  const roomB = (await call("GET", "/rooms", S)).json.find((x) => x.name === "R2").id;
  await call("POST", "/teachers", S, { name: "Opt One", employeeCode: "T9", maxPeriodsPerWeek: 30 });
  await call("POST", "/teachers", S, { name: "Opt Two", employeeCode: "T8", maxPeriodsPerWeek: 30 });
  const staff = (await call("GET", "/teachers", S)).json;
  const optA = staff.find((t) => t.employeeCode === "T9");
  const optB = staff.find((t) => t.employeeCode === "T8");
  const block = await call("POST", "/elective-blocks", S, {
    name: "Third Language", periodsPerWeek: 5, maxPeriodsPerDay: 1,
    classSectionIds: sections.map((s) => s.id),
    options: [
      { subjectId: subjects.French, teacherId: optA.id, roomId },
      { subjectId: subjects.German, teacherId: optB.id, roomId: roomB },
    ],
  });
  /*
    The status is checked, and that is the point of this line.

    The first version of this smoke posted options with no teacher or room, got
    a 400 it never looked at, and then asserted `!of(r,"French")?.breakdown` —
    which is TRUE when French is missing from the report entirely. A green tick
    for a subject that was never created. An assertion that passes when the
    thing under test is absent is worse than no assertion.
  */
  check(block.status === 201, "the block was actually created", `HTTP ${block.status} ${block.text.slice(0, 90)}`);
  r = await report();
  const fr0 = of(r, "French");
  check(
    fr0?.demand === 5 && of(r, "German")?.demand === 5,
    "both options of a block need a teacher for the same 5 periods (§4.9)",
    `French ${fr0?.demand} · German ${of(r, "German")?.demand}`,
  );
  check(
    !!fr0 && !fr0.breakdown.some((b) => b.kind === "curriculum")
      && fr0.breakdown.some((b) => b.kind === "elective"),
    "and they arrive with no curriculum row at all — what a `class_subjects` reader misses entirely",
    fr0 ? fr0.breakdown.map((b) => b.kind).join(",") : "French missing from the report",
  );

  // ── 6. SHARED capacity is spent once ────────────────────────────────
  /*
    The case the reference school does not exercise: one teacher qualified for
    two short subjects. A per-subject sum reports both covered; the truth is
    that her spare can only go to one of them.
  */
  await call("POST", "/teachers", S, { name: "Lang Teacher", employeeCode: "T2", maxPeriodsPerWeek: 30 });
  const lang = (await call("GET", "/teachers", S)).json.find((t) => t.employeeCode === "T2");
  await call("PUT", `/teachers/${lang.id}`, S, {
    name: "Lang Teacher", employeeCode: "T2", maxPeriodsPerWeek: 30,
    subjectIds: [subjects.French, subjects.German],
  });
  await call("POST", "/class-subjects", S, {
    classId, subjectId: subjects.French, academicYearId: yearId, periodsPerWeek: 10,
  });
  await call("POST", "/class-subjects", S, {
    classId, subjectId: subjects.German, academicYearId: yearId, periodsPerWeek: 10,
  });
  r = await report("?targetLoad=30");
  const fr = of(r, "French"), de = of(r, "German");
  const sharedCovered = fr.covered + de.covered;
  check(
    fr.qualified.includes(lang.id) && de.qualified.includes(lang.id),
    "one teacher is qualified for both short subjects — the case a naive sum gets wrong",
  );
  check(
    sharedCovered === 30,
    "her 30 free periods are spent ONCE across the two — a naive sum would claim 60",
    `covered ${fr.covered} + ${de.covered} = ${sharedCovered} against a 30 cap`,
  );
  check(
    fr.short + de.short > 0,
    "so the pair is still reported short rather than as comfortably covered",
    `short ${fr.short} + ${de.short}`,
  );

  // ── 7. §32 — "not stated" is every subject, never none ──────────────
  const all = await report();
  check(all.subjects.length >= 4, "with no §32 narrowing, every taught subject is reported", `${all.subjects.length}`);
  await prisma.timetableSubject.create({
    data: { schoolId, timetableConfigId: cfg.id, subjectId: subjects.Mathematics },
  });
  const narrowed = await report();
  check(
    narrowed.subjects.length === 1 && narrowed.subjects[0].name === "Mathematics",
    "and once it narrows, only the declared subject is — the other direction of invariant 7",
    `${narrowed.subjects.map((s) => s.name).join(", ")}`,
  );
  await prisma.timetableSubject.deleteMany({ where: { timetableConfigId: cfg.id } });

  // ── 8. It is READ-ONLY ──────────────────────────────────────────────
  const hash = async () => JSON.stringify([
    await prisma.classSubject.findMany({ where: { schoolId }, orderBy: { id: "asc" } }),
    await prisma.teacherSubjectClassSection.findMany({ where: { schoolId }, orderBy: { id: "asc" } }),
    await prisma.teacher.findMany({ where: { schoolId }, orderBy: { id: "asc" } }),
  ]);
  const beforeHash = await hash();
  await report("?targetLoad=24");
  await report();
  check(await hash() === beforeHash, "asking the question changes nothing — no curriculum, mapping or teacher moved");

  await purge();
  await prisma.$disconnect();
  await control.$disconnect();
  console.log(failed ? "\nFAILED\n" : "\nAll good.\n");
  process.exit(failed);
}

main().catch((e) => { console.error(e); process.exit(1); });
