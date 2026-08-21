import { Body, Controller, Delete, Get, Param, Post, Put, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";

/** Subject Mapping — teacher_subject_class_section (§3, §8.1b). */
@Controller("mappings")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class MappingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    const rows = await this.prisma.teacherSubjectClassSection.findMany({
      where: { teacher: { schoolId: req.user.schoolId } },
      include: {
        teacher: true,
        subject: true,
        classSection: { include: { class: true, section: true } },
        preferredRoom: true,
      },
      orderBy: [{ teacher: { name: "asc" } }],
    });
    return rows.map((m) => ({
      id: m.id,
      teacherId: m.teacherId,
      teacherName: m.teacher.name,
      subjectId: m.subjectId,
      subjectName: m.subject.name,
      classSectionId: m.classSectionId,
      classSectionLabel: `${m.classSection.class.name}-${m.classSection.section.name}`,
      periodsPerWeek: m.periodsPerWeek,
      preferredRoomId: m.preferredRoomId,
      preferredRoomName: m.preferredRoom?.name ?? null,
    }));
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["teacherId", "subjectId", "classSectionId", "periodsPerWeek"]);
    const created = await uniq(
      () =>
        this.prisma.teacherSubjectClassSection.create({
          data: {
            teacherId: toInt(body.teacherId, "teacherId"),
            subjectId: toInt(body.subjectId, "subjectId"),
            classSectionId: toInt(body.classSectionId, "classSectionId"),
            periodsPerWeek: toInt(body.periodsPerWeek, "periodsPerWeek"),
            preferredRoomId: body.preferredRoomId != null ? toInt(body.preferredRoomId, "preferredRoomId") : null,
          },
        }),
      "A mapping for that subject & class-section",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return created;
  }

  @Put(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const updated = await uniq(
      () =>
        this.prisma.teacherSubjectClassSection.update({
          where: { id: toInt(id, "id") },
          data: {
            ...(body.teacherId !== undefined ? { teacherId: toInt(body.teacherId, "teacherId") } : {}),
            ...(body.periodsPerWeek !== undefined ? { periodsPerWeek: toInt(body.periodsPerWeek, "periodsPerWeek") } : {}),
            ...(body.preferredRoomId !== undefined
              ? { preferredRoomId: body.preferredRoomId === null ? null : toInt(body.preferredRoomId, "preferredRoomId") }
              : {}),
          },
        }),
      "Mapping",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return updated;
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    await uniq(
      () => this.prisma.teacherSubjectClassSection.delete({ where: { id: toInt(id, "id") } }),
      "Mapping",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }
}
