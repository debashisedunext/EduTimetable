import { Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { JwtService } from "@nestjs/jwt";
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Queue, QueueEvents } from "bullmq";
import type { Server, Socket } from "socket.io";
import type { SessionTokenPayload } from "@edutimetable/shared";
import { DEMO_QUEUE } from "../demo/demo.constants";
import { TenantContextService } from "../tenant/tenant-context.service";

/** Everyone signed in to one school. The only room job events are sent to. */
export const schoolRoom = (schoolId: number) => `school:${schoolId}`;
/** One user, across their open tabs. */
export const userRoom = (userId: number) => `user:${userId}`;

/**
 * Socket.IO gateway with the same JWT session auth as REST (§15.1) — an
 * unauthenticated socket is disconnected at handshake, mirroring the guard
 * middleware. Forwards BullMQ job progress to clients.
 *
 * 9.1 (§17): every emit is addressed to a school room. This gateway previously
 * used `server.emit(...)`, which broadcast solver progress, completion,
 * failure reasons and readiness invalidations to **every connected client in
 * the deployment** — a genuine cross-school leak the moment a second school
 * exists, and needless work even with one.
 *
 * Job events arrive from BullMQ carrying only a job id, so the school is
 * resolved from the job's own data and memoised for the life of the run
 * (progress fires repeatedly; the lookup should not).
 */
@WebSocketGateway({ cors: { origin: process.env.WEB_APP_URL ?? true } })
export class EventsGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsGateway.name);
  private queueEvents!: QueueEvents;
  private solverEvents!: QueueEvents;
  private readonly jobSchool = new Map<string, number>();

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly tenant: TenantContextService,
    @InjectQueue("solver") private readonly solverQueue: Queue,
    @InjectQueue(DEMO_QUEUE) private readonly demoQueue: Queue,
  ) {}

  async handleConnection(client: Socket) {
    const token = client.handshake.auth?.token as string | undefined;
    try {
      const user = await this.jwtService.verifyAsync<SessionTokenPayload>(token ?? "");
      client.data.user = user;
      client.join(userRoom(user.sub));
      client.join(schoolRoom(user.schoolId));
    } catch {
      client.disconnect(true);
    }
  }

  /** The only sanctioned way to push an event about one school's data. */
  emitToSchool(schoolId: number, event: string, payload: unknown) {
    this.server?.to(schoolRoom(schoolId)).emit(event, payload);
  }

  emitToUser(userId: number, event: string, payload: unknown) {
    this.server?.to(userRoom(userId)).emit(event, payload);
  }

  /**
   * Emit to the school of the request currently being handled. This is what
   * the board, publish and substitute services use — the alternative would be
   * threading a schoolId through call sites that already run inside a scoped
   * request. Throws outside a context rather than falling back to a broadcast.
   */
  emitToCurrentSchool(event: string, payload: unknown) {
    const schoolId = this.tenant.schoolId();
    if (schoolId === null) {
      this.logger.error(`Refusing to emit '${event}' with no tenant context — it would broadcast`);
      return;
    }
    this.emitToSchool(schoolId, event, payload);
  }

  /**
   * Which school owns a job. Memoised because `progress` fires many times per
   * run; evicted by the terminal event.
   */
  private async schoolOfJob(queue: Queue, jobId: string): Promise<number | null> {
    const memo = this.jobSchool.get(jobId);
    if (memo !== undefined) return memo;
    const job = await queue.getJob(jobId);
    const schoolId = typeof job?.data?.schoolId === "number" ? job.data.schoolId : null;
    if (schoolId === null) {
      // Not fatal, but the event is dropped rather than broadcast — silently
      // widening the audience is exactly the bug 9.1 removes.
      this.logger.warn(`Job ${jobId} carries no schoolId; dropping its client event`);
      return null;
    }
    this.jobSchool.set(jobId, schoolId);
    return schoolId;
  }

  private forward(queue: Queue, events: QueueEvents, prefix: string) {
    events.on("progress", async ({ jobId, data }) => {
      const schoolId = await this.schoolOfJob(queue, jobId);
      if (schoolId === null) return;
      const payload =
        prefix === "demo" ? { jobId, progress: data } : { jobId, ...(data as object) };
      this.emitToSchool(schoolId, `${prefix}:progress`, payload);
    });
    events.on("completed", async ({ jobId, returnvalue }) => {
      const schoolId = await this.schoolOfJob(queue, jobId);
      this.jobSchool.delete(jobId);
      if (schoolId === null) return;
      const payload = prefix === "demo" ? { jobId } : { jobId, result: returnvalue };
      this.emitToSchool(schoolId, `${prefix}:completed`, payload);
    });
    events.on("failed", async ({ jobId, failedReason }) => {
      const schoolId = await this.schoolOfJob(queue, jobId);
      this.jobSchool.delete(jobId);
      if (schoolId === null) return;
      this.emitToSchool(schoolId, `${prefix}:failed`, { jobId, reason: failedReason });
    });
  }

  onModuleInit() {
    const connection = {
      host: process.env.REDIS_HOST ?? "redis",
      port: Number(process.env.REDIS_PORT ?? 6379),
    };
    this.queueEvents = new QueueEvents(DEMO_QUEUE, { connection });
    this.forward(this.demoQueue, this.queueEvents, "demo");
    this.solverEvents = new QueueEvents("solver", { connection });
    this.forward(this.solverQueue, this.solverEvents, "solver");
    this.logger.log("Forwarding demo + solver queue events to their school's clients");
  }

  async onModuleDestroy() {
    await this.queueEvents?.close();
    await this.solverEvents?.close();
  }
}
