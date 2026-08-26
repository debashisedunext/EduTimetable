import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Param, Post, Put, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { del, requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";
import { assertCanOwnClass } from "./teacher-scope.util";

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
      () => this.prisma.section.create({
          data: { classId, name: String(body.name), schoolId: req.user.schoolId },
        }),
      `Section '${body.name}'`,
    );
    const classSection = await uniq(
      () =>
        this.prisma.classSection.create({
          data: {
            schoolId: req.user.schoolId,
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

  @Put(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const updated = await uniq(
      () =>
        this.prisma.schoolClass.update({
          where: { id: toInt(id, "id") },
          data: {
            ...(body.name !== undefined ? { name: String(body.name) } : {}),
            ...(body.sequence !== undefined ? { sequence: toInt(body.sequence, "sequence") } : {}),
          },
        }),
      "Class",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return updated;
  }

  /** Sections and curriculum rows CASCADE from a class — check explicitly so a
   *  class delete can never silently take its curriculum with it. */
  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const classId = toInt(id, "id");
    const [sections, curriculum] = await Promise.all([
      this.prisma.classSection.count({ where: { classId } }),
      this.prisma.classSubject.count({ where: { classId } }),
    ]);
    if (sections > 0 || curriculum > 0) {
      const parts = [
        sections > 0 ? `${sections} class-section(s)` : null,
        curriculum > 0 ? `${curriculum} curriculum row(s)` : null,
      ].filter(Boolean);
      throw new ConflictException(`This class still has ${parts.join(" and ")} — remove those first`);
    }
    await del(
      () => this.prisma.schoolClass.delete({ where: { id: classId } }),
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
    // renaming the section (the "A" in 5-A) rides along on the same call — the
    // Section row is 1:1-owned by its class, so this stays a masters concern
    if (body.sectionName !== undefined && String(body.sectionName).trim() !== "") {
      await uniq(
        () =>
          this.prisma.section.update({
            where: { id: updated.sectionId },
            data: { name: String(body.sectionName).trim() },
          }),
        `Section '${body.sectionName}'`,
      );
    }
    await this.readiness.invalidate(req.user.schoolId);
    return updated;
  }

  /** Delete a class-section (and its Section row when nothing else uses it).
   *  Dependencies are checked EXPLICITLY first — the mapping FK is ON DELETE
   *  CASCADE and timetable_slots has no FK at all, so relying on the DB to
   *  refuse would silently destroy mappings and orphan slots instead. */
  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const cs = await this.prisma.classSection.findUnique({ where: { id: toInt(id, "id") } });
    if (!cs) throw new BadRequestException("Class-section not found");
    const [mappings, mergedMembers, slots] = await Promise.all([
      this.prisma.teacherSubjectClassSection.count({ where: { classSectionId: cs.id } }),
      this.prisma.mergedTeachingGroupMember.count({ where: { classSectionId: cs.id } }),
      this.prisma.timetableSlot.count({ where: { classSectionId: cs.id } }),
    ]);
    if (mappings > 0 || mergedMembers > 0 || slots > 0) {
      const parts = [
        mappings > 0 ? `${mappings} subject mapping(s)` : null,
        mergedMembers > 0 ? `${mergedMembers} merged-group membership(s)` : null,
        slots > 0 ? `${slots} timetable slot(s)` : null,
      ].filter(Boolean);
      throw new ConflictException(
        `This class-section still has ${parts.join(", ")} — remove those first (Teacher Mapping step / regenerate without it)`,
      );
    }
    await del(
      () => this.prisma.classSection.delete({ where: { id: cs.id } }),
      "Class-section",
    );
    const otherUses = await this.prisma.classSection.count({ where: { sectionId: cs.sectionId } });
    if (otherUses === 0) {
      await del(
        () => this.prisma.section.delete({ where: { id: cs.sectionId } }),
        "Section",
      );
    }
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
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
      // A class teacher owns the class, so they must be able to teach it (§18).
      await assertCanOwnClass(this.prisma, teacherId, toInt(id, "id"));
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
