/**
 * §3.13 — deleting a whole timetable, live.
 *
 *   docker compose exec api node /app/scripts/delete-timetable-smoke.cjs
 *
 * The reason this suite exists is one fact about the schema: **`timetable_slots`
 * and `timetable_publications` have no foreign key to `timetable_config`.** The
 * old one-line delete therefore "worked" — it returned 200, the card vanished,
 * and every generated row stayed behind pointing at a timetable that no longer
 * existed. Nothing in the database complained, and nothing ever would. So every
 * check below counts ROWS, not responses.
 *
 *   1. PLAN     — the preview counts what is there, and writes nothing
 *   2. DELETE   — the config and every dependent row go, in one transaction
 *   3. KEPT     — class-sections survive, detached; masters are untouched
 *   4. NEIGHBOUR— the school's OTHER timetable is not touched
 *   5. PUBLISHED— an ever-published timetable is refused, and nothing is deleted
 *   6. STRANGER — another school's id is a 404, and its rows are all still there
 *   7. TEACHER  — a teacher may neither plan nor delete
 *
 * Everything it creates uses @zzdel.test / "ZZDEL " and is removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { groupFor } = require("./resource-groups.cjs");
const { PrismaClient: ControlClient } = req("/app/apps/api/prisma/generated/control-client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const DOMAIN = "zzdel.test";
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
  await call("POST", "/auth/register", null, { email, password: PW, name: "ZZ Deleter" });
  const vt = await mailToken(email, "verify");
  const acct = (await call("POST", "/auth/verify", null, { token: vt })).json.accountToken;
  const made = await call("POST", "/schools", acct, { name: schoolName });
  return { acct, session: made.json.sessionToken, schoolId: made.json.schoolId };
}

(async () => {
  const prisma = new PrismaClient();
  const control = new ControlClient({ datasources: { db: { url: process.env.CONTROL_DATABASE_URL } } });

  const purge = async () => {
    const mine = await prisma.school.findMany({
      where: { name: { startsWith: "ZZDEL " } }, select: { id: true, code: true },
    });
    const ids = mine.map((s) => s.id);
    if (ids.length) {
      const where = { where: { schoolId: { in: ids } } };
      // Slots before drafts: `draft_id` is the base column of the generated
      // `draft_scope`, so its FK is RESTRICT — the same order the feature uses.
      for (const m of [
        "timetableSlot", "timetableDraft", "timetablePublication", "extraClass", "period",
        "autoFixRun", "classSection", "section", "schoolClass", "subject", "teacher", "room",
        "timetableConfig", "academicYear", "onboardingSession", "aiChatLog", "auditLog",
        "user", "rolePermission", "erpRoleMapping", "role",
      ]) {
        await prisma[m].deleteMany(where).catch(() => undefined);
      }
      await prisma.school.deleteMany({ where: { id: { in: ids } } });
    }
    await control.tenant.deleteMany({ where: { schoolCode: { in: mine.map((s) => s.code) } } });
    await control.account.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
  };
  await purge();

  /**
   * A timetable with something in it: periods, two drafts, draft slots, a
   * published slot, an extra class, and three class-sections attached.
   *
   * Built with Prisma rather than by generating, because what is under test is
   * the cascade and not the solver — and because a suite that has to solve a
   * school first is a suite nobody runs.
   */
  async function buildConfig(schoolId, yearId, name, { published = false } = {}) {
    const cfg = await prisma.timetableConfig.create({
      data: {
        resourceGroupId: await groupFor(prisma, yearId),
        schoolId, academicYearId: yearId, name,
        workingDays: [1, 2, 3, 4, 5], periodsPerDay: 4, periodDurationMins: 40, startTime: "08:00",
      },
    });
    await prisma.period.createMany({
      data: [1, 2, 3, 4].map((n) => ({
        schoolId, timetableConfigId: cfg.id, sortOrder: n, periodNumber: n,
        startTime: `${String(7 + n).padStart(2, "0")}:00`,
        endTime: `${String(7 + n).padStart(2, "0")}:40`,
      })),
    });

    const klass = await prisma.schoolClass.create({
      data: { schoolId, name: `ZZ${name.slice(-1)}5`, sequence: 8 },
    });
    const sections = [];
    for (const letter of ["A", "B", "C"]) {
      const sec = await prisma.section.create({ data: { schoolId, classId: klass.id, name: letter } });
      sections.push(await prisma.classSection.create({
        data: {
          resourceGroupId: await groupFor(prisma, yearId), schoolId, classId: klass.id, sectionId: sec.id, academicYearId: yearId, timetableConfigId: cfg.id },
      }));
    }
    const subject = await prisma.subject.create({ data: { schoolId, name: `ZZ Maths ${cfg.id}` } });
    const teacher = await prisma.teacher.create({
      data: { schoolId, employeeCode: `ZZD${cfg.id}`, name: "ZZ Teacher" },
    });
    const room = await prisma.room.create({ data: { schoolId, name: `ZZ Room ${cfg.id}` } });

    // Two drafts, so "every draft's rows" is a real claim rather than one draft.
    const drafts = [];
    for (const no of [1, 2]) {
      drafts.push(await prisma.timetableDraft.create({
        data: { schoolId, timetableConfigId: cfg.id, draftNo: no, label: `ZZ Draft ${no}` },
      }));
    }
    let day = 1;
    for (const d of drafts) {
      for (const cs of sections) {
        await prisma.timetableSlot.create({
          data: {
            schoolId, timetableConfigId: cfg.id, status: "draft", draftId: d.id,
            classSectionId: cs.id, dayOfWeek: day, periodNumber: 1,
            subjectId: subject.id, teacherId: teacher.id, roomId: room.id,
            teacherOccupancyKey: `T-${teacher.id}`,
          },
        });
        day += 1;
      }
      day = 1;
    }
    // One §18 extra-class pair: the ExtraClass row and the slot that reserves
    // the cell. `draft_scope` collapses extras to 0, so they sit outside both
    // drafts — exactly the rows a per-draft delete would miss.
    await prisma.timetableSlot.create({
      data: {
        schoolId, timetableConfigId: cfg.id, status: "draft", source: "extra",
        classSectionId: sections[0].id, dayOfWeek: 6, periodNumber: 5,
        subjectId: subject.id, teacherId: teacher.id, roomId: room.id,
        teacherOccupancyKey: `T-${teacher.id}`,
      },
    });
    await prisma.extraClass.create({
      data: {
        schoolId, timetableConfigId: cfg.id, classSectionId: sections[0].id,
        subjectId: subject.id, teacherId: teacher.id, dayOfWeek: 6, periodNumber: 5,
        reason: "ZZ revision",
      },
    });

    if (published) {
      await prisma.timetableSlot.create({
        data: {
          schoolId, timetableConfigId: cfg.id, status: "published",
          classSectionId: sections[0].id, dayOfWeek: 2, periodNumber: 2,
          subjectId: subject.id, teacherId: teacher.id, roomId: room.id,
          teacherOccupancyKey: `T-${teacher.id}`,
        },
      });
      await prisma.timetablePublication.create({
        data: { schoolId, timetableConfigId: cfg.id, version: 1, slotCount: 1, changedCount: 1, unallocatedCount: 0 },
      });
    }
    return { cfg, sections, subject, teacher, room, klass };
  }

  const counts = async (configId) => ({
    slots: await prisma.timetableSlot.count({ where: { timetableConfigId: configId } }),
    drafts: await prisma.timetableDraft.count({ where: { timetableConfigId: configId } }),
    periods: await prisma.period.count({ where: { timetableConfigId: configId } }),
    extras: await prisma.extraClass.count({ where: { timetableConfigId: configId } }),
    publications: await prisma.timetablePublication.count({ where: { timetableConfigId: configId } }),
    config: await prisma.timetableConfig.count({ where: { id: configId } }),
  });

  const a = await newOwnerWithSchool(`a@${DOMAIN}`, "ZZDEL Nalanda");
  const year = await prisma.academicYear.create({
    data: { schoolId: a.schoolId, name: "ZZDEL 2026-27", startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31") },
  });
  const primary = await buildConfig(a.schoolId, year.id, "ZZDEL Primary");
  const senior = await buildConfig(a.schoolId, year.id, "ZZDEL Senior");
  const live = await buildConfig(a.schoolId, year.id, "ZZDEL Published", { published: true });

  // ─────────────────────────────────────────────────────────────── 1. PLAN
  console.log("\nThe preview counts what would go, and writes nothing:");
  const before = await counts(primary.cfg.id);
  const plan = await call("GET", `/timetable-configs/${primary.cfg.id}/deletion`, a.session);
  check(plan.status === 200, "the plan is served", `${plan.status}`);
  const line = (needle) => (plan.json?.lines ?? []).find((l) => l.label.includes(needle))?.count;
  check(line("timetable rows") === before.slots,
    "and its slot count is the REAL one — the number the confirmation shows is the number deleted",
    `${line("timetable rows")} vs ${before.slots}`);
  check(line("named drafts") === 2 && line("periods and breaks") === 4 && line("extra and guest") === 1,
    "with every dependent table named",
    `${line("named drafts")} drafts · ${line("periods and breaks")} periods · ${line("extra and guest")} extras`);
  check((plan.json?.lines ?? []).find((l) => l.effect === "detached")?.count === 3,
    "and the class-sections listed as KEPT, not deleted — the difference between removing a timetable and removing a school");
  check(plan.json?.blocked === null, "nothing blocks it");
  const afterPlan = await counts(primary.cfg.id);
  check(JSON.stringify(afterPlan) === JSON.stringify(before), "and previewing wrote nothing",
    JSON.stringify(afterPlan));

  // ───────────────────────────────────────────────────────────── 2. DELETE
  console.log("\nDeleting takes the timetable AND every row that hung off it:");
  const del = await call("DELETE", `/timetable-configs/${primary.cfg.id}`, a.session);
  check(del.status < 300, "accepted", `${del.status}`);
  const after = await counts(primary.cfg.id);
  check(after.config === 0, "the timetable is gone");
  /**
   * The regression this whole file exists for. `timetable_slots` has no FK to
   * `timetable_config`, so before §3.13 these seven rows survived the delete —
   * unreachable, uncounted, and pointing at nothing.
   */
  check(after.slots === 0, "and so is every slot, across BOTH drafts and the §18 extras",
    `${before.slots} → ${after.slots}`);
  check(after.drafts === 0 && after.periods === 0 && after.extras === 0,
    "and the drafts, periods and extra classes with them",
    `drafts ${after.drafts} · periods ${after.periods} · extras ${after.extras}`);

  // ─────────────────────────────────────────────────────────────── 3. KEPT
  console.log("\nBut the school itself is untouched:");
  const kept = await prisma.classSection.findMany({
    where: { classId: primary.klass.id }, select: { id: true, timetableConfigId: true },
  });
  check(kept.length === 3, "its class-sections still exist", `${kept.length}`);
  check(kept.every((cs) => cs.timetableConfigId === null),
    "detached, and free to be attached to another timetable");
  check(await prisma.subject.count({ where: { id: primary.subject.id } }) === 1
    && await prisma.teacher.count({ where: { id: primary.teacher.id } }) === 1
    && await prisma.room.count({ where: { id: primary.room.id } }) === 1
    && await prisma.schoolClass.count({ where: { id: primary.klass.id } }) === 1,
    "and the subject, teacher, room and class are all still there — deleting a wing is not deleting a school");

  // ────────────────────────────────────────────────────────── 4. NEIGHBOUR
  const neighbour = await counts(senior.cfg.id);
  check(neighbour.config === 1 && neighbour.slots === 7 && neighbour.drafts === 2,
    "the school's OTHER timetable is exactly as it was", JSON.stringify(neighbour));

  // ────────────────────────────────────────────────────────── 5. PUBLISHED
  console.log("\nA timetable that has been published is refused, and nothing is written:");
  const livePlan = await call("GET", `/timetable-configs/${live.cfg.id}/deletion`, a.session);
  check(typeof livePlan.json?.blocked === "string" && livePlan.json.blocked.includes("ZZDEL Published"),
    "the plan says so, and names the timetable", (livePlan.json?.blocked ?? "").slice(0, 58));
  const liveBefore = await counts(live.cfg.id);
  const refused = await call("DELETE", `/timetable-configs/${live.cfg.id}`, a.session);
  check(refused.status === 400,
    "and the DELETE is refused by the SERVER, not by a greyed-out button", `${refused.status}`);
  const liveAfter = await counts(live.cfg.id);
  check(JSON.stringify(liveAfter) === JSON.stringify(liveBefore),
    "with every row still in place — a refusal that deleted half of it would be the worst outcome available",
    JSON.stringify(liveAfter));

  // ─────────────────────────────────────────────────────────── 6. STRANGER
  console.log("\nAnother school's timetable is a 404, not a quiet no-op:");
  const b = await newOwnerWithSchool(`b@${DOMAIN}`, "ZZDEL Takshashila");
  const bYear = await prisma.academicYear.create({
    data: { schoolId: b.schoolId, name: "ZZDEL B 2026-27", startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31") },
  });
  const theirs = await buildConfig(b.schoolId, bYear.id, "ZZDEL Theirs");
  const before404 = await counts(theirs.cfg.id);
  const peek = await call("GET", `/timetable-configs/${theirs.cfg.id}/deletion`, a.session);
  check(peek.status === 404, "the plan refuses to describe it", `${peek.status}`);
  const cross = await call("DELETE", `/timetable-configs/${theirs.cfg.id}`, a.session);
  check(cross.status === 404, "and the delete refuses to touch it", `${cross.status}`);
  check(JSON.stringify(await counts(theirs.cfg.id)) === JSON.stringify(before404),
    "and every one of its rows is still there", JSON.stringify(before404));

  // ──────────────────────────────────────────────────────────── 7. TEACHER
  console.log("\nA teacher cannot delete a timetable:");
  const teacherRole = await prisma.role.findFirst({ where: { schoolId: a.schoolId, name: "Teacher" } });
  await prisma.user.create({
    data: {
      schoolId: a.schoolId, erpUserId: "local:zzdel-teacher", roleId: teacherRole.id,
      name: "ZZ Teacher User", email: `t@${DOMAIN}`,
    },
  });
  const tToken = await (async () => {
    const t = await call("POST", "/dev/erp-token", null, {
      erpUserId: "local:zzdel-teacher", erpRole: "TEACHER", name: "ZZ Teacher User", email: `t@${DOMAIN}`,
      school: { code: (await prisma.school.findUnique({ where: { id: a.schoolId } })).code, name: "ZZDEL Nalanda" },
    });
    const cb = await fetch(`${API}/api/sso/callback?token=${t.json.token}`, { redirect: "manual" });
    return (cb.headers.get("location") || "").split("#token=")[1];
  })();
  if (tToken) {
    check((await call("GET", `/timetable-configs/${senior.cfg.id}/deletion`, tToken)).status === 403,
      "the plan is refused");
    check((await call("DELETE", `/timetable-configs/${senior.cfg.id}`, tToken)).status === 403,
      "and so is the delete");
    check((await counts(senior.cfg.id)).config === 1, "and the timetable is still there");
  } else {
    check(false, "could not mint a teacher session");
  }

  // ─────────────────────────────────────────────────────────────── cleanup
  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { name: { startsWith: "ZZDEL " } } })) === 0, "test schools removed");

  await prisma.$disconnect();
  await control.$disconnect();
  console.log(failed ? "\nSOME DELETE CHECKS FAILED" : "\nALL DELETE CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
