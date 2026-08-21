import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Req } from "@nestjs/common";
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

  /**
   * Bulk create (task 1.8): one teacher + one subject + N class-sections in a
   * single Add. `classSectionIds: number[]` is the primary shape; a single
   * `classSectionId` still works. Sections that already have a mapping for
   * this subject are skipped and reported, never silently dropped.
   */
  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["teacherId", "subjectId", "periodsPerWeek"]);
    const ids: number[] = Array.isArray(body.classSectionIds)
      ? body.classSectionIds.map((x: unknown) => toInt(x, "classSectionIds[]"))
      : body.classSectionId != null
        ? [toInt(body.classSectionId, "classSectionId")]
        : [];
    if (ids.length === 0) {
      throw new BadRequestException("Select at least one class-section");
    }
    const subjectId = toInt(body.subjectId, "subjectId");
    const teacherId = toInt(body.teacherId, "teacherId");
    const periodsPerWeek = toInt(body.periodsPerWeek, "periodsPerWeek");
    const preferredRoomId =
      body.preferredRoomId != null ? toInt(body.preferredRoomId, "preferredRoomId") : null;

    // uq_tscs is (subjectId, classSectionId) — find sections already mapped for
    // this subject so the caller learns exactly what was skipped and why.
    const existing = await this.prisma.teacherSubjectClassSection.findMany({
      where: { subjectId, classSectionId: { in: ids } },
      include: { classSection: { include: { class: true, section: true } }, teacher: true },
    });
    const existingIds = new Set(existing.map((e) => e.classSectionId));
    const toCreate = ids.filter((id) => !existingIds.has(id));

    await uniq(
      () =>
        this.prisma.teacherSubjectClassSection.createMany({
          data: toCreate.map((classSectionId) => ({
            teacherId,
            subjectId,
            classSectionId,
            periodsPerWeek,
            preferredRoomId,
          })),
        }),
      "Subject mapping",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return {
      created: toCreate.length,
      skipped: existing.map(
        (e) =>
          `${e.classSection.class.name}-${e.classSection.section.name} (already mapped to ${e.teacher.name})`,
      ),
    };
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
