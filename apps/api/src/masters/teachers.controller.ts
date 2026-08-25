import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";

const RULES = ["none", "always_first_period", "random"];
const PATTERNS = ["every_period", "alternate_period", "alternate_day"];

@Controller("teachers")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class TeachersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  /** Teacher Directory (§8.1a): list-first with load vs. capacity. */
  @Get()
  async list(@Req() req: AuthedRequest) {
    const teachers = await this.prisma.teacher.findMany({
      where: { schoolId: req.user.schoolId },
      include: {
        mappings: { include: { subject: true } },
        classTeacherOf: { include: { class: true, section: true } },
        unavailability: true,
      },
      orderBy: { name: "asc" },
    });
    return teachers.map((t) => ({
      id: t.id,
      employeeCode: t.employeeCode,
      name: t.name,
      maxPeriodsPerDay: t.maxPeriodsPerDay,
      maxPeriodsPerWeek: t.maxPeriodsPerWeek,
      classTeacherPeriodRule: t.classTeacherPeriodRule,
      periodPattern: t.periodPattern,
      alternateDaySet: t.alternateDaySet,
      isActive: t.isActive,
      subjects: [...new Set(t.mappings.map((m) => m.subject.name))],
      sectionsMapped: new Set(t.mappings.map((m) => m.classSectionId)).size,
      weeklyLoad: t.mappings.reduce((s, m) => s + m.periodsPerWeek, 0),
      classTeacherOf: t.classTeacherOf.map((cs) => `${cs.class.name}-${cs.section.name}`),
      unavailability: t.unavailability,
    }));
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["name", "employeeCode"]);
    this.validateRules(body);
    const created = await uniq(
      () =>
        this.prisma.teacher.create({
          data: {
            schoolId: req.user.schoolId,
            name: String(body.name),
            employeeCode: String(body.employeeCode),
            maxPeriodsPerDay: body.maxPeriodsPerDay != null ? toInt(body.maxPeriodsPerDay, "maxPeriodsPerDay") : 6,
            maxPeriodsPerWeek: body.maxPeriodsPerWeek != null ? toInt(body.maxPeriodsPerWeek, "maxPeriodsPerWeek") : 30,
            classTeacherPeriodRule: body.classTeacherPeriodRule ?? "none",
            periodPattern: body.periodPattern ?? "every_period",
            alternateDaySet: body.alternateDaySet ?? undefined,
          },
        }),
      `Teacher '${body.employeeCode}'`,
    );
    await this.readiness.invalidate(req.user.schoolId);
    return created;
  }

  @Put(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    this.validateRules(body);
    const updated = await uniq(
      () =>
        this.prisma.teacher.update({
          where: { id: toInt(id, "id") },
          data: {
            ...(body.name !== undefined ? { name: String(body.name) } : {}),
            ...(body.employeeCode !== undefined ? { employeeCode: String(body.employeeCode) } : {}),
            ...(body.maxPeriodsPerDay !== undefined ? { maxPeriodsPerDay: toInt(body.maxPeriodsPerDay, "maxPeriodsPerDay") } : {}),
            ...(body.maxPeriodsPerWeek !== undefined ? { maxPeriodsPerWeek: toInt(body.maxPeriodsPerWeek, "maxPeriodsPerWeek") } : {}),
            ...(body.classTeacherPeriodRule !== undefined ? { classTeacherPeriodRule: body.classTeacherPeriodRule } : {}),
            ...(body.periodPattern !== undefined ? { periodPattern: body.periodPattern } : {}),
            ...(body.alternateDaySet !== undefined ? { alternateDaySet: body.alternateDaySet } : {}),
            ...(body.isActive !== undefined ? { isActive: Boolean(body.isActive) } : {}),
          },
        }),
      "Teacher",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return updated;
  }

  /** Replace a teacher's weekly-off / unavailability rows. */
  @Put(":id/unavailability")
  async setUnavailability(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const teacherId = toInt(id, "id");
    // A write carrying rows is already refused for another school's teacher —
    // the reference check on `createMany` catches it (§17, invariant 13). An
    // *empty* rows array writes nothing, so nothing is checked, and this used
    // to answer `{ok: true}` for a teacher belonging to someone else. Ask
    // first, so the answer is the same either way: not found (§17.8).
    const teacher = await this.prisma.teacher.findFirst({
      where: { id: teacherId },
      select: { id: true },
    });
    if (!teacher) throw new NotFoundException(`Teacher ${teacherId} not found`);

    const rows: any[] = Array.isArray(body.rows) ? body.rows : [];
    await this.prisma.$transaction([
      this.prisma.teacherUnavailability.deleteMany({ where: { teacherId } }),
      this.prisma.teacherUnavailability.createMany({
        data: rows.map((r) => ({
          schoolId: req.user.schoolId,
          teacherId,
          dayOfWeek: toInt(r.dayOfWeek, "dayOfWeek"),
          periodNumber: r.periodNumber != null ? toInt(r.periodNumber, "periodNumber") : null,
          reason: r.reason ? String(r.reason) : null,
        })),
      }),
    ]);
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true, count: rows.length };
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    await uniq(() => this.prisma.teacher.delete({ where: { id: toInt(id, "id") } }), "Teacher");
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }

  private validateRules(body: any) {
    if (body.classTeacherPeriodRule !== undefined && !RULES.includes(body.classTeacherPeriodRule)) {
      throw new BadRequestException(`classTeacherPeriodRule must be one of ${RULES.join(", ")}`);
    }
    if (body.periodPattern !== undefined && !PATTERNS.includes(body.periodPattern)) {
      throw new BadRequestException(`periodPattern must be one of ${PATTERNS.join(", ")}`);
    }
    if (body.alternateDaySet !== undefined && body.alternateDaySet !== null) {
      if (
        !Array.isArray(body.alternateDaySet) ||
        body.alternateDaySet.some((d: unknown) => !Number.isInteger(d) || (d as number) < 1 || (d as number) > 7)
      ) {
        throw new BadRequestException("alternateDaySet must be an array of day numbers 1-7");
      }
    }
  }
}
