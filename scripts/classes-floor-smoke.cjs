/**
 * §3.10b — the guided setup's Classes step cannot describe a smaller school
 * than the one that exists.
 *
 * ## What was wrong
 *
 * Step 4 was a pure **plan**: `planClasses` expanded the slider range by
 * "sections per class" and nothing in the flow ever asked the database what was
 * already there. Three separate consequences, and the reason none of them was
 * noticed is the same reason they mattered.
 *
 * The §16 importer skips by natural key and **has no delete path**. So a screen
 * showing two sections for a class that runs four created nothing, deleted
 * nothing, and reported success. Nothing broke. The number was simply believed,
 * and it was wrong — and "Remove" and the per-class counter both *looked*
 * destructive while being unable to destroy anything, which is the worst of
 * both: it teaches the reader that the screen deletes, and it lies about the
 * school at the same time.
 *
 * Where the wrong numbers came from:
 *
 *  - **`recordWing`** (§3.10a — "New Timetable" enters the guided setup at step
 *    4) pushed `DEFAULT_WING_SECTIONS`, a hardcoded **2**, without ever looking
 *    at the school. In a school running four sections that guess then became
 *    data the moment somebody pressed Next.
 *  - **`answersFromSchool`** collapsed a wing's per-class counts to the
 *    commonest one and rebuilt no `overrides`, so a wing running four sections
 *    up to Class 8 and two above it was drawn entirely at four.
 *
 * ## The rule
 *
 * A class's section count is a fact about the **school**, so the floor is the
 * most sections any one §30 pool runs for that class. A timetable may add
 * sections and may decline to teach the class at all; it may not run fewer than
 * the school does.
 *
 * That is a rule about the school's own record, **not** a §30 resource-sharing
 * check — every pool still gets its own `class_sections` rows and shares
 * nothing. This smoke asserts both halves, because the two are easy to conflate
 * and the second is the one §30.9 exists to protect.
 *
 * ## What this proves, in order
 *
 *  1. `GET /onboarding/classes-shape` reports the floor school-wide and the
 *     existing rows **per pool**.
 *  2. The floor reaches the **write**, not just the `<input min>` — a draft
 *     asking for fewer previews as the school's own number.
 *  3. A floor is a floor: asking for MORE still creates more.
 *  4. Lowering the number deletes nothing (it never could — asserted rather
 *     than assumed, because that is the property the whole design leans on).
 *  5. A class a wing already teaches cannot be removed from the plan.
 *  6. An individual timetable is floored by the school and still gets its OWN
 *     rows — the §30.9 promise is untouched.
 *  7. A new timetable defaults to the school's shape rather than a hardcoded 2.
 *  8. Another school cannot read any of it (§17.8).
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzcf.test";
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

const PURGE_MODELS = [
  "onboardingSession", "timetableSlot", "substitutionLog", "teacherAbsence",
  "timetableDraft", "timetablePublication", "extraClass",
  "electiveOption", "electiveBlockMember", "electiveBlock",
  "mergedTeachingGroupMember", "mergedTeachingGroup",
  "teacherSubjectClassSection", "teacherClassEligibility", "teacherSubject",
  "subjectClass", "roomSubject",
  "teacherUnavailability", "classSectionUnavailability", "subjectUnavailability", "roomUnavailability",
  "dailyActivity", "period", "holiday", "academicTerm", "classSubject",
  "classSection", "section", "subject", "schoolClass", "teacher",
  "room", "timetableConfig", "timetableGroup", "academicYear",
  "notification", "aiChatLog", "aiSettings", "autoFixRun", "erpSyncRun",
  "auditLog", "user", "rolePermission", "erpRoleMapping", "role",
];

/** The Class Sections line of a step-4 dry run: what the commit would do. */
const previewSections = async (token) => {
  const j = (await call("GET", "/onboarding/preview/4", token)).json;
  return (j?.sheets ?? []).find((s) => s.sheet === "Class Sections")
    ?? { read: 0, create: 0, skip: 0 };
};

const setWings = (token, wings, yearName) =>
  call("PUT", "/onboarding/session", token, {
    currentStep: 4,
    mode: "wizard",
    answers: {
      session: { name: yearName, startDate: "2026-04-01", endDate: "2027-03-31" },
      wings,
    },
  });

async function main() {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZCF " } }, select: { id: true, code: true },
    });
    const ids = mine.map((s) => s.id);
    for (const m of PURGE_MODELS) {
      if (ids.length) await prisma[m].deleteMany({ where: { schoolId: { in: ids } } }).catch(() => undefined);
    }
    if (ids.length) await prisma.school.deleteMany({ where: { id: { in: ids } } });
    await control.tenant.deleteMany({ where: { schoolCode: { in: mine.map((s) => s.code) } } });
    await control.account.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
    const keys = await redis.keys("throttle:*:ip:*");
    if (keys.length) await redis.del(...keys);
  };
  await purge();

  console.log("\nA school that already runs four sections of every class:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZCF Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZCF School" });
  check(made.status < 300, "school created", `school ${made.json?.schoolId}`);
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;

  const YEAR = "ZZCF 2026-27";
  const year = (await call("POST", "/academic-years", S, {
    name: YEAR, startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  })).json;

  const mainWing = (await call("POST", "/timetable-configs", S, {
    name: "ZZCF Main", academicYearId: year.id,
  })).json;
  await call("PUT", `/timetable-configs/${mainWing.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 6, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
  });

  // Class 1 – Class 3, four sections each, committed through the real step 4.
  await setWings(S, [{ name: "ZZCF Main", fromIndex: 4, toIndex: 6, sections: 4 }], YEAR);
  const built = await call("POST", "/onboarding/commit/4", S);
  check(built.status < 300, "four sections of Class 1–3 created", `${built.status}`);
  const total = await prisma.classSection.count({ where: { schoolId } });
  check(total === 12, "12 class-sections exist", `${total}`);

  // ─────────────── 1. THE SHAPE IS READABLE, AND SAYS TWO DIFFERENT THINGS
  console.log("\nWhat the school already is:");
  const shape = (await call("GET", "/onboarding/classes-shape", S)).json;
  check(shape?.floors?.["Class 1"] === 4,
    "the floor for Class 1 is what the school runs", `${shape?.floors?.["Class 1"]}`);
  check((shape?.existing?.["ZZCF Main"]?.["Class 1"] ?? []).join(",") === "A,B,C,D",
    "and the rows themselves are reported per timetable",
    (shape?.existing?.["ZZCF Main"]?.["Class 1"] ?? []).join(","));

  // ─────────────── 2. THE FLOOR REACHES THE WRITE
  //
  // The whole reason the rule lives in `planClasses` rather than in an
  // `<input min>`: the grid and the importer sheets come from one function, so
  // a floor the screen showed and the commit ignored is impossible by
  // construction. A dry run is the only way to assert that without writing.
  console.log("\nA draft that asks for fewer sections than the school runs:");
  await setWings(S, [{ name: "ZZCF Main", fromIndex: 4, toIndex: 6, sections: 2 }], YEAR);
  const low = await previewSections(S);
  check(low.read === 12 && low.create === 0 && low.skip === 12,
    "the COMMIT still plans four — the floor is not a UI hint",
    `read ${low.read} · create ${low.create} · skip ${low.skip}`);

  // ─────────────── 3. A FLOOR IS A FLOOR, NOT A FIXED NUMBER
  console.log("\nA draft that asks for more:");
  await setWings(S, [{ name: "ZZCF Main", fromIndex: 4, toIndex: 6, sections: 6 }], YEAR);
  const high = await previewSections(S);
  check(high.read === 18 && high.create === 6,
    "adding sections still works — this step is for growing the school",
    `read ${high.read} · create ${high.create}`);

  // ─────────────── 4. NOTHING HERE DELETES ANYTHING
  //
  // Asserted rather than assumed. The entire argument for why the old screen
  // was *misleading* rather than *destructive* rests on this, and an importer
  // that grew a delete path would turn every "harmless" wrong number above
  // into data loss.
  console.log("\nAsking for fewer, and committing it:");
  await setWings(S, [{ name: "ZZCF Main", fromIndex: 4, toIndex: 6, sections: 1 }], YEAR);
  await call("POST", "/onboarding/commit/4", S);
  const afterLow = await prisma.classSection.count({ where: { schoolId } });
  check(afterLow === 12, "deletes nothing — all twelve are still there", `${afterLow}`);

  // ─────────────── 5. A CLASS THIS WING TEACHES CANNOT BE DROPPED
  console.log("\nRemoving a class the wing already teaches:");
  await setWings(S, [{
    name: "ZZCF Main", fromIndex: 4, toIndex: 6, sections: 4,
    overrides: { "Class 1": { removed: true }, "Class 9": { removed: true } },
  }], YEAR);
  const removed = await previewSections(S);
  check(removed.read === 12,
    "Class 1 stays in the plan — its children are still timetabled",
    `${removed.read} section rows`);

  // ─────────────── 6. §30.9 IS UNTOUCHED
  //
  // The floor is about the school's record; the POOL is about what a timetable
  // can see. An individual timetable is floored at four AND gets four rows of
  // its own — it does not inherit, share or collide with the main school's.
  console.log("\nAn individual timetable in the same school:");
  const weekly = (await call("POST", "/timetable-configs", S, {
    name: "ZZCF Weekly", academicYearId: year.id, mode: "individual",
  })).json;
  await call("PUT", `/timetable-configs/${weekly.id}/structure`, S, {
    startTime: "08:00", periodsPerDay: 6, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
  });

  // §3.10a — entering it as a wing is what a school actually presses.
  const entered = await call("POST", `/onboarding/session/wing/${weekly.id}`, S);
  const asWing = (entered.json?.answers?.wings ?? []).find((w) => w.name === "ZZCF Weekly");
  check(asWing?.sections === 4,
    "a new timetable opens on the school's own shape, not a hardcoded 2",
    `${asWing?.sections} sections`);

  await setWings(S, [{ name: "ZZCF Weekly", fromIndex: 4, toIndex: 6, sections: 2 }], YEAR);
  const indiv = await previewSections(S);
  check(indiv.read === 12 && indiv.create === 12 && indiv.skip === 0,
    "it is floored at four AND every row is new — it shares none of the main school's",
    `read ${indiv.read} · create ${indiv.create} · skip ${indiv.skip}`);

  await call("POST", "/onboarding/commit/4", S);
  const pools = await prisma.classSection.groupBy({
    by: ["resourceGroupId"], where: { schoolId }, _count: { _all: true },
  });
  check(pools.length === 2 && pools.every((p) => p._count._all === 12),
    "two pools, twelve rows each — the same labels, different children",
    pools.map((p) => `pool ${p.resourceGroupId}: ${p._count._all}`).join(" · "));

  const both = (await call("GET", "/onboarding/classes-shape", S)).json;
  check(both?.floors?.["Class 1"] === 4,
    "and the floor is still four — the widest ONE pool runs, never the total",
    `${both?.floors?.["Class 1"]}`);

  // ─────────────── 7. §17.8
  console.log("\nAnother school cannot read any of it:");
  const email2 = `stranger@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email: email2, password: PW, name: "ZZCF Stranger" });
  const acct2 = (await call("POST", "/auth/verify", null, { token: await mailToken(email2, "verify") })).json.accountToken;
  const other = await call("POST", "/schools", acct2, { name: "ZZCF Other" });
  const T = other.json.sessionToken;
  /*
    A controlled experiment, not an empty-school check.

    Asserting that a school with nothing gets nothing back proves nothing — it
    is the shape of a test that cannot fail. So the stranger builds the SAME
    classes at a DIFFERENT section count, and both halves are required: they
    must see three, and they must not see our four or our timetable's name.
  */
  const yearB = (await call("POST", "/academic-years", T, {
    name: "ZZCF B 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  })).json;
  const cfgB = (await call("POST", "/timetable-configs", T, {
    name: "ZZCF Their Wing", academicYearId: yearB.id,
  })).json;
  await call("PUT", `/timetable-configs/${cfgB.id}/structure`, T, {
    startTime: "08:00", periodsPerDay: 6, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5], breaks: [],
  });
  await call("PUT", "/onboarding/session", T, {
    currentStep: 4,
    mode: "wizard",
    answers: {
      session: { name: "ZZCF B 2026-27", startDate: "2026-04-01", endDate: "2027-03-31" },
      wings: [{ name: "ZZCF Their Wing", fromIndex: 4, toIndex: 6, sections: 3 }],
    },
  });
  await call("POST", "/onboarding/commit/4", T);

  const theirs = (await call("GET", "/onboarding/classes-shape", T)).json;
  check(theirs?.floors?.["Class 1"] === 3,
    "the stranger sees THEIR three sections of Class 1", `${theirs?.floors?.["Class 1"]}`);
  check(!Object.keys(theirs?.existing ?? {}).includes("ZZCF Main")
    && !Object.keys(theirs?.existing ?? {}).includes("ZZCF Weekly"),
    "and none of our timetables", Object.keys(theirs?.existing ?? {}).join(", ") || "(none)");

  const ours = (await call("GET", "/onboarding/classes-shape", S)).json;
  check(ours?.floors?.["Class 1"] === 4,
    "while we still see our own four — the same route, two answers",
    `${ours?.floors?.["Class 1"]}`);

  console.log("\nCleanup:");
  await purge();
  check(true, "test schools removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();

  console.log(failed ? "\nSOME CLASSES-FLOOR CHECKS FAILED" : "\nALL CLASSES-FLOOR CHECKS PASSED");
  process.exit(failed);
}

main().catch((e) => { console.error(e); process.exit(1); });
