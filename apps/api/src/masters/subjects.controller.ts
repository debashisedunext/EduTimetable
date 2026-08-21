import { Body, Controller, Delete, Get, Param, Post, Put, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";

@Controller("subjects")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class SubjectsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.prisma.subject.findMany({
      where: { schoolId: req.user.schoolId },
      orderBy: { name: "asc" },
    });
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["name"]);
    const created = await uniq(
      () =>
        this.prisma.subject.create({
          data: {
            schoolId: req.user.schoolId,
            name: String(body.name),
            code: body.code ? String(body.code) : null,
            isLab: Boolean(body.isLab),
            requiresDoublePeriod: Boolean(body.requiresDoublePeriod),
          },
        }),
      `Subject '${body.name}'`,
    );
    await this.readiness.invalidate(req.user.schoolId);
    return created;
  }

  @Put(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const updated = await uniq(
      () =>
        this.prisma.subject.update({
          where: { id: toInt(id, "id") },
          data: {
            ...(body.name !== undefined ? { name: String(body.name) } : {}),
            ...(body.code !== undefined ? { code: body.code ? String(body.code) : null } : {}),
            ...(body.isLab !== undefined ? { isLab: Boolean(body.isLab) } : {}),
            ...(body.requiresDoublePeriod !== undefined
              ? { requiresDoublePeriod: Boolean(body.requiresDoublePeriod) }
              : {}),
          },
        }),
      "Subject",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return updated;
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    await uniq(() => this.prisma.subject.delete({ where: { id: toInt(id, "id") } }), "Subject");
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }
}
