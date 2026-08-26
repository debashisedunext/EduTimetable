import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { buildPeriodRows } from "./structure.util";
import { requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";

@Controller("timetable-configs")
export class TimetableConfigsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  /** Landing screen list — visible to anyone who can generate or manage. */
  @Get()
  @RequirePermission(PERMISSIONS.TIMETABLE_GENERATE)
  async list(@Req() req: AuthedRequest) {
    const configs = await this.prisma.timetableConfig.findMany({
      where: { schoolId: req.user.schoolId },
      include: {
        academicYear: true,
        classSections: { include: { class: true, section: true } },
        periods: { orderBy: { sortOrder: "asc" } },
      },
      orderBy: { name: "asc" },
    });
    return configs.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      academicYear: c.academicYear.name,
      academicYearId: c.academicYearId,
      workingDays: c.workingDays,
      periodsPerDay: c.periodsPerDay,
      periodDurationMins: c.periodDurationMins,
      hasZeroPeriod: c.hasZeroPeriod,
      zeroPeriodDurationMins: c.zeroPeriodDurationMins,
      // §18 extra-class window
      extraPeriodsPerDay: c.extraPeriodsPerDay,
      extraPeriodDurationMins: c.extraPeriodDurationMins,
      startTime: c.startTime,
      endTime: c.endTime,
      status: c.status,
      classSections: c.classSections.map((cs) => `${cs.class.name}-${cs.section.name}`),
      breaks: c.periods
        .filter((p) => p.isBreak)
        .map((p) => ({ name: p.breakName, startTime: p.startTime, endTime: p.endTime })),
      periods: c.periods.map((p) => ({
        periodNumber: p.periodNumber,
        startTime: p.startTime,
        endTime: p.endTime,
        isBreak: p.isBreak,
        breakName: p.breakName,
      })),
    }));
  }

  @Post()
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async create(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["name", "academicYearId"]);
    const created = await uniq(
      () =>
        this.prisma.timetableConfig.create({
          data: {
            schoolId: req.user.schoolId,
            academicYearId: toInt(body.academicYearId, "academicYearId"),
            name: String(body.name),
            description: body.description ? String(body.description) : null,
            workingDays: body.workingDays ?? [1, 2, 3, 4, 5],
          },
        }),
      `Timetable '${body.name}'`,
    );
    await this.readiness.invalidate(req.user.schoolId);
    return created;
  }

  @Put(":id")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const updated = await uniq(
      () =>
        this.prisma.timetableConfig.update({
          where: { id: toInt(id, "id") },
          data: {
            ...(body.name !== undefined ? { name: String(body.name) } : {}),
            ...(body.description !== undefined ? { description: body.description ? String(body.description) : null } : {}),
            ...(body.status !== undefined ? { status: body.status } : {}),
          },
        }),
      "Timetable config",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return updated;
  }

  /**
   * §3.10 — rebuild the daily structure: periods, breaks, zero period, and the
   * server-computed period times + end time, in one transaction.
   */
  @Put(":id/structure")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async setStructure(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const configId = toInt(id, "id");
    requireFields(body, ["startTime", "periodsPerDay", "periodDurationMins", "workingDays"]);
    if (!Array.isArray(body.workingDays) || body.workingDays.length === 0) {
      throw new BadRequestException("workingDays must be a non-empty array of day numbers 1-7");
    }
    let built;
    try {
      built = buildPeriodRows({
        startTime: String(body.startTime),
        periodsPerDay: toInt(body.periodsPerDay, "periodsPerDay"),
        periodDurationMins: toInt(body.periodDurationMins, "periodDurationMins"),
        hasZeroPeriod: Boolean(body.hasZeroPeriod),
        zeroPeriodDurationMins:
          body.zeroPeriodDurationMins != null ? toInt(body.zeroPeriodDurationMins, "zeroPeriodDurationMins") : null,
        breaks: Array.isArray(body.breaks)
          ? body.breaks.map((b: any) => ({
              afterPeriod: toInt(b.afterPeriod, "break.afterPeriod"),
              name: String(b.name ?? "Break"),
              durationMins: toInt(b.durationMins, "break.durationMins"),
            }))
          : [],
        // §18: the extra-class window, appended after the teaching day.
        extraPeriodsPerDay: body.extraPeriodsPerDay != null ? toInt(body.extraPeriodsPerDay, "extraPeriodsPerDay") : 0,
        extraPeriodDurationMins:
          body.extraPeriodDurationMins != null ? toInt(body.extraPeriodDurationMins, "extraPeriodDurationMins") : null,
      });
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    await this.prisma.$transaction([
      this.prisma.period.deleteMany({ where: { timetableConfigId: configId } }),
      this.prisma.period.createMany({
        data: built.rows.map((r) => ({ ...r, timetableConfigId: configId, schoolId: req.user.schoolId })),
      }),
      this.prisma.timetableConfig.update({
        where: { id: configId },
        data: {
          workingDays: body.workingDays,
          periodsPerDay: toInt(body.periodsPerDay, "periodsPerDay"),
          periodDurationMins: toInt(body.periodDurationMins, "periodDurationMins"),
          hasZeroPeriod: Boolean(body.hasZeroPeriod),
          zeroPeriodDurationMins:
            body.zeroPeriodDurationMins != null ? toInt(body.zeroPeriodDurationMins, "zeroPeriodDurationMins") : null,
          startTime: String(body.startTime),
          endTime: built.endTime,
          extraPeriodsPerDay: body.extraPeriodsPerDay != null ? toInt(body.extraPeriodsPerDay, "extraPeriodsPerDay") : 0,
          extraPeriodDurationMins:
            body.extraPeriodDurationMins != null ? toInt(body.extraPeriodDurationMins, "extraPeriodDurationMins") : null,
          extraDays: Array.isArray(body.extraDays) ? body.extraDays : undefined,
        },
      }),
    ]);
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true, endTime: built.endTime, extraEndTime: built.extraEndTime, periods: built.rows };
  }

  /**
   * §3.10 — scope class-sections to this config. A section already claimed by a
   * DIFFERENT config is rejected, naming that timetable.
   */
  @Put(":id/class-sections")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async setClassSections(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const configId = toInt(id, "id");
    const ids: number[] = Array.isArray(body.classSectionIds)
      ? body.classSectionIds.map((x: unknown) => toInt(x, "classSectionIds[]"))
      : [];
    const claimed = await this.prisma.classSection.findMany({
      where: { id: { in: ids }, timetableConfigId: { not: configId } },
      include: { class: true, section: true, timetableConfig: true },
    });
    const conflict = claimed.filter((c) => c.timetableConfigId !== null);
    if (conflict.length > 0) {
      throw new BadRequestException(
        `Already claimed by another timetable: ${conflict
          .map((c) => `${c.class.name}-${c.section.name} (${c.timetableConfig!.name})`)
          .join(", ")}`,
      );
    }
    await this.prisma.$transaction([
      this.prisma.classSection.updateMany({
        where: { timetableConfigId: configId, id: { notIn: ids } },
        data: { timetableConfigId: null },
      }),
      this.prisma.classSection.updateMany({
        where: { id: { in: ids } },
        data: { timetableConfigId: configId },
      }),
    ]);
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true, count: ids.length };
  }

  @Delete(":id")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const configId = toInt(id, "id");
    await this.prisma.classSection.updateMany({
      where: { timetableConfigId: configId },
      data: { timetableConfigId: null },
    });
    await uniq(
      () => this.prisma.timetableConfig.delete({ where: { id: configId } }),
      "Timetable config",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }

  /** Readiness Dashboard data (§4) — Feasibility Engine over the live DB. */
  @Get(":id/readiness")
  @RequirePermission(PERMISSIONS.TIMETABLE_GENERATE)
  readiness_(@Param("id") id: string) {
    return this.readiness.getReadiness(toInt(id, "id"));
  }
}
