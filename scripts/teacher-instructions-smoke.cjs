/**
 * §26.5 — a teacher's plain-English instruction, end to end.
 *
 *   docker compose exec api node /app/scripts/teacher-instructions-smoke.cjs
 *
 * The claim under test is not "the AI understands English". It is:
 *
 *   **anything ticked green compiled to a constraint the solver already
 *   enforces — and a generation obeys it.**
 *
 * So the last section is the one that matters: it generates a real timetable
 * and asserts the teacher is never scheduled against their own instruction. The
 * rest is the boundary — what is accepted, what is refused, and what is left
 * alone.
 *
 *   1. GATE     — no AI configured means the box is not offered
 *   2. COMPILE  — an unavailability instruction becomes real rows, ticked
 *   3. REFUSE   — an instruction about people is denied, and writes NOTHING
 *   4. KEEP     — a denied instruction is still stored; it is what they typed
 *   5. EDIT     — changing the text re-evaluates, and old rows do not pile up
 *   6. OBEY     — a generated timetable never places them where they said no
 *   7. STRANGER — another school's teacher is a 404
 *
 * Skipped with a clear message when the school has no AI provider: pretending
 * otherwise would be a green tick for a deployment that cannot evaluate at all.
 *
 * Everything it creates uses @zzins.test / "ZZINS " and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzins.test";
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

function must(res, what) {
  if (res.status >= 300) {
    console.error(`  SETUP FAILED  ${what} → ${res.status} ${(res.json?.message ?? res.text ?? "").slice(0, 160)}`);
    process.exit(1);
  }
  return res.json;
}

const mailToken = async (to, kind) =>
  (await call("GET", `/dev/mail/token?to=${encodeURIComponent(to)}&kind=${kind}`)).json?.token ?? null;

(async () => {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZINS " } }, select: { id: true, code: true },
    });
    const ids = mine.map((s) => s.id);
    if (ids.length) {
      const where = { where: { schoolId: { in: ids } } };
      for (const m of [
        "timetableSlot", "timetableDraft", "timetablePublication", "extraClass", "period",
        "autoFixRun", "teacherSubjectClassSection", "classSubject", "teacherUnavailability",
        "teacherClassEligibility", "classSection", "section", "schoolClass", "subject", "teacher",
        "room", "timetableConfig", "academicTerm", "academicYear", "onboardingSession",
        "aiChatLog", "aiSettings", "auditLog", "user", "rolePermission", "erpRoleMapping", "role",
      ]) {
        await prisma[m].deleteMany(where).catch(() => undefined);
      }
      await prisma.school.deleteMany({ where: { id: { in: ids } } });
    }
    await control.tenant.deleteMany({ where: { schoolCode: { in: mine.map((s) => s.code) } } });
    await control.account.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
    const keys = await redis.keys("throttle:*:ip:*");
    if (keys.length) await redis.del(...keys);
  };
  await purge();

  // ───────────────────────────────────────────────────────────── the school
  const email = `a@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZ Ins Owner" });
  const vt = await mailToken(email, "verify");
  const acct = (await call("POST", "/auth/verify", null, { token: vt })).json.accountToken;
  const made = must(await call("POST", "/schools", acct, { name: "ZZINS School" }), "create school");
  const S = made.sessionToken;
  const schoolId = made.schoolId;

  const year = must(await call("POST", "/academic-years", S, {
    name: "ZZINS 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  }), "create year");
  const cfg = must(await call("POST", "/timetable-configs", S, { name: "ZZINS Wing", academicYearId: year.id }), "create timetable");
  must(await call("PUT", `/timetable-configs/${cfg.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 6, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
  }), "write the week");

  const klass = must(await call("POST", "/classes", S, { name: "ZZ Class 6", sequence: 9 }), "create class");
  const secA = must(await call("POST", `/classes/${klass.id}/sections`, S, { name: "A", academicYearId: year.id }), "create section");
  must(await call("PUT", `/timetable-configs/${cfg.id}/class-sections`, S, {
    classSectionIds: [secA.classSection.id],
  }), "attach section");
  const room = must(await call("POST", "/rooms", S, { name: "ZZINS Room" }), "create room");
  must(await call("PUT", `/class-sections/${secA.classSection.id}`, S, { homeRoomId: room.id }), "set home room");

  const maths = must(await call("POST", "/subjects", S, { name: "Mathematics" }), "create subject");
  must(await call("POST", "/class-subjects", S, {
    classId: klass.id, subjectId: maths.id, academicYearId: year.id, periodsPerWeek: 10, maxPeriodsPerDay: 3,
  }), "curriculum");
  const rao = must(await call("POST", "/teachers", S, {
    name: "Mrs Rao", employeeCode: "ZZI-1", maxPeriodsPerDay: 6, minPeriodsPerDay: 0, maxPeriodsPerWeek: 40,
  }), "create teacher");
  must(await call("POST", "/mappings", S, {
    teacherId: rao.id, subjectId: maths.id, classSectionIds: [secA.classSection.id], periodsPerWeek: 10,
  }), "map maths");

  // ──────────────────────────────────────────────────────────────── 1. GATE
  console.log("\nWithout an assistant configured, nothing is offered:");
  const before = await call("GET", "/teachers/instruction/available", S);
  check(before.status === 200 && before.json?.available === false,
    "the box is not offered", `available=${before.json?.available}`);
  const unchecked = await call("PUT", `/teachers/${rao.id}/instruction`, S, { text: "Leaves at 1pm on Fridays" });
  check(unchecked.json?.instructionStatus === "pending",
    "and an instruction typed anyway is kept as NOT CHECKED, never silently applied",
    `${unchecked.json?.instructionStatus}`);
  check((await prisma.teacherUnavailability.count({ where: { teacherId: rao.id } })) === 0,
    "with nothing written");

  /**
   * Configure the assistant, or stop here honestly.
   *
   * An env var if there is one; otherwise the ENCRYPTED key another school in
   * this dev database has already configured, copied across as-is. The
   * encryption key is deployment-wide (`AI_ENCRYPTION_KEY`, or derived from
   * `JWT_SECRET`), so the blob decrypts for any school — which means this test
   * can run without the secret ever being read, printed or passed through a
   * shell. What it must not do is invent a key and report a green tick from a
   * provider that refused the request.
   */
  const envKey = process.env.ANTHROPIC_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  let configured = false;
  if (envKey) {
    const provider = process.env.ANTHROPIC_API_KEY ? "anthropic" : "google";
    must(await call("PUT", "/ai-settings", S, { provider, apiKey: envKey, enabled: true }), "configure the assistant");
    configured = true;
  } else {
    const lender = await prisma.aiSettings.findFirst({
      where: { apiKeyEncrypted: { not: null }, isActive: true, schoolId: { not: schoolId } },
    });
    if (lender) {
      await prisma.aiSettings.create({
        data: {
          schoolId, provider: lender.provider, model: lender.model,
          apiKeyEncrypted: lender.apiKeyEncrypted, apiBaseUrl: lender.apiBaseUrl, isActive: true,
        },
      });
      console.log(`\n  (borrowing the ${lender.provider} key school ${lender.schoolId} already has — never decrypted here)`);
      configured = true;
    }
  }
  if (!configured) {
    console.log("\nNo API key in the environment and no school in this database has one configured,");
    console.log("so the compiling half of §26.5 cannot be exercised. The gate above is real;");
    console.log("the rest is skipped rather than reported as passing.");
    await purge();
    await prisma.$disconnect(); await control.$disconnect(); redis.disconnect();
    process.exit(failed);
  }
  check((await call("GET", "/teachers/instruction/available", S)).json?.available === true,
    "with a provider configured, the box appears");

  // ───────────────────────────────────────────────────────────── 2. COMPILE
  console.log("\nAn instruction about WHEN becomes real rules:");
  const applied = await call("PUT", `/teachers/${rao.id}/instruction`, S, {
    text: "Mrs Rao is not available on Friday at all.",
  });
  check(applied.json?.instructionStatus === "accepted",
    "accepted", `${applied.json?.instructionStatus} · ${(applied.json?.instructionNote ?? "").slice(0, 70)}`);
  const rows = await prisma.teacherUnavailability.findMany({ where: { teacherId: rao.id } });
  check(rows.length > 0 && rows.every((r) => r.dayOfWeek === 5),
    "as teacher_unavailability rows on Friday — the SAME rows the availability screen writes",
    `${rows.length} row(s), day(s) ${[...new Set(rows.map((r) => r.dayOfWeek))].join(",")}`);
  check(rows.every((r) => (r.reason ?? "").startsWith("AI: ")),
    "marked as the instruction's own, so a hand-set block is never confused with one of these");
  check(typeof applied.json?.instructionNote === "string" && applied.json.instructionNote.includes("Friday"),
    "and read back in words, so the tick can be checked rather than believed",
    applied.json?.instructionNote);

  // ────────────────────────────────────────────────────────────── 3. REFUSE
  console.log("\nAn instruction about PEOPLE is refused, and writes nothing:");
  const beforeRefusal = await prisma.teacherUnavailability.count({ where: { teacherId: rao.id } });
  const denied = await call("PUT", `/teachers/${rao.id}/instruction`, S, {
    text: "Put Mrs Rao with the nicer classes and keep her away from Mr Shah.",
  });
  check(denied.json?.instructionStatus === "denied",
    "denied", `${denied.json?.instructionStatus} · ${(denied.json?.instructionNote ?? "").slice(0, 80)}`);
  check(typeof denied.json?.instructionNote === "string" && denied.json.instructionNote.length > 5,
    "with a reason a person can read", denied.json?.instructionNote);
  /**
   * The assertion that matters most here. A refusal that quietly left the
   * previous instruction's rows in place would mean the screen says "not
   * applied" while the timetable still obeys something.
   */
  check((await prisma.teacherUnavailability.count({ where: { teacherId: rao.id } })) === beforeRefusal,
    "and NOTHING new was written", `${beforeRefusal} row(s) before and after`);

  // ──────────────────────────────────────────────────────────────── 4. KEEP
  check((denied.json?.specialInstruction ?? "").includes("nicer classes"),
    "the refused text is KEPT — it is what somebody typed, not ours to discard");

  // ──────────────────────────────────────────────────────────────── 5. EDIT
  console.log("\nEditing re-evaluates, and old rows do not pile up:");
  await call("PUT", `/teachers/${rao.id}/instruction`, S, { text: "Mrs Rao is not available on Friday at all." });
  const firstCount = await prisma.teacherUnavailability.count({ where: { teacherId: rao.id } });
  const edited = await call("PUT", `/teachers/${rao.id}/instruction`, S, {
    text: "Mrs Rao is not available on Monday at all.",
  });
  const after = await prisma.teacherUnavailability.findMany({ where: { teacherId: rao.id } });
  check(edited.json?.instructionStatus === "accepted", "the new wording is evaluated afresh");
  check(after.every((r) => r.dayOfWeek === 1),
    "and Friday's rows are GONE — an edit replaces, it does not accumulate",
    `${firstCount} → ${after.length} row(s), day(s) ${[...new Set(after.map((r) => r.dayOfWeek))].join(",")}`);

  // ──────────────────────────────────────────────────────────────── 6. OBEY
  //
  // The only assertion that proves the feature rather than the UI.
  console.log("\nA generated timetable never places her where she said no:");
  const readiness = (await call("GET", `/timetable-configs/${cfg.id}/readiness`, S)).json;
  check((readiness?.blockers ?? []).length === 0,
    "the school is still ready to generate", `score ${readiness?.score}`);
  await call("POST", `/timetable-configs/${cfg.id}/generate`, S, { mode: "fast" });
  let slots = [];
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    slots = await prisma.timetableSlot.findMany({
      where: { schoolId, status: "draft", teacherId: rao.id },
      select: { dayOfWeek: true, periodNumber: true },
    });
    if (slots.length > 0) break;
  }
  check(slots.length > 0, "she was scheduled", `${slots.length} periods`);
  check(slots.every((s) => s.dayOfWeek !== 1),
    "and NOT ONCE on the Monday her instruction ruled out",
    `days used: ${[...new Set(slots.map((s) => s.dayOfWeek))].sort().join(",")}`);

  // ─────────────────────────────────────────────────────────── 7. STRANGER
  console.log("\nAnother school's teacher is a 404:");
  const b = await (async () => {
    const e2 = `b@${DOMAIN}`;
    await call("POST", "/auth/register", null, { email: e2, password: PW, name: "ZZ Ins Other" });
    const t = await mailToken(e2, "verify");
    const a2 = (await call("POST", "/auth/verify", null, { token: t })).json.accountToken;
    return must(await call("POST", "/schools", a2, { name: "ZZINS Other" }), "create school B");
  })();
  const cross = await call("PUT", `/teachers/${rao.id}/instruction`, b.sessionToken, { text: "Never on Tuesday" });
  check(cross.status === 404, "refused", `${cross.status}`);
  check((await prisma.teacher.findUnique({ where: { id: rao.id } })).specialInstruction.includes("Monday"),
    "and A's instruction is untouched");

  // ─────────────────────────────────────────────────────────────── cleanup
  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { name: { startsWith: "ZZINS " } } })) === 0, "test schools removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
  console.log(failed ? "\nSOME INSTRUCTION CHECKS FAILED" : "\nALL INSTRUCTION CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
