import { BadRequestException, Body, Controller, Delete, Get, Logger, NotFoundException, Param, Post, Put, Query, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { assertFixedLessonsValid, type FixedLessonInput } from "./fixed-lessons";
import { ReadinessService } from "../readiness/readiness.service";
import { ResourceGroupService, type MoveTarget } from "../groups/resource-group.service";
import { ValidityService, type Window } from "../validity/validity.service";
import { CacheKeysService } from "../redis/cache-keys.service";
import { CloneService } from "./clone.service";
import { planDeletion, runDeletion } from "./config-deletion";
import { planReset, runReset } from "./allocation-reset";
import { planCellDelete, runCellDelete } from "./allocation-cell";
import { breaksFromRows, buildPeriodRows } from "./structure.util";
import { requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";
import { FreezeService } from "../freeze/freeze.service";


/**
 * §30.5 — the window off a request body, in one place.
 *
 * An absent key and an explicit `null` both mean "no bound": a school clearing
 * an end date is saying the timetable runs to the end of the session, and a
 * screen that sends `null` for an empty input must mean the same thing as one
 * that omits it. An unparseable date is refused rather than silently dropped,
 * because a dropped bound reads on screen as "the whole session" — the widest
 * possible answer arrived at by accident.
 */
function readWindow(body: any): Window {
  const one = (v: unknown, field: string): Date | null => {
    if (v === undefined || v === null || v === "") return null;
    const d = new Date(`${String(v)}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} is not a date`);
    return d;
  };
  return { from: one(body.effectiveFrom, "effectiveFrom"), to: one(body.effectiveTo, "effectiveTo") };
}


/**
 * §30 — the destination off a request, in one place so the GET and the POST
 * cannot read it differently.
 *
 * Anything that is not the word "individual" is grouped, which is the safe
 * reading: a typo lands a timetable in the session's shared pool, where it
 * would have been anyway, rather than silently minting a pool of one.
 */
function readTarget(mode: unknown, groupId: unknown): MoveTarget {
  if (mode === "individual") return { mode: "individual" };
  const id = groupId === undefined || groupId === null || groupId === "" ? undefined : Number(groupId);
  if (id !== undefined && (!Number.isInteger(id) || id <= 0)) {
    throw new BadRequestException("resourceGroupId must be a timetable group id");
  }
  return { mode: "grouped", resourceGroupId: id };
}

@Controller("timetable-configs")
export class TimetableConfigsController {
  private readonly logger = new Logger(TimetableConfigsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
    private readonly groups: ResourceGroupService,
    private readonly validity: ValidityService,
    private readonly clone: CloneService,
    private readonly keys: CacheKeysService,
    private readonly freeze: FreezeService,
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
        resourceGroup: { select: { id: true, name: true, mode: true } },
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
      // §30 — the pool, and when this timetable applies. Both flow through
      // `ConfigContext` to eighteen screens, which is what "show the timetable
      // period everywhere" costs once the summary carries it.
      resourceGroupId: c.resourceGroupId,
      resourceGroupName: c.resourceGroup.name,
      // §30.1 — "individual" means this timetable stands alone: its own cohort
      // rows, its own Readiness, nothing of anybody else's counted against it.
      resourceMode: c.resourceGroup.mode,
      effectiveFrom: c.effectiveFrom ? c.effectiveFrom.toISOString().slice(0, 10) : null,
      effectiveTo: c.effectiveTo ? c.effectiveTo.toISOString().slice(0, 10) : null,
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
      // §29.1 — served with the config, so every screen reads one answer to
      // "is this settled?" rather than each asking a different endpoint. The
      // UI uses it to explain and to disable; the server is still the
      // authority, and refuses whether or not a button was greyed out.
      frozenAt: c.frozenAt,
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
    // §30 — the session's shared pool. Choosing an individual one is stage 4;
    // until then every timetable joins the pool it would have been in anyway,
    // which is what keeps this stage invisible.
    const yearId = toInt(body.academicYearId, "academicYearId");
    /*
      §30.1 — grouped by default, which is what every timetable was before this
      existed. `individual` gets a pool of its own: its own cohort rows, its own
      Readiness, and nothing of anybody else's counted against it.
    */
    const individual = body.mode === "individual";
    /*
      `resourceGroupId` names a pool to JOIN. Verified to belong to this session
      before it is used — a pool id is not a capability, the same rule §25.2
      states for a term id — and then asked whether it admits another timetable,
      which is where "one wing only" is enforced.
    */
    let resourceGroupId: number;
    if (body.resourceGroupId != null) {
      const joinId = toInt(body.resourceGroupId, "resourceGroupId");
      const pool = await this.prisma.timetableGroup.findUnique({
        where: { id: joinId }, select: { id: true, academicYearId: true },
      });
      if (!pool || pool.academicYearId !== yearId) {
        throw new BadRequestException("That resource group does not belong to this session.");
      }
      resourceGroupId = pool.id;
    } else {
      resourceGroupId = individual
        ? await this.groups.createIndividual(yearId, String(body.name))
        : await this.groups.defaultFor(yearId);
    }
    await this.groups.assertAdmits(resourceGroupId);
    // §30.5 — when this timetable applies. Absent means the whole session,
    // which is every school before this feature.
    const window = readWindow(body);
    await this.validity.assertWindowValid(yearId, window);
    const created = await uniq(
      () =>
        this.prisma.timetableConfig.create({
          data: {
            schoolId: req.user.schoolId,
            academicYearId: yearId,
            resourceGroupId,
            effectiveFrom: window.from,
            effectiveTo: window.to,
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
    const configId = toInt(id, "id");
    /*
      §30.5 — re-dating is the OTHER way to create the overlap publishing
      refuses, so it is checked here too. Only when the dates are actually in
      the request: an update that renames a timetable must not have to satisfy a
      rule about dates it did not touch.
    */
    const dated = body.effectiveFrom !== undefined || body.effectiveTo !== undefined;
    let window: Window | null = null;
    if (dated) {
      const existing = await this.prisma.timetableConfig.findUnique({
        where: { id: configId }, select: { academicYearId: true },
      });
      if (!existing) throw new BadRequestException("Timetable not found");
      window = readWindow(body);
      await this.validity.assertWindowValid(existing.academicYearId, window);
      // Asked of the PROPOSED window, before anything is written: the
      // alternative is storing it, asking, and rolling back — three writes to
      // answer a question, with a window briefly applied that the school is
      // about to be told it cannot have.
      await this.validity.assertPublishable(configId, window);
    }
    const updated = await uniq(
      () =>
        this.prisma.timetableConfig.update({
          where: { id: configId },
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
            ...(window ? { effectiveFrom: window.from, effectiveTo: window.to } : {}),
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
    // §29.1 — `PUT /structure` rewrites the period grid wholesale (§27), so on
    // a published week it changes when every lesson in the school happens.
    await this.freeze.assertConfigs([configId], "the school week");
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
    // §29.1. Note the preview above is deliberately NOT guarded: it writes
    // nothing, and a school is entitled to see what a reset would cost before
    // deciding whether to unfreeze.
    await this.freeze.assertConfigs([configId], "the allocation");
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
    await this.freeze.assertConfigs([configId], "what a class is taught");
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
    // §28.3 activities produce a band in `periods`, so they move the printed
    // start of the day for every class in the wing.
    await this.freeze.assertConfigs([configId], "the school day");

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
    // §34.5 — one definition, in `structure.util`, shared with the per-day
    // clock. Two copies would be free to disagree about which rows count as a
    // break and which period each one follows.
    return breaksFromRows(rows);
  }


  /**
   * §30 stage 5 — what moving this timetable to another resource pool would do.
   *
   * A GET, because it is a question. The same plan is recomputed at apply, so
   * this can never be the list of writes (§21) — it is what the confirmation
   * shows, and nothing more.
   */
  @Get(":id/resource-group/preview")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async previewMove(
    @Param("id") id: string,
    @Query("mode") mode?: string,
    @Query("resourceGroupId") groupId?: string,
  ) {
    return this.groups.planMove(toInt(id, "id"), readTarget(mode, groupId));
  }

  /**
   * Move it.
   *
   * Deliberately NOT freeze-guarded (§30 decision 4): a pool change alters what
   * is *validated* and never what is placed — no slot moves — which is the same
   * argument §4.7 availability is exempt on. It is recorded and Readiness is
   * dropped immediately, so a blocker it creates shows up now rather than at
   * the next Generate with nobody remembering what changed.
   */
  @Post(":id/resource-group")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async move(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const configId = toInt(id, "id");
    const done = await this.groups.applyMove(
      configId, req.user.sub, readTarget(body?.mode, body?.resourceGroupId),
    );
    await this.readiness.invalidate(req.user.schoolId);
    return done;
  }

  /**
   * §3.10 — scope class-sections to this config. A section already claimed by a
   * DIFFERENT config is rejected, naming that timetable.
   */
  @Put(":id/class-sections")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async setClassSections(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const configId = toInt(id, "id");
    await this.freeze.assertConfigs([configId], "which classes this timetable covers");
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
    /*
      §30 — and it must be a cohort row from THIS timetable's own pool.

      The check above only catches a section another *timetable* holds; a
      section sitting unattached in a different pool has `timetable_config_id`
      NULL and would sail through it. Attaching one would put a row in a pool
      its own timetable is not in — precisely the drift `ResourceGroupService`
      exists to prevent, arrived at through a legitimate screen.

      It cannot fire today, because nothing creates a second pool until stage 4.
      It is written now for that reason: a guard added at the same time as the
      thing it guards is a guard nobody has yet had a chance to need.
    */
    const foreign = await this.prisma.classSection.findMany({
      where: { id: { in: ids }, resourceGroup: { configs: { none: { id: configId } } } },
      include: { class: true, section: true, resourceGroup: { select: { name: true } } },
    });
    if (foreign.length > 0) {
      throw new BadRequestException(
        `Not in this timetable's resource group: ${foreign
          .map((c) => `${c.class.name}-${c.section.name} (${c.resourceGroup.name})`)
          .join(", ")} — a class-section belongs to one group, and a timetable can only cover its own`,
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
    await this.freeze.assertConfigs([configId], "this timetable");
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

  /**
   * §29.1 — freeze a published timetable.
   *
   * Requires a LIVE publication, and that is the whole precondition worth
   * having: freezing a timetable nobody is teaching from protects nothing and
   * would only lock the school out of its own planning. The message says which
   * of the two is missing rather than a flat refusal.
   *
   * `timetable.publish`, not a permission of its own: whoever may put a week on
   * the wall may declare it settled. A new permission would need a §15.2
   * registry entry and a decision, per role, for every school that already
   * exists — paid for a distinction nobody has asked for.
   *
   * Idempotent. Freezing a frozen timetable keeps the original timestamp: the
   * answer to "when was this settled?" must not be rewritten by somebody
   * pressing the button twice.
   */
  @Post(":id/freeze")
  @RequirePermission(PERMISSIONS.TIMETABLE_PUBLISH)
  async freezeConfig(@Req() req: AuthedRequest, @Param("id") id: string) {
    const configId = toInt(id, "id");
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId },
      select: { id: true, name: true, frozenAt: true },
    });
    if (!config) throw new NotFoundException(`Timetable ${configId} not found`);
    if (config.frozenAt) return { ok: true, frozenAt: config.frozenAt, alreadyFrozen: true };

    const live = await this.prisma.timetablePublication.findFirst({
      where: { timetableConfigId: configId, withdrawnAt: null },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    if (!live) {
      throw new BadRequestException(
        `${config.name} has nothing published, so there is no settled week to freeze. ` +
          `Publish it first — freezing protects what is on the wall.`,
      );
    }

    const updated = await this.prisma.timetableConfig.update({
      where: { id: configId },
      data: { frozenAt: new Date(), frozenById: req.user.sub },
      select: { frozenAt: true },
    });
    this.logger.log(`froze timetable ${configId} (${config.name}) at v${live.version}`);
    return { ok: true, frozenAt: updated.frozenAt, version: live.version };
  }

  /**
   * §29.1 — unfreeze, the escape hatch.
   *
   * Deliberately not a staffing change: this is "we are re-planning this
   * timetable", and it must exist or a school that froze by mistake has no way
   * back. §29.2's scoped thaw is the narrow tool for moving one teacher's
   * classes; this is the wide one, and it is logged for that reason.
   */
  @Post(":id/unfreeze")
  @RequirePermission(PERMISSIONS.TIMETABLE_PUBLISH)
  async unfreezeConfig(@Req() req: AuthedRequest, @Param("id") id: string) {
    const configId = toInt(id, "id");
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId },
      select: { id: true, name: true, frozenAt: true },
    });
    if (!config) throw new NotFoundException(`Timetable ${configId} not found`);
    // Not an error: asking twice is the same answer, and a 400 here would make
    // a double-click look like a failure.
    if (!config.frozenAt) return { ok: true, frozenAt: null, alreadyThawed: true };

    await this.prisma.timetableConfig.update({
      where: { id: configId },
      data: { frozenAt: null, frozenById: null },
    });
    this.logger.log(`unfroze timetable ${configId} (${config.name})`);
    return { ok: true, frozenAt: null };
  }

  /**
   * §32 — which subjects this timetable teaches.
   *
   * `selected: null` means **not stated**, which behaves as all (invariant 7)
   * — not the same as `[]`, and the two are returned differently so a client
   * cannot collapse them. Every subject the school has comes back beside it,
   * because the question the screen asks is "which of these?" and fetching the
   * master list separately would let the two lists disagree about what exists.
   */
  @Get(":id/subjects")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async subjectsFor(@Param("id") id: string) {
    const configId = toInt(id, "id");
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId }, select: { id: true, schoolId: true },
    });
    // §17.8 — another school's id is a 404, never an empty list that reads as
    // "this timetable teaches nothing".
    if (!config) throw new NotFoundException("Timetable config not found");

    const [all, chosen] = await Promise.all([
      this.prisma.subject.findMany({
        where: { schoolId: config.schoolId },
        select: { id: true, name: true, code: true },
        orderBy: { name: "asc" },
      }),
      this.prisma.timetableSubject.findMany({
        where: { timetableConfigId: configId }, select: { subjectId: true },
      }),
    ]);
    return {
      subjects: all,
      selected: chosen.length === 0 ? null : chosen.map((r) => r.subjectId),
    };
  }

  /**
   * Replace the selection.
   *
   * **Deliberately not freeze-guarded** (§29.1). Its "not frozen" list already
   * names subjects, and this writes no slot: a frozen timetable's published
   * week is untouched by it. What it changes is what the NEXT generation would
   * produce, which is the same thing editing the curriculum does, and refusing
   * that would leave a school unable to record a decision it has already taken.
   *
   * An empty array is accepted and means "no narrowing" — the same as never
   * having stated one. See `applySubjectSelection` for why "all of them" is
   * stored as nothing rather than as a row per subject.
   */
  @Put(":id/subjects")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async setSubjectsFor(@Param("id") id: string, @Body() body: { subjectIds?: unknown }) {
    const configId = toInt(id, "id");
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId }, select: { id: true, schoolId: true, name: true },
    });
    if (!config) throw new NotFoundException("Timetable config not found");

    const asked = Array.isArray(body?.subjectIds) ? body.subjectIds.map(Number).filter(Number.isFinite) : [];
    // Ours only. A subject id from another school would otherwise be stored
    // against our config and read back by the snapshot as a subject we teach.
    const mine = await this.prisma.subject.findMany({
      where: { schoolId: config.schoolId, id: { in: asked } }, select: { id: true },
    });
    const total = await this.prisma.subject.count({ where: { schoolId: config.schoolId } });
    const ids = mine.map((s) => s.id);
    const narrows = ids.length > 0 && ids.length < total;

    await this.prisma.$transaction(async (tx) => {
      await tx.timetableSubject.deleteMany({ where: { timetableConfigId: configId } });
      if (narrows) {
        await tx.timetableSubject.createMany({
          data: ids.map((subjectId) => ({ timetableConfigId: configId, subjectId, schoolId: config.schoolId })),
        });
      }
    });
    // §22 — swept by PREFIX. The snapshot, `/context` and every per-draft copy
    // are all keyed under this config, and the subject list changes all of them.
    await this.keys.invalidateTimetable(configId);
    this.logger.log(`timetable ${configId} (${config.name}) now teaches ${narrows ? ids.length : "all"} subjects`);
    return { ok: true, selected: narrows ? ids : null };
  }

  /**
   * §34 — the weekdays that run a shape of their own.
   *
   * Returns one row per WORKING day, each carrying the shape it actually has —
   * its own where it has one, the config's where it does not. The client never
   * has to know which, and `full` says so explicitly rather than leaving it to
   * be inferred from two numbers being equal.
   */
  @Get(":id/day-shapes")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async dayShapes(@Param("id") id: string) {
    const configId = toInt(id, "id");
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId },
      select: { id: true, workingDays: true, periodsPerDay: true, periodDurationMins: true },
    });
    // §17.8 — another school's id is a 404, never an empty week.
    if (!config) throw new NotFoundException("Timetable config not found");

    const rows = await this.prisma.timetableDayShape.findMany({
      where: { timetableConfigId: configId },
    });
    const own = new Map(rows.map((r) => [r.dayOfWeek, r]));
    const days = ((config.workingDays as number[]) ?? []).slice().sort((a, b) => a - b);

    return {
      periodsPerDay: config.periodsPerDay,
      periodDurationMins: config.periodDurationMins,
      days: days.map((d) => {
        const r = own.get(d);
        return {
          day: d,
          periodsPerDay: r?.periodsPerDay ?? config.periodsPerDay,
          periodDurationMins: r?.periodDurationMins ?? config.periodDurationMins,
          /** Whether this day runs the same shape as the rest of the week. */
          full: !r,
        };
      }),
    };
  }

  /**
   * Give a weekday its own shape, or put it back on the week's.
   *
   * `full: true` **deletes the row** rather than storing the config's numbers:
   * "the same as every other day" and "not stated" are one answer (invariant
   * 7), and storing the copy would freeze today's period count into a day that
   * should follow the week when the week changes.
   *
   * Refused for a day the timetable does not work — a shape for a day nobody
   * teaches is a row the solver would never read and the screen would never
   * show, and accepting it silently is how a school comes to believe it has
   * configured a Saturday it does not run.
   *
   * Not freeze-guarded, matching §29.1's treatment of things that shape a
   * future generation rather than the published week: it writes no slot.
   */
  @Put(":id/day-shapes")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async setDayShape(
    @Param("id") id: string,
    @Body() body: { day?: unknown; full?: unknown; periodsPerDay?: unknown; periodDurationMins?: unknown },
  ) {
    const configId = toInt(id, "id");
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId },
      select: { id: true, schoolId: true, name: true, workingDays: true, periodsPerDay: true },
    });
    if (!config) throw new NotFoundException("Timetable config not found");

    const day = toInt(body?.day, "day");
    const working = ((config.workingDays as number[]) ?? []);
    if (!working.includes(day)) {
      throw new BadRequestException(
        `This timetable does not run on day ${day} — add it to the working days first.`,
      );
    }

    if (body?.full === true) {
      await this.prisma.timetableDayShape.deleteMany({ where: { timetableConfigId: configId, dayOfWeek: day } });
      await this.keys.invalidateTimetable(configId);
      return { ok: true, day, full: true };
    }

    const periodsPerDay = toInt(body?.periodsPerDay, "periodsPerDay");
    const periodDurationMins = toInt(body?.periodDurationMins, "periodDurationMins");
    /*
      Bounded to the same range the week's own fields are, and for the same
      reason: these numbers become the ceiling every curriculum entry is
      checked against, so a zero or a negative is not a smaller week, it is a
      week nothing can be placed in.
    */
    if (periodsPerDay < 1 || periodsPerDay > 14) {
      throw new BadRequestException("A day has between 1 and 14 periods.");
    }
    if (periodDurationMins < 20 || periodDurationMins > 120) {
      throw new BadRequestException("A period is between 20 and 120 minutes.");
    }

    await this.prisma.timetableDayShape.upsert({
      where: { timetableConfigId_dayOfWeek: { timetableConfigId: configId, dayOfWeek: day } },
      create: { timetableConfigId: configId, dayOfWeek: day, periodsPerDay, periodDurationMins, schoolId: config.schoolId },
      update: { periodsPerDay, periodDurationMins },
    });
    // §22 — swept by prefix: the snapshot, `/context` and every per-draft copy
    // are keyed under this config, and the week's shape changes all of them.
    await this.keys.invalidateTimetable(configId);
    this.logger.log(`timetable ${configId} (${config.name}): day ${day} runs ${periodsPerDay} × ${periodDurationMins} min`);
    return { ok: true, day, full: false, periodsPerDay, periodDurationMins };
  }

  /**
   * §33 — how long one lesson is, per class, in this timetable.
   *
   * Returns the classes this timetable actually teaches, each with its span in
   * base periods and the minutes that comes to. Minutes are **derived** and
   * never stored: the base duration belongs to the config (§28), so
   * `span × period_duration_mins` is the only figure that cannot drift from it.
   *
   * `allowed` is the set of lesson lengths this timetable can express — every
   * whole multiple of the base that still fits the day. Sent rather than
   * computed on the client so the divisibility rule (§33) has one author, and
   * so the form can offer a list in which no invalid value exists.
   */
  /**
   * §36 — the lessons this timetable has pinned to a cell.
   *
   * Served with everything the Whole tab needs to paint them without a second
   * round trip: the section's label, the subject's name, the teacher's stored
   * initials (§31's one definition, never re-derived) and the room's name.
   *
   * `caps` rides along because the screen has to say "3 of 6 fixed" before
   * anybody presses Save, and the cap is a CLASS fact (§27) — one number for
   * every section of the class — which a client counting rows could not know.
   */
  @Get(":id/fixed-lessons")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async fixedLessons(@Param("id") id: string) {
    const configId = toInt(id, "id");
    const config = await this.ownConfigOr404(configId);

    const rows = await this.prisma.timetableFixedLesson.findMany({
      where: { timetableConfigId: configId },
      select: {
        id: true, classSectionId: true, subjectId: true, teacherId: true, roomId: true,
        dayOfWeek: true, periodNumber: true,
        classSection: { select: { class: { select: { name: true } }, section: { select: { name: true } } } },
        subject: { select: { name: true } },
        teacher: { select: { name: true, initials: true } },
        room: { select: { name: true } },
      },
      orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
    });

    const sections = await this.prisma.classSection.findMany({
      where: { timetableConfigId: configId },
      select: { id: true, classId: true },
    });
    const caps = await this.prisma.classSubject.findMany({
      where: {
        classId: { in: [...new Set(sections.map((s) => s.classId))] },
        academicYearId: config.academicYearId,
      },
      select: { classId: true, subjectId: true, periodsPerWeek: true },
    });

    /*
      §36 — what the pickers may OFFER, decided by the server.

      A mapping is what a pin attaches to (`variables.ts` matches on
      section+subject+teacher), so the list of legal (subject, teacher) pairs
      for a section IS its mapping list — minus the two things the save
      refuses anyway: a subject an elective block already owns (§31.19) and a
      row taught as §4.8 double periods, which has no single occurrence to pin.

      Sent rather than derived on the client for the reason the Electives
      screen's teacher list is: a picker that can offer something the save
      refuses is a picker that teaches people to distrust the screen.
    */
    const mappings = await this.prisma.teacherSubjectClassSection.findMany({
      where: { classSectionId: { in: sections.map((s) => s.id) } },
      select: {
        classSectionId: true, subjectId: true, teacherId: true,
        subject: { select: { name: true } },
        teacher: { select: { name: true, initials: true, isActive: true, employmentType: true } },
      },
    });
    const blockOwned = new Set(
      (await this.prisma.electiveOption.findMany({
        where: { electiveBlock: { members: { some: { classSectionId: { in: sections.map((s) => s.id) } } } } },
        select: { subjectId: true, electiveBlock: { select: { members: { select: { classSectionId: true } } } } },
      })).flatMap((o) => o.electiveBlock.members.map((m) => `${m.classSectionId}:${o.subjectId}`)),
    );
    const classOf = new Map(sections.map((s) => [s.id, s.classId]));
    const doubled = new Set(
      (await this.prisma.classSubject.findMany({
        where: {
          classId: { in: [...new Set(sections.map((s) => s.classId))] },
          academicYearId: config.academicYearId,
          consecutiveBlockSize: { gt: 1 },
        },
        select: { classId: true, subjectId: true },
      })).map((c) => `${c.classId}:${c.subjectId}`),
    );

    return {
      options: mappings
        .filter((m) => m.teacher.isActive && m.teacher.employmentType !== "guest")
        .filter((m) => !blockOwned.has(`${m.classSectionId}:${m.subjectId}`))
        .filter((m) => !doubled.has(`${classOf.get(m.classSectionId)}:${m.subjectId}`))
        .map((m) => ({
          classSectionId: m.classSectionId,
          subjectId: m.subjectId,
          subject: m.subject.name,
          teacherId: m.teacherId,
          teacher: m.teacher.name,
          initials: m.teacher.initials,
        })),
      rooms: (await this.prisma.room.findMany({
        select: { id: true, name: true }, orderBy: { name: "asc" },
      })).map((r) => ({ id: r.id, name: r.name })),
      lessons: rows.map((r) => ({
        id: r.id,
        classSectionId: r.classSectionId,
        classSection: `${r.classSection.class.name}-${r.classSection.section.name}`,
        subjectId: r.subjectId,
        subject: r.subject.name,
        teacherId: r.teacherId,
        teacher: r.teacher.name,
        initials: r.teacher.initials,
        roomId: r.roomId,
        room: r.room?.name ?? null,
        dayOfWeek: r.dayOfWeek,
        periodNumber: r.periodNumber,
      })),
      /** The curriculum cap, per class and subject — what "3 of 6" counts against. */
      caps: caps.map((c) => ({
        classId: c.classId, subjectId: c.subjectId, periodsPerWeek: c.periodsPerWeek,
      })),
      sections: sections.map((s) => ({ id: s.id, classId: s.classId })),
    };
  }

  /**
   * §36 — replace the whole set of pins for this timetable.
   *
   * **Replace, not upsert**, because that is what a Save button means: the
   * screen holds the school's whole answer and sends it. Anything else would
   * need a second way to say "this one is gone", and a grid whose deletions
   * travel differently from its additions is a grid that loses one of them.
   *
   * Validated as ONE set before anything is written (`assertFixedLessonsValid`),
   * so two pins that are each legal alone and collide with each other are
   * refused — and refused before the delete, so a rejected save leaves the
   * school exactly what it had.
   */
  @Put(":id/fixed-lessons")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async setFixedLessons(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const configId = toInt(id, "id");
    await this.ownConfigOr404(configId);
    // §29.1 — a published week does not quietly acquire new hard constraints.
    await this.freeze.assertConfigs([configId], "the fixed lessons");

    const rows: FixedLessonInput[] = Array.isArray(body?.lessons)
      ? body.lessons.map((l: any) => ({
        classSectionId: toInt(l?.classSectionId, "classSectionId"),
        subjectId: toInt(l?.subjectId, "subjectId"),
        teacherId: toInt(l?.teacherId, "teacherId"),
        roomId: l?.roomId === null || l?.roomId === undefined || l?.roomId === ""
          ? null
          : toInt(l.roomId, "roomId"),
        dayOfWeek: toInt(l?.dayOfWeek, "dayOfWeek"),
        periodNumber: toInt(l?.periodNumber, "periodNumber"),
      }))
      : [];

    await assertFixedLessonsValid(this.prisma as never, configId, rows);

    await this.prisma.$transaction(async (tx: any) => {
      await tx.timetableFixedLesson.deleteMany({ where: { timetableConfigId: configId } });
      if (rows.length > 0) {
        await tx.timetableFixedLesson.createMany({
          data: rows.map((r) => ({
            timetableConfigId: configId,
            classSectionId: r.classSectionId,
            subjectId: r.subjectId,
            teacherId: r.teacherId,
            roomId: r.roomId ?? null,
            dayOfWeek: r.dayOfWeek,
            periodNumber: r.periodNumber,
            schoolId: req.user.schoolId,
          })),
        });
      }
    });

    /*
      A pin changes what the solver may do, so it changes what Readiness has to
      say — Check 14 reads these rows. Swept by prefix (§22) as well, because
      the Whole tab's own payload is cached per timetable.
    */
    await this.keys.invalidateTimetable(configId);
    await this.readiness.invalidate(req.user.schoolId);
    this.logger.warn(`Fixed lessons for timetable ${configId} set to ${rows.length} row(s)`);
    return { ok: true, count: rows.length };
  }

  @Get(":id/class-periods")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async classPeriods(@Param("id") id: string) {
    const configId = toInt(id, "id");
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId },
      select: { id: true, schoolId: true, periodsPerDay: true, periodDurationMins: true, startTime: true },
    });
    // §17.8 — another school's id is a 404, never an empty list that reads as
    // "this timetable teaches nobody".
    if (!config) throw new NotFoundException("Timetable config not found");

    const [sections, spans, periods] = await Promise.all([
      this.prisma.classSection.findMany({
        where: { timetableConfigId: configId },
        select: { classId: true, class: { select: { id: true, name: true, sequence: true } } },
        orderBy: [{ class: { sequence: "asc" } }],
      }),
      this.prisma.timetableClassSpan.findMany({
        where: { timetableConfigId: configId },
        select: { classId: true, span: true },
      }),
      this.prisma.period.findMany({
        where: { timetableConfigId: configId },
        select: { startTime: true, endTime: true, isBreak: true, isExtra: true, isActivity: true },
        orderBy: { sortOrder: "asc" },
      }),
    ]);

    /*
      When school closes — READ off the period rows rather than computed.

      start + periods × duration + breaks + activities is the arithmetic, and
      every one of those terms is already a row with a real end time. Adding
      them up again would be a second answer, free to disagree with the grid
      the school is looking at — and it would get §28.4 wrong, where an
      activity before the first period makes the day start EARLIER rather than
      pushing period 1 later.

      The §18 extra window is excluded: it is teaching, but it is not the
      school day, and the same exclusion is what the Matrix's fill rate makes.
    */
    const day = periods.filter((p) => !p.isExtra);
    const opensAt = day.length > 0 ? day[0].startTime : config.startTime;
    const closesAt = day.length > 0 ? day[day.length - 1].endTime : null;
    const breaks = day.filter((p) => p.isBreak).length;
    const activities = day.filter((p) => p.isActivity).length;
    const spanBy = new Map(spans.map((r) => [r.classId, Math.max(1, r.span)]));
    // One row per CLASS, not per class-section: a lesson's length is a fact
    // about the class's week (§27's rule that periods are a class fact), and
    // 5-A and 5-B are one answer shown twice.
    const classes = [...new Map(sections.map((cs) => [cs.classId, cs.class])).values()];

    return {
      baseDurationMins: config.periodDurationMins,
      periodsPerDay: config.periodsPerDay,
      startTime: config.startTime,
      /**
       * §33 — when the day opens and closes, and what is in it besides
       * lessons. One answer for every class: the grid is shared, which is the
       * whole point of expressing a longer lesson as a double period rather
       * than as a second clock.
       */
      opensAt,
      closesAt,
      breaks,
      activities,
      /** Every lesson length this grid can express, longest last. */
      allowed: Array.from({ length: config.periodsPerDay }, (_, i) => i + 1)
        .map((span) => ({ span, mins: span * config.periodDurationMins })),
      classes: classes.map((c) => {
        const span = spanBy.get(c.id) ?? 1;
        return {
          id: c.id,
          name: c.name,
          span,
          durationMins: span * config.periodDurationMins,
          /** How many lessons of that length the day holds. */
          lessonsPerDay: Math.floor(config.periodsPerDay / span),
          /**
           * The day does not divide evenly by this span — the last lesson
           * would run past the end of the grid. Reported rather than refused:
           * it is a real state while somebody is mid-edit, and the screen says
           * so where the number is.
           */
          leftover: config.periodsPerDay % span,
        };
      }),
    };
  }

  /**
   * Set one class's lesson length.
   *
   * **A span, never minutes.** The solver wants a block size in base periods,
   * and storing minutes would re-derive it at every call site and go stale the
   * moment the config's own duration changed. See the model's own note.
   *
   * Span 1 deletes the row rather than storing it: "not stated" and "one base
   * period" are the same answer (invariant 7), and storing the absence keeps
   * the table a record of what was *changed* — so a school that never touches
   * this screen has no rows at all.
   *
   * Deliberately not freeze-guarded, matching §29.1's treatment of the things
   * that shape a future generation rather than the published week: it writes no
   * slot.
   */
  @Put(":id/class-periods")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async setClassPeriod(@Param("id") id: string, @Body() body: { classId?: unknown; span?: unknown }) {
    const configId = toInt(id, "id");
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId },
      select: { id: true, schoolId: true, name: true, periodsPerDay: true },
    });
    if (!config) throw new NotFoundException("Timetable config not found");

    const classId = toInt(body?.classId, "classId");
    const span = toInt(body?.span, "span");
    if (span < 1 || span > config.periodsPerDay) {
      throw new BadRequestException(
        `A lesson is between 1 and ${config.periodsPerDay} periods long — this timetable's day is ${config.periodsPerDay} periods.`,
      );
    }
    // Ours, and actually taught here. A class id from another school would
    // otherwise be stored against our config and read back by the snapshot.
    const taught = await this.prisma.classSection.findFirst({
      where: { timetableConfigId: configId, classId }, select: { id: true },
    });
    if (!taught) throw new NotFoundException(`This timetable does not teach class ${classId}`);

    if (span === 1) {
      await this.prisma.timetableClassSpan.deleteMany({ where: { timetableConfigId: configId, classId } });
    } else {
      await this.prisma.timetableClassSpan.upsert({
        where: { timetableConfigId_classId: { timetableConfigId: configId, classId } },
        create: { timetableConfigId: configId, classId, span, schoolId: config.schoolId },
        update: { span },
      });
    }
    // §22 — swept by prefix: the snapshot, `/context` and every per-draft copy
    // are keyed under this config, and a lesson's length changes all of them.
    await this.keys.invalidateTimetable(configId);
    this.logger.log(`timetable ${configId} (${config.name}): class ${classId} lessons span ${span} period(s)`);
    return { ok: true, classId, span };
  }

  /** Readiness Dashboard data (§4) — Feasibility Engine over the live DB. */
  @Get(":id/readiness")
  @RequirePermission(PERMISSIONS.TIMETABLE_GENERATE)
  readiness_(@Param("id") id: string) {
    return this.readiness.getReadiness(toInt(id, "id"));
  }
}
