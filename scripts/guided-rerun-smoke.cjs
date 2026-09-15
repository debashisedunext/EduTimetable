/**
 * §3.10c / §32 — the guided setup, opened a SECOND time.
 *
 * ## What a school did, and what it saw
 *
 * *"After saving the timetable from the guided setup, if I again go to the
 * guided setup and do any changes — minimise the classes, uncheck some of the
 * subjects — and save it, the data is not saving. It shows the old data only."*
 *
 * Two different faults sat behind one sentence, and neither reported anything:
 *
 *  1. **A class could be removed by narrowing the wing's range, and nothing
 *     happened.** The §16 importer skips by natural key and has no delete path,
 *     so the shorter sheet created nothing, deleted nothing, and the commit
 *     answered *"Everything here already exists — nothing to add."* — true, and
 *     indistinguishable from success. §3.10b had floored the section COUNT and
 *     withheld Remove from a class with rows; the range was the hole left in it.
 *
 *  2. **The reopened Subjects step showed every subject ticked**, whatever the
 *     timetable actually ran. `answersFromSchool` rebuilds the draft from the
 *     school (§27.12) and never read `timetable_subjects`, so a school that had
 *     narrowed Main to three subjects was shown all of them again — invariant
 *     7's "not stated means all" pointed at the one table that stores the
 *     narrowing. Unticking from there would then store a set computed from a
 *     starting point that was never true.
 *
 * ## What this proves
 *
 *  1. A first pass builds the school.
 *  2. Narrowing the range does NOT lose a class — it is kept, marked, and the
 *     sheet still carries it.
 *  3. Unticking subjects IS written to `timetable_subjects`.
 *  4. Reopening the setup reads that narrowing BACK, rather than showing every
 *     subject ticked.
 *  5. Narrowing again from there lands, and it is a narrowing of the real set.
 *  6. A timetable that never narrowed still reports nothing — "not stated" and
 *     "exactly these" stay different things (§32).
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzrr.test";
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

const PURGE = ["onboardingSession", "timetableSlot", "timetableDraft", "timetablePublication",
  "teacherSubjectClassSection", "teacherClassEligibility", "teacherSubject", "subjectClass", "roomSubject",
  "timetableSubject", "timetableClassSpan", "timetableDayShape", "period", "classSubject", "classSection",
  "section", "subject", "schoolClass", "teacher", "room", "timetableConfig", "timetableGroup", "academicYear",
  "notification", "auditLog", "user", "rolePermission", "erpRoleMapping", "role"];

const SUBJECTS = ["Mathematics", "English", "Hindi", "Science", "Art & Craft"];

async function main() {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZRR" } }, select: { id: true, code: true },
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

  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZRR Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZRR School" });
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;
  const save = (step, answers) => call("PUT", "/onboarding/session", S, { currentStep: step, answers, mode: "wizard" });
  const commit = (step) => call("POST", `/onboarding/commit/${step}`, S);

  // ─────────────── 1. THE FIRST PASS
  console.log("\nThe first pass through the guided setup:");
  await save(3, {
    school: { name: "ZZRR School" },
    session: { name: "ZZRR 2026-27", startDate: "2026-04-01", endDate: "2027-03-31" },
  });
  await commit(2);
  const yearId = (await call("GET", "/academic-years", S)).json[0].id;
  await call("POST", "/timetable-configs", S, { name: "Main", academicYearId: yearId });
  const cfg = (await call("GET", "/timetable-configs", S)).json[0];
  // Class 1 to Class 3 (ladder 5..7), three sections each.
  await save(5, { wings: [{ name: "Main", fromIndex: 5, toIndex: 7, sections: 3 }] });
  await commit(4);
  await call("PUT", `/timetable-configs/${cfg.id}/structure`, S, {
    periodsPerDay: 8, periodDurationMins: 40, startTime: "08:00", workingDays: [1, 2, 3, 4, 5], breaks: [],
  });
  await save(7, { subjects: SUBJECTS.map((name) => ({ name })) });
  await commit(6);

  const built = {
    classes: await prisma.schoolClass.count({ where: { schoolId } }),
    sections: await prisma.classSection.count({ where: { schoolId } }),
    subjects: await prisma.subject.count({ where: { schoolId } }),
  };
  check(built.classes === 3 && built.sections === 9 && built.subjects === 5,
    "3 classes, 9 sections, 5 subjects", JSON.stringify(built));

  // ─────────────── 2. NARROWING THE RANGE MUST NOT LOSE A CLASS
  console.log("\nComing back and dragging the range off Class 3:");
  const shape = (await call("GET", "/onboarding/classes-shape", S)).json;
  check(Object.keys(shape?.floors ?? {}).length === 3,
    "the school's own shape is served to the step", JSON.stringify(shape?.floors));

  await save(5, { wings: [{ name: "Main", fromIndex: 5, toIndex: 6, sections: 3 }] });
  const narrowed = await commit(4);
  /*
    §3.10d — the range now TAKES EFFECT, and it does so by detaching.

    Counted in the database, never read off the message: the old behaviour
    passed every "did it error?" test there is — 201, `ok: true`, no issues —
    while doing nothing at all.
  */
  const after = {
    classes: await prisma.schoolClass.count({ where: { schoolId } }),
    sections: await prisma.classSection.count({ where: { schoolId } }),
    attached: await prisma.classSection.count({ where: { schoolId, timetableConfigId: { not: null } } }),
  };
  check(after.classes === 3 && after.sections === 9,
    "nothing is DELETED — the class, its sections and its children stay in the school",
    JSON.stringify({ classes: after.classes, sections: after.sections }));
  check(after.attached === 6,
    "but the three sections of the class that left ARE detached",
    `${after.attached} of 9 still attached`);
  check((narrowed.json?.detached?.sections ?? []).length === 3,
    "and the commit SAYS so rather than letting it happen quietly",
    (narrowed.json?.detached?.sections ?? []).join(", ") || "reported nothing");

  /*
    The other direction, which is what makes this safe enough to do on a Next
    press: widening puts them back, through §16.1's own repair path.
  */
  await save(5, { wings: [{ name: "Main", fromIndex: 5, toIndex: 7, sections: 3 }] });
  await commit(4);
  check((await prisma.classSection.count({ where: { schoolId, timetableConfigId: { not: null } } })) === 9,
    "widening the range again re-attaches them — it is reversible", "9 of 9");

  // ─────────────── 2a. WHAT IT REFUSES
  /*
    The ladder is 0-indexed and `fromIndex: 5` is Class 2, so this wing runs
    Class 2, Class 3, Class 4 — and narrowing to `toIndex: 6` is what drops
    **Class 4**. Named here because getting it wrong is how a refusal test
    passes for the wrong reason: a fixture on a class that was never leaving
    would assert nothing at all.
  */
  console.log("\nA published lesson blocks the detach:");
  const cfgRow = await prisma.timetableConfig.findFirst({ where: { schoolId } });
  const sec3 = await prisma.classSection.findFirst({
    where: { schoolId, class: { name: "Class 4" } }, select: { id: true },
  });
  const subj = await prisma.subject.findFirst({ where: { schoolId } });
  const tch = await prisma.teacher.create({
    data: { schoolId, name: "ZZRR Cover", employeeCode: "ZZRR-1" },
  });
  await prisma.timetableSlot.create({
    data: {
      schoolId, timetableConfigId: cfgRow.id,
      classSectionId: sec3.id, subjectId: subj.id, teacherId: tch.id,
      dayOfWeek: 1, periodNumber: 1, status: "published",
      teacherOccupancyKey: `T-${tch.id}`,
    },
  });
  await save(5, { wings: [{ name: "Main", fromIndex: 5, toIndex: 6, sections: 3 }] });
  const blocked = await commit(4);
  check((blocked.json?.detached?.refused ?? []).some((r) => r.includes("Class 4")),
    "refused BY NAME — those lessons are on a wall somewhere",
    (blocked.json?.detached?.refused ?? []).join(" · ") || "nothing refused");
  check((await prisma.classSection.count({ where: { id: sec3.id, timetableConfigId: { not: null } } })) === 1,
    "...and the section is still attached", "still in the timetable");
  await prisma.timetableSlot.deleteMany({ where: { timetableConfigId: cfgRow.id } });

  /*
    §29.1 — a frozen timetable refuses the WHOLE commit, upstream of this.

    The guided setup is the blunt exception: it resolves names inside one
    transaction, so it refuses while any wing is frozen rather than per row.
    The detach carries its own frozen check as well — a second caller reaching
    it directly would not have passed the importer's — but through this door
    the right assertion is that nothing happens at all, which is stronger.
  */
  console.log("\nA frozen timetable refuses the whole commit (§29.1):");
  const attachedBefore = await prisma.classSection.count({
    where: { schoolId, timetableConfigId: { not: null } },
  });
  await prisma.timetableConfig.update({ where: { id: cfgRow.id }, data: { frozenAt: new Date() } });
  const frozen = await commit(4);
  check(frozen.status >= 400, "the commit is refused", `${frozen.status} ${(frozen.json?.message ?? "").slice(0, 60)}`);
  check((await prisma.classSection.count({ where: { schoolId, timetableConfigId: { not: null } } })) === attachedBefore,
    "...and not one section moved", `${attachedBefore} attached, unchanged`);
  await prisma.timetableConfig.update({ where: { id: cfgRow.id }, data: { frozenAt: null } });
  // Back to the full range for the rest of the file.
  await save(5, { wings: [{ name: "Main", fromIndex: 5, toIndex: 7, sections: 3 }] });
  await commit(4);

  // ─────────────── 3. UNTICKING SUBJECTS IS WRITTEN
  console.log("\nUnticking two subjects:");
  await save(7, { subjectsByWing: { Main: ["Mathematics", "English", "Hindi"] } });
  await commit(6);
  const sel = await prisma.timetableSubject.findMany({
    where: { schoolId }, select: { subject: { select: { name: true } } },
  });
  check(sel.length === 3, "§32 — the narrowing is stored",
    `${sel.length} rows: ${sel.map((x) => x.subject.name).sort().join(", ")}`);

  // ─────────────── 4. AND READ BACK, WHICH IS WHAT WAS MISSING
  console.log("\nOpening the guided setup again, with no draft:");
  await call("DELETE", "/onboarding/session", S);
  const fresh = await call("GET", "/onboarding/session", S);
  const byWing = fresh.json?.answers?.subjectsByWing ?? {};
  check(Array.isArray(byWing.Main) && byWing.Main.length === 3,
    "the Subjects step is told which three this timetable runs, not all five",
    `${JSON.stringify(byWing.Main)}`);
  /*
    The whole bug, stated as an assertion: absent reads as ALL (invariant 7),
    so a missing `subjectsByWing` is not a blank screen — it is five ticks on a
    timetable that runs three, and every later edit computed from it is wrong.
  */
  check(!(byWing.Main ?? []).includes("Science") && !(byWing.Main ?? []).includes("Art & Craft"),
    "...and the two that were unticked are NOT in it",
    (byWing.Main ?? []).join(", "));

  // ─────────────── 5. NARROWING AGAIN, FROM THE TRUE SET
  console.log("\nUnticking one more, from that screen:");
  /*
    The WHOLE answers object, as the client sends it after a §27.12 rebuild:
    the prefilled keys are marked touched, so the first Next persists them all.

    Sending only `subjectsByWing` is what caught the third fault here — the
    draft then named no wings and `applySubjectSelection` wrote nothing at all,
    silently, which is the same "saved, and nothing happened" the whole file is
    about. It has a fallback to the selection's own keys now, and the assertion
    below runs against the realistic shape so a regression in EITHER path shows.
  */
  await save(7, {
    ...fresh.json.answers,
    subjectsByWing: { Main: ["Mathematics", "English"] },
  });
  await commit(6);
  const sel2 = await prisma.timetableSubject.count({ where: { schoolId } });
  check(sel2 === 2, "a second narrowing lands too", `${sel2} rows`);

  // …and again with ONLY the selection in the draft, which is the shape that
  // used to write nothing at all.
  await call("DELETE", "/onboarding/session", S);
  await save(7, { subjectsByWing: { Main: ["Mathematics"] } });
  await commit(6);
  const sel3 = await prisma.timetableSubject.count({ where: { schoolId } });
  check(sel3 === 1,
    "even a draft naming no wings writes it — the key IS the wing name",
    `${sel3} row(s)`);

  // ─────────────── 6. "NOT STATED" IS STILL A DIFFERENT THING
  console.log("\nA timetable that has never narrowed:");
  await call("POST", "/timetable-configs", S, { name: "Second", academicYearId: yearId });
  await call("DELETE", "/onboarding/session", S);
  const two = await call("GET", "/onboarding/session", S);
  const map = two.json?.answers?.subjectsByWing ?? {};
  check(map.Second === undefined,
    "says NOTHING about it — §32 records narrowing, never the subject list restated",
    `keys: ${Object.keys(map).join(", ") || "none"}`);

  console.log("\nCleanup:");
  await purge();
  check(true, "test school removed");

  await prisma.$disconnect();
  await control.$disconnect();
  console.log(failed ? "\nSOME GUIDED RE-RUN CHECKS FAILED" : "\nALL GUIDED RE-RUN CHECKS PASSED");
  process.exit(failed);
}

main().catch((e) => { console.error(e); process.exit(1); });
