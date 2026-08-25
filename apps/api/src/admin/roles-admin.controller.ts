import { BadRequestException, Body, Controller, Get, Param, Post, Put, Req } from "@nestjs/common";
import { ALL_PERMISSIONS, PERMISSIONS, type Permission } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../auth/permissions.service";
import { requireFields, toInt, uniq, type AuthedRequest } from "../masters/crud.util";

/**
 * Roles & Responsibility page backend (§15.4). Every change is audit-logged
 * and takes effect on the next request (permission cache invalidated on save).
 * The whole controller requires roles.manage — server-side, per invariant.
 */
@Controller("admin")
@RequirePermission(PERMISSIONS.ROLES_MANAGE)
export class RolesAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  @Get("overview")
  async overview(@Req() req: AuthedRequest) {
    const schoolId = req.user.schoolId;
    const [roles, erpMappings, users, audit] = await Promise.all([
      this.prisma.role.findMany({
        where: { schoolId },
        include: { permissions: true },
        orderBy: { id: "asc" },
      }),
      this.prisma.erpRoleMapping.findMany({ where: { schoolId }, include: { role: true } }),
      this.prisma.user.findMany({ where: { schoolId }, include: { role: true }, orderBy: { name: "asc" } }),
      this.prisma.auditLog.findMany({ where: { schoolId }, orderBy: { id: "desc" }, take: 30 }),
    ]);
    const teacherIds = users.map((u) => u.teacherId).filter((x): x is number => x !== null);
    const teachers = await this.prisma.teacher.findMany({ where: { id: { in: teacherIds } } });
    const teacherById = new Map(teachers.map((t) => [t.id, t]));
    return {
      allPermissions: ALL_PERMISSIONS,
      roles: roles.map((r) => ({
        id: r.id,
        name: r.name,
        isSystem: r.isSystem,
        permissions: r.permissions.map((p) => p.permission),
      })),
      erpMappings: erpMappings.map((m) => ({ id: m.id, erpRole: m.erpRole, roleId: m.roleId, roleName: m.role.name })),
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        roleId: u.roleId,
        roleName: u.role.name,
        roleOverridden: u.roleOverridden,
        teacherId: u.teacherId,
        teacherName: u.teacherId ? (teacherById.get(u.teacherId)?.name ?? "⚠ unknown teacher") : null,
        teacherLinked: u.teacherId !== null && teacherById.has(u.teacherId),
      })),
      audit: audit.map((a) => ({
        id: String(a.id),
        userId: a.userId,
        action: a.action,
        detail: a.detail,
        createdAt: a.createdAt,
      })),
    };
  }

  @Post("roles")
  async createRole(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["name"]);
    const role = await uniq(
      () => this.prisma.role.create({ data: { schoolId: req.user.schoolId, name: String(body.name) } }),
      `Role '${body.name}'`,
    );
    await this.audit(req, "role.created", { roleId: role.id, name: role.name });
    return role;
  }

  @Put("roles/:id/permissions")
  async setPermissions(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const roleId = toInt(id, "role id");
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, schoolId: req.user.schoolId },
    });
    if (!role) throw new BadRequestException("Role not found");
    if (role.isSystem && role.name === "Super Admin") {
      throw new BadRequestException("Super Admin permissions are fixed");
    }
    const requested: string[] = Array.isArray(body.permissions) ? body.permissions : [];
    const invalid = requested.filter((p) => !ALL_PERMISSIONS.includes(p as Permission));
    if (invalid.length > 0) {
      throw new BadRequestException(`Unknown permission(s): ${invalid.join(", ")}`);
    }
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId } }),
      this.prisma.rolePermission.createMany({
        data: requested.map((permission) => ({ roleId, permission, schoolId: req.user.schoolId })),
      }),
    ]);
    this.permissions.invalidate(roleId);
    await this.audit(req, "role.permissions_changed", { roleId, name: role.name, permissions: requested });
    return { ok: true };
  }

  @Put("erp-mappings")
  async setErpMapping(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["erpRole", "roleId"]);
    const mapping = await this.prisma.erpRoleMapping.upsert({
      where: { schoolId_erpRole: { schoolId: req.user.schoolId, erpRole: String(body.erpRole) } },
      create: { schoolId: req.user.schoolId, erpRole: String(body.erpRole), roleId: toInt(body.roleId, "roleId") },
      update: { roleId: toInt(body.roleId, "roleId") },
    });
    await this.audit(req, "erp_mapping.changed", { erpRole: mapping.erpRole, roleId: mapping.roleId });
    return mapping;
  }

  /** Per-user role override (wins over ERP mapping on re-login) + teacher link. */
  @Put("users/:id")
  async updateUser(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const userId = toInt(id, "user id");
    const data: Record<string, unknown> = {};
    if (body.roleId !== undefined) {
      data.roleId = toInt(body.roleId, "roleId");
      data.roleOverridden = true;
    }
    if (body.teacherId !== undefined) {
      if (body.teacherId !== null) {
        const t = await this.prisma.teacher.findFirst({
          where: { id: toInt(body.teacherId, "teacherId"), schoolId: req.user.schoolId },
        });
        if (!t) throw new BadRequestException("Teacher record not found");
      }
      data.teacherId = body.teacherId === null ? null : toInt(body.teacherId, "teacherId");
    }
    const user = await uniq(
      () => this.prisma.user.update({ where: { id: userId }, data }),
      "User",
    );
    await this.audit(req, "user.updated", { userId, ...data });
    return { id: user.id, roleId: user.roleId, teacherId: user.teacherId, roleOverridden: user.roleOverridden };
  }

  private audit(req: AuthedRequest, action: string, detail: object) {
    return this.prisma.auditLog.create({
      data: { schoolId: req.user.schoolId, userId: req.user.sub, action, detail },
    });
  }
}
