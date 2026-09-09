import { PrismaClient } from "@prisma/client";
import { DEFAULT_ROLES } from "@edutimetable/shared";
import { TenantContextService } from "../src/tenant/tenant-context.service";
import { withSchoolScope } from "../src/prisma/school-scope";

const SCHOOL_ID = 1;

// Seeding runs through the same school-scoped client the app uses (9.1 / §17),
// so the denormalized school_id on child tables like role_permissions is
// stamped here exactly as it would be at runtime — one code path, not two.
const tenant = new TenantContextService();
const base = new PrismaClient();
const prisma = withSchoolScope(base, tenant);

async function main() {
  // The school this seed is about must exist before anything can reference it.
  //
  // Phase 9.2's migration back-FILLS `schools` from rows that already carried a
  // school_id, which is right for an upgrade and does nothing at all on an
  // empty database — so a genuinely fresh volume reached this seed with no
  // school 1 and failed on the foreign key, with a message naming `roles`
  // rather than the actual gap. Created through the UNSCOPED client because
  // `schools` is the tenant root: it is scoped by its own id and never stamped
  // with somebody else's (§17, invariant 18).
  //
  // The name is a placeholder on purpose. Inventing a real school's name here
  // would be a guess; SSO provisioning overwrites it from the ERP on the first
  // login, and a self-serve admin renames it on School Profile.
  await base.school.upsert({
    where: { id: SCHOOL_ID },
    create: { id: SCHOOL_ID, code: `SCHOOL-${SCHOOL_ID}`, name: `School ${SCHOOL_ID}` },
    update: {},
  });

  for (const [name, permissions] of Object.entries(DEFAULT_ROLES)) {
    const role = await prisma.role.upsert({
      where: { schoolId_name: { schoolId: SCHOOL_ID, name } },
      create: { schoolId: SCHOOL_ID, name, isSystem: true },
      update: { isSystem: true },
    });
    // Refresh seed defaults only for permissions rows; runtime edits from the
    // Roles & Responsibility page live in the same table and re-seeding must
    // stay idempotent, so we only add missing defaults, never delete.
    for (const permission of permissions) {
      await prisma.rolePermission.upsert({
        where: { roleId_permission: { roleId: role.id, permission } },
        create: { roleId: role.id, permission, schoolId: SCHOOL_ID },
        update: {},
      });
    }
  }

  const roleByName = async (name: string) =>
    (await prisma.role.findUniqueOrThrow({
      where: { schoolId_name: { schoolId: SCHOOL_ID, name } },
    })).id;

  const erpMappings: Array<[string, string]> = [
    ["ADMIN", "Super Admin"],
    ["PRINCIPAL", "Principal"],
    ["TEACHER", "Teacher"],
    ["FRONT_OFFICE", "Front Office"],
  ];
  for (const [erpRole, roleName] of erpMappings) {
    await prisma.erpRoleMapping.upsert({
      where: { schoolId_erpRole: { schoolId: SCHOOL_ID, erpRole } },
      create: { schoolId: SCHOOL_ID, erpRole, roleId: await roleByName(roleName) },
      update: {},
    });
  }

  console.log("Seed complete: roles, permissions, ERP role mappings (school 1).");
}

tenant
  .runAs({ schoolId: SCHOOL_ID, origin: "seed" }, main)
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
