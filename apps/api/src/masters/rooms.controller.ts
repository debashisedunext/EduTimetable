import { Body, Controller, Delete, Get, Param, Post, Put, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";

@Controller("rooms")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class RoomsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.prisma.room.findMany({
      where: { schoolId: req.user.schoolId },
      orderBy: { name: "asc" },
    });
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
          },
        }),
      `Room '${body.name}'`,
    );
    await this.readiness.invalidate(req.user.schoolId);
    return created;
  }

  @Put(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const updated = await uniq(
      () =>
        this.prisma.room.update({
          where: { id: toInt(id, "id") },
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
    await this.readiness.invalidate(req.user.schoolId);
    return updated;
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    await uniq(() => this.prisma.room.delete({ where: { id: toInt(id, "id") } }), "Room");
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }
}
