/**
 * §28 — the body-limit fix, proved at the size that broke it.
 *
 * Second Branch has 957 subject mappings; that one key of a guided-setup draft
 * is 98kb, and the whole draft is 145kb against Express's 100kb default.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const API = process.env.API_INTERNAL || "http://localhost:3000";

let failed = 0;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = 1;
};

(async () => {
  const prisma = new PrismaClient();
  // The same two-hop the isolation sweep uses: a stub ERP token, then the SSO
  // callback, which is what actually mints a session.
  const erp = await (await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ erpUserId: "ZZBODY-admin", erpRole: "ADMIN", name: "Body Size", email: "body@zzbody.test", schoolId: 1 }),
  })).json();
  const cb = await fetch(`${API}/api/sso/callback?token=${erp.token}`, { redirect: "manual" });
  const token = (cb.headers.get("location") || "").split("#token=")[1];
  if (!token) { console.log("  FAIL  could not obtain a session"); process.exit(1); }
  const put = (body) => fetch(`${API}/api/onboarding/session`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  console.log("\nA draft the size a real school actually produces:");
  const mappings = Array.from({ length: 957 }, (_, i) => ({
    employeeCode: `EDX-${1000 + (i % 122)}`,
    subjectName: "Mathematics",
    classSections: [`Class ${(i % 16) + 1}-${"ABCD"[i % 4]}`],
    periodsPerWeek: 6,
  }));
  const teachers = Array.from({ length: 122 }, (_, i) => ({
    name: `Teacher Number ${i}`, employeeCode: `EDX-${1000 + i}`,
    subjects: ["Mathematics", "Science"], maxPeriodsPerDay: 6, maxPeriodsPerWeek: 30,
    canSubstitute: true, employmentType: "permanent",
  }));
  const curriculum = Array.from({ length: 320 }, (_, i) => ({
    className: `Class ${(i % 16) + 1}`, subjectName: "Mathematics", periodsPerWeek: 6, maxPerDay: 2,
  }));
  const answers = { mappings, teachers, curriculum };
  const kb = Math.round(JSON.stringify({ currentStep: 9, answers, mode: "wizard" }).length / 1024);
  console.log(`  (payload is ${kb} KB — the default limit is 100)`);

  const res = await put({ currentStep: 9, answers, mode: "wizard" });
  const text = await res.text();
  check(res.status < 300, `a ${kb} KB draft is accepted`, `${res.status}${res.status >= 300 ? " " + text.slice(0, 60) : ""}`);
  check(!text.includes("too large"), "and not refused as an entity too large");

  const row = await prisma.$queryRawUnsafe(
    "SELECT LENGTH(answers) b FROM onboarding_sessions ORDER BY updated_at DESC LIMIT 1");
  check(Number(row[0].b) > 100 * 1024, "and it really landed in the database",
    `${Math.round(Number(row[0].b) / 1024)} KB stored`);

  console.log("\nThe delta the wizard now sends for one step:");
  const small = { subjects: Array.from({ length: 20 }, (_, i) => ({ name: `Subject ${i}`, code: `S${i}` })) };
  const smallKb = Math.round(JSON.stringify(small).length / 1024);
  const r2 = await put({ currentStep: 6, answers: small, mode: "wizard" });
  check(r2.status < 300, `${smallKb} KB instead of ${kb} KB`, `${r2.status}`);
  // The server MERGES, so a partial payload must not wipe the keys it omits —
  // which is the whole reason the client may send one.
  const after = await prisma.$queryRawUnsafe(
    "SELECT answers FROM onboarding_sessions ORDER BY updated_at DESC LIMIT 1");
  const stored = typeof after[0].answers === "string" ? JSON.parse(after[0].answers) : after[0].answers;
  check(Array.isArray(stored.mappings) && stored.mappings.length === 957,
    "and the 957 mappings it did NOT mention are still there",
    `${stored.mappings?.length ?? 0} mappings · ${stored.subjects?.length ?? 0} subjects`);

  console.log("\nA step whose defaults nobody typed into still commits:");
  /*
    The wizard shows a filled-in session — name, start, end — and writes it to
    the draft only when a field is EDITED. Somebody who agrees with all three
    therefore leaves `answers.session` undefined, and the old code tried to fix
    that with a `patch` on the line above `persist`, which cannot work: `patch`
    schedules a state update and `persist` reads the render that scheduled it.
    The draft went up without a session and the commit answered "There is
    nothing to create yet" — on the commonest path through the step.

    This asserts the SHAPE the fixed client sends: the default, explicitly.
  */
  await put({ currentStep: 2, answers: { session: { name: "ZZBODY 2026-27", startDate: "2026-04-01", endDate: "2027-03-31" } }, mode: "wizard" });
  const commit = await fetch(`${API}/api/onboarding/commit/2`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
  });
  const cj = await commit.json().catch(() => ({}));
  check(commit.status < 300 && (cj.created?.academicYears ?? 0) > 0,
    "an untouched session default is committed, not refused",
    `${commit.status} ${JSON.stringify(cj.created ?? cj.message ?? "")}`.slice(0, 70));
  await prisma.academicYear.deleteMany({ where: { name: "ZZBODY 2026-27" } });

  console.log("\nSomething that could only be a mistake is still refused:");
  const huge = { junk: "x".repeat(3 * 1024 * 1024) };
  const r3 = await put({ currentStep: 1, answers: huge });
  check(r3.status === 413, "a 3 MB body is rejected", `${r3.status}`);

  await prisma.onboardingSession.deleteMany({ where: { currentStep: { in: [6, 9] }, schoolId: 1 } });
  await prisma.$disconnect();
  console.log(failed ? "\nSOME BODY-SIZE CHECKS FAILED" : "\nALL BODY-SIZE CHECKS PASSED");
  process.exit(failed);
})();
