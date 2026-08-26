import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { del, requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";

/**
 * Rooms (§19).
 *
 * Two mappings are set here, both of which the solver now honours:
 *
 *   - **Home room for a class-section.** In most schools Class 1-A sits in one
 *     room all week. That was recordable before Phase 12 and had no effect —
 *     the solver wrote `room_id = NULL` on every ordinary lesson, so a school
 *     that carefully filled it in got a timetable that never mentioned it.
 *   - **Which subjects a lab teaches.** A free physics lab is not a place to
 *     hold a biology period. A lab with no subjects listed is a *general* lab
 *     and still serves any lab subject, which is what every school had before.
 *
 * `class_sections.home_room_id` stays the single source of truth for the first;
 * this screen simply writes it from the other side, because "which room is this
 * class in" and "which class is in this room" are the same fact and a school
 * thinks of it either way round.
 */
@Controller("rooms")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class RoomsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    const rooms = await this.prisma.room.findMany({
      where: { schoolId: req.user.schoolId },
      include: {
        subjects: { include: { subject: true } },
        homeRoomOf: { include: { class: true, section: true } },
      },
      orderBy: { name: "asc" },
    });
    return rooms.map((r) => ({
      id: r.id,
      name: r.name,
      capacity: r.capacity,
      roomType: r.roomType,
      isShared: r.isShared,
      schoolId: r.schoolId,
      /** §19: the subjects this room is set up for — labs, mostly. */
      subjectIds: r.subjects.map((x) => x.subjectId),
      subjectNames: r.subjects.map((x) => x.subject.name),
      /** §19: the class-sections that sit here all week. */
      homeForIds: r.homeRoomOf.map((cs) => cs.id),
      homeForLabels: r.homeRoomOf.map((cs) => `${cs.class.name}-${cs.section.name}`),
    }));
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["name"]);
    const created = await uniq(
      () =>
        this.prisma.room.create({
          data: {
            schoolId: req.user.schoolId,
            name: String(body.name),
            capacity: body.capacity != null ? toInt(body.capacity, "capacity") : null,
            roomType: body.roomType ?? "classroom",
            isShared: Boolean(body.isShared ?? body.roomType === "lab"),
            subjects: {
              create: this.subjectIds(body).map((subjectId) => ({ subjectId, schoolId: req.user.schoolId })),
            },
          },
        }),
      `Room '${body.name}'`,
    );
    await this.setHomeFor(req, created.id, body);
    await this.readiness.invalidate(req.user.schoolId);
    return created;
  }

  @Put(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const roomId = toInt(id, "id");
    const updated = await uniq(
      () =>
        this.prisma.room.update({
          where: { id: roomId },
          data: {
            ...(body.name !== undefined ? { name: String(body.name) } : {}),
            ...(body.capacity !== undefined
              ? { capacity: body.capacity === null ? null : toInt(body.capacity, "capacity") }
              : {}),
            ...(body.roomType !== undefined ? { roomType: body.roomType } : {}),
            ...(body.isShared !== undefined ? { isShared: Boolean(body.isShared) } : {}),
          },
        }),
      "Room",
    );

    // Both lists are replaced wholesale when sent and left alone when not, so a
    // rename cannot silently unassign a room.
    if (Array.isArray(body.subjectIds)) {
      const ids = this.subjectIds(body);
      await this.prisma.$transaction([
        this.prisma.roomSubject.deleteMany({ where: { roomId } }),
        this.prisma.roomSubject.createMany({
          data: ids.map((subjectId) => ({ roomId, subjectId, schoolId: req.user.schoolId })),
        }),
      ]);
    }
    if (Array.isArray(body.homeForIds)) await this.setHomeFor(req, roomId, body);

    await this.readiness.invalidate(req.user.schoolId);
    return updated;
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    await del(() => this.prisma.room.delete({ where: { id: toInt(id, "id") } }), "Room");
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }

  private subjectIds(body: any): number[] {
    if (!Array.isArray(body.subjectIds)) return [];
    return [...new Set(body.subjectIds.map((x: unknown) => toInt(x, "subjectIds[]")))] as number[];
  }

  /**
   * Point the named class-sections at this room, and release any that used to
   * be here and no longer are — otherwise unticking a section on this screen
   * would appear to work and change nothing.
   */
  private async setHomeFor(req: AuthedRequest, roomId: number, body: any) {
    if (!Array.isArray(body.homeForIds)) return;
    const wanted = [...new Set(body.homeForIds.map((x: unknown) => toInt(x, "homeForIds[]")))] as number[];

    // Two class-sections in one room all week is not a timetable — say so here
    // rather than let the solver discover it as a room collision.
    if (wanted.length > 1) {
      const rooms = await this.prisma.classSection.findMany({
        where: { id: { in: wanted } },
        include: { class: true, section: true },
      });
      throw new BadRequestException(
        `A room can be the home room of one class-section, not ${wanted.length} (${rooms
          .map((cs) => `${cs.class.name}-${cs.section.name}`)
          .join(", ")}) — they are all timetabled every period of the week.`,
      );
    }

    await this.prisma.classSection.updateMany({
      where: { homeRoomId: roomId, id: { notIn: wanted.length > 0 ? wanted : [0] } },
      data: { homeRoomId: null },
    });
    if (wanted.length > 0) {
      await this.prisma.classSection.updateMany({ where: { id: { in: wanted } }, data: { homeRoomId: roomId } });
    }
  }
}
