import { BadRequestException, Body, Controller, Delete, Get, Logger, NotFoundException, Param, Post, Put, Query, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { CacheKeysService } from "../redis/cache-keys.service";
import { CloneService } from "./clone.service";
import { planDeletion, runDeletion } from "./config-deletion";
import { planReset, runReset } from "./allocation-reset";
import { planCellDelete, runCellDelete } from "./allocation-cell";
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
      // §28.1 — served with the config so the Allocation rail and Readiness
      // read one number rather than each holding its own default.
      loadAlertPct: c.loadAlertPct,
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
        isActivity: p.isActivity,
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
            // §28.1 — the percentage at which the app says a teacher is
            // getting full. Clamped rather than rejected: it is a reporting
            // preference, and 0 or 500 is a slip rather than an attack.
            ...(body.loadAlertPct !== undefined
              ? { loadAlertPct: Math.max(50, Math.min(100, toInt(body.loadAlertPct, "loadAlertPct"))) }
              : {}),
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
        // §28.3/28.4 — read from the table rather than the request body.
        //
        // The activities are edited on their own screen and this endpoint
        // rebuilds the period rows wholesale, so a structure save that did not
        // read them would silently delete every assembly band a school had set
        // up. Same reason `setActivities` below re-runs this build.
        activities: await this.activitiesFor(configId),
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

  // ──────────────────────────────────── §27.11 clear the allocation

  /**
   * What clearing this timetable's allocation would remove — counted, not
   * estimated, and by the same objects that do the removing.
   */
  @Get(":id/allocation-reset")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async resetPlan(@Param("id") id: string) {
    const configId = toInt(id, "id");
    await this.ownConfigOr404(configId);
    return planReset(this.prisma, configId);
  }

  /**
   * §27.11 — clear the curriculum, the mappings and the class teachers.
   *
   * The plan is recomputed here rather than taken from the request, for the
   * same two reasons §3.13's delete does it: a preview the client held for five
   * minutes is not what is true now, and it is never the list of writes. It is
   * also what enforces the refusal — a published timetable is blocked whether
   * or not the button that led here was greyed out.
   */
  @Post(":id/allocation-reset")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async resetAllocation(@Req() req: AuthedRequest, @Param("id") id: string) {
    const configId = toInt(id, "id");
    await this.ownConfigOr404(configId);
    const plan = await planReset(this.prisma, configId);
    if (!plan) throw new NotFoundException(`No timetable with id ${configId}`);
    if (plan.blocked) throw new BadRequestException(plan.blocked);

    await this.prisma.$transaction(async (tx: any) => { await runReset(tx, configId); });
    // The board, the matrix and the readiness score are all downstream of rows
    // that have just gone. `invalidateTimetable` sweeps by PREFIX (§22), which
    // is what catches every per-draft copy — three hand-written deletes left
    // them stale last time somebody named keys instead.
    await this.keys.invalidateTimetable(configId);
    await this.readiness.invalidate(req.user.schoolId);
    this.logger.warn(
      `Allocation cleared for timetable ${configId}: ` +
        plan.lines.filter((l) => l.count > 0).map((l) => `${l.count} ${l.label}`).join(", "),
    );
    return { ok: true, removed: plan.lines.filter((l) => l.count > 0), total: plan.total };
  }

  // ──────────────────── §27.15 one class does not take one subject

  /**
   * What removing this subject from this class would delete.
   *
   * A GET so the confirmation can be shown before anything is written, and so
   * the screen can tell "there is nothing saved yet" (a draft-only cell, which
   * needs no server call at all) from "this would delete four rows".
   */
  @Get(":id/allocation-cell")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async cellDeletePlan(
    @Param("id") id: string,
    @Query("className") className: string,
    @Query("subjectName") subjectName: string,
  ) {
    const configId = toInt(id, "id");
    await this.ownConfigOr404(configId);
    if (!className?.trim() || !subjectName?.trim()) {
      throw new BadRequestException("className and subjectName are both required");
    }
    return planCellDelete(this.prisma, configId, className.trim(), subjectName.trim());
  }

  /**
   * Remove it: the curriculum row, its mappings, its merged groups and its
   * draft lessons. The plan is recomputed here rather than taken from the
   * request — a preview the client held is not what is true now, and it is
   * never the list of writes.
   *
   * A cell with nothing saved answers `{ok: true, total: 0}` rather than 404:
   * "there was nothing to delete" is a successful outcome of asking for a
   * deletion, and the wizard's draft is where the removal is really recorded.
   * A class or subject that does not exist at all is still a 404 — that is a
   * request about something else.
   */
  @Post(":id/allocation-cell/delete")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async cellDelete(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const configId = toInt(id, "id");
    await this.ownConfigOr404(configId);
    const className = String(body?.className ?? "").trim();
    const subjectName = String(body?.subjectName ?? "").trim();
    if (!className || !subjectName) {
      throw new BadRequestException("className and subjectName are both required");
    }
    const plan = await planCellDelete(this.prisma, configId, className, subjectName);
    if (!plan) throw new NotFoundException(`No class ${className} or subject ${subjectName} in this timetable`);
    if (plan.blocked) throw new BadRequestException(plan.blocked);

    if (plan.total > 0) {
      await this.prisma.$transaction(async (tx: any) => {
        await runCellDelete(tx, configId, className, subjectName);
      });
      // Swept by PREFIX (§22), which is what catches every per-draft copy.
      await this.keys.invalidateTimetable(configId);
      await this.readiness.invalidate(req.user.schoolId);
      this.logger.warn(
        `${className} no longer takes ${subjectName} (timetable ${configId}): ` +
          plan.lines.filter((l) => l.count > 0).map((l) => `${l.count} ${l.label}`).join(", "),
      );
    }
    return { ok: true, removed: plan.lines.filter((l) => l.count > 0), total: plan.total };
  }

  // ─────────────────────────────────────── §28.3/28.4 daily activities

  /** The activity rows this config's day is built from, in running order. */
  private async activitiesFor(configId: number) {
    const rows = await this.prisma.dailyActivity.findMany({
      where: { timetableConfigId: configId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      placement: a.placement as "before_first" | "after_last",
      durationMins: a.durationMins,
      sortOrder: a.sortOrder,
    }));
  }

  /**
   * This config, or 404 — never a successful answer about somebody else's.
   *
   * The §17 scope extension already stops another school's rows being READ, so
   * a bare `findMany` returns `[]` and leaks nothing. But `200 []` is
   * indistinguishable from a config that genuinely has no activities, which
   * makes it a confirmation that the id exists — and it becomes a real write
   * the moment somebody copies the pattern into an endpoint that mutates.
   * Another school's id is 404. The isolation sweep caught exactly this.
   */
  private async ownConfigOr404(configId: number) {
    const config = await this.prisma.timetableConfig.findFirst({ where: { id: configId } });
    if (!config) throw new NotFoundException(`No timetable with id ${configId}`);
    return config;
  }

  @Get(":id/activities")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async listActivities(@Param("id") id: string) {
    const configId = toInt(id, "id");
    await this.ownConfigOr404(configId);
    const rows = await this.prisma.dailyActivity.findMany({
      where: { timetableConfigId: configId },
      orderBy: [{ placement: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
      include: { teacher: { select: { id: true, name: true, initials: true } },
                 room: { select: { id: true, name: true } } },
    });
    return rows.map((a) => ({
      id: a.id, name: a.name, placement: a.placement, durationMins: a.durationMins,
      days: a.days, sortOrder: a.sortOrder, isActive: a.isActive,
      teacherId: a.teacherId, teacherName: a.teacher?.name ?? null,
      teacherInitials: a.teacher?.initials ?? null,
      roomId: a.roomId, roomName: a.room?.name ?? null,
    }));
  }

  /**
   * Replace this config's activities, then rebuild the day.
   *
   * A whole-set PUT rather than per-row CRUD, for the same reason §25's terms
   * are: the *order* of two before-first activities is part of the answer, and
   * a screen that adds one row at a time would need its own reordering
   * protocol. One payload, one meaning.
   *
   * The rebuild at the end is the load-bearing half. `periods` is a projection
   * of the config plus its activities, and an activity saved without it would
   * exist in the database and appear on no timetable — which reads as the save
   * having failed.
   */
  @Put(":id/activities")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async setActivities(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const configId = toInt(id, "id");
    const config = await this.ownConfigOr404(configId);

    const input: any[] = Array.isArray(body.activities) ? body.activities : [];
    const seen = new Set<string>();
    const rows = input.map((a, i) => {
      const name = String(a.name ?? "").trim();
      if (name.length < 2) throw new BadRequestException(`Activity ${i + 1} needs a name`);
      if (name.length > 60) throw new BadRequestException(`"${name}" is longer than 60 characters`);
      // Refused by name rather than collapsed silently: two rows called
      // Assembly is somebody having typed it twice, and the unique key would
      // reject the second insert with a message about a constraint.
      const key = name.toLowerCase();
      if (seen.has(key)) throw new BadRequestException(`"${name}" is listed twice`);
      seen.add(key);
      if (a.placement !== "before_first" && a.placement !== "after_last") {
        throw new BadRequestException(`"${name}" must be before the first period or after the last`);
      }
      const durationMins = toInt(a.durationMins, "durationMins");
      if (durationMins < 1 || durationMins > 120) {
        throw new BadRequestException(`"${name}" must be between 1 and 120 minutes`);
      }
      const days = Array.isArray(a.days) && a.days.length > 0
        ? a.days.map((d: unknown) => toInt(d, "days[]"))
        : (config.workingDays as number[]);
      return {
        timetableConfigId: configId,
        schoolId: req.user.schoolId,
        name,
        placement: a.placement as "before_first" | "after_last",
        durationMins,
        days,
        teacherId: a.teacherId != null ? toInt(a.teacherId, "teacherId") : null,
        roomId: a.roomId != null ? toInt(a.roomId, "roomId") : null,
        sortOrder: a.sortOrder != null ? toInt(a.sortOrder, "sortOrder") : i,
        isActive: a.isActive === false ? false : true,
      };
    });

    await this.prisma.$transaction([
      this.prisma.dailyActivity.deleteMany({ where: { timetableConfigId: configId } }),
      ...(rows.length > 0 ? [this.prisma.dailyActivity.createMany({ data: rows })] : []),
    ]);

    // Rebuild the day from the config it already has plus the activities it
    // now has. Everything but `activities` is read back rather than taken from
    // the request: this endpoint is about activities, and letting it carry a
    // period count would make it a second way to set the week.
    const built = buildPeriodRows({
      startTime: config.startTime,
      periodsPerDay: config.periodsPerDay,
      periodDurationMins: config.periodDurationMins,
      hasZeroPeriod: config.hasZeroPeriod,
      zeroPeriodDurationMins: config.zeroPeriodDurationMins,
      breaks: await this.breaksFor(configId),
      extraPeriodsPerDay: config.extraPeriodsPerDay,
      extraPeriodDurationMins: config.extraPeriodDurationMins,
      activities: await this.activitiesFor(configId),
    });
    await this.prisma.$transaction([
      this.prisma.period.deleteMany({ where: { timetableConfigId: configId } }),
      this.prisma.period.createMany({
        data: built.rows.map((r) => ({ ...r, timetableConfigId: configId, schoolId: req.user.schoolId })),
      }),
      this.prisma.timetableConfig.update({ where: { id: configId }, data: { endTime: built.endTime } }),
    ]);
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true, count: rows.length, endTime: built.endTime };
  }

  /**
   * The breaks currently in the period rows, back as a spec.
   *
   * `periods` is the only record of them — there is no `breaks` table — so a
   * rebuild that did not read them back would quietly delete every break in
   * the school the first time somebody saved an assembly.
   */
  private async breaksFor(configId: number) {
    const rows = await this.prisma.period.findMany({
      where: { timetableConfigId: configId },
      orderBy: { sortOrder: "asc" },
    });
    const out: Array<{ afterPeriod: number; name: string; durationMins: number }> = [];
    let lastNumbered = 0;
    for (const p of rows) {
      if (p.isActivity || p.isExtra) continue;
      if (p.periodNumber !== null && p.periodNumber > 0) { lastNumbered = p.periodNumber; continue; }
      if (!p.isBreak) continue;
      const [sh, sm] = p.startTime.split(":").map(Number);
      const [eh, em] = p.endTime.split(":").map(Number);
      out.push({
        afterPeriod: lastNumbered,
        name: p.breakName ?? "Break",
        durationMins: (eh * 60 + em) - (sh * 60 + sm),
      });
    }
    return out;
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
