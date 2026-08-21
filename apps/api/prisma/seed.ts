import { PrismaClient } from "@prisma/client";
import { DEFAULT_ROLES } from "@edutimetable/shared";

const prisma = new PrismaClient();
const SCHOOL_ID = 1;

async function main() {
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
        create: { roleId: role.id, permission },
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

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
