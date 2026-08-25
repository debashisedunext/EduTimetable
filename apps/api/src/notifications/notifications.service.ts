/**
 * §9 Notifications engine: one `notifications` table + real-time Socket.IO
 * delivery to each recipient's `user:{id}` room. Email/push ride on the
 * Edunext ERP's existing provider — the channel hook here logs until that
 * integration lands (documented deferral).
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { QueueEvents } from "bullmq";
import { PERMISSIONS } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EventsGateway } from "../events/events.gateway";
import { TenantContextService } from "../tenant/tenant-context.service";

export interface NotifyInput {
  type: string;
  title: string;
  body: string;
  link?: string | null;
}

@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private solverEvents?: QueueEvents;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly tenant: TenantContextService,
  ) {}

  /** Create rows for explicit user ids + push each over their socket room. */
  async notifyUsers(userIds: number[], n: NotifyInput) {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return { created: 0 };
    await this.prisma.notification.createMany({
      data: ids.map((userId) => ({
        schoolId: this.tenant.requireSchoolId(),
        userId,
        type: n.type,
        title: n.title,
        body: n.body,
        link: n.link ?? null,
      })),
    });
    for (const id of ids) {
      this.events.emitToUser(id, "notification:new", { ...n });
    }
    // email/push channel: reuse the Edunext parent-app provider when wired (§9)
    this.logger.log(`notify[${n.type}] → ${ids.length} user(s): ${n.title}`);
    return { created: ids.length };
  }

  /** All active users of a school whose role holds the given permission. */
  async notifyByPermission(schoolId: number, permission: string, n: NotifyInput) {
    const users = await this.prisma.user.findMany({
      where: {
        schoolId,
        isActive: true,
        role: { permissions: { some: { permission } } },
      },
      select: { id: true },
    });
    return this.notifyUsers(users.map((u) => u.id), n);
  }

  /** Users linked to the given teacher ids (substitute pings, publish fan-out). */
  async notifyTeachers(teacherIds: number[], n: NotifyInput) {
    const users = await this.prisma.user.findMany({
      where: { teacherId: { in: teacherIds }, isActive: true },
      select: { id: true },
    });
    return this.notifyUsers(users.map((u) => u.id), n);
  }

  /** Admins who manage timetables (feasibility/solver/publish triggers). */
  notifyAdmins(schoolId: number, n: NotifyInput) {
    return this.notifyByPermission(schoolId, PERMISSIONS.TIMETABLE_GENERATE, n);
  }

  // ---- §9 trigger: "Solver run completes" — listen on the queue directly so
  // the worker process needs no Nest context and no HTTP callback ----
  onModuleInit() {
    this.solverEvents = new QueueEvents("solver", {
      connection: {
        host: process.env.REDIS_HOST ?? "redis",
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    });
    this.solverEvents.on("completed", async ({ returnvalue }) => {
      try {
        const r = returnvalue as unknown as {
          configId?: number;
          userId?: number;
          schoolId?: number;
          placements?: number;
          total?: number;
          unplaced?: number;
        };
        if (!r || r.userId === undefined) return;
        if (typeof r.schoolId !== "number") {
          this.logger.warn("solver summary carried no schoolId — skipping notification");
          return;
        }
        const unplacedCount = Array.isArray(r.unplaced) ? r.unplaced.length : (r.unplaced ?? 0);
        const pct = r.total ? Math.round(((r.placements ?? 0) / r.total) * 1000) / 10 : 100;
        // Queue events arrive outside any request, so the context the
        // notification row and its socket push need is opened here from the
        // job summary (9.1 / §17).
        await this.tenant.runAs({ schoolId: r.schoolId, origin: "solver-completed" }, () =>
          this.notifyUsers([r.userId as number], {
          type: "solver_completed",
          title: "Timetable generated",
          body: `${r.placements ?? 0}/${r.total ?? 0} variables placed (${pct}%).${unplacedCount > 0 ? ` ${unplacedCount} need manual placement on the Draft Board.` : " Conflict-free draft is ready to review."}`,
          link: "/matrix",
          }),
        );
      } catch (e) {
        this.logger.warn(`solver-completed notification failed: ${(e as Error).message}`);
      }
    });
  }

  async onModuleDestroy() {
    await this.solverEvents?.close();
  }
}
