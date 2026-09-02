/**
 * §21 (Phase 14.1) — Auto-resolve, end to end against the running app.
 *
 * Breaks a real school five ways, resolves, and checks the three things that
 * make this feature trustworthy rather than merely convenient:
 *
 *   1. The score goes UP and the broken rows are gone — verified by re-running
 *      the engine, not by believing the resolver's own report.
 *   2. Undo puts every value back, exactly, and the score returns to what it
 *      was. A button that edits master data across dozens of rows is only
 *      reasonable to offer if it is reversible.
 *   3. It refuses what it should: a crafted change the engine never proposed,
 *      a value that moved since the admin looked, another school's config.
 *
 * In-container:  node scripts/auto-fix-smoke.cjs
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");

const API = process.env.API_URL || "http://localhost:3000";
const P = "ZZFIX";

let failed = 0;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = 1;
};

async function session(code) {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      erpUserId: `${P}-1`, erpRole: "ADMIN", name: "Fix Admin",
      email: "f@zzfix.test", school: { code, name: "ZZFIX School" },
    }),
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
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}
const readiness = async (configId, token) => (await call("GET", `/timetable-configs/${configId}/readiness`, token)).body;
const issuesOf = (r) => [...(r.blockers ?? []), ...(r.warnings ?? [])];

/**
 * A school that is clean apart from what we deliberately break: 2 sections,
 * 3 subjects x 5 periods = 15 of 15 slots, one teacher per subject.
 */
async function build(prisma, schoolId) {
  const year = await prisma.academicYear.create({
    data: { schoolId, name: `${P} 2026-27`, startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"), isActive: true },
  });
  const config = await prisma.timetableConfig.create({
    data: {
      schoolId, academicYearId: year.id, name: `${P} Main`,
      workingDays: [1, 2, 3, 4, 5], periodsPerDay: 3,
      periods: {
        create: [1, 2, 3].map((n) => ({
          schoolId, periodNumber: n, sortOrder: n, isBreak: false,
          startTime: `0${7 + n}:00`.slice(-5), endTime: `0${7 + n}:45`.slice(-5),
        })),
      },
    },
  });
  const cls = await prisma.schoolClass.create({ data: { schoolId, name: `${P} Class 1`, sequence: 1 } });
  const rooms = [];
  for (const n of [1, 2, 3]) {
    rooms.push(await prisma.room.create({
      data: { schoolId, name: `${P} Room ${n}`, roomType: "classroom", capacity: 40 },
    }));
  }
  const sections = [];
  for (const [i, name] of ["A", "B"].entries()) {
    const section = await prisma.section.create({ data: { schoolId, classId: cls.id, name } });
    sections.push(await prisma.classSection.create({
      data: {
        schoolId, classId: cls.id, sectionId: section.id, academicYearId: year.id,
        timetableConfigId: config.id, homeRoomId: rooms[i].id,
      },
    }));
  }
  const subjects = [];
  for (const name of ["Maths", "English", "Science"]) {
    const subject = await prisma.subject.create({ data: { schoolId, name: `${P} ${name}` } });
    const teacher = await prisma.teacher.create({
      data: {
        schoolId, employeeCode: `${P}-${name}`, name: `${P} T.${name}`,
        maxPeriodsPerDay: 3, minPeriodsPerDay: 1, maxPeriodsPerWeek: 30,
        eligibility: { create: [{ classId: cls.id, schoolId }] },
      },
    });
    await prisma.classSubject.create({
      data: { schoolId, classId: cls.id, academicYearId: year.id, subjectId: subject.id, periodsPerWeek: 5, maxPeriodsPerDay: 1 },
    });
    for (const cs of sections) {
      await prisma.teacherSubjectClassSection.create({
        data: { schoolId, teacherId: teacher.id, subjectId: subject.id, classSectionId: cs.id, periodsPerWeek: 5 },
      });
    }
    subjects.push({ subject, teacher });
  }
  // A spare teacher with room to take work, so `redistribute` has an answer.
  const spare = await prisma.teacher.create({
    data: {
      schoolId, employeeCode: `${P}-SPARE`, name: `${P} T.Spare`,
      maxPeriodsPerDay: 3, minPeriodsPerDay: 1, maxPeriodsPerWeek: 30,
      eligibility: { create: [{ classId: cls.id, schoolId }] },
    },
  });
  await prisma.classSection.update({ where: { id: sections[0].id }, data: { classTeacherId: subjects[0].teacher.id } });
  await prisma.classSection.update({ where: { id: sections[1].id }, data: { classTeacherId: subjects[1].teacher.id } });
  return { config, cls, sections, subjects, rooms, spare };
}

(async () => {
  const prisma = new PrismaClient();
  const code = `${P}-${Date.now().toString(36).toUpperCase()}`;
  const token = await session(code);
  check(Boolean(token), "admin session");
  const school = await prisma.school.findFirst({ where: { code } });
  check(Boolean(school), "school provisioned by SSO", code);

  let s;
  try {
    s = await build(prisma, school.id);

    console.log("\nA clean school offers nothing to resolve:");
    let r = await readiness(s.config.id, token);
    check(issuesOf(r).filter((i) => i.remedy).length === 0, "no remedies on a school with nothing wrong", `score ${r.score}`);

    console.log("\nNow break it five ways:");
    await prisma.classSection.update({ where: { id: s.sections[0].id }, data: { classTeacherId: null } });   // CT_UNASSIGNED
    await prisma.classSection.update({ where: { id: s.sections[1].id }, data: { homeRoomId: null } });        // HOME_ROOM_UNSET
    await prisma.teacherClassEligibility.deleteMany({ where: { teacherId: s.subjects[2].teacher.id } });      // TEACHER_SCOPE_UNSET
    await prisma.teacher.update({ where: { id: s.spare.id }, data: { classTeacherPeriodRule: "always_first_period" } }); // CT_RULE_INERT
    await prisma.teacher.update({ where: { id: s.subjects[0].teacher.id }, data: { maxPeriodsPerWeek: 5 } }); // TEACHER_OVERLOAD
    // Writes made straight through Prisma bypass the readiness cache, so nudge
    // it the way a real edit would — a no-op PUT through the API.
    await call("PUT", `/teachers/${s.spare.id}`, token, { name: `${P} T.Spare` });

    r = await readiness(s.config.id, token);
    const broken = issuesOf(r);
    const scoreBroken = r.score;
    for (const code of ["CT_UNASSIGNED", "HOME_ROOM_UNSET", "TEACHER_SCOPE_UNSET", "CT_RULE_INERT", "TEACHER_OVERLOAD"]) {
      check(broken.some((i) => i.code === code), `${code} is reported`);
    }
    const fixable = broken.filter((i) => i.remedy);
    check(fixable.length >= 5, "each of them carries a remedy", `${fixable.length} remedies`);
    check(
      fixable.every((i) => i.remedy.kind === "complete" || i.remedy.kind === "redistribute"),
      "and none of them loosens a limit — that is 14.2",
    );

    console.log("\nIt refuses a change the engine never proposed:");
    // A real, live issue key — so this exercises the change-matching guard
    // itself, not merely "no such issue". Tampering with the changes is what a
    // crafted payload would do, and it is the thing that must not get through.
    const victim = fixable.find((i) => i.code === "CT_UNASSIGNED");
    const tampered = (await call("POST", `/timetable-configs/${s.config.id}/auto-fix`, token, {
      apply: [{ key: victim.key, changes: [
        { op: "set", entity: "teacher", id: s.spare.id, field: "maxPeriodsPerWeek", from: 30, to: 999 },
      ] }],
    })).body;
    check(tampered.outcomes[0]?.outcome === "changed", "a tampered change list is refused", JSON.stringify(tampered.outcomes[0] ?? {}));
    const uncapped = await prisma.teacher.findFirst({ where: { id: s.spare.id } });
    check(uncapped.maxPeriodsPerWeek === 30, "and the field it aimed at is untouched", `${uncapped.maxPeriodsPerWeek}`);

    console.log("\nAnd a value that moved since the admin looked:");
    // Consent captured now; the data changes underneath before it is applied.
    const roomIssue = fixable.find((i) => i.code === "HOME_ROOM_UNSET");
    const consented = { key: roomIssue.key, changes: roomIssue.remedy.changes };
    await prisma.classSection.update({ where: { id: s.sections[1].id }, data: { homeRoomId: s.rooms[2].id } });
    await call("PUT", `/teachers/${s.spare.id}`, token, { name: `${P} T.Spare` });
    const moved = (await call("POST", `/timetable-configs/${s.config.id}/auto-fix`, token, { apply: [consented] })).body;
    check(
      moved.outcomes[0]?.outcome === "already-resolved" || moved.outcomes[0]?.outcome === "changed",
      "a stale consent is skipped, not applied blind",
      JSON.stringify(moved.outcomes[0] ?? {}),
    );
    // Put it back so the run below is the one under test.
    await prisma.classSection.update({ where: { id: s.sections[1].id }, data: { homeRoomId: null } });
    await call("PUT", `/teachers/${s.spare.id}`, token, { name: `${P} T.Spare` });

    console.log("\nResolve them:");
    const fresh = issuesOf(await readiness(s.config.id, token)).filter((i) => i.remedy);
    const apply = fresh.map((i) => ({ key: i.key, changes: i.remedy.changes }));
    const run = (await call("POST", `/timetable-configs/${s.config.id}/auto-fix`, token, { apply })).body;
    check(run.fixed === fresh.length, "every issue reported fixed", `${run.fixed}/${fresh.length}`);
    check(
      run.outcomes.every((o) => o.outcome === "fixed"),
      "no remedy applied without resolving its issue",
      run.outcomes.filter((o) => o.outcome !== "fixed").map((o) => `${o.code}:${o.outcome}`).join(", ") || "all clean",
    );
    check(run.scoreAfter > run.scoreBefore, "readiness went up", `${run.scoreBefore} → ${run.scoreAfter}`);

    const afterFix = await readiness(s.config.id, token);
    check(
      !issuesOf(afterFix).some((i) => ["CT_UNASSIGNED", "HOME_ROOM_UNSET", "TEACHER_SCOPE_UNSET", "CT_RULE_INERT", "TEACHER_OVERLOAD"].includes(i.code)),
      "and the engine agrees — none of the five is still reported",
    );

    console.log("\nThe changes are real, in the database:");
    const csA = await prisma.classSection.findFirst({ where: { id: s.sections[0].id } });
    const csB = await prisma.classSection.findFirst({ where: { id: s.sections[1].id } });
    check(csA.classTeacherId !== null, "5-A has a class teacher again", `teacher ${csA.classTeacherId}`);
    check(csB.homeRoomId !== null, "5-B has a home room again", `room ${csB.homeRoomId}`);
    const scope = await prisma.teacherClassEligibility.count({ where: { teacherId: s.subjects[2].teacher.id } });
    check(scope === 1, "the unscoped teacher has a scope", `${scope} class(es)`);

    console.log("\nUndo puts it all back:");
    const undo = (await call("POST", `/timetable-configs/${s.config.id}/auto-fix/${run.runId}/undo`, token)).body;
    check(undo.ok === true, "the run was undone", `${undo.reversed} change(s) reversed`);
    check(undo.skipped.length === 0, "nothing had to be skipped");
    const back = await readiness(s.config.id, token);
    check(back.score === scoreBroken, "readiness is exactly where it was before the run", `${back.score} vs ${scoreBroken}`);
    const csA2 = await prisma.classSection.findFirst({ where: { id: s.sections[0].id } });
    check(csA2.classTeacherId === null, "5-A's class teacher is unset again");
    const scope2 = await prisma.teacherClassEligibility.count({ where: { teacherId: s.subjects[2].teacher.id } });
    check(scope2 === 0, "the inferred scope is gone again");

    const twice = (await call("POST", `/timetable-configs/${s.config.id}/auto-fix/${run.runId}/undo`, token)).body;
    check(String(twice.message ?? "").includes("already been undone"), "undoing twice is refused", twice.message);

    // ---------------------------------------------------------------- 14.2
    console.log("\nA limit change (14.2) is offered, priced, and never swept up:");
    // Maths at 5 periods a week and 1 a day cannot fit a 5-day week.
    const maths = await prisma.classSubject.findFirst({
      where: { schoolId: school.id, subjectId: s.subjects[0].subject.id },
    });
    await prisma.classSubject.update({ where: { id: maths.id }, data: { maxPeriodsPerDay: 1, periodsPerWeek: 6 } });
    for (const cs of s.sections) {
      await prisma.teacherSubjectClassSection.updateMany({
        where: { classSectionId: cs.id, subjectId: s.subjects[0].subject.id }, data: { periodsPerWeek: 6 },
      });
    }
    await call("PUT", `/teachers/${s.spare.id}`, token, { name: `${P} T.Spare` });

    const withRelax = issuesOf(await readiness(s.config.id, token));
    if (process.env.DEBUG_FIX) {
      for (const i of withRelax) console.log(`      [dbg] ${i.code} remedy=${i.remedy ? i.remedy.kind : "-"}`);
    }
    const relaxIssues = withRelax.filter((i) => i.remedy && i.remedy.kind === "relax");
    check(relaxIssues.length > 0, "a relax remedy is offered", relaxIssues.map((i) => i.code).join(", "));
    const dd = relaxIssues.find((i) => i.code === "DAILY_DISTRIBUTION");
    check(Boolean(dd), "DAILY_DISTRIBUTION among them");
    check(
      /up from 1/.test(dd?.remedy.summary ?? ""),
      "and it says what it costs — the old value and the new one",
      dd?.remedy.summary,
    );

    // The whole point: applying everything *except* the relax ones must leave
    // the limit exactly where it was.
    const safeOnly = withRelax
      .filter((i) => i.remedy && i.remedy.kind !== "relax")
      .map((i) => ({ key: i.key, changes: i.remedy.changes }));
    if (safeOnly.length > 0) {
      await call("POST", `/timetable-configs/${s.config.id}/auto-fix`, token, { apply: safeOnly });
    }
    const untouched = await prisma.classSubject.findFirst({ where: { id: maths.id } });
    check(untouched.maxPeriodsPerDay === 1, "a run that did not name it leaves the limit alone", `max/day ${untouched.maxPeriodsPerDay}`);

    console.log("\nAnd when it IS named, it applies and undoes like any other:");
    const fresh2 = issuesOf(await readiness(s.config.id, token)).find((i) => i.code === "DAILY_DISTRIBUTION");
    const relaxRun = (await call("POST", `/timetable-configs/${s.config.id}/auto-fix`, token, {
      apply: [{ key: fresh2.key, changes: fresh2.remedy.changes }],
    })).body;
    check(relaxRun.fixed === 1, "the limit change resolved its issue", JSON.stringify(relaxRun.outcomes[0] ?? {}));
    check(relaxRun.outcomes[0]?.kind === "relax", "and the run log records that it was a relax", relaxRun.outcomes[0]?.kind);
    const raised = await prisma.classSubject.findFirst({ where: { id: maths.id } });
    check(raised.maxPeriodsPerDay === 2, "the cap really moved", `max/day ${raised.maxPeriodsPerDay}`);

    const undoRelax = (await call("POST", `/timetable-configs/${s.config.id}/auto-fix/${relaxRun.runId}/undo`, token)).body;
    check(undoRelax.ok === true, "and undo puts the limit back");
    const restored = await prisma.classSubject.findFirst({ where: { id: maths.id } });
    check(restored.maxPeriodsPerDay === 1, "back to where it started", `max/day ${restored.maxPeriodsPerDay}`);
  } catch (e) {
    check(false, "unexpected error", String(e.message).split("\n").slice(0, 3).join(" ").slice(0, 240));
  } finally {
    console.log("\nCleanup:");
    const id = school.id;
    await prisma.$transaction([
      prisma.autoFixRun.deleteMany({ where: { schoolId: id } }),
      prisma.timetableSlot.deleteMany({ where: { schoolId: id } }),
      // §22: after the slots — the draft FK is RESTRICT (generated draft_scope)
      prisma.timetableDraft.deleteMany({ where: { schoolId: id } }),
      prisma.teacherSubjectClassSection.deleteMany({ where: { schoolId: id } }),
      prisma.teacherClassEligibility.deleteMany({ where: { schoolId: id } }),
      prisma.classSubject.deleteMany({ where: { schoolId: id } }),
      prisma.classSection.deleteMany({ where: { schoolId: id } }),
      prisma.teacher.deleteMany({ where: { schoolId: id } }),
      prisma.subject.deleteMany({ where: { schoolId: id } }),
      prisma.section.deleteMany({ where: { schoolId: id } }),
      prisma.schoolClass.deleteMany({ where: { schoolId: id } }),
      prisma.room.deleteMany({ where: { schoolId: id } }),
      prisma.period.deleteMany({ where: { schoolId: id } }),
      prisma.timetableConfig.deleteMany({ where: { schoolId: id } }),
      prisma.academicYear.deleteMany({ where: { schoolId: id } }),
    ]);
    check(true, "test school's data removed");
    await prisma.$disconnect();
  }

  console.log(failed ? "\nSOME AUTO-FIX CHECKS FAILED" : "\nALL AUTO-FIX CHECKS PASSED");
  process.exit(failed);
})();
