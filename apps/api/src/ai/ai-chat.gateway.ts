/**
 * §13.3 — the chat namespace. Auth and permission are enforced HERE, at the
 * socket layer: a hand-crafted client without `ai.chat` is disconnected at
 * handshake, so hiding the nav item stays purely cosmetic. Answers stream
 * token-by-token over the same Socket.IO infrastructure as solver progress.
 */
import { Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { OnGatewayConnection, SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import type { Socket } from "socket.io";
import { randomUUID } from "node:crypto";
import { PERMISSIONS, type Permission, type SessionTokenPayload } from "@edutimetable/shared";
import { PermissionsService } from "../auth/permissions.service";
import { ScopeService } from "../auth/scope.service";
import { PrismaService } from "../prisma/prisma.service";
import { AiChatService } from "./chat.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { TenantConnectionsService } from "../prisma/tenant-connections.service";

@WebSocketGateway({ namespace: "/ai", cors: { origin: process.env.WEB_APP_URL ?? true } })
export class AiChatGateway implements OnGatewayConnection {
  private readonly logger = new Logger(AiChatGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly permissions: PermissionsService,
    private readonly scopes: ScopeService,
    private readonly prisma: PrismaService,
    private readonly chat: AiChatService,
    private readonly tenant: TenantContextService,
    private readonly connections: TenantConnectionsService,
  ) {}

  async handleConnection(client: Socket) {
    // Socket.IO delivers messages as soon as the transport is up, without
    // waiting for this async handshake — so a client that asks immediately on
    // `connect` could arrive before the session was attached and be told it is
    // "not authorised", which is both wrong and confusing. Messages await this.
    const ready = this.authenticate(client);
    client.data.ready = ready;
    await ready;
  }

  private async authenticate(client: Socket) {
    try {
      const token = client.handshake.auth?.token as string | undefined;
      const session = await this.jwt.verifyAsync<SessionTokenPayload>(token ?? "");
      const perms = (await this.permissions.getForRole(session.roleId)) as Permission[];
      if (!perms.includes(PERMISSIONS.AI_CHAT)) {
        // server-side refusal — the client may look however it likes
        client.emit("ai:error", { message: "Your role does not have AI chat access (ai.chat)." });
        client.disconnect(true);
        return;
      }
      client.data.session = session;
      client.data.permissions = perms;
    } catch {
      client.disconnect(true);
    }
  }

  @SubscribeMessage("ai:ask")
  async onAsk(
    client: Socket,
    body: { question?: string; conversationId?: string; timetableConfigId?: number | null },
  ) {
    // Wait for the handshake rather than racing it (see handleConnection).
    await client.data.ready;
    const session = client.data.session as SessionTokenPayload | undefined;
    const perms = (client.data.permissions ?? []) as Permission[];
    if (!session || !perms.includes(PERMISSIONS.AI_CHAT)) {
      client.emit("ai:error", { message: "Not authorised for AI chat." });
      return;
    }
    const question = String(body?.question ?? "").trim();
    if (!question) return;
    const conversationId = body?.conversationId || randomUUID();

    // A Socket.IO message never passes through the HTTP middleware, so nothing
    // has opened a tenant context for it (9.1 / §17). Without this, every query
    // below — including the conversation history and the audit log — runs
    // unscoped, and for a school with its own database would run against the
    // wrong one entirely (9.4 / §17.5). The school comes from the signed
    // session token, exactly as it does for REST.
    const client_ = await this.connections.clientFor(session.tenantId);
    await this.tenant.runAs(
      {
        schoolId: session.schoolId,
        tenantId: session.tenantId ?? null,
        client: client_,
        userId: session.sub,
        origin: "ai:ask",
      },
      () => this.handleAsk(client, session, perms, question, conversationId, body),
    );
  }

  private async handleAsk(
    client: Socket,
    session: SessionTokenPayload,
    perms: Permission[],
    question: string,
    conversationId: string,
    body: { timetableConfigId?: number | null },
  ) {
    try {
      const user = await this.prisma.user.findUnique({ where: { id: session.sub } });
      const scope = await this.scopes.resolve(perms, user?.teacherId ?? null);
      const configId = Number(body?.timetableConfigId) || null;
      // Scoped by the context opened above, so a config from another school
      // simply is not found.
      const config = configId ? await this.prisma.timetableConfig.findFirst({ where: { id: configId } }) : null;

      client.emit("ai:start", { conversationId });
      const { answer, tools } = await this.chat.ask(
        {
          schoolId: session.schoolId,
          userId: session.sub,
          userName: user?.name ?? "a staff user",
          permissions: perms,
          scope,
          conversationId,
          question,
          // a config from another school is silently ignored, never queried
          timetableConfigId: config?.id ?? null,
          timetableName: config?.name ?? null,
        },
        {
          onDelta: (text) => client.emit("ai:delta", { conversationId, text }),
          onTool: (t) => client.emit("ai:tool", { conversationId, ...t }),
          onCard: (card) => client.emit("ai:card", { conversationId, card }),
        },
      );
      client.emit("ai:done", { conversationId, answer, tools });
    } catch (e) {
      this.logger.warn(`ai:ask failed — ${(e as Error).message}`);
      client.emit("ai:error", { conversationId, message: (e as Error).message });
    }
  }
}
