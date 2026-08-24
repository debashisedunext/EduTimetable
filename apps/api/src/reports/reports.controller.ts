import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import { PERMISSIONS, type Permission } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { ScopeService } from "../auth/scope.service";
import { PermissionsService } from "../auth/permissions.service";
import { PrismaService } from "../prisma/prisma.service";
import { toInt, type AuthedRequest } from "../masters/crud.util";
import { ReportsService } from "./reports.service";

const dateOf = (q?: string) => (q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : null);

/** §10 Reports — every endpoint resolves the caller's ViewScope server-side
 *  and passes it into the query layer; UI hiding is cosmetic (§15.3). */
@Controller("reports")
@RequirePermission(PERMISSIONS.REPORTS_VIEW)
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly scopeSvc: ScopeService,
    private readonly permissions: PermissionsService,
    private readonly prisma: PrismaService,
  ) {}

  private async scopeOf(req: AuthedRequest) {
    const user = await this.prisma.user.findUnique({ where: { id: req.user.sub } });
    const perms = (await this.permissions.getForRole(req.user.roleId)) as Permission[];
    return this.scopeSvc.resolve(perms, user?.teacherId ?? null);
  }

  /** Scope-filtered picker options — a teacher only ever sees their own
   *  linked sections and themselves (§15.3). */
  @Get("options")
  async options(@Req() req: AuthedRequest) {
    const scope = await this.scopeOf(req);
    if (scope.level === "none") return { sections: [], teachers: [], configs: [] };
    const sectionWhere =
      scope.level === "all"
        ? { timetableConfigId: { not: null } }
        : { id: { in: scope.level === "class" ? scope.classSectionIds : [] } };
    const [sections, teachers, configs] = await Promise.all([
      this.prisma.classSection.findMany({
        where: sectionWhere,
        include: { class: true, section: true },
        orderBy: [{ class: { sequence: "asc" } }, { section: { name: "asc" } }],
      }),
      scope.level === "all"
        ? this.prisma.teacher.findMany({ where: { isActive: true }, orderBy: { name: "asc" } })
        : this.prisma.teacher.findMany({ where: { id: scope.teacherId } }),
      scope.level === "all" ? this.prisma.timetableConfig.findMany() : Promise.resolve([]),
    ]);
    return {
      scope: scope.level,
      sections: sections.map((cs) => ({ id: cs.id, label: `${cs.class.name}-${cs.section.name}` })),
      teachers: teachers.map((t) => ({ id: t.id, name: t.name })),
      configs: configs.map((c) => ({ id: c.id, name: c.name })),
    };
  }

  @Get("class-section/:id")
  async classSection(@Req() req: AuthedRequest, @Param("id") id: string, @Query("date") date?: string) {
    return this.reports.classSectionTimetable(await this.scopeOf(req), toInt(id, "id"), dateOf(date));
  }

  @Get("teacher/:id")
  async teacher(@Req() req: AuthedRequest, @Param("id") id: string, @Query("date") date?: string) {
    return this.reports.teacherTimetable(await this.scopeOf(req), toInt(id, "id"), dateOf(date));
  }

  @Get("rooms/:configId")
  async rooms(@Req() req: AuthedRequest, @Param("configId") configId: string) {
    return this.reports.roomUtilization(await this.scopeOf(req), toInt(configId, "configId"));
  }

  @Get("teacher-load/:configId")
  async load(@Req() req: AuthedRequest, @Param("configId") configId: string) {
    return this.reports.teacherLoadSummary(await this.scopeOf(req), toInt(configId, "configId"));
  }
}

/** §15.3 — the teacher-facing scoped views: own grid + linked class grids.
 *  Same query layer, scope resolved server-side, never trusting the client. */
@Controller("my")
export class MyViewsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly scopeSvc: ScopeService,
    private readonly permissions: PermissionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get("timetable")
  @RequirePermission(PERMISSIONS.TIMETABLE_VIEW_OWN)
  async myTimetable(@Req() req: AuthedRequest, @Query("date") date?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user?.teacherId) {
      return { kind: "teacher", label: user?.name ?? "You", grid: {}, periods: [], workingDays: [], dayNames: [], unlinked: true };
    }
    const perms = (await this.permissions.getForRole(req.user.roleId)) as Permission[];
    const scope = await this.scopeSvc.resolve(perms, user.teacherId);
    return this.reports.teacherTimetable(scope, user.teacherId, dateOf(date));
  }

  @Get("classes")
  @RequirePermission(PERMISSIONS.TIMETABLE_VIEW_CLASS)
  async myClasses(@Req() req: AuthedRequest) {
    const user = await this.prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user?.teacherId) return { sections: [] };
    const perms = (await this.permissions.getForRole(req.user.roleId)) as Permission[];
    const scope = await this.scopeSvc.resolve(perms, user.teacherId);
    if (scope.level !== "class" && scope.level !== "all") return { sections: [] };
    const ids = scope.level === "class" ? scope.classSectionIds : [];
    const sections = await this.prisma.classSection.findMany({
      where: { id: { in: ids } },
      include: { class: true, section: true },
      orderBy: [{ class: { sequence: "asc" } }, { section: { name: "asc" } }],
    });
    return {
      sections: sections.map((cs) => ({ id: cs.id, label: `${cs.class.name}-${cs.section.name}` })),
    };
  }
}
