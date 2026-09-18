import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PERMISSIONS, isElectivePlacement, parsePins, type ElectivePin, type ElectivePlacement } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";
import { assertWithinWeek, capacityForClassSections } from "./capacity.util";
import { assertCanTeach } from "./teacher-scope.util";
import { FreezeService } from "../freeze/freeze.service";

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
    private readonly freeze: FreezeService,
  ) {}

  /**
   * §3.12 — narrowed to one session on request. A block belongs to a session
   * through its member sections, having no year of its own; after a clone the
   * school has "Class 5 Third Language" in two sessions, and this is what tells
   * them apart.
   */
  @Get()
  async list(@Query("academicYearId") academicYearId?: string) {
    const year = academicYearId ? toInt(academicYearId, "academicYearId") : null;
    const blocks = await this.prisma.electiveBlock.findMany({
      ...(year === null
        ? {}
        : { where: { members: { some: { classSection: { academicYearId: year } } } } }),
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
      placement: b.placement,
      fixedSlots: parsePins(b.fixedSlots),
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
    /*
      §29.8 — a block is ONE card over several sections with several option
      teachers, so it takes every member, or every option teacher (`grant.ts`).
      Not "any": changing the block changes all its members' weeks at once.
    */
    const ticket = await this.freeze.assertSections(memberIds, "a split elective block", {
      teacherIds: options.map((o) => o.teacherId),
    });
    // Every option teacher takes the block's member classes (§18).
    for (const o of options) {
      await assertCanTeach(this.prisma, o.teacherId, memberIds, { what: "this elective option" });
    }
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
            ...this.placement(body),
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
    await ticket.record(
      `added the split elective block “${String(body.name)}” over ${memberIds.length} section(s)`,
    );
    await this.readiness.invalidate(req.user.schoolId);
    return block;
  }

  @Put(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const blockId = toInt(id, "id");
    const existing = await this.prisma.electiveBlock.findFirst({ where: { id: blockId } });
    if (!existing) throw new BadRequestException(`Elective block ${blockId} not found`);
    // Both sides, as with a merged group: an edit may replace the member list,
    // so it reaches the sections it leaves as well as the ones it joins.
    const currentMembers = await this.prisma.electiveBlockMember.findMany({
      where: { electiveBlockId: blockId },
      select: { classSectionId: true },
    });
    // §29.8 — the block's CURRENT option teachers, never the incoming ones:
    // the grant reads the row as it stands, so a re-staffing edit is not
    // refused by the teacher it is about to name.
    const currentOptions = await this.prisma.electiveOption.findMany({
      where: { electiveBlockId: blockId },
      select: { teacherId: true },
    });
    const ticket = await this.freeze.assertSections(
      [
        ...currentMembers.map((m) => m.classSectionId),
        ...(Array.isArray(body.classSectionIds) ? this.memberIds(body) : []),
      ],
      "a split elective block",
      { teacherIds: currentOptions.map((o) => o.teacherId) },
    );

    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = String(body.name);
    if (body.periodsPerWeek !== undefined) data.periodsPerWeek = toInt(body.periodsPerWeek, "periodsPerWeek");
    if (body.maxPeriodsPerDay !== undefined) data.maxPeriodsPerDay = toInt(body.maxPeriodsPerDay, "maxPeriodsPerDay");
    if (body.placement !== undefined || body.fixedSlots !== undefined) {
      Object.assign(data, this.placement({ ...body, placement: body.placement ?? existing.placement }));
    }

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
    await ticket.record(`changed the split elective block #${blockId}`);
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const members = await this.prisma.electiveBlockMember.findMany({
      where: { electiveBlockId: toInt(id, "id") },
      select: { classSectionId: true },
    });
    await this.freeze.assertSections(members.map((m) => m.classSectionId), "a split elective block");
    await uniq(() => this.prisma.electiveBlock.delete({ where: { id: toInt(id, "id") } }), "Elective block");
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }

  /**
   * §4.9 Phase 15 — when the block runs.
   *
   * This is the only setting on the screen that takes slots AWAY from the
   * solver rather than expressing a preference, so it is checked hard here:
   * shape, range, duplicates. What it deliberately does NOT check is whether
   * the pinned cells work for the school's teachers and other blocks — that
   * needs the whole snapshot, and the Feasibility Engine already does it
   * (Check 7b) with a specific fix and a §21 remedy. Refusing to save a pin
   * the engine could explain would leave the admin with an error and no
   * readiness row telling them what to do about it.
   */
  private placement(body: any): {
    placement: ElectivePlacement;
    fixedSlots: Prisma.InputJsonValue | typeof Prisma.DbNull;
  } {
    const placement = body.placement ?? "solver";
    if (!isElectivePlacement(placement)) {
      throw new BadRequestException(
        `placement must be one of solver, same_period, fixed — got '${placement}'`,
      );
    }
    // Leaving `fixed` clears the pins rather than keeping them warm: a pin the
    // school cannot see on screen must not come back the next time somebody
    // switches the setting on.
    if (placement !== "fixed") return { placement, fixedSlots: Prisma.DbNull };

    const raw = Array.isArray(body.fixedSlots) ? body.fixedSlots : [];
    const pins: ElectivePin[] = raw.map((s: any, i: number) => {
      requireFields(s, ["day", "period"]);
      const day = toInt(s.day, `fixedSlots[${i}].day`);
      const period = toInt(s.period, `fixedSlots[${i}].period`);
      if (day < 1 || day > 7) {
        throw new BadRequestException(`fixedSlots[${i}].day must be 1 (Mon) to 7 (Sun) — got ${day}`);
      }
      if (period < 1) throw new BadRequestException(`fixedSlots[${i}].period must be 1 or more — got ${period}`);
      return { day, period };
    });
    // The same cell twice is never anything but a mistake: one slot cannot
    // hold the block two times over, whatever the block's daily cap says.
    const seen = new Set<string>();
    for (const p of pins) {
      const k = `${p.day}:${p.period}`;
      if (seen.has(k)) {
        throw new BadRequestException(
          `Day ${p.day} period ${p.period} is fixed twice — one slot can only hold this block once`,
        );
      }
      seen.add(k);
    }
    // Round-trip through the reader the solver and engine use, so anything
    // those two would silently drop is refused here instead.
    return { placement, fixedSlots: parsePins(pins).map((p) => ({ day: p.day, period: p.period })) };
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
