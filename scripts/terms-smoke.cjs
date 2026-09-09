/**
 * §25 Phase 26 — term-wise sessions, live.
 *
 *   docker compose exec api node /app/scripts/terms-smoke.cjs
 *
 * Step 1 of the phase: the calendar itself. Later steps extend this file with
 * the reads, the writes and the treble-count sweep.
 *
 *   1. YEAR-WISE  — a session with no terms is untouched, and SAYS it has none
 *   2. PROPOSE    — N terms split the session evenly, and write nothing
 *   3. SAVE       — the set round-trips, and re-saving keeps the same ids
 *   4. REFUSE     — overlaps, terms outside the session, one term, twin names
 *   5. TODAY      — the term containing today is the one a request gets by default
 *   6. STRANGER   — another school's session is a 404 both ways
 *   7. TEACHER    — may read the terms, may not write the calendar
 *
 * Everything it creates uses @zzterm.test / "ZZTERM " and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
// The very function the screens split dates with (§25) — asserting against the
// endpoints with it is what proves the two sides agree.
const { splitSession } = req("@edutimetable/shared");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzterm.test";
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

async function newOwnerWithSchool(email, schoolName) {
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZ Term Owner" });
  const vt = await mailToken(email, "verify");
  const acct = (await call("POST", "/auth/verify", null, { token: vt })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: schoolName });
  return { acct, session: made.json.sessionToken, schoolId: made.json.schoolId };
}

/**
 * A session spanning TODAY, so "which term is it now?" has a real answer that
 * does not rot. Built from the clock rather than hardcoded: a fixture dated
 * 2026 passes for a year and then starts failing for reasons nobody remembers.
 */
function sessionAroundToday() {
  const now = new Date();
  const y = now.getUTCFullYear();
  // Six months either side of today, snapped to month starts and ends.
  const start = new Date(Date.UTC(y, now.getUTCMonth() - 5, 1));
  const end = new Date(Date.UTC(y, now.getUTCMonth() + 7, 0));
  const iso = (d) => d.toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(end) };
}

(async () => {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZTERM " } }, select: { id: true, code: true },
    });
    const ids = mine.map((s) => s.id);
    if (ids.length) {
      const where = { where: { schoolId: { in: ids } } };
      for (const m of [
        "timetableSlot", "timetableDraft", "timetablePublication", "extraClass", "period",
        "autoFixRun", "classSection", "section", "schoolClass", "subject", "teacher", "room",
        "timetableConfig", "academicTerm", "academicYear", "onboardingSession", "aiChatLog",
        "auditLog", "user", "rolePermission", "erpRoleMapping", "role",
      ]) {
        await prisma[m].deleteMany(where).catch(() => undefined);
      }
      await prisma.school.deleteMany({ where: { id: { in: ids } } });
    }
    await control.tenant.deleteMany({ where: { schoolCode: { in: mine.map((s) => s.code) } } });
    await control.account.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
    // This suite registers four accounts from one address, and running it twice
    // in five minutes trips the sign-up throttle — which then fails every check
    // in the file with a 401 that has nothing to do with terms.
    const keys = await redis.keys("throttle:*:ip:*");
    if (keys.length) await redis.del(...keys);
  };
  await purge();

  const SESSION = sessionAroundToday();
  const a = await newOwnerWithSchool(`a@${DOMAIN}`, "ZZTERM Nalanda");
  const year = (await call("POST", "/academic-years", a.session, {
    name: "ZZTERM Session", startDate: SESSION.startDate, endDate: SESSION.endDate, isActive: true,
  })).json;
  const cfg = (await call("POST", "/timetable-configs", a.session, {
    name: "ZZTERM Primary", academicYearId: year.id,
  })).json;

  // ────────────────────────────────────────────────────────── 1. YEAR-WISE
  console.log("\nA session with no terms runs as a whole year, and says so:");
  const none = await call("GET", `/academic-years/${year.id}/terms`, a.session);
  check(none.status === 200 && Array.isArray(none.json) && none.json.length === 0,
    "it has no terms", `${none.status} · ${JSON.stringify(none.json)}`);
  const noneForConfig = await call("GET", `/timetable-configs/${cfg.id}/terms`, a.session);
  /**
   * `null` is what tells every screen to hide the term selector entirely. A
   * school that does not use terms must never meet the concept.
   */
  check(noneForConfig.json?.currentTermId === null,
    "and its timetable reports no current term — which is how the selector knows to hide",
    `${noneForConfig.json?.currentTermId}`);
  const askedAnyway = await call("GET", `/timetable-configs/${cfg.id}/terms?on=2026-11-12`, a.session);
  check(askedAnyway.json?.terms?.length === 0, "asking for a date changes nothing");

  // ─────────────────────────────────────────────────────────── 2. PROPOSE
  //
  // The split is `splitSession` from packages/shared, which the screens call in
  // the browser — there is deliberately no endpoint for it, since the guided
  // setup has to ask before the academic year exists. Calling the same function
  // here is what proves the dates a screen offers are dates the server accepts:
  // the unit tests check the arithmetic, this checks the two sides agree.
  console.log("\nThe split the screens offer is a split the server accepts:");
  const two = { json: splitSession(SESSION.startDate, SESSION.endDate, 2) };
  check(two.json.length === 2, "two terms proposed", `${two.json.length}`);
  check(two.json[0].startDate === SESSION.startDate && two.json[1].endDate === SESSION.endDate,
    "covering the session end to end",
    `${two.json[0].startDate} … ${two.json[1].endDate}`);
  check(two.json[0].name === "Term 1" && two.json[1].name === "Term 2", "named Term 1 and Term 2");
  const three = { json: splitSession(SESSION.startDate, SESSION.endDate, 3) };
  check(three.json.length === 3, "three when asked for three");
  check((await call("GET", `/academic-years/${year.id}/terms`, a.session)).json?.length === 0,
    "and none of that wrote anything — the dates on screen are a suggestion until Save");

  // ────────────────────────────────────────────────────────────── 3. SAVE
  console.log("\nSaving the set makes the session term-wise:");
  const saved = await call("PUT", `/academic-years/${year.id}/terms`, a.session, { terms: two.json });
  check(saved.status < 300 && saved.json?.length === 2, "two terms saved", `${saved.status}`);
  check(saved.json?.[0]?.id > 0 && saved.json?.[1]?.sortOrder === 2, "with ids and an order",
    `#${saved.json?.[0]?.id} · order ${saved.json?.[1]?.sortOrder}`);

  /**
   * The property that matters most here. Every slot, draft and publication will
   * point at a term id, so re-dating or renaming a term must MOVE the row the
   * timetable is filed under — never replace it with a new one and orphan a
   * term's work.
   */
  const ids = saved.json.map((t) => t.id);
  const renamed = await call("PUT", `/academic-years/${year.id}/terms`, a.session, {
    terms: saved.json.map((t, i) => ({ ...t, name: i === 0 ? "Autumn Term" : t.name })),
  });
  check(JSON.stringify(renamed.json.map((t) => t.id)) === JSON.stringify(ids),
    "re-saving KEEPS the same term ids — a rename moves the term, it does not replace it",
    `${ids.join(",")} → ${renamed.json.map((t) => t.id).join(",")}`);
  check(renamed.json?.[0]?.name === "Autumn Term", "and the new name is stored");

  // Back to three terms: the third is added, the first two keep their ids.
  const grown = await call("PUT", `/academic-years/${year.id}/terms`, a.session, {
    terms: [
      { ...renamed.json[0], endDate: three.json[0].endDate },
      { ...renamed.json[1], startDate: three.json[1].startDate, endDate: three.json[1].endDate },
      { name: "Term 3", startDate: three.json[2].startDate, endDate: three.json[2].endDate },
    ],
  });
  check(grown.status < 300 && grown.json?.length === 3, "a third term can be added", `${grown.status}`);
  check(grown.json[0].id === ids[0] && grown.json[1].id === ids[1],
    "and the two that were already there are the same rows");

  // ──────────────────────────────────────────────────────────── 4. REFUSE
  console.log("\nAn illegal calendar is refused, naming the row and the fix:");
  const overlap = await call("PUT", `/academic-years/${year.id}/terms`, a.session, {
    terms: [
      { ...grown.json[0], endDate: grown.json[1].endDate },
      grown.json[1], grown.json[2],
    ],
  });
  check(overlap.status === 400 && /Autumn Term/.test(overlap.json?.message ?? ""),
    "an overlap is refused, and BOTH terms are named",
    (overlap.json?.message ?? "").slice(0, 76));

  const outside = await call("PUT", `/academic-years/${year.id}/terms`, a.session, {
    terms: [grown.json[0], grown.json[1], { ...grown.json[2], endDate: "2099-12-31" }],
  });
  check(outside.status === 400 && /outside the session/.test(outside.json?.message ?? ""),
    "a term reaching outside the session is refused", (outside.json?.message ?? "").slice(0, 62));

  const single = await call("PUT", `/academic-years/${year.id}/terms`, a.session, {
    terms: [grown.json[0]],
  });
  check(single.status === 400 && /at least two/.test(single.json?.message ?? ""),
    "one term is not a term-wise session", (single.json?.message ?? "").slice(0, 52));

  check((await call("GET", `/academic-years/${year.id}/terms`, a.session)).json?.length === 3,
    "and after three refusals the saved calendar is exactly as it was");

  // Removing them all is how a school goes back to running the whole year.
  const cleared = await call("PUT", `/academic-years/${year.id}/terms`, a.session, { terms: [] });
  check(cleared.status < 300 && cleared.json?.length === 0,
    "clearing the list turns the session back into a whole year", `${cleared.status}`);
  await call("PUT", `/academic-years/${year.id}/terms`, a.session, { terms: grown.json.map(({ id, ...t }) => t) });

  // ───────────────────────────────────────────────────────────── 5. TODAY
  console.log("\nA request with no term gets the one today is in:");
  const live = (await call("GET", `/timetable-configs/${cfg.id}/terms`, a.session)).json;
  const today = new Date().toISOString().slice(0, 10);
  const containing = live.terms.find((t) => t.startDate <= today && today <= t.endDate);
  check(live.currentTermId === containing?.id,
    "which is the term whose dates contain today, not the first one",
    `${containing?.name} (${containing?.startDate}..${containing?.endDate})`);

  const inLast = live.terms[live.terms.length - 1];
  const onDate = await call("GET", `/timetable-configs/${cfg.id}/terms?on=${inLast.endDate}`, a.session);
  check(onDate.json?.currentTermId === inLast.id,
    "and asking about a date in another term gets THAT term — the rule the reports use",
    `${inLast.name}`);

  // ────────────────────────────────────────────────────────── 6. STRANGER
  console.log("\nAnother school's session is a 404, both reading and writing:");
  const b = await newOwnerWithSchool(`b@${DOMAIN}`, "ZZTERM Takshashila");
  const peek = await call("GET", `/academic-years/${year.id}/terms`, b.session);
  /**
   * Strictly 404, and this assertion started life as `404 || (200 && empty)` —
   * which passed while the endpoint was answering B with `200 []`. The
   * isolation gate caught what this check had been written to tolerate. An
   * empty list is indistinguishable from "that session runs as a whole year",
   * so a scoped read that matches nothing must never be a successful answer.
   */
  check(peek.status === 404, "B cannot read A's terms — 404, not an empty list",
    `${peek.status} · ${JSON.stringify(peek.json).slice(0, 40)}`);
  const write = await call("PUT", `/academic-years/${year.id}/terms`, b.session, { terms: [] });
  check(write.status === 404, "and cannot rewrite A's calendar", `${write.status}`);
  check((await call("GET", `/academic-years/${year.id}/terms`, a.session)).json?.length === 3,
    "A's three terms are still there");

  // ─────────────────────────────────────────────────────────── 7. TEACHER
  console.log("\nA teacher reads the terms and cannot change them:");
  const teacherRole = await prisma.role.findFirst({ where: { schoolId: a.schoolId, name: "Teacher" } });
  await prisma.user.create({
    data: {
      schoolId: a.schoolId, erpUserId: "local:zzterm-teacher", roleId: teacherRole.id,
      name: "ZZ Term Teacher", email: `t@${DOMAIN}`,
    },
  });
  const tToken = await (async () => {
    const t = await call("POST", "/dev/erp-token", null, {
      erpUserId: "local:zzterm-teacher", erpRole: "TEACHER", name: "ZZ Term Teacher", email: `t@${DOMAIN}`,
      school: { code: (await prisma.school.findUnique({ where: { id: a.schoolId } })).code, name: "ZZTERM Nalanda" },
    });
    const cb = await fetch(`${API}/api/sso/callback?token=${t.json.token}`, { redirect: "manual" });
    return (cb.headers.get("location") || "").split("#token=")[1];
  })();
  if (tToken) {
    // Reading is deliberately NOT masters.manage: the term selector sits on the
    // Board and the Matrix, and a 403 there would break the screen.
    check((await call("GET", `/timetable-configs/${cfg.id}/terms`, tToken)).status === 200,
      "the selector's list is readable");
    check((await call("PUT", `/academic-years/${year.id}/terms`, tToken, { terms: [] })).status === 403,
      "but the calendar is masters.manage");
    check((await call("GET", `/academic-years/${year.id}/terms`, a.session)).json?.length === 3,
      "and the calendar is unchanged");
  } else {
    check(false, "could not mint a teacher session");
  }

  // ───────────────────────────────────────────────────────── 8. GUIDED SETUP
  //
  // The guided setup asks the same question at its session step, but there is
  // no academic year yet to hang the answer off — so it collects into the draft
  // and step 2's commit writes the terms straight after the importer creates
  // the year. Idempotency is the property under test: pressing Next twice must
  // re-date the same terms, not replace them with new ids and orphan a term's
  // timetable.
  console.log("\nThe guided setup collects terms into the draft and writes them at step 2:");
  const g = await newOwnerWithSchool(`g@${DOMAIN}`, "ZZTERM Guided");
  const gTerms = [
    { name: "Term 1", startDate: SESSION.startDate, endDate: two.json[0].endDate },
    { name: "Term 2", startDate: two.json[1].startDate, endDate: SESSION.endDate },
  ];
  await call("PUT", "/onboarding/session", g.session, {
    currentStep: 2,
    answers: {
      school: { name: "ZZTERM Guided" },
      session: { name: "ZZTERM G 2026-27", startDate: SESSION.startDate, endDate: SESSION.endDate },
      terms: gTerms,
    },
  });
  const gYearsBefore = (await call("GET", "/academic-years", g.session)).json ?? [];
  check(gYearsBefore.length === 0, "before committing, the school has no session at all — a draft writes nothing");

  const gCommit = await call("POST", "/onboarding/commit/2", g.session);
  check(gCommit.status < 300, "step 2 committed", `${gCommit.status} ${gCommit.json?.message ?? ""}`);
  const gYear = ((await call("GET", "/academic-years", g.session)).json ?? [])[0];
  const gSaved = (await call("GET", `/academic-years/${gYear.id}/terms`, g.session)).json;
  check(gSaved?.length === 2, "and the session came out term-wise", `${gSaved?.length} terms`);
  check(gSaved?.[0]?.startDate === SESSION.startDate && gSaved?.[1]?.endDate === SESSION.endDate,
    "with the dates the draft held");

  const gIds = gSaved.map((t) => t.id);
  const gAgain = await call("POST", "/onboarding/commit/2", g.session);
  check(gAgain.status < 300, "pressing Next again is accepted", `${gAgain.status}`);
  const gAfter = (await call("GET", `/academic-years/${gYear.id}/terms`, g.session)).json;
  check(gAfter.length === 2 && JSON.stringify(gAfter.map((t) => t.id)) === JSON.stringify(gIds),
    "and creates NOTHING — the same two terms, the same ids, matched by name",
    `${gIds.join(",")} → ${gAfter.map((t) => t.id).join(",")}`);

  // A draft that never mentions terms must not acquire a calendar it did not
  // ask for — which is every draft made before this phase.
  const y = await newOwnerWithSchool(`y@${DOMAIN}`, "ZZTERM YearWise");
  await call("PUT", "/onboarding/session", y.session, {
    currentStep: 2,
    answers: {
      school: { name: "ZZTERM YearWise" },
      session: { name: "ZZTERM Y 2026-27", startDate: SESSION.startDate, endDate: SESSION.endDate },
    },
  });
  await call("POST", "/onboarding/commit/2", y.session);
  const yYear = ((await call("GET", "/academic-years", y.session)).json ?? [])[0];
  check((await call("GET", `/academic-years/${yYear.id}/terms`, y.session)).json?.length === 0,
    "a draft that says nothing about terms produces a whole-year session — no calendar nobody asked for");

  // ─────────────────────────────────────────────────────────────── cleanup
  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { name: { startsWith: "ZZTERM " } } })) === 0, "test schools removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();
  console.log(failed ? "\nSOME TERM CHECKS FAILED" : "\nALL TERM CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
