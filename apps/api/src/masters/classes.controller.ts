import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";

@Controller("classes")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class ClassesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.prisma.schoolClass.findMany({
      where: { schoolId: req.user.schoolId },
      orderBy: { sequence: "asc" },
      include: { sections: true },
    });
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["name"]);
    const created = await uniq(
      () =>
        this.prisma.schoolClass.create({
          data: {
            schoolId: req.user.schoolId,
            name: String(body.name),
            sequence: body.sequence != null ? toInt(body.sequence, "sequence") : 0,
          },
        }),
      `Class '${body.name}'`,
    );
    await this.readiness.invalidate(req.user.schoolId);
    return created;
  }

  /** Add a section to a class and (optionally) its class-section for a year. */
  @Post(":id/sections")
  async addSection(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    requireFields(body, ["name", "academicYearId"]);
    const classId = toInt(id, "class id");
    const section = await uniq(
      () => this.prisma.section.create({ data: { classId, name: String(body.name) } }),
      `Section '${body.name}'`,
    );
    const classSection = await uniq(
      () =>
        this.prisma.classSection.create({
          data: {
            classId,
            sectionId: section.id,
            academicYearId: toInt(body.academicYearId, "academicYearId"),
            strength: body.strength != null ? toInt(body.strength, "strength") : null,
            homeRoomId: body.homeRoomId != null ? toInt(body.homeRoomId, "homeRoomId") : null,
          },
        }),
      "Class-section",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return { section, classSection };
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    await uniq(
      () => this.prisma.schoolClass.delete({ where: { id: toInt(id, "id") } }),
      "Class",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }
}

@Controller("class-sections")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class ClassSectionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    const rows = await this.prisma.classSection.findMany({
      where: { class: { schoolId: req.user.schoolId } },
      include: {
        class: true,
        section: true,
        classTeacher: true,
        homeRoom: true,
        timetableConfig: true,
      },
      orderBy: [{ class: { sequence: "asc" } }, { section: { name: "asc" } }],
    });
    return rows.map((cs) => ({
      id: cs.id,
      label: `${cs.class.name}-${cs.section.name}`,
      classId: cs.classId,
      sectionId: cs.sectionId,
      academicYearId: cs.academicYearId,
      strength: cs.strength,
      homeRoom: cs.homeRoom?.name ?? null,
      homeRoomId: cs.homeRoomId,
      classTeacherId: cs.classTeacherId,
      classTeacherName: cs.classTeacher?.name ?? null,
      timetableConfigId: cs.timetableConfigId,
      timetableConfigName: cs.timetableConfig?.name ?? null,
    }));
  }

  @Put(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const updated = await uniq(
      () =>
        this.prisma.classSection.update({
          where: { id: toInt(id, "id") },
          data: {
            ...(body.strength !== undefined
              ? { strength: body.strength === null ? null : toInt(body.strength, "strength") }
              : {}),
            ...(body.homeRoomId !== undefined
              ? { homeRoomId: body.homeRoomId === null ? null : toInt(body.homeRoomId, "homeRoomId") }
              : {}),
          },
        }),
      "Class-section",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return updated;
  }

  /** §8.1b — Class Teacher Assignment: the pointer that activates a teacher's P1 rule. */
  @Put(":id/class-teacher")
  async assignClassTeacher(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const teacherId = body.teacherId === null ? null : toInt(body.teacherId, "teacherId");
    if (teacherId !== null) {
      const teacher = await this.prisma.teacher.findFirst({
        where: { id: teacherId, schoolId: req.user.schoolId, isActive: true },
      });
      if (!teacher) throw new BadRequestException("Teacher not found or inactive");
    }
    const updated = await uniq(
      () =>
        this.prisma.classSection.update({
          where: { id: toInt(id, "id") },
          data: { classTeacherId: teacherId },
        }),
      "Class-section",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return updated;
  }
}
