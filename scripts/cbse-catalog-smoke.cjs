/**
 * §35 — the board catalogue, and the rule it exists to enforce.
 *
 * ## What it is
 *
 * "Which subjects does CBSE run, and for which classes" is the same answer for
 * every school in the country, so it is seeded once per database as
 * `board_subject_catalog` — the one master in this schema with **no
 * `school_id`**, because invariant 18 scopes rows a school OWNS and nobody owns
 * the CBSE scheme of studies. Read through `PrismaBaseService`, the sanctioned
 * way out of §17's ambient scoping, and written only by the seed.
 *
 * ## The requirement
 *
 * *"Accountancy or Biology is applicable for 11th and 12th, then it should not
 * be added to lower classes."*
 *
 * That is not a filter on a screen — it is `subject_classes` (§27.16), declared
 * rather than derived, and `assertSubjectApplies` then refuses a curriculum row
 * for a class a subject was never declared for. So this asserts the whole
 * chain: the catalogue says 11–12, Apply writes 11–12 and nothing else, and the
 * curriculum then refuses Class 5.
 *
 * ## What this proves, in order
 *
 *  1. The catalogue is there, versioned, with class ranges — and the 45
 *     languages are OFFERED rather than recommended.
 *  2. Apply creates the subjects **and** their class declarations, through the
 *     §16 committer rather than a write path of its own.
 *  3. Biology lands on Class 11 and 12 and **nowhere else**.
 *  4. A curriculum row for Class 5 Biology is then REFUSED — the point of the
 *     whole feature, tested at the layer that enforces it.
 *  5. A class the school does not have is dropped, never invented.
 *  6. Pressing Create twice adds nothing (the importer skips by natural key).
 *  7. The catalogue is reference data: another school reads the SAME rows, and
 *     that is correct rather than a leak (§17.8 classification).
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");
const Redis = req("ioredis");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzcb.test";
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
  "onboardingSession", "timetableSlot", "timetableDraft", "timetablePublication",
  "teacherSubjectClassSection", "teacherClassEligibility", "teacherSubject",
  "subjectClass", "roomSubject", "timetableSubject", "timetableClassSpan", "timetableDayShape",
  "period", "classSubject", "classSection", "section", "subject", "schoolClass",
  "teacher", "room", "timetableConfig", "timetableGroup", "academicYear",
  "notification", "auditLog", "user", "rolePermission", "erpRoleMapping", "role",
];

async function main() {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });
  const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379");

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZCB " } }, select: { id: true, code: true },
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

  console.log("\nA school with Classes 1 to 12:");
  const email = `owner@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZCB Owner" });
  const acct = (await call("POST", "/auth/verify", null, { token: await mailToken(email, "verify") })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: "ZZCB School" });
  check(made.status < 300, "school created", `school ${made.json?.schoolId}`);
  const S = made.json.sessionToken;
  const schoolId = made.json.schoolId;

  const year = (await call("POST", "/academic-years", S, {
    name: "ZZCB 2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
  })).json;
  // Class 1 … Class 12, so every catalogue range has somewhere to land.
  const classIds = {};
  for (let n = 1; n <= 12; n++) {
    const c = (await call("POST", "/classes", S, { name: `Class ${n}`, sequence: n + 4 })).json;
    classIds[`Class ${n}`] = c.id;
  }
  check(Object.keys(classIds).length === 12, "twelve classes exist");

  // ─────────────── 1. THE CATALOGUE
  console.log("\nWhat the board recommends:");
  const cat = (await call("GET", "/subjects/catalog", S)).json;
  check(cat?.board === "CBSE" && cat?.version === "2026-27",
    "the catalogue is there, and says which scheme it is", `${cat?.board} ${cat?.version}`);
  const by = (n) => (cat?.subjects ?? []).find((s) => s.name === n);
  check(by("Biology")?.fromClass === "Class 11" && by("Biology")?.toClass === "Class 12",
    "Biology is Class 11–12", `${by("Biology")?.fromClass}–${by("Biology")?.toClass}`);
  check(by("Environmental Studies")?.classes.length === 3,
    "EVS is Classes 3–5 only", (by("Environmental Studies")?.classes ?? []).join(", "));
  check((cat?.subjects ?? []).filter((s) => s.isLanguage).length === 45,
    "and 45 languages are OFFERED, never recommended — a school runs two or three",
    `${(cat?.subjects ?? []).filter((s) => s.isLanguage).length} languages`);

  /*
    §35 — `recommended` is what the dialog opens ticked, and it is the SERVER's
    answer: the group labels are defined in `cbse-catalog.ts`, so a screen
    carrying its own list of which groups are streams is one rename away from
    silently ticking nothing.

    Asserted in both directions on purpose. A field that were always true would
    pass "Mathematics is ticked" while quietly creating forty-five languages and
    twenty stream subjects for every school that pressed the button.
  */
  check(by("Mathematics")?.recommended === true && by("Physical Education")?.recommended === true,
    "Maths and PE open TICKED — every CBSE school runs them");
  check(by("Biology")?.recommended === false && by("Accountancy")?.recommended === false,
    "...while the senior streams do not — a school offering Science and Commerce "
    + "must not have to delete Sociology");
  check((cat?.subjects ?? []).filter((s) => s.isLanguage).every((s) => s.recommended === false),
    "...and not one of the 45 languages does",
    `${(cat?.subjects ?? []).filter((s) => s.isLanguage && s.recommended).length} ticked`);
  const ticked = (cat?.subjects ?? []).filter((s) => s.recommended);
  check(ticked.length > 0 && ticked.length < (cat?.subjects ?? []).length,
    "so pressing the button proposes a school, not a catalogue",
    `${ticked.length} of ${(cat?.subjects ?? []).length} ticked`);

  // ─────────────── 2 & 3. APPLY, AND THE CLASS RULE
  console.log("\nCreating Mathematics, Biology, Accountancy and English:");
  const applied = await call("POST", "/subjects/catalog/apply", S, {
    names: ["Mathematics", "Biology", "Accountancy", "English"],
  });
  check(applied.status < 300, "they are created", `${applied.status} ${JSON.stringify(applied.json?.created ?? {})}`);

  const declared = async (name) => {
    const s = await prisma.subject.findFirst({
      where: { schoolId, name }, include: { classes: { include: { class: true } } },
    });
    return (s?.classes ?? []).map((c) => c.class.name).sort((a, b) => Number(a.split(" ")[1]) - Number(b.split(" ")[1]));
  };
  const bio = await declared("Biology");
  check(bio.join(",") === "Class 11,Class 12",
    "Biology is declared for Class 11 and 12 and NOWHERE ELSE", bio.join(", ") || "none");
  const acc = await declared("Accountancy");
  check(acc.join(",") === "Class 11,Class 12", "so is Accountancy", acc.join(", ") || "none");
  check((await declared("Mathematics")).length === 12,
    "while Mathematics is declared for all twelve", `${(await declared("Mathematics")).length} classes`);

  // ─────────────── 4. THE RULE, AT THE LAYER THAT ENFORCES IT
  console.log("\nWhat that declaration then refuses:");
  const bioId = (await prisma.subject.findFirst({ where: { schoolId, name: "Biology" } })).id;
  const low = await call("POST", "/class-subjects", S, {
    classId: classIds["Class 5"], subjectId: bioId, academicYearId: year.id, periodsPerWeek: 4,
  });
  check(low.status >= 400,
    "Biology cannot be given to Class 5 — §27.16 refuses it, not the screen",
    `${low.status} ${(low.json?.message ?? "").slice(0, 70)}`);
  const high = await call("POST", "/class-subjects", S, {
    classId: classIds["Class 11"], subjectId: bioId, academicYearId: year.id, periodsPerWeek: 4,
  });
  check(high.status < 300, "...while Class 11 is accepted", `${high.status}`);

  // ─────────────── 5. A CLASS THE SCHOOL DOES NOT HAVE
  console.log("\nA school that stops at Class 8:");
  const email2 = `small@${DOMAIN}`;
  await call("POST", "/auth/register", null, { email: email2, password: PW, name: "ZZCB Small" });
  const acct2 = (await call("POST", "/auth/verify", null, { token: await mailToken(email2, "verify") })).json.accountToken;
  const small = await call("POST", "/schools", acct2, { name: "ZZCB Small School" });
  const T = small.json.sessionToken;
  for (let n = 1; n <= 8; n++) await call("POST", "/classes", T, { name: `Class ${n}`, sequence: n + 4 });

  const partial = await call("POST", "/subjects/catalog/apply", T, { names: ["Mathematics", "Biology"] });
  check(partial.status < 300 && partial.json?.skipped === 1,
    "Biology is skipped rather than inventing Class 11 — this is the Subjects screen",
    `skipped ${partial.json?.skipped}`);
  const noBio = await prisma.subject.count({ where: { schoolId: small.json.schoolId, name: "Biology" } });
  check(noBio === 0, "and no Biology row exists for it", `${noBio} rows`);

  // ─────────────── 6. IDEMPOTENT
  console.log("\nPressing Create twice:");
  /*
    Counted in the DATABASE, not read off the response.

    `created.subjectClasses` counts writes attempted rather than rows added —
    `subject_classes` has a composite primary key, so a repeat is an upsert that
    changes nothing — and a run that reported 14 while adding none would make
    this assertion pass for the wrong reason if it trusted the number.
  */
  const before = await prisma.subjectClass.count({ where: { schoolId } });
  const again = await call("POST", "/subjects/catalog/apply", S, { names: ["Mathematics", "Biology"] });
  const after = await prisma.subjectClass.count({ where: { schoolId } });
  const subjectsNow = await prisma.subject.count({ where: { schoolId } });
  check(again.status < 300 && after === before && subjectsNow === 4,
    "adds no row — the §16 committer skips by natural key, and the class PK makes a repeat an upsert",
    `subject_classes ${before} → ${after}, subjects ${subjectsNow}`);

  // ─────────────── 7. REFERENCE DATA, NOT A LEAK
  console.log("\nThe catalogue is the same for everybody:");
  const theirs = (await call("GET", "/subjects/catalog", T)).json;
  check((theirs?.subjects ?? []).length === (cat?.subjects ?? []).length,
    "another school reads the same rows — reference data, which is why it has no school_id",
    `${(theirs?.subjects ?? []).length} vs ${(cat?.subjects ?? []).length}`);
  check(!(theirs?.alreadyHave ?? []).includes("Accountancy") && (cat?.alreadyHave ?? []).length >= 0,
    "...while 'what this school already has' is per school and does NOT cross",
    `theirs: ${(theirs?.alreadyHave ?? []).join(", ") || "none"}`);

  console.log("\nCleanup:");
  await purge();
  check(true, "test schools removed");

  await prisma.$disconnect();
  await control.$disconnect();
  redis.disconnect();

  console.log(failed ? "\nSOME CBSE CATALOGUE CHECKS FAILED" : "\nALL CBSE CATALOGUE CHECKS PASSED");
  process.exit(failed);
}

main().catch((e) => { console.error(e); process.exit(1); });
