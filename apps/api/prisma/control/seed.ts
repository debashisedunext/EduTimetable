/**
 * Phase 9.2 (§17.3) — bring the tenant registry in line with reality.
 *
 * Idempotent, and safe to run on every boot. It does two things:
 *
 *   1. Ensures an ErpInstance row exists for this deployment's ERP. Phase 9.5
 *      makes token verification select a key per installation; until then this
 *      row's job is to give tenants a parent and a code namespace.
 *   2. Registers every school that already exists in the application database
 *      as a `shared`-mode tenant. A deployment that predates Phase 9 has
 *      exactly one, and after this it is a first-class tenant rather than an
 *      implicit assumption.
 *
 * It never invents a school and never deletes one: schools are created by
 * provisioning (9.3), and this only reflects what the app database already has.
 */
import { PrismaClient as AppPrismaClient } from "@prisma/client";
import { PrismaClient as ControlPrismaClient } from "../generated/control-client";

const DEFAULT_INSTANCE_NAME = "Edunext ERP (default installation)";

async function main() {
  const controlUrl = process.env.CONTROL_DATABASE_URL;
  if (!controlUrl) {
    console.log("[control-seed] CONTROL_DATABASE_URL unset — nothing to do (single-school mode).");
    return;
  }

  const app = new AppPrismaClient();
  const control = new ControlPrismaClient({ datasources: { db: { url: controlUrl } } });

  try {
    // ---- 1. the ERP installation ----
    const configuredKey = process.env.ERP_PUBLIC_KEY?.trim();
    const existingInstance = await control.erpInstance.findFirst({
      where: { name: DEFAULT_INSTANCE_NAME },
    });
    const instance =
      existingInstance ??
      (await control.erpInstance.create({
        data: {
          name: DEFAULT_INSTANCE_NAME,
          publicKeyPem:
            configuredKey ||
            // Dev signs with an in-memory keypair generated per API process, so
            // there is no stable PEM to record here. 9.5 replaces this with a
            // real per-installation key selected by the token's `kid`.
            "DEV-IN-MEMORY-KEYPAIR — no configured ERP_PUBLIC_KEY (see §15.1)",
        },
      }));
    // Keep a configured key current without clobbering it with the dev placeholder.
    if (configuredKey && instance.publicKeyPem !== configuredKey) {
      await control.erpInstance.update({
        where: { id: instance.id },
        data: { publicKeyPem: configuredKey },
      });
    }

    // ---- 2. one tenant per school already in the application database ----
    const schools = await app.school.findMany({ orderBy: { id: "asc" } });
    let created = 0;
    let updated = 0;

    for (const school of schools) {
      const existing = await control.tenant.findUnique({
        where: {
          erpInstanceId_schoolCode: { erpInstanceId: instance.id, schoolCode: school.code },
        },
      });
      if (existing) {
        // Keep the display name and local id honest if the school was renamed,
        // but never touch mode, status or stored credentials — those are the
        // platform's to set, not the application database's.
        if (existing.displayName !== school.name || existing.localSchoolId !== school.id) {
          await control.tenant.update({
            where: { id: existing.id },
            data: { displayName: school.name, localSchoolId: school.id },
          });
          updated++;
        }
        continue;
      }
      await control.tenant.create({
        data: {
          erpInstanceId: instance.id,
          schoolCode: school.code,
          displayName: school.name,
          mode: "shared",
          localSchoolId: school.id,
          status: "active",
        },
      });
      created++;
    }

    const total = await control.tenant.count();
    console.log(
      `[control-seed] ERP instance ${instance.id}; tenants: ${created} registered, ${updated} refreshed, ${total} total.`,
    );
  } finally {
    await app.$disconnect();
    await control.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
