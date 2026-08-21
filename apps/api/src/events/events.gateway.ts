import { Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { QueueEvents } from "bullmq";
import type { Server, Socket } from "socket.io";
import type { SessionTokenPayload } from "@edutimetable/shared";

/**
 * Socket.IO gateway with the same JWT session auth as REST (§15.1) — an
 * unauthenticated socket is disconnected at handshake, mirroring the guard
 * middleware. Forwards BullMQ job progress to clients (solver progress in
 * Phase 2; the demo queue for now).
 */
@WebSocketGateway({ cors: { origin: process.env.WEB_APP_URL ?? true } })
export class EventsGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsGateway.name);
  private queueEvents!: QueueEvents;

  @WebSocketServer()
  server!: Server;

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket) {
    const token = client.handshake.auth?.token as string | undefined;
    try {
      const user = await this.jwtService.verifyAsync<SessionTokenPayload>(token ?? "");
      client.data.user = user;
      client.join(`user:${user.sub}`);
    } catch {
      client.disconnect(true);
    }
  }

  onModuleInit() {
    this.queueEvents = new QueueEvents("demo", {
      connection: {
        host: process.env.REDIS_HOST ?? "redis",
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    });
    this.queueEvents.on("progress", ({ jobId, data }) => {
      this.server.emit("demo:progress", { jobId, progress: data });
    });
    this.queueEvents.on("completed", ({ jobId }) => {
      this.server.emit("demo:completed", { jobId });
    });
    this.logger.log("Forwarding demo queue events to Socket.IO clients");
  }

  async onModuleDestroy() {
    await this.queueEvents?.close();
  }
}
