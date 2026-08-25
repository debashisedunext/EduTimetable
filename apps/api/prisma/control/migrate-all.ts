/**
 * Migrate every school's database (§17.3, Phase 9.3).
 *
 *   docker compose exec api pnpm --filter @edutimetable/api migrate:all
 *   ... --dry-run     # report where each database stands, change nothing
 *
 * Once schools can have their own databases, "run the migrations" stops being
 * one command and becomes N — and the one you forget fails silently, deep
 * inside a query, on whichever screen touches the new column first. This walks
 * the tenant registry so nothing is forgotten, and stamps each tenant's applied
 * version so the Platform Console can show it without opening N connections.
 *
 * Deliberate properties:
 *   - **The shared database is migrated once**, however many schools live in it.
 *   - **One tenant's failure does not stop the rest.** A school whose database
 *     is unreachable should not block every other school's upgrade; it is
 *     reported at the end and the exit code is non-zero.
 *   - **Idempotent.** `migrate deploy` applies only what is pending, so running
 *     this twice is a no-op and running it after a partial failure resumes.
 *   - **Credentials never printed.** Connection URLs are redacted in all output.
 */
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaClient as ControlClient } from "../generated/control-client";
import { decryptSecret } from "../../src/common/crypto.util";
import { expectedVersion, schemaStatus } from "../../src/prisma/schema-version";

const DRY_RUN = process.argv.includes("--dry-run");

function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable url>";
  }
}

interface Target {
  label: string;
  url: string;
  /** Tenants served by this database — several, for the shared one. */
  tenantIds: number[];
}

async function main() {
  const appUrl = process.env.DATABASE_URL;
  if (!appUrl) {
    console.error("DATABASE_URL is required.");
    process.exit(1);
  }
  const expected = expectedVersion();
  console.log(`This build expects: ${expected ?? "(no migrations)"}\n`);

  const targets: Target[] = [];
  const controlUrl = process.env.CONTROL_DATABASE_URL;

  if (!controlUrl) {
    // No registry: a single-school deployment. There is exactly one database.
    console.log("No CONTROL_DATABASE_URL — migrating the application database only.\n");
    targets.push({ label: "application database", url: appUrl, tenantIds: [] });
  } else {
    const control = new ControlClient({ datasources: { db: { url: controlUrl } } });
    const tenants = await control.tenant.findMany({ orderBy: { id: "asc" } });
    await control.$disconnect();

    const shared = tenants.filter((t) => t.mode === "shared");
    // Every shared school lives in the one application database — migrating it
    // once per school would be N times the work for the same result.
    targets.push({
      label: `application database (${shared.length} shared school${shared.length === 1 ? "" : "s"})`,
      url: appUrl,
      tenantIds: shared.map((t) => t.id),
    });

    for (const t of tenants.filter((x) => x.mode === "dedicated")) {
      if (!t.dbUrlEncrypted) {
        console.error(`  ! tenant ${t.id} (${t.displayName}) is dedicated but has no stored URL — skipped`);
        continue;
      }
      targets.push({
        label: `${t.displayName} (tenant ${t.id})`,
        url: decryptSecret(t.dbUrlEncrypted),
        tenantIds: [t.id],
      });
    }
  }

  const failures: string[] = [];
  const stamps: Array<{ tenantIds: number[]; version: string | null }> = [];

  for (const target of targets) {
    console.log(`→ ${target.label}`);
    console.log(`  ${redact(target.url)}`);
    const client = new PrismaClient({ datasources: { db: { url: target.url } } });
    try {
      const before = await schemaStatus(client);
      if (before.ok) {
        console.log(`  ✓ already at ${before.applied ?? "(none)"} — nothing to apply`);
        stamps.push({ tenantIds: target.tenantIds, version: before.applied });
        continue;
      }
      console.log(`  ${before.missing.length} migration(s) pending: ${before.missing.join(", ")}`);
      if (DRY_RUN) {
        console.log("  (dry run — not applied)");
        continue;
      }

      execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
        env: { ...process.env, DATABASE_URL: target.url },
        stdio: "inherit",
      });
      const after = await schemaStatus(client);
      if (!after.ok) throw new Error(`still behind after deploy: missing ${after.missing.join(", ")}`);
      console.log(`  ✓ now at ${after.applied}`);
      stamps.push({ tenantIds: target.tenantIds, version: after.applied });
    } catch (e) {
      // One school's failure must not stop every other school's upgrade.
      console.error(`  ✗ ${target.label}: ${(e as Error).message}`);
      failures.push(target.label);
    } finally {
      await client.$disconnect().catch(() => undefined);
    }
    console.log("");
  }

  // Stamp the registry so the Platform Console can report versions without
  // opening a connection to every tenant. The database remains the authority —
  // this is a cached summary (see prisma/schema-version.ts).
  if (!DRY_RUN && controlUrl && stamps.length > 0) {
    const control = new ControlClient({ datasources: { db: { url: controlUrl } } });
    for (const { tenantIds, version } of stamps) {
      if (tenantIds.length === 0) continue;
      await control.tenant.updateMany({
        where: { id: { in: tenantIds } },
        data: { schemaVersion: version },
      });
    }
    await control.$disconnect();
    console.log("Registry stamped with applied versions.");
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} database(s) failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log(`\nAll ${targets.length} database(s) at ${expected ?? "(no migrations)"}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
