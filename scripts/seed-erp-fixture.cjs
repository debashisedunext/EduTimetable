/**
 * §23 — the dev stand-in ERP.
 *
 *   docker compose exec api node /app/scripts/seed-erp-fixture.cjs
 *
 * Creates (or recreates) the database `ERP_DATABASE_URL` points at and fills it
 * with a small school. There is no real ERP in the dev stack, so without this
 * the Sync screen has nothing to talk to.
 *
 * This database is the **stand-in ERP's own storage**, read by
 * `scripts/fake-erp-api.cjs` and by nothing else — since §23.6 the timetable
 * app reads its ERP over HTTP only, exactly as it would a real one.
 *
 * Exported as a function too, because `erp-sync-smoke.cjs` re-seeds through it
 * on the way out. The smoke used to DROP this database, which left the Sync
 * screen permanently broken for anyone who ran the test suite and then opened
 * the app — a test that breaks the thing it tests.
 *
 * Dev only: nothing here is ever run against a real deployment.
 */
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");

const DDL = [
  `CREATE TABLE schools (id INT PRIMARY KEY AUTO_INCREMENT, code VARCHAR(40) UNIQUE, name VARCHAR(120))`,
  `CREATE TABLE academic_sessions (id INT PRIMARY KEY AUTO_INCREMENT, school_id INT, name VARCHAR(20), start_date DATE, end_date DATE, is_current TINYINT(1))`,
  `CREATE TABLE classes (id INT PRIMARY KEY AUTO_INCREMENT, school_id INT, name VARCHAR(30), display_order INT)`,
  `CREATE TABLE sections (id INT PRIMARY KEY AUTO_INCREMENT, school_id INT, class_id INT, session_id INT, name VARCHAR(10), strength INT)`,
  `CREATE TABLE subjects (id INT PRIMARY KEY AUTO_INCREMENT, school_id INT, name VARCHAR(60), code VARCHAR(10))`,
  `CREATE TABLE staff (id INT PRIMARY KEY AUTO_INCREMENT, school_id INT, employee_code VARCHAR(20), name VARCHAR(120), is_active TINYINT(1), is_teaching TINYINT(1))`,
];

/** Recreate the fixture from scratch. Returns the ERP's own school ids by code. */
async function seedErpFixture(erpUrl, { quiet = false } = {}) {
  const dbName = erpUrl.split("/").pop().split("?")[0];
  const serverUrl = erpUrl.slice(0, erpUrl.lastIndexOf("/")) + "/information_schema";
  const server = new PrismaClient({ datasources: { db: { url: serverUrl } } });
  await server.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await server.$executeRawUnsafe(`CREATE DATABASE \`${dbName}\``);
  await server.$disconnect();

  const erp = new PrismaClient({ datasources: { db: { url: erpUrl } } });
  for (const q of DDL) await erp.$executeRawUnsafe(q);

  // Matches the seeded school's code so the Sync screen works out of the box
  // for whoever opens it first (`apps/api/prisma/seed.ts` creates SCHOOL-1).
  const schools = [
    { code: "SCHOOL-1", name: "Demo Public School" },
    { code: "SCHOOL-2", name: "Second Branch" },
  ];
  for (const s of schools) {
    await erp.$executeRawUnsafe(`INSERT INTO schools (code, name) VALUES (?, ?)`, s.code, s.name);
  }
  const rows = await erp.$queryRawUnsafe(`SELECT id, code FROM schools`);
  const byCode = Object.fromEntries(rows.map((r) => [r.code, Number(r.id)]));

  for (const s of schools) {
    const id = byCode[s.code];
    await erp.$executeRawUnsafe(
      `INSERT INTO academic_sessions (school_id, name, start_date, end_date, is_current) VALUES (?, ?, ?, ?, 1)`,
      id, "2026-27", "2026-04-01", "2027-03-31",
    );
    const [{ ssid }] = await erp.$queryRawUnsafe(
      `SELECT id AS ssid FROM academic_sessions WHERE school_id = ?`, id);

    for (let n = 1; n <= 5; n++) {
      await erp.$executeRawUnsafe(
        `INSERT INTO classes (school_id, name, display_order) VALUES (?, ?, ?)`, id, `Class ${n}`, n);
    }
    const classes = await erp.$queryRawUnsafe(
      `SELECT id, name FROM classes WHERE school_id = ? ORDER BY display_order`, id);
    for (const c of classes) {
      for (const [sec, strength] of [["A", 34], ["B", 32]]) {
        await erp.$executeRawUnsafe(
          `INSERT INTO sections (school_id, class_id, session_id, name, strength) VALUES (?, ?, ?, ?, ?)`,
          id, Number(c.id), Number(ssid), sec, strength,
        );
      }
    }
    for (const [name, code] of [
      ["English", "ENG"], ["Mathematics", "MAT"], ["Science", "SCI"],
      ["Hindi", "HIN"], ["Social Studies", "SST"], ["Computer", "CMP"],
    ]) {
      await erp.$executeRawUnsafe(
        `INSERT INTO subjects (school_id, name, code) VALUES (?, ?, ?)`, id, name, code);
    }
    const staff = [
      ["Aditi Verma", 1], ["Rahul Nair", 1], ["Meera Das", 1], ["Sanjay Rao", 1],
      ["Priya Menon", 1], ["Imran Sheikh", 1], ["Accounts Office", 0],
    ];
    let i = 1;
    for (const [name, teaching] of staff) {
      await erp.$executeRawUnsafe(
        `INSERT INTO staff (school_id, employee_code, name, is_active, is_teaching) VALUES (?, ?, ?, 1, ?)`,
        id, `${s.code}-E${String(i).padStart(3, "0")}`, name, teaching,
      );
      i++;
    }
  }
  await erp.$disconnect();
  if (!quiet) {
    console.log(
      `Fixture ERP seeded in "${dbName}": ${schools.length} schools, ` +
        `5 classes × 2 sections, 6 subjects, 6 teachers (+1 non-teaching) each.`,
    );
  }
  return byCode;
}

module.exports = { seedErpFixture, DDL };

if (require.main === module) {
  const url = process.env.ERP_DATABASE_URL;
  if (!url) {
    console.error("ERP_DATABASE_URL is not set — start the dev stack, which sets it (§23).");
    process.exit(1);
  }
  seedErpFixture(url).catch((e) => { console.error(e); process.exit(1); });
}
