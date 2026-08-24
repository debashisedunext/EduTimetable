import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { del, requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";
import { assertWithinWeek, capacityForClass } from "./capacity.util";

/** Curriculum mapping — class_subjects (§3), with §4.8 block validation at entry. */
@Controller("class-subjects")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class CurriculumController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    const rows = await this.prisma.classSubject.findMany({
      where: { class: { schoolId: req.user.schoolId } },
      include: { class: true, subject: true },
      orderBy: [{ class: { sequence: "asc" } }, { subject: { name: "asc" } }],
    });
    return rows.map((r) => ({
      id: r.id,
      classId: r.classId,
      className: r.class.name,
      subjectId: r.subjectId,
      subjectName: r.subject.name,
      periodsPerWeek: r.periodsPerWeek,
      maxPeriodsPerDay: r.maxPeriodsPerDay,
      samePeriodAcrossWeek: r.samePeriodAcrossWeek,
      consecutiveBlockSize: r.consecutiveBlockSize,
      consecutiveBlocksPerWeek: r.consecutiveBlocksPerWeek,
    }));
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["classId", "subjectId", "periodsPerWeek"]);
    const data = this.normalize(body);
    assertWithinWeek(data.periodsPerWeek, await capacityForClass(this.prisma, toInt(body.classId, "classId")));
    const created = await uniq(
      () => this.prisma.classSubject.create({ data: { ...data, classId: toInt(body.classId, "classId"), subjectId: toInt(body.subjectId, "subjectId") } }),
      "Curriculum row for that class & subject",
    );
    await this.readiness.invalidate(req.user.schoolId);
    return created;
  }

  @Put(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const existing = await this.prisma.classSubject.findUnique({ where: { id: toInt(id, "id") } });
    if (!existing) throw new BadRequestException("Curriculum row not found");
    const data = this.normalize({ ...existing, ...body });
    assertWithinWeek(data.periodsPerWeek, await capacityForClass(this.prisma, existing.classId));
    const updated = await this.prisma.classSubject.update({
      where: { id: existing.id },
      data,
    });
    await this.readiness.invalidate(req.user.schoolId);
    return updated;
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
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
    };
  }
}
