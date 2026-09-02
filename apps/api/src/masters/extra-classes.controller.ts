import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { CacheKeysService } from "../redis/cache-keys.service";
import { EventsGateway } from "../events/events.gateway";
import { requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";
import { assertCanTeach } from "./teacher-scope.util";

/**
 * §18 — extra and guest classes.
 *
 * An extra class is remedial or revision teaching that sits **outside** the
 * timetable the solver builds: a school whose grid is already full has no
 * spare period to give one, so they run in the config's extra window (the
 * periods appended after the teaching day) and never compete with the
 * curriculum for a slot.
 *
 * They are stored as ordinary `timetable_slots` rows with `source = 'extra'`,
 * which is the whole point: the same three unique keys that stop a teacher
 * being double-booked in a normal lesson stop it here too, and every grid,
 * report and substitute plan already reads that table. A separate store would
 * have meant a second set of conflict rules that could disagree with the first.
 *
 * They are placed by hand rather than solved. An extra class is a specific
 * arrangement — this teacher, this group, this slot — and there is nothing for
 * a search to decide.
 */
@Controller("extra-classes")
@RequirePermission(PERMISSIONS.TIMETABLE_EDIT)
export class ExtraClassesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: CacheKeysService,
    private readonly events: EventsGateway,
  ) {}

  @Get()
  async list(@Query("configId") configIdQ?: string) {
    const where = configIdQ ? { timetableConfigId: toInt(configIdQ, "configId") } : {};
    const rows = await this.prisma.extraClass.findMany({
      where,
      include: {
        classSection: { include: { class: true, section: true } },
        subject: true,
        teacher: true,
        room: true,
      },
      orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
    });
    return rows.map((x) => ({
      id: x.id,
      timetableConfigId: x.timetableConfigId,
      classSectionId: x.classSectionId,
      classSectionLabel: `${x.classSection.class.name}-${x.classSection.section.name}`,
      subjectId: x.subjectId,
      subjectName: x.subject.name,
      teacherId: x.teacherId,
      teacherName: x.teacher.name,
      employmentType: x.teacher.employmentType,
      roomId: x.roomId,
      roomName: x.room?.name ?? null,
      dayOfWeek: x.dayOfWeek,
      periodNumber: x.periodNumber,
      reason: x.reason,
      effectiveFrom: x.effectiveFrom,
      effectiveTo: x.effectiveTo,
    }));
  }

  /** The cells an extra class may be put in, for the create form. */
  @Get("window")
  async window(@Query("configId") configIdQ: string) {
    const configId = toInt(configIdQ, "configId");
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId },
      include: { periods: { where: { isExtra: true }, orderBy: { sortOrder: "asc" } } },
    });
    if (!config) throw new BadRequestException("Timetable config not found");
    return {
      days: [...((config.workingDays as number[]) ?? []), ...((config.extraDays as number[]) ?? [])],
      periods: config.periods.map((p) => ({
        periodNumber: p.periodNumber,
        startTime: p.startTime,
        endTime: p.endTime,
      })),
    };
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["timetableConfigId", "classSectionId", "subjectId", "teacherId", "dayOfWeek", "periodNumber"]);
    const configId = toInt(body.timetableConfigId, "timetableConfigId");
    const classSectionId = toInt(body.classSectionId, "classSectionId");
    const teacherId = toInt(body.teacherId, "teacherId");
    const dayOfWeek = toInt(body.dayOfWeek, "dayOfWeek");
    const periodNumber = toInt(body.periodNumber, "periodNumber");
    const roomId = body.roomId != null ? toInt(body.roomId, "roomId") : null;

    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId },
      include: { periods: true },
    });
    if (!config) throw new BadRequestException("Timetable config not found");

    // The window, not the teaching day. A school at 40/40 has no free regular
    // period, and letting an extra class take one would silently displace a
    // lesson the Feasibility Engine has already proved must exist.
    const slot = config.periods.find((p) => p.periodNumber === periodNumber);
    if (!slot || !slot.isExtra) {
      const window = config.periods.filter((p) => p.isExtra).map((p) => p.periodNumber).join(", ");
      throw new BadRequestException(
        window
          ? `Period ${periodNumber} is part of the teaching day. Extra classes run in the extra window — periods ${window}.`
          : `${config.name} has no extra-class window yet. Add extra periods to it in Setup → Timetable Structure first.`,
      );
    }
    const days = [...((config.workingDays as number[]) ?? []), ...((config.extraDays as number[]) ?? [])];
    if (!days.includes(dayOfWeek)) {
      throw new BadRequestException(`${config.name} does not run on day ${dayOfWeek}.`);
    }

    // Scope still applies — a primary teacher does not take a Class 12 revision
    // class. Guests are the exception this whole screen exists for.
    await assertCanTeach(this.prisma, teacherId, [classSectionId], {
      allowGuest: true,
      what: "this extra class",
    });

    const created = await uniq(async () => {
      const row = await this.prisma.extraClass.create({
        data: {
          schoolId: req.user.schoolId,
          timetableConfigId: configId,
          classSectionId,
          subjectId: toInt(body.subjectId, "subjectId"),
          teacherId,
          roomId,
          dayOfWeek,
          periodNumber,
          reason: body.reason ? String(body.reason) : null,
          effectiveFrom: body.effectiveFrom ? new Date(`${body.effectiveFrom}T00:00:00.000Z`) : null,
          effectiveTo: body.effectiveTo ? new Date(`${body.effectiveTo}T00:00:00.000Z`) : null,
          createdBy: req.user.sub ?? null,
        },
      });
      // The slot is what actually reserves the cell, in both draft and
      // published, so an extra class is visible whichever the school is
      // looking at — and is guarded by uq_teacher_slot / uq_room_slot in both.
      for (const status of ["draft", "published"] as const) {
        await this.prisma.timetableSlot.create({
          data: {
            schoolId: req.user.schoolId,
            timetableConfigId: configId,
            status,
            classSectionId,
            dayOfWeek,
            periodNumber,
            subjectId: toInt(body.subjectId, "subjectId"),
            teacherId,
            roomId,
            teacherOccupancyKey: `T-${teacherId}`,
            source: "extra",
          },
        });
      }
      return row;
    }, "Extra class");

    await this.invalidate(configId);
    return created;
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const extraId = toInt(id, "id");
    const row = await this.prisma.extraClass.findFirst({ where: { id: extraId } });
    if (!row) throw new BadRequestException(`Extra class ${extraId} not found`);
    await this.prisma.$transaction([
      this.prisma.timetableSlot.deleteMany({
        where: {
          timetableConfigId: row.timetableConfigId,
          classSectionId: row.classSectionId,
          dayOfWeek: row.dayOfWeek,
          periodNumber: row.periodNumber,
          source: "extra",
        },
      }),
      this.prisma.extraClass.delete({ where: { id: extraId } }),
    ]);
    await this.invalidate(row.timetableConfigId);
    return { ok: true };
  }

  /** An extra class writes *published* rows, so the class's and the teacher's
   *  report aggregates are stale the moment one is scheduled or cancelled. */
  private async invalidate(configId: number) {
    await this.keys.invalidateTimetable(configId);
    this.events.emitToCurrentSchool("slots:changed", { configId });
  }
}
