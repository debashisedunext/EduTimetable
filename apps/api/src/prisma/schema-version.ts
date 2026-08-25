/**
 * Schema version checking (§17.3, Phase 9.3).
 *
 * Once schools can have their own databases, "run the migrations" stops being
 * one command and becomes N. The failure mode of getting that wrong is the
 * quiet kind: a tenant whose database is a migration behind does not fail on
 * connect — it fails later, deep inside a query, as `Unknown column
 * 'school_id' in 'field list'`, on whichever screen happens to touch the new
 * column first. Nothing points at the real cause.
 *
 * So the version is checked at the door. The app knows which migrations it
 * expects (the folders it ships with), the database knows which it has
 * (`_prisma_migrations`), and a tenant that is behind is refused with a message
 * naming the missing migration and the command that fixes it.
 *
 * The database is asked directly rather than trusting `tenants.schema_version`
 * in the registry: that column is a cached summary for the Platform Console,
 * and it would be wrong the moment anyone migrated out of band.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";

/** Where the application's own migrations live inside the image. */
const MIGRATIONS_DIR =
  process.env.PRISMA_MIGRATIONS_DIR ?? join(process.cwd(), "prisma", "migrations");

let expectedCache: string[] | null = null;

/**
 * Every migration this build ships, in application order. Prisma names folders
 * with a sortable timestamp prefix, so lexicographic order is apply order.
 */
export function expectedMigrations(): string[] {
  if (expectedCache) return expectedCache;
  try {
    expectedCache = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    // No migrations directory (a unit-test process, say). Nothing to enforce.
    expectedCache = [];
  }
  return expectedCache;
}

/** The newest migration this build expects, or null if it ships none. */
export const expectedVersion = (): string | null => expectedMigrations().at(-1) ?? null;

export interface SchemaStatus {
  ok: boolean;
  expected: string | null;
  applied: string | null;
  /** Migrations the app ships that this database has not applied. */
  missing: string[];
  /** Migrations the database has that this app does not know about. */
  ahead: string[];
}

/**
 * Compare one database against this build.
 *
 * "Ahead" is reported but tolerated: it means the database was migrated by a
 * newer build, which happens mid-rollout and resolves itself. "Behind" is not
 * tolerated, because the code is about to reference columns that do not exist.
 */
export async function schemaStatus(client: PrismaClient): Promise<SchemaStatus> {
  const expected = expectedMigrations();
  let applied: string[] = [];
  try {
    const rows = await client.$queryRawUnsafe<Array<{ migration_name: string }>>(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`,
    );
    applied = rows.map((r) => r.migration_name);
  } catch {
    // No _prisma_migrations table at all: an empty or hand-built database.
    // Everything is missing, which is exactly what the caller needs to know.
    return {
      ok: expected.length === 0,
      expected: expected.at(-1) ?? null,
      applied: null,
      missing: expected,
      ahead: [],
    };
  }

  const appliedSet = new Set(applied);
  const expectedSet = new Set(expected);
  const missing = expected.filter((m) => !appliedSet.has(m));
  const ahead = applied.filter((m) => !expectedSet.has(m));

  return {
    ok: missing.length === 0,
    expected: expected.at(-1) ?? null,
    applied: applied.at(-1) ?? null,
    missing,
    ahead,
  };
}

/** The message a refused tenant gets — it has to name the fix, not just the fault. */
export function behindMessage(label: string, status: SchemaStatus): string {
  const count = status.missing.length;
  return (
    `${label} cannot be served: its database is ${count} migration${count === 1 ? "" : "s"} behind ` +
    `this build (has ${status.applied ?? "none"}, needs ${status.expected}). ` +
    `Missing: ${status.missing.slice(0, 3).join(", ")}${count > 3 ? `, +${count - 3} more` : ""}. ` +
    `Run \`pnpm --filter @edutimetable/api migrate:all\` to bring every school's database up to date.`
  );
}
