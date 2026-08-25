/**
 * Provision a school into its own database (§17.5, Phase 9.4).
 *
 *   docker compose exec api pnpm --filter @edutimetable/api tenant:create \
 *     --code SCH-042 --name "St. Xavier's High School"
 *
 *   # ...or against a database that already exists somewhere else:
 *   ... --code SCH-042 --name "…" --url "mysql://user:pw@host:3306/xavier"
 *
 * What it does, in order:
 *   1. creates the database (unless --url points at an existing one elsewhere)
 *   2. applies the application migrations to it
 *   3. creates the school row and seeds its permission registry and ERP role
 *      mappings, so its users can sign in the moment the ERP sends them
 *   4. registers it in the tenant registry as `dedicated`, with its connection
 *      URL encrypted at rest
 *
 * Deliberately a command and not an API call: creating a database is an
 * operator action with credentials attached, and nothing a login should be able
 * to trigger implicitly. A school the ERP mentions that nobody has provisioned
 * lands in the shared database, which is the safe default.
 *
 * Idempotent: re-running against an existing code updates the registration
 * rather than creating a second school.
 */
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { DEFAULT_ROLES } from "@edutimetable/shared";
import { PrismaClient as ControlClient } from "../generated/control-client";
import { encryptSecret } from "../../src/common/crypto.util";

const ERP_ROLE_DEFAULTS: Array<[string, string]> = [
  ["ADMIN", "Super Admin"],
  ["PRINCIPAL", "Principal"],
  ["TEACHER", "Teacher"],
  ["FRONT_OFFICE", "Front Office"],
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Swap the database name in a MySQL URL, keeping host and credentials. */
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** A URL safe to print: credentials replaced, host and database kept. */
function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable url>";
  }
}

async function main() {
  const code = arg("code");
  const name = arg("name");
  if (!code || !name) {
    console.error(
      "Usage: tenant:create --code <SCHOOL-CODE> --name <School Name> [--url <mysql://…>] [--database <name>]",
    );
    process.exit(1);
  }

  const controlUrl = process.env.CONTROL_DATABASE_URL;
  if (!controlUrl) {
    console.error("CONTROL_DATABASE_URL is required — a dedicated tenant has to be registered.");
    process.exit(1);
  }
  const appUrl = process.env.DATABASE_URL;
  if (!appUrl) {
    console.error("DATABASE_URL is required (it supplies the server and credentials).");
    process.exit(1);
  }

  const explicitUrl = arg("url");
  const database = arg("database") ?? `edutimetable_${code.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  const tenantUrl = explicitUrl ?? withDatabase(appUrl, database);

  console.log(`Provisioning '${name}' (${code})`);
  console.log(`  database: ${redact(tenantUrl)}`);

  // ---- 1. create the database, unless it lives somewhere we were handed ----
  if (!explicitUrl) {
    const admin = new PrismaClient({ datasources: { db: { url: appUrl } } });
    await admin.$executeRawUnsafe(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await admin.$disconnect();
    console.log("  ✓ database created");
  }

  // ---- 2. bring it up to the application schema ----
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: tenantUrl },
    stdio: "inherit",
  });
  console.log("  ✓ migrations applied");

  // ---- 3. the school row, and enough roles for its users to sign in ----
  const db = new PrismaClient({ datasources: { db: { url: tenantUrl } } });
  const school =
    (await db.school.findUnique({ where: { code } })) ??
    (await db.school.create({ data: { code, name } }));
  if (school.name !== name) {
    await db.school.update({ where: { id: school.id }, data: { name } });
  }

  for (const [roleName, permissions] of Object.entries(DEFAULT_ROLES)) {
    const role = await db.role.upsert({
      where: { schoolId_name: { schoolId: school.id, name: roleName } },
      create: { schoolId: school.id, name: roleName, isSystem: true },
      update: {},
    });
    await db.rolePermission.createMany({
      data: permissions.map((permission) => ({ roleId: role.id, permission, schoolId: school.id })),
      skipDuplicates: true,
    });
  }
  for (const [erpRole, roleName] of ERP_ROLE_DEFAULTS) {
    const role = await db.role.findUnique({
      where: { schoolId_name: { schoolId: school.id, name: roleName } },
    });
    if (!role) continue;
    await db.erpRoleMapping.upsert({
      where: { schoolId_erpRole: { schoolId: school.id, erpRole } },
      create: { schoolId: school.id, erpRole, roleId: role.id },
      update: {},
    });
  }
  await db.$disconnect();
  console.log(`  ✓ school row (school_id ${school.id}) and permission registry seeded`);

  // ---- 4. register it, with the connection URL encrypted at rest ----
  const control = new ControlClient({ datasources: { db: { url: controlUrl } } });
  const instance =
    (await control.erpInstance.findFirst({ orderBy: { id: "asc" } })) ??
    (await control.erpInstance.create({
      data: { name: "Edunext ERP (default installation)", publicKeyPem: "" },
    }));

  const tenant = await control.tenant.upsert({
    where: { erpInstanceId_schoolCode: { erpInstanceId: instance.id, schoolCode: code } },
    create: {
      erpInstanceId: instance.id,
      schoolCode: code,
      displayName: name,
      mode: "dedicated",
      localSchoolId: school.id,
      dbUrlEncrypted: Uint8Array.from(encryptSecret(tenantUrl)),
      status: "active",
    },
    update: {
      displayName: name,
      mode: "dedicated",
      localSchoolId: school.id,
      dbUrlEncrypted: Uint8Array.from(encryptSecret(tenantUrl)),
    },
  });
  await control.$disconnect();

  console.log(`  ✓ registered as tenant ${tenant.id} (dedicated)`);
  console.log(
    `\nDone. Send \`school: { code: "${code}", name: "${name}" }\` on the SSO token and its users land here.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
