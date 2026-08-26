/**
 * Build School 2's master data and import it (§16).
 *
 *   docker compose exec api node /app/scripts/seed-school2.cjs [--dry-run]
 *
 * Order matters and is not arbitrary:
 *
 *   1. the **timetable config** is created first, through the API, because
 *      Phase 8 deliberately keeps period and break structure out of the
 *      workbook — and the Class Sections sheet names the timetable each
 *      section joins, so it has to exist before the file is read;
 *   2. the workbook is **generated** from the model, not typed out;
 *   3. it is **dry-run** first, always, and the plan is printed;
 *   4. only then committed, in one transaction.
 *
 * The file is left on disk afterwards so it can be opened, edited and
 * re-imported by hand — re-importing is a no-op, since every sheet is
 * skip-existing.
 */
const path = require("node:path");
const fs = require("node:fs");
const M = require("./school2-model.cjs");
const { writeWorkbook, buildRows } = require("./school2-workbook.cjs");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const SCHOOL_CODE = "SCHOOL-2";
const SCHOOL_NAME = "Second Branch";
const OUT = process.env.OUT || "/app/school2-masters.xlsx";
const DRY_ONLY = process.argv.includes("--dry-run");

let failed = 0;
const pass = (l, x = "") => console.log(`  PASS  ${l}${x ? ` — ${x}` : ""}`);
const fail = (l, x = "") => { console.log(`  FAIL  ${l}${x ? ` — ${x}` : ""}`); failed = 1; };
const check = (ok, l, x = "") => (ok ? pass(l, x) : fail(l, x));

async function signIn() {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      erpUserId: "SCHOOL2-SETUP", erpRole: "ADMIN", name: "Timetable Admin",
      email: "admin@second-branch.test", school: { code: SCHOOL_CODE, name: SCHOOL_NAME },
    }),
  });
  const { token } = await r.json();
  const cb = await fetch(`${API}/api/sso/callback?token=${token}`, { redirect: "manual" });
  return (cb.headers.get("location") || "").split("#token=")[1] ?? null;
}

async function call(method, p, token, body) {
  const res = await fetch(`${API}/api${p}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function upload(p, token, file) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }), path.basename(file));
  const res = await fetch(`${API}/api${p}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

(async () => {
  const token = await signIn();
  check(Boolean(token), `signed in to ${SCHOOL_NAME} (${SCHOOL_CODE})`);
  if (!token) process.exit(1);
  const me = await call("GET", "/me", token);
  console.log(`  INFO  school id ${me.json?.school?.id} · tenant ${me.json?.school?.tenantId}`);

  // ------------------------------------------------- 1. the timetable itself
  console.log("\nThe timetable, created before the file that joins sections to it:");
  const years = await call("GET", "/academic-years", token);
  let year = (years.json ?? []).find((y) => y.name === M.YEAR);
  if (!year) {
    const made = await call("POST", "/academic-years", token, {
      name: M.YEAR, startDate: "2026-04-01", endDate: "2027-03-31", isActive: true,
    });
    year = made.json;
  }
  check(Boolean(year?.id), `academic year ${M.YEAR}`, "01-Apr-2026 → 31-Mar-2027");

  const configs = await call("GET", "/timetable-configs", token);
  let config = (configs.json ?? []).find((c) => c.name === M.CONFIG);
  if (!config) {
    const made = await call("POST", "/timetable-configs", token, {
      name: M.CONFIG, academicYearId: year.id,
      workingDays: [1, 2, 3, 4, 5], periodsPerDay: 8, periodDurationMins: 37, startTime: "08:00",
    });
    config = made.json;
  }
  check(Boolean(config?.id), `timetable "${M.CONFIG}"`, "Mon–Fri, 8 periods");

  // 8 x 37 + 45 + 2 x 10 = 361 minutes: 08:00 to 14:01. Equal periods are what
  // `buildPeriodRows` supports, and no whole-minute period divides 8am-2pm
  // exactly once the three breaks are taken out — so this lands a minute over
  // rather than trimming the lunch break to make the arithmetic tidy.
  const structure = await call("PUT", `/timetable-configs/${config.id}/structure`, token, {
    startTime: "08:00", periodsPerDay: 8, periodDurationMins: 37, workingDays: [1, 2, 3, 4, 5],
    breaks: [
      { afterPeriod: 3, name: "Short Break", durationMins: 10 },
      { afterPeriod: 5, name: "Lunch", durationMins: 45 },
      { afterPeriod: 7, name: "Short Break", durationMins: 10 },
    ],
  });
  check(structure.status === 200, "day structure", `08:00 → ${structure.json?.endTime ?? "?"}`);

  // ------------------------------------------------------- 2. the workbook
  console.log("\nThe workbook, generated from the model:");
  const stats = await writeWorkbook(OUT);
  const rows = buildRows();
  const counts = Object.entries(rows)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => `${k} ${v.length}`);
  console.log(`  INFO  ${OUT}`);
  console.log(`  INFO  ${counts.join(" · ")}`);

  const overloaded = stats.teachers.filter((t) => t.load > 26);
  check(overloaded.length === 0, "no teacher is packed past 26 periods/week",
    overloaded.length ? overloaded.map((t) => `${t.name} ${t.load}`).join(", ")
      : `heaviest ${Math.max(...stats.teachers.map((t) => t.load))}, average ${(
          stats.teachers.reduce((s, t) => s + t.load, 0) / stats.teachers.length
        ).toFixed(1)}`);

  // --------------------------------------------------------- 3. the dry run
  console.log("\nDry run — nothing is written yet:");
  const dry = await upload("/import/dry-run", token, OUT);
  const plan = dry.json?.plan;
  check(dry.status === 200 || dry.status === 201, "the file was read", `${dry.status}`);
  if (!plan) { console.error(dry.text.slice(0, 800)); process.exit(1); }

  for (const s of plan.sheets) {
    console.log(`        ${s.sheet.padEnd(24)} read ${String(s.read).padStart(4)}  new ${String(s.create).padStart(4)}  existing ${String(s.skip).padStart(4)}  errors ${s.errors}`);
  }
  if (plan.issues.length > 0) {
    console.log("\n  Issues:");
    for (const i of plan.issues.slice(0, 25)) {
      console.log(`        ${i.severity.toUpperCase()} ${i.sheet}!${i.cell ?? `row ${i.row}`} — ${i.message}`);
    }
    if (plan.issues.length > 25) console.log(`        …and ${plan.issues.length - 25} more`);
  }
  check(plan.ok, "the plan is clean", `${plan.totals.create} row(s) to create, ${plan.totals.errors} error(s)`);
  if (!plan.ok || DRY_ONLY) {
    console.log(DRY_ONLY ? "\n--dry-run: stopping before commit." : "\nNot importing — fix the issues above.");
    process.exit(plan.ok ? 0 : 1);
  }

  // ---------------------------------------------------------- 4. the commit
  console.log("\nCommit:");
  const done = await upload("/import/commit", token, OUT);
  check(done.status === 200 || done.status === 201, "imported", `${done.status}`);
  if (done.json?.created) {
    console.log(`  INFO  ${Object.entries(done.json.created).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  }

  // ------------------------------------------------------- 5. what it means
  console.log("\nReadiness:");
  const r = await call("GET", `/timetable-configs/${config.id}/readiness`, token);
  const rd = r.json ?? {};
  check(rd.ready === true, `score ${rd.score}%`,
    `${rd.blockers?.length ?? "?"} blocker(s), ${rd.warnings?.length ?? "?"} warning(s)`);
  for (const b of (rd.blockers ?? []).slice(0, 12)) console.log(`        BLOCKER  ${b.message}`);
  for (const w of (rd.warnings ?? []).slice(0, 12)) console.log(`        warning  ${w.message}`);
  if ((rd.blockers?.length ?? 0) > 12) console.log(`        …and ${rd.blockers.length - 12} more blockers`);
  console.log(`  INFO  ${rd.stats?.classSections} sections · ${rd.stats?.teachers} teachers · ${rd.stats?.totalRequiredSlots} periods to place`);

  console.log(failed ? "\nSCHOOL 2 SETUP INCOMPLETE" : `\nSCHOOL 2 READY — generate from the Timetables screen, or run:\n  docker compose exec api node -e '…' # POST /timetable-configs/${config.id}/generate`);
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
