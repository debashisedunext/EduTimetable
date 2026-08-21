import { Body, ConflictException, Controller, Delete, Get, Param, Post, Put, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { del, requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";

@Controller("academic-years")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class AcademicYearsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.prisma.academicYear.findMany({
      where: { schoolId: req.user.schoolId },
      orderBy: { startDate: "desc" },
    });
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["name", "startDate", "endDate"]);
    const created = await uniq(
      () =>
        this.prisma.academicYear.create({
          data: {
            schoolId: req.user.schoolId,
            name: String(body.name),
            startDate: new Date(body.startDate),
            endDate: new Date(body.endDate),
          },
        }),
      `Academic year '${body.name}'`,
    );
    await this.readiness.invalidate(req.user.schoolId);
    return created;
  }

  @Put(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const updated = await uniq(
      () =>
        this.prisma.academicYear.update({
          where: { id: toInt(id, "id") },
          data: {
            ...(body.name !== undefined ? { name: String(body.name) } : {}),
            ...(body.startDate ? { startDate: new Date(body.startDate) } : {}),
            ...(body.endDate ? { endDate: new Date(body.endDate) } : {}),
            ...(body.isActive !== undefined ? { isActive: Boolean(body.isActive) } : {}),
          },
        }),
      "Academic year",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return updated;
  }

  /** Class-sections CASCADE from a year — check explicitly, never rely on the DB. */
  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const yearId = toInt(id, "id");
    const sections = await this.prisma.classSection.count({ where: { academicYearId: yearId } });
    if (sections > 0) {
      throw new ConflictException(
        `This academic year still has ${sections} class-section(s) — remove those first`,
      );
    }
    await del(
      () => this.prisma.academicYear.delete({ where: { id: yearId } }),
      "Academic year",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }
}
