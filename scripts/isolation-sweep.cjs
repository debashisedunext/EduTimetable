/**
 * Phase 9.10 (§17.8) — the exhaustive cross-school sweep, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/isolation-sweep.cjs
 *
 * `tenant-isolation.cjs` (9.1) proves the mechanism works on a sample of
 * endpoints. This proves it holds on **all** of them — and, more importantly,
 * that it keeps holding. It asks the running application for its route table
 * and requires every route to be either swept or explicitly classified. Add a
 * controller and forget to think about tenancy, and this suite fails naming it.
 * A hand-written list of endpoints could not do that: it would keep passing,
 * reporting safety it had never checked, which is worse than no suite at all.
 *
 *   1. CENSUS   — every registered route is accounted for; an unclassified one fails
 *   2. PATH     — the same request, the same id, two sessions, two outcomes
 *   3. LIST     — the two schools' collections share no ids
 *   4. BODY     — ids smuggled through a request body are refused
 *   5. EFFECT   — session-wide writes leave the other school untouched
 *   6. TOOLS    — every AI tool answers about its own school alone
 *   7. KEYS     — no Redis key escapes its school's prefix
 *
 * Step 2 is a controlled experiment, not a one-sided probe, and that matters
 * more than it sounds. "B got 404" on its own proves nothing: a route that is
 * dead, mis-permissioned or renamed refuses *everyone* and sails through an
 * isolation check while being thoroughly broken — the suite would report a
 * boundary it never exercised. So every route is called twice with **the same
 * URL and the same body**, once as each school, and the only thing allowed to
 * differ is who is asking. B must be refused; A must get a different answer.
 * A 400 for A is a perfectly good control: it means the request reached A's
 * row and failed on its own merits, which is the discrimination under test.
 * Where both sessions get the same answer, nothing was proved — the run says
 * so and fails, rather than quietly counting it as a pass.
 *
 * Both schools are created by this script and deleted at the end. It never
 * writes to a real school: the routes here include DELETE and publish, and a
 * suite that mutates live data to prove a point is not one you can run twice.
 * The school in the seed data is used only as a witness that nothing strayed.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const Redis = req("ioredis");
const ExcelJS = req("exceljs");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const WITNESS = 1; // the seeded school: touched by nothing here
const P = "ZZSWP";
/**
 * The two schools this run owns. Allocated above every id already in use
 * rather than hardcoded, and — more importantly — only ever purged by their
 * `ZZSWP-` code, never by id.
 *
 * Both rules exist because the first version of this script hardcoded ids in
 * a range it assumed was free, and one of them was already a real school. The
 * purge then deleted it. An id is not proof of ownership; a marker you wrote
 * yourself is. Nothing here may delete a row it did not create.
 */
let SCHOOL_A = 0;
let SCHOOL_B = 0;

let failed = 0;
const pass = (l, x = "") => console.log(`  PASS  ${l}${x ? ` — ${x}` : ""}`);
const fail = (l, x = "") => { console.log(`  FAIL  ${l}${x ? ` — ${x}` : ""}`); failed = 1; };
const info = (l, x = "") => console.log(`  INFO  ${l}${x ? ` — ${x}` : ""}`);
const check = (ok, l, x = "") => (ok ? pass(l, x) : fail(l, x));

/**
 * A cross-school attempt must not succeed. 400/403/404 are all honest
 * refusals, and so is 409: the board reports a cell it cannot find as a stale
 * card, and for another school's board that is both the truthful answer and
 * exactly what its owner would see for a genuinely stale one — which is the
 * property we want. What matters is that nothing was returned and nothing was
 * written; the status is how the refusal is phrased.
 */
const refused = (s) => s === 400 || s === 403 || s === 404 || s === 409;
const ok2xx = (s) => s >= 200 && s < 300;

async function sessionFor(payload) {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const { token } = await r.json();
  const cb = await fetch(`${API}/api/sso/callback?token=${token}`, { redirect: "manual" });
  return (cb.headers.get("location") || "").split("#token=")[1] ?? null;
}

async function call(method, path, token, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* file or empty body */ }
  return { status: res.status, json, text };
}

/** Every numeric `id` anywhere in a response, however deeply nested. */
function idsIn(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => idsIn(v, found));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "id" && typeof v === "number") found.add(v);
      else idsIn(v, found);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Route classification.
//
// Each table below records a *decision* about a shape of route, and the census
// then requires every real route to match one. They stay small because they
// are keyed on resource and on shape, never on individual endpoints.
// ---------------------------------------------------------------------------

/**
 * Which resource a parameterised route addresses, by path shape. Longest
 * pattern wins, so `/timetable-configs/:id/board/...` is not shadowed by the
 * bare `/timetable-configs/:id`.
 */
const PARAM_RESOURCE = [
  ["/absences/:id", "absence"],
  ["/academic-years/:id", "year"],
  ["/admin/roles/:id/permissions", "role"],
  ["/admin/users/:id", "user"],
  // §24.8 — swept, not merely classified: these take another school's user
  // id perfectly happily unless somebody checks, and "deactivate that
  // login" is the one you least want working across a boundary.
  ["/users/:id", "user"],
  ["/ai/settings/roles/:id", "role"],
  ["/class-sections/:id", "classSection"],
  ["/elective-blocks/:id", "electiveBlock"],
  ["/extra-classes/:id", "extraClass"],
  ["/class-subjects/:id", "curriculum"],
  ["/classes/:id", "class"],
  ["/mappings/:id", "mapping"],
  ["/merged-groups/:id", "mergedGroup"],
  ["/notifications/:id", "notification"],
  ["/reports/class-section/:id", "classSection"],
  ["/reports/teacher/:id", "teacher"],
  ["/reports/rooms/:configId", "config"],
  ["/reports/teacher-load/:configId", "config"],
  ["/rooms/:id", "room"],
  ["/subjects/:id", "subject"],
  ["/teachers/:id", "teacher"],
  ["/timetable-configs/:id", "config"],
];

/**
 * A body that gets past validation, so the status difference is about
 * ownership and nothing else. `n` keeps names unique across iterations —
 * without it the second PUT of the same name collides on a unique key and the
 * control turns into a 409 that says nothing.
 */
const BODY_FOR = (key, n, A) => ({
  "PUT /academic-years/:id": { name: `${P} Y${n}`, startDate: "2026-04-01", endDate: "2027-03-31" },
  "PUT /admin/roles/:id/permissions": { permissions: ["masters.manage"] },
  "PUT /admin/users/:id": { roleId: null },
  "PUT /ai/settings/roles/:id": { ai: { "ai.chat": true } },
  "PUT /class-sections/:id": { strength: 31 },
  "PUT /class-sections/:id/class-teacher": { teacherId: null },
  "PUT /class-subjects/:id": { periodsPerWeek: 4 },
  "PUT /classes/:id": { name: `${P} C${n}`, sequence: 2 },
  "POST /classes/:id/sections": { name: `S${n}`, academicYearId: A.rows.year.id },
  "PUT /mappings/:id": { periodsPerWeek: 3 },
  "PUT /merged-groups/:id": { periodsPerWeek: 3 },
  "PUT /elective-blocks/:id": { name: `${P} Elective ${n}` },
  "PUT /rooms/:id": { name: `${P} R${n}`, roomType: "classroom" },
  "PUT /subjects/:id": { name: `${P} S${n}` },
  "PUT /teachers/:id": { employeeCode: `${P}T${n}`, name: `${P} T${n}`, maxPeriodsPerDay: 6, maxPeriodsPerWeek: 30 },
  "PUT /teachers/:id/unavailability": { rows: [{ dayOfWeek: 3, periodNumber: 4 }] },
  "PUT /timetable-configs/:id": { name: `${P} G${n}`, periodsPerDay: 8 },
  "PUT /timetable-configs/:id/class-sections": { classSectionIds: [] },
  "PUT /timetable-configs/:id/structure": { startTime: "08:00", periodsPerDay: 4, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5] },
  // §3.12 clone. The target session is the CALLER's own new year, so the only
  // thing separating owner from stranger is whether they own the source
  // timetable named in the path — which is exactly what this route must decide.
  "POST /timetable-configs/:id/clone/preview": { name: `${P} Clone ${n}`, newYear: { name: `${P} CY${n}`, startDate: "2027-04-01", endDate: "2028-03-31" } },
  "POST /timetable-configs/:id/clone": { name: `${P} Clone C${n}`, newYear: { name: `${P} CYC${n}`, startDate: "2027-04-01", endDate: "2028-03-31" } },
  // The board's real payload shapes, pointing at A's own fixture slots. A
  // malformed body is rejected before the config is ever looked up, so both
  // sessions would get the same 400 and the control would prove nothing.
  // These carry A's ids on purpose: for B they are also the smuggling test.
  "POST /timetable-configs/:id/board/place": {
    classSectionId: A.rows.classSection.id, subjectId: A.rows.subject.id, teacherId: A.rows.teacher.id, day: 3, period: 3,
  },
  "POST /timetable-configs/:id/board/lock": {
    from: { classSectionId: A.rows.classSection.id, day: 3, period: 3 }, locked: true,
  },
  "POST /timetable-configs/:id/board/move": {
    from: { classSectionId: A.rows.classSection.id, day: 1, period: 1 },
    expect: { subjectId: A.rows.subject.id, teacherId: A.rows.teacher.id },
    to: { day: 4, period: 4 },
  },
  "POST /timetable-configs/:id/board/swap": {
    a: { classSectionId: A.rows.classSection.id, day: 4, period: 4 },
    expectA: { subjectId: A.rows.subject.id, teacherId: A.rows.teacher.id },
    b: { classSectionId: A.rows.classSection.id, day: 2, period: 1 },
    expectB: { subjectId: A.rows.subject.id, teacherId: A.rows.teacher.id },
  },
  // §22 Phase 17 — draft registry. A draft id is not a capability: B must not
  // reach A's drafts even knowing the number.
  "GET /timetable-configs/:id/drafts": null,
  "POST /timetable-configs/:id/drafts": { label: "sweep probe" },
  "PUT /timetable-configs/:id/drafts/:draftId": { label: "renamed by sweep" },
  "POST /timetable-configs/:id/drafts/:draftId/archive": { archived: true },
  "POST /timetable-configs/:id/drafts/:draftId/recompute": {},
  "DELETE /timetable-configs/:id/drafts/:draftId": null,
  "POST /timetable-configs/:id/board/swap-group": {
    from: { classSectionId: A.rows.classSection.id, day: 1, period: 1 },
    expect: { subjectId: A.rows.subject.id, teacherId: A.rows.teacher.id },
    to: { day: 2, period: 1 },
  },
  "POST /timetable-configs/:id/board/remove": {
    from: { classSectionId: A.rows.classSection.id, day: 2, period: 1 },
    expect: { subjectId: A.rows.subject.id, teacherId: A.rows.teacher.id },
  },
  "POST /timetable-configs/:id/board/publish": {},
  "POST /timetable-configs/:id/board/draft-from-published": {},
  "POST /timetable-configs/:id/generate": { mode: "fast" },
  "POST /absences/:id/confirm": { assignments: [{ slotId: 1, substituteTeacherId: 1 }] },
}[key] ?? {});

/**
 * Routes that cannot use the standing fixture — because they destroy or
 * restructure what they touch, or because the fixture row is a special case
 * the route refuses on its own. Each gets a throwaway row, so no route's
 * control depends on another route not having run first.
 */
const NEEDS_FRESH = new Set([
  "PUT /timetable-configs/:id/class-sections",
  "PUT /timetable-configs/:id/structure",
  // Super Admin's permissions are deliberately immutable, so the standing
  // fixture role would give both sessions the same 400 and prove nothing.
  "PUT /admin/roles/:id/permissions",
]);

/**
 * Routes with no id to smuggle. Each carries the reason it is safe *and* which
 * assertion covers it — an exemption without a covering check is a hole, and
 * writing the reason down is what stops one being added quietly.
 */
/**
 * Routes whose path parameter is NOT a row id.
 *
 * The census assumes `:something` addresses a resource, because it almost
 * always does — and that assumption is what catches a new controller taking an
 * id it forgot to scope. A step number is the exception: it names a position in
 * a wizard, not a row, so there is no other school's version of it to reach.
 * Recorded here rather than given a fake resource mapping, which would have the
 * sweep call it with a class-section id and prove nothing.
 */
const PARAM_NOT_AN_ID = {
  "POST /onboarding/commit/:step": { how: "effect", reason: "§15.3 :step is a wizard step number; the draft is keyed (school, user) from the session — onboarding-smoke.cjs proves two schools' drafts do not cross" },
  "GET /onboarding/preview/:step": { how: "effect", reason: "§15.3 :step is a wizard step number; reads the caller's own draft and writes nothing" },
};

const NO_ID = {
  "POST /absences": { how: "body", reason: "takes the other school's teacherId in the body" },
  "POST /class-subjects": { how: "body", reason: "takes the other school's classId in the body" },
  "POST /mappings": { how: "body", reason: "takes the other school's class-section in the body" },
  "POST /merged-groups": { how: "body", reason: "takes the other school's ids in the body" },
  "POST /elective-blocks": { how: "body", reason: "takes the other school's class-sections and option ids in the body" },
  "POST /extra-classes": { how: "body", reason: "takes the other school's config, class-section and teacher in the body" },
  "PUT /admin/erp-mappings": { how: "body", reason: "takes the other school's roleId in the body" },
  "POST /ai/explain-readiness": { how: "body", reason: "takes a configId in the body" },
  "POST /auth/switch-school": { how: "body", reason: "names a school the session was never granted" },
  "POST /import/dry-run": { how: "body", reason: "resolves names against the caller's school only" },

  // §23 — the ERP sync takes NO id from the request: it reads the ERP with the
  // session school's own code and writes through the scoped client. Covered by
  // erp-sync-smoke.cjs step 13, which runs two schools against one stand-in ERP
  // and asserts each sees, writes and logs only its own rows.
  "POST /sync/erp/preview": { how: "effect", reason: "reads the ERP for the session's own school code — erp-sync-smoke.cjs step 13 proves two schools do not cross" },
  "POST /sync/erp/apply": { how: "effect", reason: "writes only the session's own school — erp-sync-smoke.cjs step 13 proves two schools do not cross" },
  "GET /sync/erp/logs": { how: "effect", reason: "the run history is read through the scoped client — erp-sync-smoke.cjs step 13 asserts B sees only B's runs" },
  // No school id anywhere in these two: `status` counts through the scoped
  // client and `reload` re-reads a file on disk. Neither takes a body.
  "GET /sync/erp/status": { how: "effect", reason: "counts through the scoped client; no id in the request" },
  "POST /sync/erp/reload": { how: "none", reason: "re-reads the deployment's endpoint file — server config, not school data" },

  // §13.5 — AI data entry. `apply` takes a proposal id, and the stash it reads
  // is keyed `s{schoolId}:aiproposal:*`, so another school's id is simply not
  // found. Covered by ai-data-entry-smoke.cjs, which drafts in one school and
  // tries to apply from the other.
  "POST /ai/data-entry/apply": { how: "effect", reason: "proposal stash is school-keyed — ai-data-entry-smoke.cjs proves B cannot apply A's proposal" },
  "GET /ai/data-entry/common-subjects": { how: "none", reason: "a static catalogue of subject names; carries no school data" },

  // §15.3 Phase 25.2 — the guided setup's saved answers. No id in any of these:
  // the draft is keyed (school, user) from the SESSION, so there is nothing in
  // a request that could name somebody else's. onboarding-smoke.cjs drives the
  // crossing case directly — two schools, two drafts, and a second school of
  // the SAME owner starting empty, which is the one that would catch scoping by
  // account instead of by school.
  "POST /me/onboarding/dismiss": { how: "effect", reason: "stamps the caller's own users row; takes no id — onboarding-smoke.cjs asserts a colleague's is untouched" },
  "PUT /onboarding/session": { how: "effect", reason: "draft is keyed (school, user) from the session — onboarding-smoke.cjs proves two schools' drafts do not cross" },
  "DELETE /onboarding/session": { how: "effect", reason: "deletes only the caller's own draft; takes no id" },
  // Phase 25.4g. Writes settings across the session's own school — the
  // `updateMany` carries no id from the request, and the school-scope extension
  // narrows it to the ambient school. guided-setup-smoke.cjs drives it.
  "POST /onboarding/finish": { how: "effect", reason: "§24.5 writes timetable_config and teacher settings for the session's own school; takes no id" },
  // Phase 25.5. Takes a sentence, not an id. Everything it writes goes into the
  // caller's own draft, keyed (school, user) from the session — and the model is
  // offered ONE tool, which reaches nothing but that draft. interview-smoke.cjs
  // drives the whole conversation without an LLM in the loop.
  "POST /onboarding/interview": { how: "effect", reason: "§24.6 one interview turn; writes only the caller's own onboarding draft, and the model has no tool that reaches further" },

  // §24.8 Phase 25.6 — inviting people. Neither takes a row id: the school comes
  // from the session, and both are refused outright unless the school is
  // self-serve. users-smoke.cjs drives the whole invite → accept → sign-in →
  // refused-everything story, including the ERP refusal.
  "POST /users/invite": { how: "effect", reason: "§24.8 creates a users row in the SESSION's school; roles.manage, and refused for an ERP school" },
  "POST /users/invite-teachers": { how: "effect", reason: "§24.8 the same, in bulk, over the session school's own teacher master" },

  "PUT /school": { how: "effect", reason: "edits the session's own school row" },
  "PUT /ai/settings": { how: "effect", reason: "edits the session's own settings row" },
  "POST /notifications/read-all": { how: "effect", reason: "marks the session's own notifications read" },

  "POST /academic-years": { how: "stamp", reason: "creates the caller's own row — tenant-isolation.cjs asserts B's creates land stamped as B's" },
  "POST /admin/roles": { how: "stamp", reason: "creates the caller's own row — tenant-isolation.cjs asserts B's creates land stamped as B's" },
  "POST /classes": { how: "stamp", reason: "creates the caller's own row — tenant-isolation.cjs asserts B's creates land stamped as B's, on child tables too" },
  "POST /rooms": { how: "stamp", reason: "creates the caller's own row — tenant-isolation.cjs asserts B's creates land stamped as B's" },
  "POST /subjects": { how: "stamp", reason: "creates the caller's own row — tenant-isolation.cjs asserts B's creates land stamped as B's" },
  "POST /teachers": { how: "stamp", reason: "creates the caller's own row — tenant-isolation.cjs asserts B's creates land stamped as B's" },
  "POST /timetable-configs": { how: "stamp", reason: "creates the caller's own row — tenant-isolation.cjs asserts B's creates land stamped as B's" },

  "POST /ai/settings/test": { how: "none", reason: "pings the configured provider; carries no school data — ai-providers-smoke.cjs covers it" },
  "POST /demo-jobs": { how: "none", reason: "queue smoke job; carries no id — fair-scheduling-smoke.cjs drives it" },
  "POST /import/commit": { how: "none", reason: "re-validates through the same path as dry-run (asserted below), then writes stamped — import-smoke.cjs covers the write" },
  "POST /import/annotate": { how: "none", reason: "writes the caller's own uploaded file back with error columns — reads no school data" },
};

/**
 * GETs that address a resource through the query string rather than the path.
 * They are not collections, so the disjointness check has nothing to compare —
 * they are swept exactly like a parameterised route instead: the same request,
 * once as each school, and only the answer may differ.
 */
const QUERY_ROUTES = {
  "GET /extra-classes/window": { resource: "config", query: (id) => `?configId=${id}` },
};

/** Collections whose payload legitimately has no school-owned ids to compare. */
const LIST_NO_IDS = {
  "GET /ai/settings/models": "the provider catalogue is the same for every school",
  "GET /ai/settings/tools": "the §13.1 tool registry is the same for every school",
  "GET /import/template": "an empty workbook, identical for every school",
  "GET /import/export": "a workbook, checked by name below rather than by id",
  "GET /notifications/unread-count": "a count, carrying no ids",
};

(async () => {
  const prisma = new PrismaClient(); // unscoped: the oracle, never the subject
  const redis = new Redis({ host: process.env.REDIS_HOST ?? "redis", port: 6379 });

  /**
   * Remove both test schools and everything they own. Run at the start as well
   * as the end: a run that dies half-way must not leave rows that make the
   * *next* run fail on a unique key, which reads as a broken suite rather than
   * a broken previous run.
   */
  async function purge() {
    // By code, not by id: these are the schools this suite created, whatever
    // ids they were given, and nothing else can match.
    const mine = await prisma.school.findMany({
      where: { code: { startsWith: `${P}-` } },
      select: { id: true, code: true },
    });
    for (const school of mine.map((m) => m.id)) {
      for (const k of await redis.keys(`s${school}:*`)) await redis.del(k);
      await prisma.$transaction([
        prisma.mergedTeachingGroupMember.deleteMany({ where: { schoolId: school } }),
        prisma.mergedTeachingGroup.deleteMany({ where: { schoolId: school } }),
        prisma.substitutionLog.deleteMany({ where: { schoolId: school } }),
        prisma.teacherAbsence.deleteMany({ where: { schoolId: school } }),
        prisma.timetableSlot.deleteMany({ where: { schoolId: school } }),
        // after the slots: the FK is RESTRICT, because `draft_id` is the base
        // column of the generated `draft_scope` (§22.2)
        prisma.timetableDraft.deleteMany({ where: { schoolId: school } }),
        prisma.timetablePublication.deleteMany({ where: { schoolId: school } }),
        prisma.teacherSubjectClassSection.deleteMany({ where: { schoolId: school } }),
        prisma.extraClass.deleteMany({ where: { schoolId: school } }),
        prisma.electiveOption.deleteMany({ where: { schoolId: school } }),
        prisma.electiveBlockMember.deleteMany({ where: { schoolId: school } }),
        prisma.electiveBlock.deleteMany({ where: { schoolId: school } }),
        prisma.notification.deleteMany({ where: { schoolId: school } }),
        prisma.classSubject.deleteMany({ where: { schoolId: school } }),
        prisma.classSection.deleteMany({ where: { schoolId: school } }),
        prisma.section.deleteMany({ where: { schoolId: school } }),
        prisma.period.deleteMany({ where: { schoolId: school } }),
        prisma.holiday.deleteMany({ where: { schoolId: school } }),
        prisma.timetableConfig.deleteMany({ where: { schoolId: school } }),
        prisma.schoolClass.deleteMany({ where: { schoolId: school } }),
        prisma.teacherUnavailability.deleteMany({ where: { schoolId: school } }),
        prisma.teacher.deleteMany({ where: { schoolId: school } }),
        prisma.room.deleteMany({ where: { schoolId: school } }),
        prisma.subject.deleteMany({ where: { schoolId: school } }),
        prisma.academicYear.deleteMany({ where: { schoolId: school } }),
        prisma.aiChatLog.deleteMany({ where: { schoolId: school } }),
        prisma.aiSettings.deleteMany({ where: { schoolId: school } }),
        prisma.auditLog.deleteMany({ where: { schoolId: school } }),
        prisma.user.deleteMany({ where: { schoolId: school } }),
        prisma.erpRoleMapping.deleteMany({ where: { schoolId: school } }),
        prisma.rolePermission.deleteMany({ where: { schoolId: school } }),
        prisma.role.deleteMany({ where: { schoolId: school } }),
        prisma.school.deleteMany({ where: { id: school } }),
      ]);
    }
  }

  // --------------------------------------------------------------- fixtures
  console.log("Two schools built for this run, each with a row of every kind:");
  await purge();
  const highest = (await prisma.school.aggregate({ _max: { id: true } }))._max.id ?? 0;
  SCHOOL_A = Math.max(highest + 1, 90000);
  SCHOOL_B = SCHOOL_A + 1;
  info("allocated ids above every existing school", `A ${SCHOOL_A} · B ${SCHOOL_B}`);

  /** A school with a working role, an ERP mapping, and one of everything. */
  async function buildSchool(id, tag) {
    await prisma.school.upsert({
      where: { id },
      create: { id, code: `${P}-${tag}`, name: `${P} School ${tag}` },
      update: { name: `${P} School ${tag}` },
    });
    const role = await prisma.role.upsert({
      where: { schoolId_name: { schoolId: id, name: "Super Admin" } },
      create: { schoolId: id, name: "Super Admin", isSystem: true },
      update: {},
    });
    const seeded = await prisma.rolePermission.findMany({
      where: { role: { schoolId: WITNESS, name: "Super Admin" } },
      select: { permission: true },
    });
    await prisma.rolePermission.createMany({
      data: seeded.map((p) => ({ roleId: role.id, permission: p.permission, schoolId: id })),
      skipDuplicates: true,
    });
    await prisma.erpRoleMapping.upsert({
      where: { schoolId_erpRole: { schoolId: id, erpRole: "ADMIN" } },
      create: { schoolId: id, erpRole: "ADMIN", roleId: role.id },
      update: {},
    });

    const token = await sessionFor({
      erpUserId: `${P}-${tag}`, erpRole: "ADMIN", name: `Admin ${tag}`,
      email: `${tag.toLowerCase()}@${P.toLowerCase()}.test`, schoolId: id,
    });
    const user = await prisma.user.findFirst({ where: { schoolId: id } });

    const year = await prisma.academicYear.create({
      data: { schoolId: id, name: `${P} ${tag} 26-27`, startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31") },
    });
    const room = await prisma.room.create({ data: { schoolId: id, name: `${P} ${tag} Room`, roomType: "classroom" } });
    const subject = await prisma.subject.create({ data: { schoolId: id, name: `${P} ${tag} Maths` } });
    const teacher = await prisma.teacher.create({
      data: { schoolId: id, employeeCode: `${P}${tag}T`, name: `${P} ${tag} Teacher`, maxPeriodsPerWeek: 30 },
    });
    const config = await prisma.timetableConfig.create({
      data: { schoolId: id, name: `${P} ${tag} Wing`, academicYearId: year.id, workingDays: [1, 2, 3, 4, 5], periodsPerDay: 4 },
    });
    // Real periods, so the board and readiness routes have something to answer
    // about rather than 404-ing for their owner too.
    await prisma.period.createMany({
      data: [1, 2, 3, 4, 5].map((n) => ({
        schoolId: id, timetableConfigId: config.id, sortOrder: n, periodNumber: n,
        startTime: `${String(7 + n).padStart(2, "0")}:00`, endTime: `${String(7 + n).padStart(2, "0")}:40`,
        // P5 is the §18 extra window, so an extra class has somewhere to go.
        isExtra: n === 5,
      })),
    });
    const cls = await prisma.schoolClass.create({ data: { schoolId: id, name: `${P} ${tag} VI`, sequence: 6 } });
    const section = await prisma.section.create({ data: { classId: cls.id, name: "A", schoolId: id } });
    const classSection = await prisma.classSection.create({
      data: {
        classId: cls.id, sectionId: section.id, academicYearId: year.id,
        schoolId: id, timetableConfigId: config.id, strength: 30,
      },
    });
    const curriculum = await prisma.classSubject.create({
      data: { classId: cls.id, academicYearId: year.id, subjectId: subject.id, periodsPerWeek: 4, schoolId: id },
    });
    const mapping = await prisma.teacherSubjectClassSection.create({
      data: { teacherId: teacher.id, subjectId: subject.id, classSectionId: classSection.id, periodsPerWeek: 4, schoolId: id },
    });
    const electiveBlock = await prisma.electiveBlock.create({
      data: {
        schoolId: id, name: `${P} ${tag} Third Language`, periodsPerWeek: 2, maxPeriodsPerDay: 1,
        members: { create: [{ classSectionId: classSection.id, schoolId: id }] },
        options: {
          create: [
            { subjectId: subject.id, teacherId: teacher.id, roomId: room.id, schoolId: id },
            { subjectId: subject.id, teacherId: teacher.id, roomId: room.id, schoolId: id },
          ],
        },
      },
    });
    const mergedGroup = await prisma.mergedTeachingGroup.create({
      data: {
        schoolId: id, subjectId: subject.id, teacherId: teacher.id, periodsPerWeek: 2,
        members: { create: [{ classSectionId: classSection.id, schoolId: id }] },
      },
    });
    const extraClass = await prisma.extraClass.create({
      data: {
        schoolId: id, timetableConfigId: config.id, classSectionId: classSection.id,
        subjectId: subject.id, teacherId: teacher.id, dayOfWeek: 1, periodNumber: 5,
        reason: `${P} ${tag} revision`,
      },
    });
    const absence = await prisma.teacherAbsence.create({
      data: { teacherId: teacher.id, date: new Date("2026-09-01"), schoolId: id, reason: `${P} ${tag}` },
    });
    const notification = await prisma.notification.create({
      data: { userId: user.id, schoolId: id, type: "test", title: `${P} ${tag} note`, body: "x" },
    });
    // Draft slots at Monday/Tuesday period 1. Without them the board's move/
    // remove/lock/publish routes answer "nothing there" to *both* sessions, and
    // a matching refusal on both sides is not evidence of scoping.
    //
    // §22 Phase 17: they hang off a real draft registry row, because that is
    // how every write path in the app now builds a slot. Left with a NULL
    // `draft_id` they fall outside the draft the board reads and the routes go
    // back to refusing everyone — which is the fixture lying, not the app.
    const draft = await prisma.timetableDraft.create({
      data: { schoolId: id, timetableConfigId: config.id, draftNo: 1, label: `${P} ${tag} draft` },
    });
    await prisma.timetableSlot.createMany({
      data: [[1, 1], [2, 1]].map(([day, period]) => ({
        schoolId: id, timetableConfigId: config.id, classSectionId: classSection.id,
        dayOfWeek: day, periodNumber: period, subjectId: subject.id, teacherId: teacher.id,
        roomId: room.id, status: "draft", draftId: draft.id, source: "manual",
      })),
    });
    // A published row as well, so `draft-from-published` has something real to
    // copy for the owner. Without it that route answers "nothing published" to
    // both sessions and proves nothing either.
    await prisma.timetableSlot.create({
      data: {
        schoolId: id, timetableConfigId: config.id, classSectionId: classSection.id,
        dayOfWeek: 3, periodNumber: 1, subjectId: subject.id, teacherId: teacher.id,
        roomId: room.id, status: "published", source: "auto",
      },
    });
    // One chat turn, so the AI history collections have rows to compare.
    await prisma.aiChatLog.create({
      data: {
        schoolId: id, userId: user.id, conversationId: `00000000-0000-4000-8000-00000000000${id % 10}`,
        role: "user", content: `${P} ${tag} question`,
      },
    });

    return {
      id, tag, token,
      rows: { year, room, subject, teacher, config, class: cls, classSection, curriculum, mapping, mergedGroup, electiveBlock, absence, notification, role, user },
    };
  }

  const A = await buildSchool(SCHOOL_A, "A");
  const B = await buildSchool(SCHOOL_B, "B");
  check(Boolean(A.token && B.token), "both schools have an admin session");
  if (!A.token || !B.token) process.exit(1);

  const missing = Object.entries(A.rows).filter(([, v]) => !v).map(([k]) => k);
  check(missing.length === 0, "school A has a row of every kind to go after",
    missing.length ? `missing: ${missing.join(", ")}` : `${Object.keys(A.rows).length} resources`);

  /**
   * A throwaway row of one kind, for routes that delete or restructure what
   * they touch. Every such route gets its own, so no route's control depends
   * on another route not having run first.
   */
  let seq = 0;
  async function freshRow(school, resource) {
    const id = school.id;
    const t = school.tag;
    const n = ++seq;
    const base = school.rows;
    switch (resource) {
      case "room": return prisma.room.create({ data: { schoolId: id, name: `${P} ${t} R${n}`, roomType: "classroom" } });
      case "subject": return prisma.subject.create({ data: { schoolId: id, name: `${P} ${t} S${n}` } });
      case "class": return prisma.schoolClass.create({ data: { schoolId: id, name: `${P} ${t} C${n}`, sequence: n } });
      case "year": return prisma.academicYear.create({
        data: { schoolId: id, name: `${P} ${t} Y${n}`, startDate: new Date("2027-04-01"), endDate: new Date("2028-03-31") },
      });
      case "teacher": return prisma.teacher.create({
        data: { schoolId: id, employeeCode: `${P}${t}T${n}`, name: `${P} ${t} T${n}`, maxPeriodsPerWeek: 30 },
      });
      case "config": return prisma.timetableConfig.create({
        data: { schoolId: id, name: `${P} ${t} W${n}`, academicYearId: base.year.id, workingDays: [1, 2, 3, 4, 5], periodsPerDay: 4 },
      });
      case "classSection": {
        const cls = await prisma.schoolClass.create({ data: { schoolId: id, name: `${P} ${t} CS${n}`, sequence: n } });
        const sec = await prisma.section.create({ data: { classId: cls.id, name: "A", schoolId: id } });
        return prisma.classSection.create({
          data: { classId: cls.id, sectionId: sec.id, academicYearId: base.year.id, schoolId: id, strength: 30 },
        });
      }
      case "curriculum": {
        const cls = await prisma.schoolClass.create({ data: { schoolId: id, name: `${P} ${t} CU${n}`, sequence: n } });
        return prisma.classSubject.create({ data: { classId: cls.id, academicYearId: base.year.id, subjectId: base.subject.id, periodsPerWeek: 3, schoolId: id } });
      }
      case "mapping": {
        const cs = await freshRow(school, "classSection");
        return prisma.teacherSubjectClassSection.create({
          data: { teacherId: base.teacher.id, subjectId: base.subject.id, classSectionId: cs.id, periodsPerWeek: 3, schoolId: id },
        });
      }
      case "extraClass": {
        const cs = await freshRow(school, "classSection");
        return prisma.extraClass.create({
          data: {
            schoolId: id, timetableConfigId: base.config.id, classSectionId: cs.id,
            subjectId: base.subject.id, teacherId: base.teacher.id, dayOfWeek: (n % 5) + 1, periodNumber: 5,
          },
        });
      }
      case "electiveBlock": {
        const cs = await freshRow(school, "classSection");
        return prisma.electiveBlock.create({
          data: {
            schoolId: id, name: `${P} ${t} Elective ${n}`, periodsPerWeek: 2, maxPeriodsPerDay: 1,
            members: { create: [{ classSectionId: cs.id, schoolId: id }] },
            options: {
              create: [
                { subjectId: base.subject.id, teacherId: base.teacher.id, roomId: base.room.id, schoolId: id },
                { subjectId: base.subject.id, teacherId: base.teacher.id, roomId: base.room.id, schoolId: id },
              ],
            },
          },
        });
      }
      case "mergedGroup": {
        const cs = await freshRow(school, "classSection");
        return prisma.mergedTeachingGroup.create({
          data: {
            schoolId: id, subjectId: base.subject.id, teacherId: base.teacher.id, periodsPerWeek: 2,
            members: { create: [{ classSectionId: cs.id, schoolId: id }] },
          },
        });
      }
      case "absence": {
        const teacher = await freshRow(school, "teacher");
        return prisma.teacherAbsence.create({ data: { teacherId: teacher.id, date: new Date("2026-10-01"), schoolId: id } });
      }
      case "notification": return prisma.notification.create({
        data: { userId: base.user.id, schoolId: id, type: "test", title: `${P} ${t} n${n}`, body: "x" },
      });
      case "role": return prisma.role.create({ data: { schoolId: id, name: `${P} ${t} Role ${n}` } });
      case "user": return prisma.user.create({
        data: { schoolId: id, roleId: base.role.id, name: `${P} ${t} U${n}`, email: `u${n}.${t}@${P.toLowerCase()}.test`, erpUserId: `${P}-${t}-U${n}` },
      });
      default: throw new Error(`freshRow: no recipe for ${resource}`);
    }
  }

  const witnessBefore = JSON.stringify({
    school: await prisma.school.findUnique({ where: { id: WITNESS } }),
    rooms: await prisma.room.count({ where: { schoolId: WITNESS } }),
    subjects: await prisma.subject.count({ where: { schoolId: WITNESS } }),
    slots: await prisma.timetableSlot.count({ where: { schoolId: WITNESS } }),
    unread: await prisma.notification.count({ where: { schoolId: WITNESS, isRead: false } }),
    settings: await prisma.aiSettings.findMany({ where: { schoolId: WITNESS } }),
  });

  // ------------------------------------------------------------ 1. CENSUS
  console.log("\nEvery route the application registers is accounted for:");
  const census = await call("GET", "/dev/routes", A.token);
  check(census.status === 200 && census.json?.count > 0, "the running app reported its route table",
    `${census.json?.count ?? 0} route(s)`);
  const routes = census.json?.routes ?? [];

  const buckets = { path: [], list: [], body: [], effect: [], stamp: [], none: [], platform: [], public: [], dev: [] };
  const unclassified = [];
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    if (r.public) { buckets.public.push(r); continue; }
    if (r.platform) { buckets.platform.push(r); continue; }
    if (r.path.startsWith("/dev/")) { buckets.dev.push(r); continue; }
    if (r.path.includes(":")) {
      // A parameter that is not a row id has nothing to cross schools with.
      const notAnId = PARAM_NOT_AN_ID[key];
      if (notAnId) { buckets[notAnId.how].push({ ...r, ...notAnId }); continue; }
      const hit = PARAM_RESOURCE.filter(([pat]) => r.path.startsWith(pat)).sort((x, y) => y[0].length - x[0].length)[0];
      if (hit) buckets.path.push({ ...r, resource: hit[1] });
      else unclassified.push(`${key} (parameterised, no resource mapping)`);
      continue;
    }
    if (r.method === "GET") {
      const q = QUERY_ROUTES[key];
      if (q) buckets.path.push({ ...r, resource: q.resource, query: q.query });
      else buckets.list.push(r);
      continue;
    }
    const decided = NO_ID[key];
    if (!decided) unclassified.push(`${key} (no id in the path, and no decision recorded)`);
    else buckets[decided.how].push({ ...r, ...decided });
  }
  check(unclassified.length === 0, "no route is unclassified",
    unclassified.length ? `\n        ${unclassified.join("\n        ")}` : `${routes.length} classified`);

  // A @Public() route is exempt from every scoping check below, so the set of
  // them is the application's whole unauthenticated attack surface. Bucketing
  // them automatically — as the loop above does — means a data endpoint that
  // someone marks public by mistake passes this sweep in silence, which is the
  // one thing this file exists not to allow. Every one must be named here, with
  // the reason it is safe to serve a stranger.
  const PUBLIC_ALLOWED = {
    "GET /health": "liveness; reports no school's data",
    "GET /sso/callback": "§15.1 the ERP door — the signed token IS the credential",
    "POST /dev/erp-token": "dev-only stub ERP; refused when NODE_ENV=production",
    "GET /dev/mail": "dev-only captured mail; refused when NODE_ENV=production",
    "GET /dev/mail/token": "dev-only captured mail; refused when NODE_ENV=production",
    // §15.3 Phase 25.0 — the local sign-in surface. Public by definition:
    // whoever calls these has no credential yet. Each answers identically for a
    // known and an unknown address, so none of them is an existence oracle.
    "GET /auth/methods": "§15.3 which ways in this deployment offers; no data",
    "POST /auth/register": "§15.3 create an account; same answer whoever you are",
    "POST /auth/login": "§15.3 sign in; same body AND time for unknown vs wrong",
    "POST /auth/forgot": "§15.3 request a reset; same answer whoever you are",
    "POST /auth/reset": "§15.3 redeem a reset link; the one-shot token is the credential",
    "POST /auth/verify": "§15.3 redeem a verification link; likewise",
    "GET /auth/verify": "§15.3 landing hint only; reveals nothing",
    "GET /auth/account": "§15.3 guarded by AccountAuthGuard, not JwtAuthGuard — @Public() only skips the SESSION guard",
    // §15.3 Phase 25.1 — the account-level school endpoints. Same story as
    // /auth/account: `@Public()` here means "not a SCHOOL session", not
    // "unauthenticated". `AccountAuthGuard` requires an account token, and each
    // one then scopes to that account: the list is every school it has an
    // active `users` row in (since 25.6, which is when creating a school and
    // being able to enter one came apart), and
    // `enter` mints a session only where the account already has a `users` row
    // — a school it does not is *not found*, never a refusal that confirms the
    // school exists.
    // §24.8 Phase 25.6 — accepting an invitation. The emailed one-shot token IS
    // the credential, exactly as the verify and reset links are. The GET only
    // LOOKS: it names who was invited without spending the token, so a mail
    // scanner that pre-fetches links cannot burn the invitation — and it says
    // nothing about any school, only the address the invitation was issued to.
    "GET /auth/invite/:token": "§24.8 shows an invitation without consuming it; the token is the credential",
    "POST /auth/invite/accept": "§24.8 redeem an invitation; one-shot, and grants nothing beyond the account",
    "GET /schools": "§15.3 AccountAuthGuard; lists only this account's own schools",
    "POST /schools": "§15.3 AccountAuthGuard; owners only, verified only, capped — refused server-side",
    "POST /schools/:id/enter": "§15.3 AccountAuthGuard; mints a session only where this account has a user row",
  };
  const unexpectedPublic = buckets.public
    .map((r) => `${r.method} ${r.path}`)
    .filter((k) => !(k in PUBLIC_ALLOWED));
  check(unexpectedPublic.length === 0,
    "every unauthenticated route is one somebody decided to expose",
    unexpectedPublic.length
      ? `\n        UNEXPECTED: ${unexpectedPublic.join("\n        UNEXPECTED: ")}`
      : `${buckets.public.length} public route(s), all accounted for`);

  // ...and the reverse: a route that stops being public should not leave a
  // stale entry behind claiming it still is.
  const goneFromApp = Object.keys(PUBLIC_ALLOWED)
    .filter((k) => !buckets.public.some((r) => `${r.method} ${r.path}` === k));
  check(goneFromApp.length === 0, "and the list has no entries for routes that no longer exist",
    goneFromApp.join(", ") || "none stale");
  info("classified", Object.entries(buckets).map(([k, v]) => `${k} ${v.length}`).join(" · "));

  // Print the exemptions rather than only counting them. An exemption that
  // nobody ever reads is indistinguishable from an oversight, and this is the
  // ledger of what the run deliberately did *not* test.
  console.log("\n  Not swept here, and why:");
  for (const r of [...buckets.stamp, ...buckets.none]) {
    console.log(`    ${`${r.method} ${r.path}`.padEnd(30)} ${r.reason}`);
  }
  for (const r of buckets.public) {
    console.log(`    ${`${r.method} ${r.path}`.padEnd(30)} public — no session to scope`);
  }
  for (const r of buckets.dev) {
    console.log(`    ${`${r.method} ${r.path}`.padEnd(30)} dev-only — returns 404 in production`);
  }

  // -------------------------------------------------------------- 2. PATH
  console.log("\nSame request, same id, two sessions — only the answer differs:");
  let swept = 0, indistinct = 0;
  // Two orderings, for two different reasons.
  //
  // DELETE last, because every other verb is more informative against a row
  // whose relations are still intact.
  //
  // And the board in its own lifecycle order, because it is a stateful screen:
  // asking to draft-from-published before anything has been published gets a
  // refusal that has nothing to do with who is asking, and both sessions then
  // see the same 400. Order it as a person would use it and each route is
  // exercised in the state it exists for.
  const BOARD_ORDER = ["context", "place", "lock", "move", "swap", "remove", "publish/preview", "publish", "draft-from-published"];
  const rank = (r) => {
    if (r.method === "DELETE") return 1000;
    const step = BOARD_ORDER.findIndex((b) => r.path.endsWith(`/board/${b}`));
    return step === -1 ? 0 : 100 + step;
  };
  const ordered = [...buckets.path].sort((x, y) => rank(x) - rank(y));
  for (const r of ordered) {
    const key = `${r.method} ${r.path}`;
    const disposable = r.method === "DELETE" || NEEDS_FRESH.has(key);
    const row = disposable ? await freshRow(A, r.resource) : A.rows[r.resource];
    if (!row) { fail(key, `no ${r.resource} to test with`); continue; }

    const url = r.query ? `${r.path}${r.query(row.id)}` : r.path.replace(/:(\w+)/, String(row.id));
    const payload = r.method === "GET" ? null : BODY_FOR(key, ++seq, A);
    // A first: if A cannot reach its own row either, the control is worthless,
    // and we want to know that before reading anything into B's refusal.
    const asA = await call(r.method, url, A.token, payload);
    const asB = await call(r.method, url, B.token, payload);

    if (!refused(asB.status)) {
      fail(`${key} — B reached A's ${r.resource}`, `${asB.status} ${(asB.text || "").slice(0, 90)}`);
    } else if (asA.status === asB.status) {
      // Same answer to both: this run proved nothing about *ownership*. Never
      // counted as a pass, however plausible the status code looks.
      indistinct++;
      info(`${key} — both sessions got ${asA.status}`,
        `cannot tell scoping apart from a route that refuses everyone: ${(asA.text || "").slice(0, 70)}`);
    } else {
      swept++;
      pass(key, `A ${asA.status} · B ${asB.status} on the same ${r.resource}`);
    }
  }
  check(indistinct === 0, "every parameterised route discriminated by session",
    indistinct ? `${indistinct} answered the same to both` : `${swept} routes`);

  // Platform routes sit above schools by design (§17.6): neither school admin
  // may reach them, however complete their school permissions are.
  console.log("\nPlatform routes refuse a school session, however privileged:");
  for (const r of buckets.platform) {
    const url = r.path.replace(/:(\w+)/, "1");
    const asB = await call(r.method, url, B.token, r.method === "GET" ? null : {});
    check(asB.status === 403, `${r.method} ${r.path}`, `${asB.status}`);
  }

  // -------------------------------------------------------------- 3. LIST
  console.log("\nNo collection shows one school any of the other's rows:");
  for (const r of buckets.list) {
    const key = `${r.method} ${r.path}`;
    if (LIST_NO_IDS[key]) { info(key, LIST_NO_IDS[key]); continue; }
    const [ra, rb] = [await call("GET", r.path, A.token), await call("GET", r.path, B.token)];
    if (!ok2xx(ra.status) || !ok2xx(rb.status)) { fail(key, `A ${ra.status} · B ${rb.status}`); continue; }
    const [ia, ib] = [idsIn(ra.json), idsIn(rb.json)];
    const shared = [...ia].filter((id) => ib.has(id));
    if (shared.length) fail(key, `${shared.length} shared id(s): ${shared.slice(0, 5).join(", ")}`);
    else if (ia.size === 0) info(key, "A returned no ids here; nothing could have leaked");
    else pass(key, `A ${ia.size} id(s) · B ${ib.size} · none in common`);
  }

  // The chat log's id is a BigInt, which serialises as a string, so the id
  // comparison above finds nothing to compare on these two and would pass
  // whatever they returned. Compare what they actually carry: the text.
  const convoA = `${P} A question`;
  for (const [label, path] of [
    ["GET /ai/chat/conversations", "/ai/chat/conversations"],
    ["GET /ai/chat/history", `/ai/chat/history?conversationId=00000000-0000-4000-8000-00000000000${SCHOOL_A % 10}`],
  ]) {
    const [ra, rb] = [await call("GET", path, A.token), await call("GET", path, B.token)];
    const seenByA = JSON.stringify(ra.json ?? "").includes(convoA);
    const seenByB = JSON.stringify(rb.json ?? "").includes(convoA);
    // A must see its own turn, or the comparison is between two empty lists.
    check(seenByA && !seenByB, `${label} — B cannot read A's conversation`,
      seenByA ? (seenByB ? "B saw A's question" : "A sees it, B does not") : "A could not see its own turn either");
  }

  // The export is a workbook, so ids do not apply — but names do, and a name
  // is the tell an id cannot be: ids can coincide across schools, names will not.
  const exported = await fetch(`${API}/api/import/export`, { headers: { Authorization: `Bearer ${B.token}` } });
  const exportedWb = new ExcelJS.Workbook();
  await exportedWb.xlsx.load(await exported.arrayBuffer());
  let exportText = "";
  exportedWb.eachSheet((ws) => ws.eachRow((row) => { exportText += row.values.join("|"); }));
  const aNames = [A.rows.room.name, A.rows.subject.name, A.rows.teacher.name, A.rows.class.name];
  const leakedToExport = aNames.filter((n) => exportText.includes(n));
  check(leakedToExport.length === 0, "GET /import/export gives B only B's masters",
    leakedToExport.length ? `leaked ${leakedToExport.join(", ")}` : `${exportText.length} chars, none of A's names`);

  // -------------------------------------------------------------- 4. BODY
  // Subtler than the IDOR above, and it survives row scoping on its own: the
  // row B writes is stamped as B's, so every scoped read looks clean — but it
  // points into A's data, and B's readiness and solver would then pull A's
  // rows into B's timetable.
  console.log("\nA's ids smuggled through a request body are refused:");
  const bodyAttacks = [
    ["POST /class-subjects", "POST", "/class-subjects",
      { classId: A.rows.class.id, academicYearId: B.rows.year.id, subjectId: B.rows.subject.id, periodsPerWeek: 2 }],
    ["POST /mappings", "POST", "/mappings",
      { teacherId: B.rows.teacher.id, subjectId: B.rows.subject.id, classSectionId: A.rows.classSection.id, periodsPerWeek: 2 }],
    ["POST /merged-groups", "POST", "/merged-groups",
      { subjectId: B.rows.subject.id, teacherId: B.rows.teacher.id, periodsPerWeek: 2, classSectionIds: [A.rows.classSection.id, B.rows.classSection.id] }],
    ["POST /absences", "POST", "/absences",
      { teacherId: A.rows.teacher.id, date: "2026-09-02" }],
    ["PUT /admin/erp-mappings", "PUT", "/admin/erp-mappings",
      { mappings: [{ erpRole: "ADMIN", roleId: A.rows.role.id }] }],
    ["POST /extra-classes", "POST", "/extra-classes",
      { timetableConfigId: A.rows.config.id, classSectionId: A.rows.classSection.id,
        subjectId: B.rows.subject.id, teacherId: B.rows.teacher.id, dayOfWeek: 1, periodNumber: 5 }],
    ["POST /elective-blocks", "POST", "/elective-blocks",
      { name: `${P} Cross`, periodsPerWeek: 2, classSectionIds: [A.rows.classSection.id],
        options: [
          { subjectId: B.rows.subject.id, teacherId: B.rows.teacher.id, roomId: B.rows.room.id },
          { subjectId: B.rows.subject.id, teacherId: B.rows.teacher.id, roomId: B.rows.room.id },
        ] }],
    ["POST /ai/explain-readiness", "POST", "/ai/explain-readiness",
      { configId: A.rows.config.id }],
    ["POST /auth/switch-school", "POST", "/auth/switch-school",
      { schoolId: SCHOOL_A }],
  ];
  for (const [label, method, path, body] of bodyAttacks) {
    const r = await call(method, path, B.token, body);
    check(refused(r.status), label, `${r.status}`);
  }

  // The importer resolves names against the caller's school. A room that
  // exists only in A must therefore read as NEW for B, not as "already
  // exists" — a duplicate check reaching across schools is a quiet leak of
  // what the other school has.
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Rooms");
  sheet.addRow(["Room Name", "Type", "Capacity", "Shared"]);
  sheet.addRow([A.rows.room.name, "classroom", 30, "No"]);
  const form = new FormData();
  form.append("file", new Blob([await wb.xlsx.writeBuffer()], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }), "sweep.xlsx");
  const dry = await fetch(`${API}/api/import/dry-run`, {
    method: "POST", headers: { Authorization: `Bearer ${B.token}` }, body: form,
  });
  const plan = (await dry.json().catch(() => null))?.plan;
  const rooms = (plan?.sheets ?? []).find((s) => s.sheet === "Rooms");
  check(ok2xx(dry.status), "POST /import/dry-run accepted B's workbook", `${dry.status}`);
  check(rooms ? rooms.skip === 0 && rooms.create === 1 : false,
    "POST /import/dry-run — a room existing only in A reads as new for B",
    rooms ? `create ${rooms.create} · skip-as-existing ${rooms.skip}` : "no Rooms sheet in the plan");

  // ------------------------------------------------------------ 5. EFFECT
  console.log("\nB's session-wide writes touch nothing of A's:");
  const nameBefore = (await prisma.school.findUnique({ where: { id: SCHOOL_A } })).name;
  await call("PUT", "/school", B.token, { name: `${P} Renamed By B`, timezone: "Asia/Kolkata" });
  const nameAfter = (await prisma.school.findUnique({ where: { id: SCHOOL_A } })).name;
  check(nameBefore === nameAfter, "PUT /school renamed B's school only", `A is still "${nameAfter}"`);

  // A fresh one: the route sweep above marked A's standing notification read,
  // and "0 unread before and after" would be a comparison of two nothings.
  await freshRow(A, "notification");
  const unreadBefore = await prisma.notification.count({ where: { schoolId: SCHOOL_A, isRead: false } });
  await call("POST", "/notifications/read-all", B.token);
  const unreadAfter = await prisma.notification.count({ where: { schoolId: SCHOOL_A, isRead: false } });
  check(unreadBefore === unreadAfter && unreadBefore > 0, "POST /notifications/read-all spared A's notifications",
    `${unreadBefore} unread before, ${unreadAfter} after`);

  await call("PUT", "/ai/settings", A.token, { provider: "anthropic", model: "claude-opus-5" });
  const settingsBefore = await prisma.aiSettings.findFirst({ where: { schoolId: SCHOOL_A } });
  await call("PUT", "/ai/settings", B.token, { provider: "google", model: "gemini-3.5-flash-lite" });
  const settingsAfter = await prisma.aiSettings.findFirst({ where: { schoolId: SCHOOL_A } });
  check(settingsBefore && JSON.stringify(settingsBefore) === JSON.stringify(settingsAfter),
    "PUT /ai/settings left A's provider configuration alone",
    `A still on ${settingsAfter?.provider}/${settingsAfter?.model}`);

  // --------------------------------------------------- 6. AI TOOL REGISTRY
  // Invariant 9's real claim. Run through the same registry the model calls,
  // with the context built server-side from the session — so the only thing
  // that varies between these calls and a real conversation is that no model
  // chose the arguments.
  console.log("\nEvery AI tool answers about B alone, even handed A's ids:");
  const toolList = await call("GET", "/ai/settings/tools", A.token);
  const toolNames = (toolList.json ?? []).map((t) => t.name);
  const TOOL_ARGS = {
    getTimetableConfigs: {},
    listTeachers: {},
    listClassSections: {},
    // §13.5 Phase C — the read that makes a mapping change draftable.
    // Deliberately unfiltered: handing it A's employee code would return an
    // empty list for B, and an empty answer proves nothing about scoping. Run
    // wide open, B's answer is B's real mappings, class teachers and merged
    // groups — so "none of A's" is a claim about data that actually came back.
    listSubjectMappings: {},
    getClassSectionTimetable: { class_section_id: A.rows.classSection.id },
    getTeacherTimetable: { teacher_id: A.rows.teacher.id },
    getTeacherLoadSummary: {},
    getRoomUtilization: {},
    getFreeTeachers: { day_of_week: 1, period_number: 1 },
    getReadinessStatus: {},
    getSubstitutionHistory: { date_from: "2026-01-01", date_to: "2026-12-31" },
    generateReport: { report_type: "class_section", class_section_id: A.rows.classSection.id },
    // §13.5 — the drafting tool. The dev seam builds its context with
    // canWrite:false, so this must come back refused; the write path's own
    // isolation is proved by ai-data-entry-smoke.cjs.
    draftMasterData: { sheets: [{ sheet: "Subjects", rows: [{ name: "ZZSWP Probe Subject" }] }] },
  };
  const untested = toolNames.filter((n) => !(n in TOOL_ARGS));
  check(untested.length === 0, "every registered tool has a case here", untested.join(", ") || `${toolNames.length} tools`);

  // draftMasterData runs here as B, an admin, and so produces a real proposal
  // — for B's own school. That is the property this sweep tests: it must carry
  // none of A's rows. The permission gate itself is asserted in
  // ai-data-entry-smoke.cjs step 8, with a session that genuinely lacks
  // masters.manage; asserting it here, where B is a Super Admin, would only
  // ever have tested the wrong branch.

  const aNamesAll = [A.rows.room.name, A.rows.subject.name, A.rows.teacher.name, A.rows.class.name, A.rows.config.name];
  const bIds = new Set(Object.values(B.rows).map((r) => r?.id).filter((n) => typeof n === "number"));
  const aIds = new Set(Object.values(A.rows).map((r) => r?.id).filter((n) => typeof n === "number"));
  for (const name of toolNames) {
    const r = await call("POST", "/dev/ai-tool", B.token, {
      name, args: TOOL_ARGS[name] ?? {}, timetableConfigId: A.rows.config.id,
    });
    // A tool that refuses outright is a fine answer; what it must never do is
    // succeed *with A's data in it*.
    if (r.status === 404) { pass(`tool ${name}`, "refused (404)"); continue; }
    if (!ok2xx(r.status)) { fail(`tool ${name}`, `${r.status} ${(r.text || "").slice(0, 80)}`); continue; }
    const text = JSON.stringify(r.json?.result ?? null);
    const leakedName = aNamesAll.filter((n) => n && text.includes(n));
    const leakedId = [...idsIn(r.json?.result ?? null)].filter((id) => aIds.has(id) && !bIds.has(id));
    check(leakedName.length === 0 && leakedId.length === 0, `tool ${name}`,
      leakedName.length || leakedId.length
        ? `leaked ${leakedName.join(", ")}${leakedId.length ? ` id ${leakedId.join(",")}` : ""}`
        : `${text.length} chars, none of A's`);
  }

  // -------------------------------------------------------------- 7. KEYS
  console.log("\nEvery Redis key belongs to a school or to the infrastructure:");
  // Populate first. By this point the sweep's own writes have invalidated
  // everything either school had cached, and scanning an empty cache would
  // find no unprefixed key for the happy reason that it found no key at all.
  for (const school of [A, B]) {
    await call("GET", `/timetable-configs/${school.rows.config.id}/readiness`, school.token);
    await call("GET", `/timetable-configs/${school.rows.config.id}/slots`, school.token);
  }
  const keys = await redis.keys("*");
  //   bull:*          BullMQ's own bookkeeping
  //   sched:inflight: names its school inside the key (§17.7)
  //   ai:models:      the provider catalogue, identical for every school
  //   sso:nonce:      replay protection, written while verifying the ERP token —
  //                   before any school is known, which is the point of it
  //   mail:           §15.3 — captured verification and reset messages, keyed by
  //                   EMAIL ADDRESS. Deliberately school-less: a person
  //                   registering has no school, and an address is not a
  //                   school's property. Dev-read-only, short TTL.
  //   throttle:*:ip:  §15.3 — sign-in budgets, keyed by source address. Also
  //                   deliberately school-less, and for the same reason: at
  //                   sign-in nobody has chosen a school, and an IP belongs to
  //                   no tenant.
  const infra = /^(bull:|sched:inflight:|ai:models:|sso:nonce:|mail:|throttle:)/;
  const stray = keys.filter((k) => !infra.test(k) && !/^s\d+:/.test(k));
  const aKeys = keys.filter((k) => k.startsWith(`s${SCHOOL_A}:`));
  const bKeys = keys.filter((k) => k.startsWith(`s${SCHOOL_B}:`));
  check(stray.length === 0, "no cache key without a school prefix",
    stray.length ? stray.slice(0, 6).join(", ") : `${keys.length} key(s) scanned`);
  // Without this the check above is satisfied by an empty cache.
  check(aKeys.length > 0 && bKeys.length > 0, "and both schools actually cached under their own prefix",
    `A ${aKeys.length} · B ${bKeys.length}`);

  // --------------------------------------------------- the real school
  console.log("\nThe seeded school, which took no part in any of this:");
  const witnessAfter = JSON.stringify({
    school: await prisma.school.findUnique({ where: { id: WITNESS } }),
    rooms: await prisma.room.count({ where: { schoolId: WITNESS } }),
    subjects: await prisma.subject.count({ where: { schoolId: WITNESS } }),
    slots: await prisma.timetableSlot.count({ where: { schoolId: WITNESS } }),
    unread: await prisma.notification.count({ where: { schoolId: WITNESS, isRead: false } }),
    settings: await prisma.aiSettings.findMany({ where: { schoolId: WITNESS } }),
  });
  check(witnessBefore === witnessAfter, "is byte-identical to before the sweep");

  // ----------------------------------------------------------------- cleanup
  console.log("\nCleanup:");
  await purge();
  const leftovers = await prisma.school.count({ where: { code: { startsWith: `${P}-` } } });
  check(leftovers === 0, "both test schools and everything they owned are gone");

  await prisma.$disconnect();
  await redis.quit();
  console.log(failed ? "\nSOME ISOLATION SWEEP CHECKS FAILED" : "\nALL ISOLATION SWEEP CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
