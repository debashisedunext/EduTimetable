import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";

/**
 * Subject Mapping — teacher_subject_class_section (§3, §8.1b) plus merged
 * teaching groups (§4.9). GET returns BOTH kinds as one list: plain rows
 * (`type: "single"`) and merged rows (`type: "merged"`, one row per group,
 * class-section shown as "10-A + 10-B").
 */
@Controller("mappings")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class MappingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    const [rows, groups] = await Promise.all([
      this.prisma.teacherSubjectClassSection.findMany({
        where: { teacher: { schoolId: req.user.schoolId } },
        include: {
          teacher: true,
          subject: true,
          classSection: { include: { class: true, section: true, homeRoom: true } },
          preferredRoom: true,
        },
        orderBy: [{ teacher: { name: "asc" } }],
      }),
      this.prisma.mergedTeachingGroup.findMany({
        where: { schoolId: req.user.schoolId },
        include: {
          teacher: true,
          subject: true,
          room: true,
          members: { include: { classSection: { include: { class: true, section: true } } } },
        },
      }),
    ]);
    const label = (cs: { class: { name: string }; section: { name: string } }) =>
      `${cs.class.name}-${cs.section.name}`;
    return [
      ...rows.map((m) => ({
        type: "single" as const,
        id: m.id,
        teacherId: m.teacherId,
        teacherName: m.teacher.name,
        subjectId: m.subjectId,
        subjectName: m.subject.name,
        classSectionIds: [m.classSectionId],
        classSectionLabel: label(m.classSection),
        periodsPerWeek: m.periodsPerWeek,
        roomId: m.preferredRoomId,
        roomLabel: m.preferredRoom
          ? m.preferredRoom.name
          : m.classSection.homeRoom
            ? `${m.classSection.homeRoom.name} (home)`
            : "Home room",
      })),
      ...groups.map((g) => ({
        type: "merged" as const,
        id: g.id,
        teacherId: g.teacherId,
        teacherName: g.teacher.name,
        subjectId: g.subjectId,
        subjectName: g.subject.name,
        classSectionIds: g.members.map((m) => m.classSectionId),
        classSectionLabel: g.members.map((m) => label(m.classSection)).join(" + "),
        periodsPerWeek: g.periodsPerWeek,
        roomId: g.roomId,
        roomLabel: g.room?.name ?? "Home room",
      })),
    ];
  }

  /**
   * Bulk create (task 1.8): one teacher + one subject + N class-sections in one
   * Add. Sections already mapped for this subject are skipped and reported.
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

/** Merged teaching groups (§4.9): one teacher, one slot, several sections at once. */
@Controller("merged-groups")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class MergedGroupsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["teacherId", "subjectId", "periodsPerWeek", "classSectionIds"]);
    const ids = this.memberIds(body);
    const group = await uniq(
      () =>
        this.prisma.mergedTeachingGroup.create({
          data: {
            schoolId: req.user.schoolId,
            teacherId: toInt(body.teacherId, "teacherId"),
            subjectId: toInt(body.subjectId, "subjectId"),
            periodsPerWeek: toInt(body.periodsPerWeek, "periodsPerWeek"),
            roomId: body.roomId != null ? toInt(body.roomId, "roomId") : null,
            members: { create: ids.map((classSectionId) => ({ classSectionId })) },
          },
        }),
      "Merged group",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return group;
  }

  @Put(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const groupId = toInt(id, "id");
    const data: Record<string, unknown> = {};
    if (body.teacherId !== undefined) data.teacherId = toInt(body.teacherId, "teacherId");
    if (body.periodsPerWeek !== undefined) data.periodsPerWeek = toInt(body.periodsPerWeek, "periodsPerWeek");
    if (body.roomId !== undefined) data.roomId = body.roomId === null ? null : toInt(body.roomId, "roomId");

    await uniq(async () => {
      await this.prisma.mergedTeachingGroup.update({ where: { id: groupId }, data });
      if (body.classSectionIds !== undefined) {
        const ids = this.memberIds(body);
        await this.prisma.$transaction([
          this.prisma.mergedTeachingGroupMember.deleteMany({ where: { mergedGroupId: groupId } }),
          this.prisma.mergedTeachingGroupMember.createMany({
            data: ids.map((classSectionId) => ({ mergedGroupId: groupId, classSectionId })),
          }),
        ]);
      }
    }, "Merged group");
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    await uniq(
      () => this.prisma.mergedTeachingGroup.delete({ where: { id: toInt(id, "id") } }),
      "Merged group",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }

  private memberIds(body: any): number[] {
    const ids: number[] = Array.isArray(body.classSectionIds)
      ? body.classSectionIds.map((x: unknown) => toInt(x, "classSectionIds[]"))
      : [];
    if (ids.length < 2) {
      throw new BadRequestException("A merged group needs at least 2 class-sections");
    }
    return ids;
  }
}
