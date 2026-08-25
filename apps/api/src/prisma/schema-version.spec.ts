/**
 * Schema version checking (§17.3, Phase 9.3).
 *
 * The point of this module is that a school whose database is behind the build
 * is caught *at the door*, not fifty queries later as `Unknown column …` on
 * whichever screen touches the new column first. These pin the comparison and
 * — just as importantly — the message, because a refusal that does not name
 * the fix is only marginally better than the crash it replaced.
 */
import { describe, expect, it, vi } from "vitest";
import { behindMessage, expectedMigrations, schemaStatus, type SchemaStatus } from "./schema-version";

/** A stand-in for a database at a given set of applied migrations. */
const dbWith = (applied: string[] | null) =>
  ({
    $queryRawUnsafe: vi.fn(async () => {
      if (applied === null) throw new Error("Table '_prisma_migrations' doesn't exist");
      return applied.map((migration_name) => ({ migration_name }));
    }),
  }) as never;

describe("expectedMigrations", () => {
  it("reads the migrations this build ships, in apply order", () => {
    const list = expectedMigrations();
    expect(list.length).toBeGreaterThan(0);
    // Prisma prefixes folders with a sortable timestamp, which is what makes
    // lexicographic order the same as apply order.
    expect([...list].sort()).toEqual(list);
    expect(list.every((m) => /^\d{14}_/.test(m))).toBe(true);
  });
});

describe("schemaStatus", () => {
  it("is ok when the database has everything this build ships", async () => {
    const status = await schemaStatus(dbWith(expectedMigrations()));
    expect(status.ok).toBe(true);
    expect(status.missing).toEqual([]);
  });

  it("names exactly what is missing when the database is behind", async () => {
    const all = expectedMigrations();
    const status = await schemaStatus(dbWith(all.slice(0, -1)));
    expect(status.ok).toBe(false);
    expect(status.missing).toEqual([all.at(-1)]);
    expect(status.applied).toBe(all.at(-2));
    expect(status.expected).toBe(all.at(-1));
  });

  it("tolerates a database that is ahead, and says so", async () => {
    // Mid-rollout the database is migrated before every instance is replaced.
    // That resolves itself; refusing would take the whole deployment down.
    const status = await schemaStatus(dbWith([...expectedMigrations(), "29990101000000_from_the_future"]));
    expect(status.ok).toBe(true);
    expect(status.ahead).toEqual(["29990101000000_from_the_future"]);
  });

  it("treats a database with no migration table as entirely behind", async () => {
    // An empty or hand-built database — everything is missing, which is
    // precisely what the caller needs to be told.
    const status = await schemaStatus(dbWith(null));
    expect(status.ok).toBe(false);
    expect(status.applied).toBeNull();
    expect(status.missing).toEqual(expectedMigrations());
  });

  it("ignores migrations that started but never finished", async () => {
    // A half-applied migration is not an applied one; the query filters on
    // finished_at, so a failed deploy still reads as behind.
    const db = dbWith(expectedMigrations().slice(0, -1));
    const status = await schemaStatus(db);
    expect(status.ok).toBe(false);
    expect(String((db as never as { $queryRawUnsafe: { mock: { calls: string[][] } } }).$queryRawUnsafe.mock.calls[0][0]))
      .toContain("finished_at IS NOT NULL");
  });
});

describe("behindMessage", () => {
  const status: SchemaStatus = {
    ok: false,
    expected: "20260825061848_phase9_5_school_trust",
    applied: "20260825045259_phase9_2_schools_table",
    missing: ["20260825061848_phase9_5_school_trust"],
    ahead: [],
  };

  it("names the school, the gap, and the command that fixes it", () => {
    const message = behindMessage("Springfield High (tenant 7)", status);
    expect(message).toContain("Springfield High (tenant 7)");
    expect(message).toContain("1 migration behind");
    expect(message).toContain("20260825045259_phase9_2_schools_table");
    expect(message).toContain("20260825061848_phase9_5_school_trust");
    // Without this the refusal is just a different mystery.
    expect(message).toContain("migrate:all");
  });

  it("does not list fifty migration names at a reader", () => {
    const many = Array.from({ length: 12 }, (_, i) => `2026010100000${i}_m${i}`);
    const message = behindMessage("A School", { ...status, missing: many });
    expect(message).toContain("12 migrations behind");
    expect(message).toContain("+9 more");
  });
});
