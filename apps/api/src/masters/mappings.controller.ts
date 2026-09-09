import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";
import { assertWithinWeek, capacityForClassSections } from "./capacity.util";
import { assertCanTeach } from "./teacher-scope.util";
import { FreezeService } from "../freeze/freeze.service";

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
    private readonly freeze: FreezeService,
  ) {}

  /**
   * §3.12 — `academicYearId` narrows the list to one session. Optional, like
   * the curriculum list: reading every session is merely noisy. But once a
   * school has cloned a timetable it has two sessions' mappings, and a screen
   * that shows "Class 5-A · English · Mrs Rao" twice with nothing to tell them
   * apart is a screen nobody can use.
   */
  @Get()
  async list(@Req() req: AuthedRequest, @Query("academicYearId") academicYearId?: string) {
    const year = academicYearId ? toInt(academicYearId, "academicYearId") : null;
    const [rows, groups] = await Promise.all([
      this.prisma.teacherSubjectClassSection.findMany({
        where: {
          teacher: { schoolId: req.user.schoolId },
          ...(year === null ? {} : { classSection: { academicYearId: year } }),
        },
        include: {
          teacher: true,
          subject: true,
          classSection: { include: { class: true, section: true, homeRoom: true } },
          preferredRoom: true,
        },
        orderBy: [{ teacher: { name: "asc" } }],
      }),
      this.prisma.mergedTeachingGroup.findMany({
        // A group belongs to a session through its members, having no year of
        // its own — `some` is right because a group's members are always in one
        // session (the clone refuses to copy one that spans timetables).
        where: {
          schoolId: req.user.schoolId,
          ...(year === null ? {} : { members: { some: { classSection: { academicYearId: year } } } }),
        },
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
    // §29.1 — asked before anything is checked or written, so a frozen
    // timetable refuses for its own reason rather than for a capacity one.
    await this.freeze.assertSections(ids, "who teaches a subject");
    await assertCanTeach(this.prisma, teacherId, ids, { what: "this subject" });
    const periodsPerWeek = toInt(body.periodsPerWeek, "periodsPerWeek");
    const preferredRoomId =
      body.preferredRoomId != null ? toInt(body.preferredRoomId, "preferredRoomId") : null;
    assertWithinWeek(periodsPerWeek, await capacityForClassSections(this.prisma, ids));

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
            schoolId: req.user.schoolId,
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
    const mine = await this.prisma.teacherSubjectClassSection.findUnique({
      where: { id: toInt(id, "id") },
      select: { classSectionId: true },
    });
    if (mine) await this.freeze.assertSections([mine.classSectionId], "who teaches a subject");
    if (body.periodsPerWeek !== undefined) {
      const row = await this.prisma.teacherSubjectClassSection.findUnique({
        where: { id: toInt(id, "id") },
        select: { classSectionId: true },
      });
      if (row) {
        assertWithinWeek(
          toInt(body.periodsPerWeek, "periodsPerWeek"),
          await capacityForClassSections(this.prisma, [row.classSectionId]),
        );
      }
    }
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
    const row = await this.prisma.teacherSubjectClassSection.findUnique({
      where: { id: toInt(id, "id") },
      select: { classSectionId: true },
    });
    if (row) await this.freeze.assertSections([row.classSectionId], "who teaches a subject");
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
    private readonly freeze: FreezeService,
  ) {}

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["teacherId", "subjectId", "periodsPerWeek", "classSectionIds"]);
    const ids = this.memberIds(body);
    await this.freeze.assertSections(ids, "a merged teaching group");
    await assertCanTeach(this.prisma, toInt(body.teacherId, "teacherId"), ids, { what: "this merged group" });
    assertWithinWeek(
      toInt(body.periodsPerWeek, "periodsPerWeek"),
      await capacityForClassSections(this.prisma, ids),
    );
    const group = await uniq(
      () =>
        this.prisma.mergedTeachingGroup.create({
          data: {
            schoolId: req.user.schoolId,
            teacherId: toInt(body.teacherId, "teacherId"),
            subjectId: toInt(body.subjectId, "subjectId"),
            periodsPerWeek: toInt(body.periodsPerWeek, "periodsPerWeek"),
            roomId: body.roomId != null ? toInt(body.roomId, "roomId") : null,
            members: {
              create: ids.map((classSectionId) => ({
                classSectionId,
                schoolId: req.user.schoolId,
              })),
            },
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
    /*
      §29.1 — both sides of the edit, not just the one being written to.

      A group's members can be replaced, so an edit reaches the sections it is
      leaving as well as the ones it is joining. Checking only the incoming list
      would let a frozen wing quietly lose a lesson.
    */
    const current = await this.prisma.mergedTeachingGroupMember.findMany({
      where: { mergedGroupId: groupId },
      select: { classSectionId: true },
    });
    await this.freeze.assertSections(
      [...current.map((m) => m.classSectionId), ...(Array.isArray(body.classSectionIds) ? this.memberIds(body) : [])],
      "a merged teaching group",
    );
    const data: Record<string, unknown> = {};
    if (body.teacherId !== undefined) data.teacherId = toInt(body.teacherId, "teacherId");
    if (body.periodsPerWeek !== undefined) data.periodsPerWeek = toInt(body.periodsPerWeek, "periodsPerWeek");
    // A change to either side can break scope, so re-check whichever is not
    // being changed against whichever is.
    if (body.teacherId !== undefined || body.classSectionIds !== undefined) {
      const existing = await this.prisma.mergedTeachingGroup.findFirst({
        where: { id: groupId },
        include: { members: true },
      });
      if (!existing) throw new BadRequestException(`Merged group ${groupId} not found`);
      const teacherId = body.teacherId !== undefined ? toInt(body.teacherId, "teacherId") : existing.teacherId;
      const sectionIds =
        body.classSectionIds !== undefined ? this.memberIds(body) : existing.members.map((m) => m.classSectionId);
      await assertCanTeach(this.prisma, teacherId, sectionIds, { what: "this merged group" });
    }
    if (body.roomId !== undefined) data.roomId = body.roomId === null ? null : toInt(body.roomId, "roomId");
    if (body.periodsPerWeek !== undefined) {
      const memberIds =
        body.classSectionIds !== undefined
          ? this.memberIds(body)
          : (await this.prisma.mergedTeachingGroupMember.findMany({ where: { mergedGroupId: groupId } }))
              .map((m) => m.classSectionId);
      assertWithinWeek(
        toInt(body.periodsPerWeek, "periodsPerWeek"),
        await capacityForClassSections(this.prisma, memberIds),
      );
    }

    await uniq(async () => {
      await this.prisma.mergedTeachingGroup.update({ where: { id: groupId }, data });
      if (body.classSectionIds !== undefined) {
        const ids = this.memberIds(body);
        await this.prisma.$transaction([
          this.prisma.mergedTeachingGroupMember.deleteMany({ where: { mergedGroupId: groupId } }),
          this.prisma.mergedTeachingGroupMember.createMany({
            data: ids.map((classSectionId) => ({
              mergedGroupId: groupId,
              classSectionId,
              schoolId: req.user.schoolId,
            })),
          }),
        ]);
      }
    }, "Merged group");
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const members = await this.prisma.mergedTeachingGroupMember.findMany({
      where: { mergedGroupId: toInt(id, "id") },
      select: { classSectionId: true },
    });
    await this.freeze.assertSections(members.map((m) => m.classSectionId), "a merged teaching group");
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
