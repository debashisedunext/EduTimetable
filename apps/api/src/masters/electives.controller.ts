import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";
import { assertWithinWeek, capacityForClassSections } from "./capacity.util";

/**
 * Split electives (§4.9) — the mirror of a merged group.
 *
 * A merged group is one teacher across several sections. A block is several
 * teachers inside one slot: every member section holds the same period open,
 * and the students go to whichever option they picked. "Class 5 Third
 * Language" with French, Sanskrit and German is the canonical case.
 *
 * The rules below are the ones a person can get wrong at data-entry time and
 * would otherwise only discover as a timetable that will not generate. The
 * Feasibility Engine re-checks all of them (Check 7) — this is the early,
 * specific "no" at the point of the mistake, not the authority.
 */
@Controller("elective-blocks")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class ElectiveBlocksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  @Get()
  async list() {
    const blocks = await this.prisma.electiveBlock.findMany({
      include: {
        members: { include: { classSection: { include: { class: true, section: true } } } },
        options: { include: { subject: true, teacher: true, room: true } },
      },
      orderBy: { name: "asc" },
    });
    return blocks.map((b) => ({
      id: b.id,
      name: b.name,
      periodsPerWeek: b.periodsPerWeek,
      maxPeriodsPerDay: b.maxPeriodsPerDay,
      members: b.members.map((m) => ({
        classSectionId: m.classSectionId,
        label: `${m.classSection.class.name}-${m.classSection.section.name}`,
      })),
      options: b.options.map((o) => ({
        id: o.id,
        subjectId: o.subjectId,
        subjectName: o.subject.name,
        teacherId: o.teacherId,
        teacherName: o.teacher.name,
        roomId: o.roomId,
        roomName: o.room.name,
      })),
    }));
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["name", "periodsPerWeek", "classSectionIds", "options"]);
    const memberIds = this.memberIds(body);
    const options = this.options(body);
    const periodsPerWeek = toInt(body.periodsPerWeek, "periodsPerWeek");
    // Capacity-first (§8.1): a block cannot ask for more periods than the
    // shortest member's week has left.
    assertWithinWeek(periodsPerWeek, await capacityForClassSections(this.prisma, memberIds));

    const block = await uniq(
      () =>
        this.prisma.electiveBlock.create({
          data: {
            schoolId: req.user.schoolId,
            name: String(body.name),
            periodsPerWeek,
            maxPeriodsPerDay: body.maxPeriodsPerDay != null ? toInt(body.maxPeriodsPerDay, "maxPeriodsPerDay") : 1,
            members: {
              create: memberIds.map((classSectionId) => ({ classSectionId, schoolId: req.user.schoolId })),
            },
            options: {
              create: options.map((o) => ({ ...o, schoolId: req.user.schoolId })),
            },
          },
        }),
      `Elective block '${body.name}'`,
    );
    await this.readiness.invalidate(req.user.schoolId);
    return block;
  }

  @Put(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const blockId = toInt(id, "id");
    const existing = await this.prisma.electiveBlock.findFirst({ where: { id: blockId } });
    if (!existing) throw new BadRequestException(`Elective block ${blockId} not found`);

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = String(body.name);
    if (body.periodsPerWeek !== undefined) data.periodsPerWeek = toInt(body.periodsPerWeek, "periodsPerWeek");
    if (body.maxPeriodsPerDay !== undefined) data.maxPeriodsPerDay = toInt(body.maxPeriodsPerDay, "maxPeriodsPerDay");

    if (body.periodsPerWeek !== undefined) {
      const memberIds =
        body.classSectionIds !== undefined
          ? this.memberIds(body)
          : (await this.prisma.electiveBlockMember.findMany({ where: { electiveBlockId: blockId } })).map(
              (m) => m.classSectionId,
            );
      assertWithinWeek(
        toInt(body.periodsPerWeek, "periodsPerWeek"),
        await capacityForClassSections(this.prisma, memberIds),
      );
    }

    await uniq(async () => {
      await this.prisma.electiveBlock.update({ where: { id: blockId }, data });
      if (body.classSectionIds !== undefined) {
        const ids = this.memberIds(body);
        await this.prisma.$transaction([
          this.prisma.electiveBlockMember.deleteMany({ where: { electiveBlockId: blockId } }),
          this.prisma.electiveBlockMember.createMany({
            data: ids.map((classSectionId) => ({
              electiveBlockId: blockId,
              classSectionId,
              schoolId: req.user.schoolId,
            })),
          }),
        ]);
      }
      if (body.options !== undefined) {
        const options = this.options(body);
        await this.prisma.$transaction([
          this.prisma.electiveOption.deleteMany({ where: { electiveBlockId: blockId } }),
          this.prisma.electiveOption.createMany({
            data: options.map((o) => ({ ...o, electiveBlockId: blockId, schoolId: req.user.schoolId })),
          }),
        ]);
      }
    }, "Elective block");
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    await uniq(() => this.prisma.electiveBlock.delete({ where: { id: toInt(id, "id") } }), "Elective block");
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }

  private memberIds(body: any): number[] {
    const ids: number[] = Array.isArray(body.classSectionIds)
      ? body.classSectionIds.map((x: unknown) => toInt(x, "classSectionIds[]"))
      : [];
    if (ids.length < 1) {
      throw new BadRequestException("An elective block needs at least one class-section attending it");
    }
    return ids;
  }

  private options(body: any): Array<{ subjectId: number; teacherId: number; roomId: number }> {
    const raw: any[] = Array.isArray(body.options) ? body.options : [];
    if (raw.length < 2) {
      throw new BadRequestException(
        "An elective block needs at least 2 options — with one there is nothing to choose, and it belongs in the curriculum as an ordinary subject",
      );
    }
    const options = raw.map((o, i) => {
      requireFields(o, ["subjectId", "teacherId", "roomId"]);
      return {
        subjectId: toInt(o.subjectId, `options[${i}].subjectId`),
        teacherId: toInt(o.teacherId, `options[${i}].teacherId`),
        roomId: toInt(o.roomId, `options[${i}].roomId`),
      };
    });
    // Every option runs in the same period, so a repeat is a person or a room
    // being asked to be in two places at once. The DB would refuse it when the
    // slots were written; refusing it here names the row instead.
    const dupe = <K extends keyof (typeof options)[number]>(key: K, what: string) => {
      const seen = new Set<number>();
      for (const o of options) {
        if (seen.has(o[key])) {
          throw new BadRequestException(
            `The same ${what} appears on two options — they are taught at the same time, so each option needs its own`,
          );
        }
        seen.add(o[key]);
      }
    };
    dupe("teacherId", "teacher");
    dupe("roomId", "room");
    return options;
  }
}
