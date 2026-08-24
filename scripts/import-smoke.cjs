/**
 * Phase 8 (§16) — master-data import smoke test against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/import-smoke.cjs
 *
 * Proves the promise the feature is sold on:
 *   1. RBAC — a Teacher session cannot reach any import endpoint.
 *   2. A dirty workbook is rejected with a named issue per planted error, and
 *      writes NOTHING (row counts identical before and after).
 *   3. A clean workbook imports, creating exactly what the preview predicted.
 *   4. Re-uploading the same clean file is a no-op (idempotent).
 *   5. Cleans up everything it created.
 */
const { createRequire } = require("node:module");
const ExcelJS = createRequire("/app/apps/api/package.json")("exceljs");
const { PrismaClient } = createRequire("/app/apps/api/package.json")("@prisma/client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const P = "ZZIMP"; // prefix so every created row is identifiable and removable

let failed = 0;
const pass = (label, extra = "") => console.log(`  PASS  ${label}${extra ? ` — ${extra}` : ""}`);
const fail = (label, extra = "") => { console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ""}`); failed = 1; };
const check = (ok, label, extra = "") => (ok ? pass(label, extra) : fail(label, extra));

async function sessionFor(payload) {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const { token } = await r.json();
  const cb = await fetch(`${API}/api/sso/callback?token=${token}`, { redirect: "manual" });
  return (cb.headers.get("location") || "").split("#token=")[1];
}

/** Build an .xlsx from {sheetName: [[header...],[row...]]} */
async function makeWorkbook(spec) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(spec)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function post(path, token, buffer, filename = "test.xlsx") {
  const body = new FormData();
  body.append("file", new Blob([buffer]), filename);
  const res = await fetch(`${API}/api${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* binary or error text */ }
  return { status: res.status, json, text };
}

async function counts(prisma) {
  const [classes, sections, subjects, teachers, curriculum, mappings] = await Promise.all([
    prisma.schoolClass.count(), prisma.classSection.count(), prisma.subject.count(),
    prisma.teacher.count(), prisma.classSubject.count(), prisma.teacherSubjectClassSection.count(),
  ]);
  return { classes, sections, subjects, teachers, curriculum, mappings };
}

(async () => {
  const prisma = new PrismaClient();
  const admin = await sessionFor({ erpUserId: "ERP-1", erpRole: "ADMIN", name: "Admin A", email: "a@school.test" });
  const teacher = await sessionFor({ erpUserId: "ERP-3", erpRole: "TEACHER", name: "R. Sharma", email: "rs@school.test", teacherId: 1 });

  // ---------------------------------------------------------------- 1. RBAC
  console.log("RBAC — import is masters.manage only:");
  for (const [method, path] of [["GET", "/import/template"], ["GET", "/import/export"]]) {
    const r = await fetch(`${API}/api${path}`, { method, headers: { Authorization: `Bearer ${teacher}` } });
    check(r.status === 403, `${method} ${path} as teacher`, `${r.status}`);
  }
  const teacherPost = await post("/import/dry-run", teacher, await makeWorkbook({ Subjects: [["Subject Name"], ["X"]] }));
  check(teacherPost.status === 403, "POST /import/dry-run as teacher", `${teacherPost.status}`);

  // --------------------------------------------------- 2. dirty file rejected
  console.log("\nA dirty workbook is rejected and writes nothing:");
  const before = await counts(prisma);
  const dirty = await makeWorkbook({
    Subjects: [
      ["Subject Name", "Code", "Is Lab"],
      [`${P} Physics`, "PHY", "Yes"],
      [`${P} physics`, "PHY", "No"],          // duplicate in file (case-insensitive)
      ["", "ORPHAN", "No"],                    // missing required
      ["x".repeat(60), "LONG", "No"],          // over the VarChar(50) limit
      [`${P} Chem`, "CH", "maybe"],            // bad enum
    ],
    Rooms: [["Room Name", "Type", "Capacity"], [`${P} Lab`, "labratory", "lots"]], // enum typo + non-numeric
    Curriculum: [
      ["Class Name", "Subject Name", "Periods/Week", "Block Size", "Blocks/Week"],
      [`${P} Nowhere`, "Mathmatics", 5, 2, 4],  // unknown class, misspelt subject, block overflow
    ],
    "Subject Mapping": [
      ["Teacher Employee Code", "Subject", "Class-Sections", "Periods/Week", "Merged"],
      ["NOBODY-1", "Mathematics", "Class 5-A", 4, "Yes"],  // unknown teacher + merged with one section
    ],
  });
  const dry = await post("/import/dry-run", admin, dirty, "dirty.xlsx");
  check(dry.status === 201 || dry.status === 200, "dry-run accepted the upload", `${dry.status}`);
  const plan = dry.json?.plan;
  check(plan && plan.ok === false, "plan is marked NOT ok");
  const codes = new Set((plan?.issues ?? []).filter((i) => i.severity === "error").map((i) => i.code));
  for (const expected of ["DUPLICATE_IN_FILE", "REQUIRED", "TOO_LONG", "BAD_ENUM", "NOT_A_NUMBER", "UNKNOWN_REFERENCE", "BLOCK_OVERFLOW", "MERGED_TOO_FEW"]) {
    check(codes.has(expected), `caught ${expected}`);
  }
  const suggestion = (plan?.issues ?? []).find((i) => i.code === "UNKNOWN_REFERENCE" && /Mathematics/.test(i.fix || ""));
  check(Boolean(suggestion), "suggests the near-miss spelling", suggestion?.fix?.slice(0, 52));
  const commitDirty = await post("/import/commit", admin, dirty, "dirty.xlsx");
  check(commitDirty.status === 400, "commit refuses a file with errors", `${commitDirty.status}`);
  const afterDirty = await counts(prisma);
  check(JSON.stringify(before) === JSON.stringify(afterDirty), "database completely unchanged", JSON.stringify(afterDirty));

  const annotated = await post("/import/annotate", admin, dirty, "dirty.xlsx");
  check(annotated.status === 200 || annotated.status === 201, "annotated error file is produced", `${annotated.text.length} bytes`);

  // ----------------------------------------------------- 3. clean file imports
  console.log("\nA clean workbook imports exactly what the preview promised:");
  const year = (await prisma.academicYear.findFirst())?.name;
  const clean = await makeWorkbook({
    Classes: [["Class Name", "Sequence"], [`${P} Class`, 99]],
    "Class Sections": [["Class Name", "Section Name", "Academic Year"], [`${P} Class`, "A", year]],
    Subjects: [["Subject Name", "Is Lab"], [`${P} Subject`, "No"]],
    Teachers: [["Employee Code", "Name", "Max Periods/Day"], [`${P}-T1`, `${P} Teacher`, 6]],
    Curriculum: [["Class Name", "Subject Name", "Periods/Week"], [`${P} Class`, `${P} Subject`, 5]],
    "Subject Mapping": [
      ["Teacher Employee Code", "Subject", "Class-Sections", "Periods/Week"],
      [`${P}-T1`, `${P} Subject`, `${P} Class-A`, 5],
    ],
  });
  const dry2 = await post("/import/dry-run", admin, clean, "clean.xlsx");
  check(dry2.json?.plan?.ok === true, "clean file passes validation", `${dry2.json?.plan?.totals?.create} row(s) to add`);
  const predicted = dry2.json.plan.totals.create;
  const commit = await post("/import/commit", admin, clean, "clean.xlsx");
  check(commit.status === 201 || commit.status === 200, "commit succeeded", `${commit.status}`);
  const createdTotal = Object.values(commit.json?.created ?? {}).reduce((a, b) => a + b, 0);
  check(createdTotal === predicted, "created exactly what the preview predicted", `${createdTotal} of ${predicted}`);
  const afterClean = await counts(prisma);
  check(afterClean.classes === before.classes + 1 && afterClean.subjects === before.subjects + 1 && afterClean.teachers === before.teachers + 1,
    "rows really landed in the database", JSON.stringify(afterClean));

  // ------------------------------------------------------- 4. re-upload no-op
  console.log("\nRe-uploading the same file changes nothing:");
  const dry3 = await post("/import/dry-run", admin, clean, "clean.xlsx");
  check(dry3.json?.plan?.totals?.create === 0, "preview reports nothing new to add", `${dry3.json?.plan?.totals?.skip} already exist`);
  const commit2 = await post("/import/commit", admin, clean, "clean.xlsx");
  check(commit2.status === 201 || commit2.status === 200, "second commit is accepted");
  const afterSecond = await counts(prisma);
  check(JSON.stringify(afterClean) === JSON.stringify(afterSecond), "row counts identical after re-import", "idempotent");

  // ----------------------------------------------------------------- cleanup
  console.log("\nCleanup:");
  const cls = await prisma.schoolClass.findFirst({ where: { name: `${P} Class` } });
  const subj = await prisma.subject.findFirst({ where: { name: `${P} Subject` } });
  const tch = await prisma.teacher.findFirst({ where: { employeeCode: `${P}-T1` } });
  if (cls) {
    await prisma.teacherSubjectClassSection.deleteMany({ where: { classSection: { classId: cls.id } } });
    await prisma.classSubject.deleteMany({ where: { classId: cls.id } });
    await prisma.classSection.deleteMany({ where: { classId: cls.id } });
    await prisma.section.deleteMany({ where: { classId: cls.id } });
    await prisma.schoolClass.delete({ where: { id: cls.id } });
  }
  if (subj) await prisma.subject.delete({ where: { id: subj.id } }).catch(() => {});
  if (tch) await prisma.teacher.delete({ where: { id: tch.id } }).catch(() => {});
  const final = await counts(prisma);
  check(JSON.stringify(final) === JSON.stringify(before), "database restored to its starting state", JSON.stringify(final));

  await prisma.$disconnect();
  console.log(failed ? "\nSOME IMPORT SMOKE CHECKS FAILED" : "\nALL IMPORT SMOKE CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
