import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { del, requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";
import { assertWithinWeek, capacityForClass } from "./capacity.util";
import { assertSubjectApplies } from "./subject-scope.util";
import { FreezeService } from "../freeze/freeze.service";

/** Curriculum mapping — class_subjects (§3), with §4.8 block validation at entry. */
@Controller("class-subjects")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class CurriculumController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
    private readonly freeze: FreezeService,
  ) {}

  /**
   * Phase 19 — `academicYearId` narrows the list to one session. Optional
   * rather than required: reading every year is merely noisy, and a GET that
   * 400s for everybody tells the §17.8 sweep nothing. Writes are the ones that
   * must name their year (see `create`).
   */
  @Get()
  async list(@Req() req: AuthedRequest, @Query("academicYearId") academicYearId?: string) {
    const rows = await this.prisma.classSubject.findMany({
      where: {
        class: { schoolId: req.user.schoolId },
        ...(academicYearId ? { academicYearId: toInt(academicYearId, "academicYearId") } : {}),
      },
      include: { class: true, subject: true, academicYear: true },
      orderBy: [{ class: { sequence: "asc" } }, { subject: { name: "asc" } }],
    });
    return rows.map((r) => ({
      id: r.id,
      classId: r.classId,
      className: r.class.name,
      academicYearId: r.academicYearId,
      academicYear: r.academicYear.name,
      subjectId: r.subjectId,
      subjectName: r.subject.name,
      periodsPerWeek: r.periodsPerWeek,
      maxPeriodsPerDay: r.maxPeriodsPerDay,
      samePeriodAcrossWeek: r.samePeriodAcrossWeek,
      consecutiveBlockSize: r.consecutiveBlockSize,
      consecutiveBlocksPerWeek: r.consecutiveBlocksPerWeek,
      blockMayCrossBreak: r.blockMayCrossBreak,
    }));
  }

  /**
   * Phase 19 — `academicYearId` is REQUIRED, deliberately not defaulted to the
   * school's active year. Guessing puts next year's syllabus into last year's
   * session with no error anywhere, and a curriculum row filed against the
   * wrong session is invisible until the timetable comes out wrong.
   */
  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["classId", "academicYearId", "periodsPerWeek", "subjectId"]);
    const classId = toInt(body.classId, "classId");
    const academicYearId = toInt(body.academicYearId, "academicYearId");
    const data = this.normalize(body);
    // §29.1 — a class's curriculum reaches every timetable its sections sit in,
    // so this is asked by CLASS and narrowed by year: last year's frozen week
    // must not refuse this year's planning.
    await this.freeze.assertClasses([classId], academicYearId, "what a class is taught");
    // §27.16 — before anything else: a row for a class this subject is not
    // taught to is a contradiction of what the school said on the Subjects
    // screen, and the message names both halves so it is obvious which one to
    // change. Only on CREATE — `normalize` cannot move a row between class or
    // subject, so an update can never introduce one.
    await assertSubjectApplies(this.prisma, toInt(body.subjectId, "subjectId"), classId);
    assertWithinWeek(data.periodsPerWeek, await capacityForClass(this.prisma, classId, academicYearId));
    const created = await uniq(
      () => this.prisma.classSubject.create({
          data: {
            ...data,
            schoolId: req.user.schoolId,
            classId,
            academicYearId,
            subjectId: toInt(body.subjectId, "subjectId"),
          },
        }),
      "Curriculum row for that class & subject in that year",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return created;
  }

  @Put(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const existing = await this.prisma.classSubject.findUnique({ where: { id: toInt(id, "id") } });
    if (!existing) throw new BadRequestException("Curriculum row not found");
    await this.freeze.assertClasses([existing.classId], existing.academicYearId, "what a class is taught");
    // `normalize` returns only the five shape fields, so a PUT can never move a
    // row between sessions — that would be a re-key, not an edit.
    const data = this.normalize({ ...existing, ...body });
    assertWithinWeek(
      data.periodsPerWeek,
      await capacityForClass(this.prisma, existing.classId, existing.academicYearId),
    );
    const updated = await this.prisma.classSubject.update({
      where: { id: existing.id },
      data,
    });
    await this.readiness.invalidate(req.user.schoolId);
    return updated;
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const existing = await this.prisma.classSubject.findUnique({ where: { id: toInt(id, "id") } });
    if (existing) {
      await this.freeze.assertClasses([existing.classId], existing.academicYearId, "what a class is taught");
    }
    await del(
      () => this.prisma.classSubject.delete({ where: { id: toInt(id, "id") } }),
      "Curriculum row",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }

  /** §4.8: consecutive_block_size × consecutive_blocks_per_week ≤ periods_per_week, at entry. */
  private normalize(body: any) {
    const periodsPerWeek = toInt(body.periodsPerWeek, "periodsPerWeek");
    const blockSize = body.consecutiveBlockSize != null ? toInt(body.consecutiveBlockSize, "consecutiveBlockSize") : 1;
    const blocksPerWeek =
      body.consecutiveBlocksPerWeek != null ? toInt(body.consecutiveBlocksPerWeek, "consecutiveBlocksPerWeek") : null;
    if (periodsPerWeek < 1 || periodsPerWeek > 20) {
      throw new BadRequestException("periodsPerWeek must be 1-20");
    }
    if (blockSize < 1) throw new BadRequestException("consecutiveBlockSize must be ≥ 1");
    if (blockSize > 1 && blocksPerWeek !== null && blockSize * blocksPerWeek > periodsPerWeek) {
      throw new BadRequestException(
        `${blocksPerWeek} blocks × ${blockSize} periods = ${blocksPerWeek * blockSize}, which exceeds ${periodsPerWeek} periods/week (§4.8)`,
      );
    }
    return {
      periodsPerWeek,
      maxPeriodsPerDay: body.maxPeriodsPerDay != null ? toInt(body.maxPeriodsPerDay, "maxPeriodsPerDay") : 1,
      samePeriodAcrossWeek: Boolean(body.samePeriodAcrossWeek),
      consecutiveBlockSize: blockSize,
      consecutiveBlocksPerWeek: blockSize > 1 ? blocksPerWeek : null,
      /*
        §31.10 — cleared with the block, not kept beside it.

        "May cross a break" is a fact about a block, so a row with no block has
        no answer to give. Leaving a stale `true` behind would make it reappear
        the day somebody sets a block size again, without them ever saying so.
      */
      blockMayCrossBreak: blockSize > 1 ? Boolean(body.blockMayCrossBreak) : false,
    };
  }
}
