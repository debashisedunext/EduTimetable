import { BadRequestException, Body, Controller, Delete, Get, Logger, Param, Post, Put, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { CacheKeysService } from "../redis/cache-keys.service";
import { CloneService } from "./clone.service";
import { planDeletion, runDeletion } from "./config-deletion";
import { buildPeriodRows } from "./structure.util";
import { requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";

@Controller("timetable-configs")
export class TimetableConfigsController {
  private readonly logger = new Logger(TimetableConfigsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
    private readonly clone: CloneService,
    private readonly keys: CacheKeysService,
  ) {}

  /**
   * The list of timetables — which is a VIEW concern, not a build one.
   *
   * This asked for `timetable.generate`, and the comment above it said "anyone
   * who can generate or manage" — but a Principal holds neither, and holds
   * `timetable.view.all`. So the top-bar selector 403'd for them, which left
   * every screen that needs to know *which* timetable it is looking at — the
   * Matrix, Reports, the Substitute Center — with nothing selected and no way
   * to select. A role that may read every timetable must be able to find out
   * that they exist.
   *
   * `view.all` rather than an OR with `generate`: the permissions guard is AND,
   * and a role that may generate a timetable it may not look at is not a role
   * anybody wants. A Teacher (`view.own`) is still refused, correctly — their
   * way in is My Timetable, not a picker over every wing in the school.
   */
  @Get()
  @RequirePermission(PERMISSIONS.TIMETABLE_VIEW_ALL)
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

  /**
   * §3.12 — what cloning this timetable into another session would do, without
   * doing any of it. Creates nothing, not even the target academic year.
   */
  @Post(":id/clone/preview")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async clonePreview(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    requireFields(body, ["name"]);
    return this.clone.plan(req.user.schoolId, toInt(id, "id"), { ...body, name: String(body.name) });
  }

  /**
   * §3.12 — do it. The plan is recomputed server-side from the database; the
   * request names the source and the target session and nothing else, so a
   * stale or doctored preview can never become the list of writes.
   */
  @Post(":id/clone")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async cloneCommit(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    requireFields(body, ["name"]);
    return this.clone.commit(req.user.schoolId, toInt(id, "id"), { ...body, name: String(body.name) });
  }

  /**
   * §3.13 — what deleting this timetable would remove, counted, before anything
   * is removed. The screen shows this and nothing else, so a confirmation can
   * never claim less than the write.
   */
  @Get(":id/deletion")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async deletionPlan(@Param("id") id: string) {
    return planDeletion(this.prisma, toInt(id, "id"));
  }

  /**
   * §3.13 — delete a timetable and everything that hangs off it.
   *
   * The plan is recomputed here rather than taken from the request: a preview
   * the client held for five minutes is not what is true now, and it is never
   * the list of writes. It is also what enforces the refusal — a published
   * timetable is blocked whether or not the button that led here was greyed out.
   */
  @Delete(":id")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const configId = toInt(id, "id");
    const plan = await planDeletion(this.prisma, configId);
    if (plan.blocked) throw new BadRequestException(plan.blocked);

    // One transaction: a half-deleted timetable is slots with no config, which
    // is precisely the state this module exists to make impossible.
    await this.prisma.$transaction(async (tx) => {
      await runDeletion(tx, configId);
    });

    // The slot cache is keyed by config and swept by PREFIX — the per-draft
    // suffixes are open-ended, and naming keys would leave copies behind.
    await this.keys.invalidateTimetable(configId);
    await this.readiness.invalidate(req.user.schoolId);
    this.logger.log(`deleted timetable ${configId} (${plan.name}) and everything under it`);
    return { ok: true, deleted: plan };
  }

  /** Readiness Dashboard data (§4) — Feasibility Engine over the live DB. */
  @Get(":id/readiness")
  @RequirePermission(PERMISSIONS.TIMETABLE_GENERATE)
  readiness_(@Param("id") id: string) {
    return this.readiness.getReadiness(toInt(id, "id"));
  }
}
