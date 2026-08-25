/**
 * Grant, revoke and list platform administrators (§17.6, Phase 9.8).
 *
 *   pnpm --filter @edutimetable/api platform:admin -- --list
 *   pnpm --filter @edutimetable/api platform:admin -- --grant ERP-1 --name "R. Ahuja"
 *   pnpm --filter @edutimetable/api platform:admin -- --revoke ERP-1
 *
 * A command rather than a screen, for the obvious reason: the first platform
 * administrator cannot be granted through a console that requires already being
 * one. It stays a command afterwards too — authority over the registry should
 * take a deliberate act on the host, not a click by whoever currently holds it.
 *
 * The identity is the ERP's user id, because that is the only identity that
 * survives across schools: the same person is a different `users` row in every
 * school they work in.
 */
import { PrismaClient as ControlClient } from "../generated/control-client";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const url = process.env.CONTROL_DATABASE_URL;
  if (!url) {
    console.error("CONTROL_DATABASE_URL is required — platform access lives in the control plane.");
    process.exit(1);
  }
  const control = new ControlClient({ datasources: { db: { url } } });

  try {
    if (has("list") || process.argv.length <= 2) {
      const rows = await control.platformUser.findMany({ orderBy: { id: "asc" } });
      const env = (process.env.PLATFORM_ADMIN_ERP_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (rows.length === 0 && env.length === 0) {
        console.log("No platform administrators. Grant one with:");
        console.log('  pnpm --filter @edutimetable/api platform:admin -- --grant <ERP-USER-ID> --name "Their Name"');
      }
      for (const r of rows) {
        console.log(
          `  ${r.isActive ? "✓" : "✗"} ${r.erpUserId}` +
            `${r.name ? `  ${r.name}` : ""}${r.email ? `  <${r.email}>` : ""}` +
            `${r.lastSeenAt ? `  last seen ${r.lastSeenAt.toISOString().slice(0, 16).replace("T", " ")}` : "  never signed in"}`,
        );
      }
      for (const e of env) {
        console.log(`  ✓ ${e}  (from PLATFORM_ADMIN_ERP_USER_IDS — an env grant, not a database row)`);
      }
      return;
    }

    const instance = await control.erpInstance.findFirst({ orderBy: { id: "asc" } });
    if (!instance) {
      console.error("No ERP installation registered yet — run `pnpm seed:control` first.");
      process.exit(1);
    }

    const grant = arg("grant");
    if (grant) {
      const row = await control.platformUser.upsert({
        where: { erpInstanceId_erpUserId: { erpInstanceId: instance.id, erpUserId: grant } },
        create: {
          erpInstanceId: instance.id,
          erpUserId: grant,
          name: arg("name") ?? null,
          email: arg("email") ?? null,
        },
        // Re-granting a revoked admin reactivates rather than duplicating.
        update: { isActive: true, ...(arg("name") ? { name: arg("name") } : {}) },
      });
      console.log(`Granted platform access to ${row.erpUserId}${row.name ? ` (${row.name})` : ""}.`);
      console.log("It takes effect within 30 seconds — the check is cached, not carried in their session token.");
      return;
    }

    const revoke = arg("revoke");
    if (revoke) {
      // Deactivated, not deleted: who *used* to hold this is worth keeping.
      const { count } = await control.platformUser.updateMany({
        where: { erpUserId: revoke },
        data: { isActive: false },
      });
      console.log(count > 0 ? `Revoked platform access for ${revoke}.` : `${revoke} did not hold platform access.`);
      if (count > 0) {
        console.log("Takes effect within 30 seconds. If they are also in PLATFORM_ADMIN_ERP_USER_IDS, remove them there too.");
      }
      return;
    }

    console.error("Usage: platform:admin -- [--list | --grant <ERP-USER-ID> [--name …] [--email …] | --revoke <ERP-USER-ID>]");
    process.exit(1);
  } finally {
    await control.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
