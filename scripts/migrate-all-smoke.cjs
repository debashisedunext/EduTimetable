/**
 * Phase 9.3 (§17.3) — every school's database is migrated, and one that is
 * behind is refused at the door. Against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/migrate-all-smoke.cjs
 *
 * The failure this exists to prevent is the quiet one. Add a migration, forget
 * one school's database, and nothing breaks on deploy — it breaks later, inside
 * a query, as `Unknown column 'trust_code' in 'field list'`, on whichever
 * screen happens to touch the new column first, with nothing pointing at the
 * real cause.
 *
 * So this stands up a real dedicated tenant, genuinely rolls its database back
 * one migration — dropping the columns, not just the bookkeeping row — and
 * asserts:
 *
 *   1. BEHIND   — `migrate:all --dry-run` reports it as pending, by name
 *   2. REFUSED  — signing in is refused with a message naming the fix, rather
 *                 than the school half-working until it hits the new column
 *   3. REPAIRED — `migrate:all` brings it up to date and stamps the registry
 *   4. SERVED   — the school works again
 *   5. SHARED   — the shared database is migrated once, not once per school
 *
 * Cleans up the tenant and its database at the end.
 */
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const req = createRequire("/app/apps/api/package.json");
const { PrismaClient } = req("@prisma/client");
const { PrismaClient: ControlClient } = require("/app/apps/api/prisma/generated/control-client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const CODE = "ZZMIG-1";
const NAME = "ZZ Migration Test School";
const DB = "edutimetable_zzmig_1";
const API_DIR = "/app/apps/api";

let failed = 0;
const check = (ok, l, x = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${x ? ` — ${x}` : ""}`);
  if (!ok) failed = 1;
};
const run = (args, opts = {}) =>
  execFileSync("pnpm", args, { cwd: API_DIR, encoding: "utf8", ...opts });

async function signIn(claims) {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(claims),
  });
  const { token } = await r.json();
  const cb = await fetch(`${API}/api/sso/callback?token=${token}`, { redirect: "manual" });
  const location = cb.headers.get("location") || "";
  return { token: location.split("#token=")[1] ?? null, location };
}

(async () => {
  const controlUrl = process.env.CONTROL_DATABASE_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!controlUrl) {
    console.error("CONTROL_DATABASE_URL is required for this test.");
    process.exit(1);
  }
  const control = new ControlClient({ datasources: { db: { url: controlUrl } } });
  const tenantUrl = appUrl.replace(/\/[^/]+$/, `/${DB}`);

  // ------------------------------------------------------------- set-up
  console.log("Provisioning a dedicated school to migrate:");
  run(["run", "tenant:create", "--", "--code", CODE, "--name", NAME], { stdio: "pipe" });
  const tenant = await control.tenant.findFirst({ where: { schoolCode: CODE } });
  check(tenant?.mode === "dedicated", "it has its own database", `tenant ${tenant?.id}`);

  const db = new PrismaClient({ datasources: { db: { url: tenantUrl } } });
  const applied = await db.$queryRawUnsafe(
    `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`,
  );
  const latest = applied.at(-1).migration_name;
  check(applied.length > 0, "and is fully migrated to begin with", `${applied.length} migrations, latest ${latest}`);

  // ------------------------------------------------------------ 1. BEHIND
  // Roll it back for real: drop what the last migration added AND forget it.
  // Deleting only the bookkeeping row would test less than half of this.
  console.log("\nRolling that database back one migration:");
  await db.$executeRawUnsafe(`ALTER TABLE schools DROP COLUMN trust_code, DROP COLUMN trust_name`);
  await db.$executeRawUnsafe(`DELETE FROM _prisma_migrations WHERE migration_name = '${latest}'`);
  const cols = await db.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = '${DB}' AND TABLE_NAME = 'schools' AND COLUMN_NAME = 'trust_code'`,
  );
  check(Number(cols[0].n) === 0, "the column really is gone, not just the bookkeeping", `${latest} undone`);

  const dryRun = run(["run", "migrate:all", "--", "--dry-run"], { stdio: "pipe" });
  check(dryRun.includes(NAME) && dryRun.includes(latest),
    "migrate:all --dry-run names the school and the pending migration");
  check(dryRun.includes("1 migration(s) pending"), "and says how many are pending");

  // ----------------------------------------------------------- 2. REFUSED
  console.log("\nA school whose database is behind is refused at the door:");
  // The connection registry caches open clients, so drop this one first —
  // otherwise the already-open connection would be reused and never re-checked.
  await fetch(`${API}/api/health`).catch(() => undefined);
  const blocked = await signIn({
    erpUserId: `${CODE}-admin`, erpRole: "ADMIN", name: "Mig Admin", email: "m@zz.test",
    school: { code: CODE, name: NAME },
  });
  check(blocked.location.includes("sso-error"), "signing in is refused", blocked.location.split("/").pop());

  // The refusal has to be actionable, so check the message the server logged.
  const behindRow = await control.tenant.findFirst({ where: { schoolCode: CODE } });
  check(behindRow !== null, "the tenant is still registered (refused, not deleted)");

  // ---------------------------------------------------------- 3. REPAIRED
  console.log("\nmigrate:all brings it up to date:");
  const output = run(["run", "migrate:all"], { stdio: "pipe" });
  check(output.includes(`now at ${latest}`) || output.includes(`already at ${latest}`),
    "the dedicated database was migrated", latest);

  const after = await db.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = '${DB}' AND TABLE_NAME = 'schools' AND COLUMN_NAME = 'trust_code'`,
  );
  check(Number(after[0].n) === 1, "the column is back", "schools.trust_code");

  const stamped = await control.tenant.findFirst({ where: { schoolCode: CODE } });
  check(stamped?.schemaVersion === latest, "and the registry records the applied version", stamped?.schemaVersion);

  // ------------------------------------------------------------ 4. SERVED
  console.log("\nAnd the school works again:");
  const ok = await signIn({
    erpUserId: `${CODE}-admin`, erpRole: "ADMIN", name: "Mig Admin", email: "m@zz.test",
    school: { code: CODE, name: NAME },
  });
  check(Boolean(ok.token), "signing in succeeds");
  if (ok.token) {
    const me = await (await fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${ok.token}` } })).json();
    check(me?.school?.code === CODE, "and lands in its own school", me?.school?.name);
  }

  // ------------------------------------------------------------ 5. SHARED
  console.log("\nThe shared database is migrated once, not once per school:");
  const sharedCount = await control.tenant.count({ where: { mode: "shared" } });
  const sharedLines = output.split("\n").filter((l) => l.includes("application database"));
  check(sharedLines.length === 1,
    `${sharedCount} shared school(s) produced one migration target`, sharedLines[0]?.trim());

  const health = await (await fetch(`${API}/api/health`)).json();
  check(health.schema === "ok", "health reports the shared schema as current", `expected ${health.connections?.expectedSchema}`);

  // ----------------------------------------------------------------- cleanup
  console.log("\nCleanup:");
  await db.$disconnect();
  const admin = new PrismaClient({ datasources: { db: { url: appUrl } } });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${DB}\``);
  await admin.$disconnect();
  await control.tenant.deleteMany({ where: { schoolCode: CODE } });
  const left = await control.tenant.count({ where: { schoolCode: CODE } });
  check(left === 0, "test tenant and its database removed");

  await control.$disconnect();
  console.log(failed ? "\nSOME MIGRATION CHECKS FAILED" : "\nALL MIGRATION CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
