import { BadRequestException, Controller, Get, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type Redis from "ioredis";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { REDIS } from "../redis/redis.module";
import { ReadinessService } from "../readiness/readiness.service";
import { toInt, type AuthedRequest } from "../masters/crud.util";

export const SOLVER_QUEUE = "solver";

@Controller("timetable-configs/:id")
export class SolverController {
  constructor(
    @InjectQueue(SOLVER_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Trigger generation (§8 screen 4). Hard-gated on Phase A: not ready → 400. */
  @Post("generate")
  @RequirePermission(PERMISSIONS.TIMETABLE_GENERATE)
  async generate(@Req() _req: AuthedRequest, @Param("id") id: string) {
    const configId = toInt(id, "id");
    const readiness = await this.readiness.getReadiness(configId);
    if (!readiness.ready) {
      throw new BadRequestException(
        `Readiness is ${readiness.score}% with ${readiness.blockers.length} blocker(s) — generation is only offered at 100% (§4)`,
      );
    }
    const job = await this.queue.add("solve", { configId });
    return { jobId: job.id };
  }

  /**
   * Compact slot matrix (§8.3, perf budget §14): flat arrays, no ORM graphs,
   * Redis-cached until the next write. meta carries the display dictionaries.
   */
  @Get("slots")
  @RequirePermission(PERMISSIONS.TIMETABLE_VIEW_ALL)
  async slots(@Param("id") id: string, @Query("status") statusQ?: string) {
    const configId = toInt(id, "id");
    const status = statusQ === "published" ? "published" : "draft";
    const cacheKey = `slots:${configId}:${status}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const [slots, sections, config] = await Promise.all([
      this.prisma.timetableSlot.findMany({
        where: { timetableConfigId: configId, status },
        select: {
          id: true, classSectionId: true, dayOfWeek: true, periodNumber: true,
          subjectId: true, teacherId: true, roomId: true, mergedGroupId: true, isLocked: true,
        },
      }),
      this.prisma.classSection.findMany({
        where: { timetableConfigId: configId },
        include: { class: true, section: true },
        orderBy: [{ class: { sequence: "asc" } }, { section: { name: "asc" } }],
      }),
      this.prisma.timetableConfig.findUnique({
        where: { id: configId },
        include: { periods: { orderBy: { sortOrder: "asc" } } },
      }),
    ]);
    if (!config) throw new BadRequestException("Timetable config not found");

    const subjectIds = [...new Set(slots.map((s) => s.subjectId).filter((x): x is number => x !== null))];
    const teacherIds = [...new Set(slots.map((s) => s.teacherId).filter((x): x is number => x !== null))];
    const roomIds = [...new Set(slots.map((s) => s.roomId).filter((x): x is number => x !== null))];
    const [subjects, teachers, rooms] = await Promise.all([
      this.prisma.subject.findMany({ where: { id: { in: subjectIds } } }),
      this.prisma.teacher.findMany({ where: { id: { in: teacherIds } } }),
      this.prisma.room.findMany({ where: { id: { in: roomIds } } }),
    ]);

    const payload = {
      status,
      workingDays: config.workingDays as number[],
      periods: config.periods.map((p) => ({
        periodNumber: p.periodNumber, startTime: p.startTime, endTime: p.endTime,
        isBreak: p.isBreak, breakName: p.breakName,
      })),
      sections: sections.map((cs) => ({ id: cs.id, label: `${cs.class.name}-${cs.section.name}` })),
      subjects: Object.fromEntries(subjects.map((s) => [s.id, s.name])),
      teachers: Object.fromEntries(teachers.map((t) => [t.id, t.name])),
      rooms: Object.fromEntries(rooms.map((r) => [r.id, r.name])),
      // compact tuples: [classSectionId, day, period, subjectId, teacherId, roomId, mergedGroupId, locked]
      slots: slots.map((s) => [
        s.classSectionId, s.dayOfWeek, s.periodNumber,
        s.subjectId, s.teacherId, s.roomId, s.mergedGroupId, s.isLocked ? 1 : 0,
      ]),
    };
    await this.redis.set(cacheKey, JSON.stringify(payload), "EX", 3600);
    return payload;
  }

  /** Latest solver job summary for the Generate screen's result panel. */
  @Get("generate/latest")
  @RequirePermission(PERMISSIONS.TIMETABLE_GENERATE)
  async latest(@Param("id") id: string) {
    const configId = toInt(id, "id");
    const jobs = await this.queue.getJobs(["completed", "failed", "active", "waiting"], 0, 20);
    const mine = jobs
      .filter((j) => j.data?.configId === configId)
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (!mine) return { state: "none" };
    const state = await mine.getState();
    return {
      state,
      jobId: mine.id,
      result: mine.returnvalue ?? null,
      failedReason: mine.failedReason ?? null,
    };
  }
}
