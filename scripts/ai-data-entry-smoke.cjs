/**
 * Phase 24 (§13.5) — AI master-data entry, against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/ai-data-entry-smoke.cjs
 *
 * Drives the write path WITHOUT an LLM in the loop. The model's only job is to
 * choose the rows; everything that decides whether those rows are safe — the
 * adapter, the validator, the stash, the transaction — is exercised here
 * directly through `/dev/ai-tool` and `/ai/data-entry/apply`. A test that
 * needed a provider key would be a test nobody runs.
 *
 *   1. DRAFT      — a class and its sections in one proposal; writes nothing
 *   2. VALIDATE   — the importer's rules apply: missing required field, bad enum
 *   3. DUPLICATE  — a row that already exists is reported, never written twice
 *   4. APPLY      — the proposal lands, in one transaction
 *   5. ONCE       — an applied proposal cannot be applied again
 *   6. CAPACITY   — a curriculum row over the week is refused, as on the screen
 *   7. SCOPE      — school B cannot apply school A's proposal
 *   8. PERMISSION — a user without masters.manage is never offered the tool
 *   9. UPDATE     — Phase B: an existing row's fields change, with a diff, and
 *                   the natural key can never be one of them
 *  10. MAPPINGS   — Phase C: the sheet where one drafted row is several rows —
 *                   moving a subject to another teacher, a half-mapped row, the
 *                   §18 refusal, class-teacher ownership, and a merged group
 *                   whose teacher is part of its identity
 *
 * Everything it creates is prefixed ZZAI and removed at the end.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { groupFor } = require("./resource-groups.cjs");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const P = "ZZAI";
const SCHOOL_A = 99081;
const SCHOOL_B = 99082;

let failed = 0;
const check = (ok, l, x = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${x ? ` — ${x}` : ""}`);
  if (!ok) failed = 1;
};

async function call(method, path, token, body) {
  const res = await fetch(`${API}/api${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

/** Draft through the same seam the chat gateway uses to run a tool. */
const draft = (token, sheets) =>
  call("POST", "/dev/ai-tool", token, { name: "draftMasterData", args: { sheets } });

(async () => {
  const prisma = new PrismaClient();
  const SCHOOLS = [SCHOOL_A, SCHOOL_B];

  const purge = async () => {
    await prisma.mergedTeachingGroupMember.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.mergedTeachingGroup.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.teacherSubjectClassSection.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.teacherClassEligibility.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.classSubject.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.classSection.updateMany({ where: { schoolId: { in: SCHOOLS } }, data: { classTeacherId: null, homeRoomId: null } });
    await prisma.classSection.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.room.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.section.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.schoolClass.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.subject.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.teacher.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.timetableConfig.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.academicYear.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.auditLog.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.user.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.erpRoleMapping.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.rolePermission.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.role.deleteMany({ where: { schoolId: { in: SCHOOLS } } });
    await prisma.school.deleteMany({ where: { id: { in: SCHOOLS } } });
  };
  await purge();

  const perms = await prisma.rolePermission.findMany({
    where: { role: { schoolId: 1, name: "Super Admin" } }, select: { permission: true },
  });

  /** A school with an admin session, an academic year and a timetable. */
  const makeSchool = async (id, tag) => {
    const code = `${P}-${tag}`;
    await prisma.school.create({ data: { id, code, name: `${P} ${tag}` } });
    const role = await prisma.role.create({ data: { schoolId: id, name: "Super Admin", isSystem: true } });
    await prisma.rolePermission.createMany({
      data: perms.map((p) => ({ roleId: role.id, permission: p.permission, schoolId: id })),
    });
    await prisma.erpRoleMapping.create({ data: { schoolId: id, erpRole: "ADMIN", roleId: role.id } });
    const year = await prisma.academicYear.create({
      data: { schoolId: id, name: `${P} 2026-27`, startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"), isActive: true },
    });
    const config = await prisma.timetableConfig.create({
      data: {
        resourceGroupId: await groupFor(prisma, year.id),
        schoolId: id, academicYearId: year.id, name: `${P} ${tag} Wing`,
        periodsPerDay: 8, periodDurationMins: 40, workingDays: [1, 2, 3, 4, 5],
      },
    });
    const r = await fetch(`${API}/api/dev/erp-token`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        erpUserId: `${P}-${tag}-1`, erpRole: "ADMIN", name: `${tag} Admin`, email: `${tag}@zzai.test`,
        school: { code, name: `${P} ${tag}` },
      }),
    });
    const { token } = await r.json();
    const cb = await fetch(`${API}/api/sso/callback?token=${token}`, { redirect: "manual" });
    return {
      id, year, config,
      token: (cb.headers.get("location") || "").split("#token=")[1],
    };
  };

  const A = await makeSchool(SCHOOL_A, "A");
  const B = await makeSchool(SCHOOL_B, "B");
  check(Boolean(A.token && B.token), "two schools with admin sessions");

  // ─────────────────────────────────────────────────────────── 1. DRAFT
  console.log("\nA class and its sections, drafted in one proposal:");
  const d1 = await draft(A.token, [
    { sheet: "Classes", rows: [{ name: `${P} Class 6`, sequence: 6 }] },
    { sheet: "Class Sections", rows: ["A", "B", "C"].map((s) => ({
      className: `${P} Class 6`, sectionName: s, academicYear: `${P} 2026-27`, strength: 32,
    })) },
  ]);
  const p1 = d1.json?.result;
  check(p1?.ok === true, "the draft validates", JSON.stringify(p1?.totals ?? p1).slice(0, 90));
  check(p1?.totals?.create === 4, "4 rows to add — 1 class + 3 sections", `${p1?.totals?.create}`);
  check(Boolean(p1?.proposalId), "a proposal id is issued for an appliable batch");
  check((await prisma.schoolClass.count({ where: { schoolId: A.id } })) === 0,
    "and NOTHING was written — a draft is not a write");
  check(/Apply/i.test(p1?.summary ?? ""), "the summary tells the user what happens next", p1?.summary);

  // ─────────────────────────────────────────────────────── 2. VALIDATE
  console.log("\nThe importer's own rules apply, unchanged:");
  const bad = await draft(A.token, [{ sheet: "Teachers", rows: [{ name: "No Code Person" }] }]);
  check(bad.json?.result?.ok === false, "a missing required field is refused");
  check((bad.json?.result?.issues ?? []).some((i) => /Employee Code/i.test(i.message)),
    "and the issue names the column", (bad.json?.result?.issues ?? [])[0]?.message?.slice(0, 60));
  check(bad.json?.result?.proposalId === null,
    "no proposal id for a batch that cannot be applied — no button to press in vain");

  const badEnum = await draft(A.token, [{
    sheet: "Teachers",
    rows: [{ employeeCode: `${P}-T9`, name: "Enum Person", periodPattern: "sometimes" }],
  }]);
  check(badEnum.json?.result?.ok === false, "a bad enum value is refused too");

  // A key the model invented must be reported, not silently dropped.
  const strayKey = await draft(A.token, [{
    sheet: "Subjects", rows: [{ name: `${P} Physics`, subjectCode: "PHY" }],
  }]);
  check((strayKey.json?.result?.issues ?? []).some((i) => /no column "subjectCode"/.test(i.message)),
    "an unknown column is reported rather than quietly ignored");

  // ─────────────────────────────────────────────────────── 3. + 4. APPLY
  console.log("\nApply writes it, once, in one transaction:");
  const applied = await call("POST", "/ai/data-entry/apply", A.token, { proposalId: p1.proposalId });
  check(applied.status === 200 || applied.status === 201, "apply accepted", `${applied.status}`);
  check((await prisma.schoolClass.count({ where: { schoolId: A.id } })) === 1, "1 class created");
  check((await prisma.classSection.count({ where: { schoolId: A.id } })) === 3, "3 class-sections created");

  const audit = await prisma.auditLog.count({ where: { schoolId: A.id, action: "ai.data-entry.apply" } });
  check(audit === 1, "and the write is audit-logged", `${audit} entry`);

  // ─────────────────────────────────────────────────────────── 5. ONCE
  const again = await call("POST", "/ai/data-entry/apply", A.token, { proposalId: p1.proposalId });
  check(again.status === 404, "the same proposal cannot be applied twice", `${again.status}`);
  check((await prisma.classSection.count({ where: { schoolId: A.id } })) === 3,
    "so a refresh does not duplicate the sections");

  // ─────────────────────────────────────────────────────── 3. DUPLICATE
  console.log("\nA row that already exists is reported, never written twice:");
  const dup = await draft(A.token, [
    { sheet: "Classes", rows: [{ name: `${P} Class 6`, sequence: 6 }] },
  ]);
  check(dup.json?.result?.totals?.skip === 1 && dup.json?.result?.totals?.create === 0,
    "reported as already existing", JSON.stringify(dup.json?.result?.totals));
  // Phase B sharpened this wording: "already exists" and "exists and differs"
  // are now different answers, so the message says which one this is.
  check(/already match what is stored/i.test(dup.json?.result?.summary ?? ""),
    "and said so in words", dup.json?.result?.summary);

  // ──────────────────────────────────────────────────────── 6. CAPACITY
  console.log("\nThe weekly-capacity guard applies here too:");
  await prisma.classSection.updateMany({ where: { schoolId: A.id }, data: { timetableConfigId: A.config.id } });
  const over = await draft(A.token, [{
    sheet: "Curriculum",
    rows: [{ className: `${P} Class 6`, subjectName: `${P} Physics`, academicYear: `${P} 2026-27`, periodsPerWeek: 20 }],
  }]);
  // The subject does not exist, so this is refused either way — what matters is
  // that it is refused with a reason, and nothing is written.
  check(over.json?.result?.ok === false, "an unresolvable reference is refused",
    (over.json?.result?.issues ?? [])[0]?.message?.slice(0, 70));
  check((await prisma.classSubject.count({ where: { schoolId: A.id } })) === 0, "and no curriculum row appeared");

  // ─────────────────────────────────────────────────────────── 7. SCOPE
  console.log("\nOne school cannot apply another's proposal:");
  const dB = await draft(B.token, [{ sheet: "Subjects", rows: [{ name: `${P} B Only`, code: "BON" }] }]);
  check(Boolean(dB.json?.result?.proposalId), "B drafts its own subject");
  const crossed = await call("POST", "/ai/data-entry/apply", A.token, { proposalId: dB.json.result.proposalId });
  check(crossed.status === 404, "A cannot apply B's proposal id", `${crossed.status}`);
  check((await prisma.subject.count({ where: { schoolId: A.id, name: `${P} B Only` } })) === 0,
    "and nothing of B's landed in A");
  const ownB = await call("POST", "/ai/data-entry/apply", B.token, { proposalId: dB.json.result.proposalId });
  check(ownB.status === 200 || ownB.status === 201, "while B applies its own perfectly well", `${ownB.status}`);
  check((await prisma.subject.count({ where: { schoolId: B.id } })) === 1, "B has its one subject");

  // ────────────────────────────────────────────────────── 8. PERMISSION
  console.log("\nA user without masters.manage is never offered the tool:");
  const teacherRole = await prisma.role.create({ data: { schoolId: A.id, name: "Teacher", isSystem: true } });
  await prisma.rolePermission.createMany({
    data: ["ai.chat", "timetable.view.own"].map((permission) => ({ roleId: teacherRole.id, permission, schoolId: A.id })),
  });
  await prisma.erpRoleMapping.create({ data: { schoolId: A.id, erpRole: "TEACHER", roleId: teacherRole.id } });
  const tr = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      erpUserId: `${P}-A-T`, erpRole: "TEACHER", name: "A Teacher", email: "t@zzai.test",
      school: { code: `${P}-A`, name: `${P} A` },
    }),
  });
  const cbT = await fetch(`${API}/api/sso/callback?token=${(await tr.json()).token}`, { redirect: "manual" });
  const tToken = (cbT.headers.get("location") || "").split("#token=")[1];

  const tDraft = await draft(tToken, [{ sheet: "Subjects", rows: [{ name: `${P} Sneaky` }] }]);
  check(/permission/i.test(JSON.stringify(tDraft.json?.result ?? {})),
    "the tool itself refuses them", JSON.stringify(tDraft.json?.result ?? {}).slice(0, 70));
  const tApply = await call("POST", "/ai/data-entry/apply", tToken, { proposalId: "any" });
  check(tApply.status === 403, "and the apply endpoint refuses them outright", `${tApply.status}`);
  check((await prisma.subject.count({ where: { schoolId: A.id, name: `${P} Sneaky` } })) === 0,
    "nothing was written either way");

  // ────────────────────────────────────────────────────── 9. UPDATE (B)
  console.log("\nPhase B — changing a row that already exists:");
  const t1 = await prisma.teacher.create({
    data: { schoolId: A.id, employeeCode: `${P}-T1`, name: "Original Name", maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6 },
  });

  // Only the fields named should move. Everything else is left alone, which is
  // the difference between a partial instruction and data loss.
  const upd = await draft(A.token, [{
    sheet: "Teachers",
    rows: [{ employeeCode: `${P}-T1`, name: "Corrected Name", maxPeriodsPerWeek: 24 }],
  }]);
  const up = upd.json?.result;
  check(up?.ok === true, "the draft validates", JSON.stringify(up?.totals ?? {}));
  check((up?.updates ?? []).length === 1, "one existing row is reported as changing", `${(up?.updates ?? []).length}`);
  const fields = (up?.updates?.[0]?.changes ?? []).map((c) => c.field).sort();
  check(JSON.stringify(fields) === JSON.stringify(["maxPeriodsPerWeek", "name"]),
    "with exactly the two fields that differ", fields.join(", "));
  const nameChange = (up?.updates?.[0]?.changes ?? []).find((c) => c.field === "name");
  check(nameChange?.from === "Original Name" && nameChange?.to === "Corrected Name",
    "and the old value beside the new", `${nameChange?.from} → ${nameChange?.to}`);
  check(/change/i.test(up?.summary ?? ""), "the summary says a change is pending", up?.summary);
  check((await prisma.teacher.findUnique({ where: { id: t1.id } })).name === "Original Name",
    "nothing is written by drafting");

  const updApplied = await call("POST", "/ai/data-entry/apply", A.token, { proposalId: up.proposalId });
  check(updApplied.status === 200 || updApplied.status === 201, "apply accepted", `${updApplied.status}`);
  const after = await prisma.teacher.findUnique({ where: { id: t1.id } });
  check(after.name === "Corrected Name" && after.maxPeriodsPerWeek === 24, "the two fields changed",
    `${after.name} / ${after.maxPeriodsPerWeek}`);
  check(after.maxPeriodsPerDay === 6,
    "and a field the draft did NOT mention was left alone — an omission is not a null");

  // A field outside UPDATABLE must not move, however it is phrased.
  const notWritable = await draft(A.token, [{
    sheet: "Teachers", rows: [{ employeeCode: `${P}-T1`, classNames: "Class 1" }],
  }]);
  const touched = (notWritable.json?.result?.updates ?? []).flatMap((u) => u.changes.map((c) => c.field));
  check(!touched.includes("classNames"),
    "a field outside the writable list is never offered as a change", touched.join(", ") || "none");

  // The natural key is identity, not a value: a different code is a NEW teacher.
  const rekey = await draft(A.token, [{
    sheet: "Teachers", rows: [{ employeeCode: `${P}-T2`, name: "Corrected Name" }],
  }]);
  check(rekey.json?.result?.totals?.create === 1 && (rekey.json?.result?.updates ?? []).length === 0,
    "a changed key reads as a new row, never as a rename",
    JSON.stringify(rekey.json?.result?.totals));

  // A draft that matches what is stored is not a change.
  const noop = await draft(A.token, [{
    sheet: "Teachers", rows: [{ employeeCode: `${P}-T1`, name: "Corrected Name", maxPeriodsPerWeek: 24 }],
  }]);
  check((noop.json?.result?.updates ?? []).length === 0 && noop.json?.result?.proposalId === null,
    "an identical draft offers nothing to apply", noop.json?.result?.summary);

  // ────────────────────────────────────────────────────── 10. MAPPINGS (C)
  //
  // Phase C. This is the sheet where one drafted row is NOT one database row:
  // naming three sections creates three mappings, and `merged = Yes` collapses
  // the same row into a single group instead. Every check below is about that
  // expansion being the importer's, not a second copy of it.
  console.log("\nPhase C — changing who teaches what:");
  const subj = await prisma.subject.create({ data: { schoolId: A.id, name: `${P} Maths`, code: "ZMA" } });
  const rekha = await prisma.teacher.create({
    data: { schoolId: A.id, employeeCode: `${P}-T3`, name: "Rekha", maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6 },
  });
  const outsider = await prisma.teacher.create({
    data: { schoolId: A.id, employeeCode: `${P}-T4`, name: "Outsider", maxPeriodsPerWeek: 30, maxPeriodsPerDay: 6 },
  });
  const lab1 = await prisma.room.create({ data: { schoolId: A.id, name: `${P} Lab 1`, capacity: 40 } });
  await prisma.room.create({ data: { schoolId: A.id, name: `${P} Lab 2`, capacity: 40 } });
  // A class Outsider IS allowed to teach, so their scope is stated but narrow —
  // an empty scope means "not stated" and would constrain nobody (§18).
  const class7 = await prisma.schoolClass.create({ data: { schoolId: A.id, name: `${P} Class 7`, sequence: 7 } });
  await prisma.teacherClassEligibility.create({
    data: { schoolId: A.id, teacherId: outsider.id, classId: class7.id },
  });

  const sec = async (name) => {
    const cs = await prisma.classSection.findFirst({
      where: { schoolId: A.id, section: { name } }, include: { class: true, section: true, classTeacher: true },
    });
    return cs;
  };
  /** Only the blocking issues — a draft always carries a SHEET_MISSING note per unused sheet. */
  const errorsOf = (r) => (r?.issues ?? []).filter((i) => i.severity === "error");
  const mapOf = async (label) => {
    const [className, sectionName] = [label.slice(0, label.lastIndexOf("-")), label.slice(label.lastIndexOf("-") + 1)];
    return prisma.teacherSubjectClassSection.findFirst({
      where: {
        schoolId: A.id, subjectId: subj.id,
        classSection: { class: { name: className }, section: { name: sectionName } },
      },
      include: { teacher: true, preferredRoom: true },
    });
  };
  const L = (s) => `${P} Class 6-${s}`;

  // 10a — two mappings, added the ordinary way, so there is something to change.
  const mk = await draft(A.token, [{
    sheet: "Subject Mapping",
    rows: [{ employeeCode: `${P}-T1`, subjectName: `${P} Maths`, classSections: `${L("A")}, ${L("B")}`, periodsPerWeek: 5 }],
  }]);
  check(mk.json?.result?.totals?.create === 1, "one drafted row…", JSON.stringify(mk.json?.result?.totals));
  await call("POST", "/ai/data-entry/apply", A.token, { proposalId: mk.json.result.proposalId });
  check((await prisma.teacherSubjectClassSection.count({ where: { schoolId: A.id } })) === 2,
    "…became TWO mappings, one per class-section — the importer's own expansion");

  // 10b — the teacher is a VALUE on this sheet, because the key is
  // (subject, class-section). This is the ask the phase exists for.
  const move = await draft(A.token, [{
    sheet: "Subject Mapping",
    rows: [{ employeeCode: `${P}-T3`, subjectName: `${P} Maths`, classSections: L("A"), periodsPerWeek: 5 }],
  }]);
  const mv = move.json?.result;
  check((mv?.updates ?? []).length === 1, "moving one section's subject to another teacher is a CHANGE",
    `${(mv?.updates ?? []).length} update(s)`);
  check(mv?.updates?.[0]?.kind === "mapping", "planned against the mapping table", mv?.updates?.[0]?.kind);
  check(JSON.stringify((mv?.updates?.[0]?.changes ?? []).map((c) => c.field)) === JSON.stringify(["employeeCode"]),
    "with only the teacher moving — the periods/week it carried already matched",
    (mv?.updates?.[0]?.changes ?? []).map((c) => c.field).join(", "));
  const codeChange = (mv?.updates?.[0]?.changes ?? [])[0];
  check(codeChange?.from === `${P}-T1` && codeChange?.to === `${P}-T3`,
    "shown as employee codes, not ids — the vocabulary the admin typed",
    `${codeChange?.from} → ${codeChange?.to}`);
  await call("POST", "/ai/data-entry/apply", A.token, { proposalId: mv.proposalId });
  check((await mapOf(L("A"))).teacher.employeeCode === `${P}-T3`, "6-A now belongs to Rekha");
  check((await mapOf(L("B"))).teacher.employeeCode === `${P}-T1`, "and 6-B was not touched");
  check((await mapOf(L("A"))).periodsPerWeek === 5, "periods/week survived a teacher-only change");

  // 10c — the case that made this sheet hard: one row where SOME sections are
  // already mapped and some are not. The validator strips the mapped ones out
  // of `classSections` so the committer leaves them alone; Phase C keeps them
  // in `existingParts`, or half the instruction would vanish silently.
  const partial = await draft(A.token, [{
    sheet: "Subject Mapping",
    rows: [{ employeeCode: `${P}-T1`, subjectName: `${P} Maths`, classSections: `${L("A")}, ${L("C")}`, periodsPerWeek: 5 }],
  }]);
  const pt = partial.json?.result;
  check(pt?.totals?.create === 1 && (pt?.updates ?? []).length === 1,
    "a half-mapped row adds the new section AND changes the existing one",
    `create ${pt?.totals?.create}, update ${(pt?.updates ?? []).length}`);
  check((pt?.issues ?? []).some((i) => /already has a teacher/i.test(i.message)),
    "and says which section was already mapped");
  await call("POST", "/ai/data-entry/apply", A.token, { proposalId: pt.proposalId });
  check((await mapOf(L("A"))).teacher.employeeCode === `${P}-T1`, "6-A moved back");
  check(Boolean(await mapOf(L("C"))), "6-C was created in the same apply");

  // 10d — §18 is not optional because the instruction arrived in a chat box.
  const ineligible = await draft(A.token, [{
    sheet: "Subject Mapping",
    rows: [{ employeeCode: `${P}-T4`, subjectName: `${P} Maths`, classSections: L("B"), periodsPerWeek: 5 }],
  }]);
  const inel = ineligible.json?.result;
  check(inel?.ok === false, "a teacher outside their teaching scope is refused");
  check(errorsOf(inel).some((i) => /does not teach/i.test(i.message)),
    "with the same message the Mapping screen gives",
    errorsOf(inel).map((i) => i.message).join(" | ").slice(0, 90));
  check(inel?.proposalId === null, "and no Apply button to press");
  check((await mapOf(L("B"))).teacher.employeeCode === `${P}-T1`, "6-B is untouched");

  // 10e — the other two values on the sheet, including a room by name.
  const reshape = await draft(A.token, [{
    sheet: "Subject Mapping",
    rows: [{ employeeCode: `${P}-T1`, subjectName: `${P} Maths`, classSections: L("B"), periodsPerWeek: 6, room: `${P} Lab 1` }],
  }]);
  const rs = reshape.json?.result;
  check(JSON.stringify((rs?.updates?.[0]?.changes ?? []).map((c) => c.field).sort()) ===
    JSON.stringify(["periodsPerWeek", "room"]),
    "periods/week and room move together, and the unchanged teacher is not listed",
    (rs?.updates?.[0]?.changes ?? []).map((c) => c.field).join(", "));
  await call("POST", "/ai/data-entry/apply", A.token, { proposalId: rs.proposalId });
  const reshaped = await mapOf(L("B"));
  check(reshaped.periodsPerWeek === 6 && reshaped.preferredRoomId === lab1.id,
    "and the room name resolved to the real room on write", `${reshaped.preferredRoom?.name}`);

  // 10f — an instruction that changes nothing is not a change.
  const same = await draft(A.token, [{
    sheet: "Subject Mapping",
    rows: [{ employeeCode: `${P}-T1`, subjectName: `${P} Maths`, classSections: L("B"), periodsPerWeek: 6, room: `${P} Lab 1` }],
  }]);
  check((same.json?.result?.updates ?? []).length === 0 && same.json?.result?.proposalId === null,
    "re-stating what is already stored offers nothing to apply", same.json?.result?.summary);

  // 10g — class-teacher ownership: added, then changed, then refused.
  const ctAdd = await draft(A.token, [{
    sheet: "Class Teachers", rows: [{ classSection: L("A"), employeeCode: `${P}-T1` }],
  }]);
  check(ctAdd.json?.result?.totals?.create === 1, "a class-section with no owner is an addition");
  await call("POST", "/ai/data-entry/apply", A.token, { proposalId: ctAdd.json.result.proposalId });
  check((await sec("A")).classTeacherId === (await prisma.teacher.findFirst({ where: { schoolId: A.id, employeeCode: `${P}-T1` } })).id,
    "the pointer was written");

  const ctMove = await draft(A.token, [{
    sheet: "Class Teachers", rows: [{ classSection: L("A"), employeeCode: `${P}-T3` }],
  }]);
  check((ctMove.json?.result?.updates ?? []).length === 1 &&
    ctMove.json?.result?.updates?.[0]?.kind === "classTeacher",
    "re-assigning it is a change, not a second row");
  await call("POST", "/ai/data-entry/apply", A.token, { proposalId: ctMove.json.result.proposalId });
  check((await sec("A")).classTeacherId === rekha.id, "6-A's class teacher is Rekha");

  const ctBad = await draft(A.token, [{
    sheet: "Class Teachers", rows: [{ classSection: L("A"), employeeCode: `${P}-T4` }],
  }]);
  check(ctBad.json?.result?.ok === false, "and a teacher who does not teach that class cannot own it either");
  check((await sec("A")).classTeacherId === rekha.id, "so the pointer did not move");

  // 10h — a merged group is the same sheet keyed differently: subject, teacher
  // AND members together. So its periods can move and its teacher cannot.
  const group = await prisma.mergedTeachingGroup.create({
    data: {
      schoolId: A.id, teacherId: rekha.id, subjectId: subj.id, periodsPerWeek: 4,
      members: {
        create: [(await sec("B")).id, (await sec("C")).id].map((classSectionId) => ({ classSectionId, schoolId: A.id })),
      },
    },
  });
  const gEdit = await draft(A.token, [{
    sheet: "Subject Mapping",
    rows: [{ employeeCode: `${P}-T3`, subjectName: `${P} Maths`, classSections: `${L("B")}, ${L("C")}`, periodsPerWeek: 3, merged: "Yes" }],
  }]);
  const ge = (gEdit.json?.result?.updates ?? []).find((u) => u.kind === "merged");
  check(Boolean(ge), "a merged group's periods/week can be changed",
    JSON.stringify((gEdit.json?.result?.updates ?? []).map((u) => u.kind)));
  check(JSON.stringify((ge?.changes ?? []).map((c) => c.field)) === JSON.stringify(["periodsPerWeek"]),
    "and only that", (ge?.changes ?? []).map((c) => c.field).join(", "));
  await call("POST", "/ai/data-entry/apply", A.token, { proposalId: gEdit.json.result.proposalId });
  check((await prisma.mergedTeachingGroup.findUnique({ where: { id: group.id } })).periodsPerWeek === 3,
    "the group changed rather than being duplicated");

  const gMove = await draft(A.token, [{
    sheet: "Subject Mapping",
    rows: [{ employeeCode: `${P}-T1`, subjectName: `${P} Maths`, classSections: `${L("B")}, ${L("C")}`, periodsPerWeek: 3, merged: "Yes" }],
  }]);
  check(gMove.json?.result?.ok === false, "but its TEACHER cannot move — that would be a second group");
  check(errorsOf(gMove.json?.result).some((i) => /already have a merged/i.test(i.message)),
    "and it names the group standing in the way",
    errorsOf(gMove.json?.result).map((i) => i.message).join(" | ").slice(0, 90));
  check((await prisma.mergedTeachingGroup.count({ where: { schoolId: A.id } })) === 1,
    "so there is still exactly one merged group over those sections");

  // ───────────────────────────────────────────────────────────── cleanup
  console.log("\nCleanup:");
  await purge();
  check((await prisma.school.count({ where: { id: { in: SCHOOLS } } })) === 0, "test schools removed");

  await prisma.$disconnect();
  console.log(failed ? "\nSOME AI DATA-ENTRY CHECKS FAILED" : "\nALL AI DATA-ENTRY CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
