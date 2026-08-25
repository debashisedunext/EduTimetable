/**
 * §13.2/13.4 — AI Settings REST surface, gated on `ai.configure`, plus the
 * conversation history endpoint for the Ask AI screen (gated on `ai.chat`).
 */
import { Body, Controller, Get, NotFoundException, Param, Post, Put, Query, Req } from "@nestjs/common";
import { ALL_PERMISSIONS, PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { toInt, type AuthedRequest } from "../masters/crud.util";
import { AiSettingsService } from "./settings.service";
import { TOOL_DEFS } from "./tools";

const AI_PERMISSIONS = [PERMISSIONS.AI_CHAT, PERMISSIONS.AI_REPORTS, PERMISSIONS.AI_CONFIGURE];

@Controller("ai/settings")
@RequirePermission(PERMISSIONS.AI_CONFIGURE)
export class AiSettingsController {
  constructor(
    private readonly settings: AiSettingsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  get(@Req() req: AuthedRequest) {
    return this.settings.get(req.user.schoolId);
  }

  @Put()
  update(@Req() req: AuthedRequest, @Body() body: any) {
    return this.settings.update(req.user.schoolId, req.user.sub, body ?? {});
  }

  @Post("test")
  test(@Req() req: AuthedRequest, @Body() body: any) {
    return this.settings.testConnection(req.user.schoolId, body?.apiKey);
  }

  /**
   * The models this school's key can actually use, asked of the provider.
   * The catalogue in providers/index.ts is only the fallback — see §13.2.
   */
  @Get("models")
  models(@Req() req: AuthedRequest) {
    return this.settings.listModels(req.user.schoolId);
  }

  /** The tool whitelist, so admins can see exactly what the model may call. */
  @Get("tools")
  tools() {
    return TOOL_DEFS.map((t) => ({ name: t.name, description: t.description }));
  }

  /** §13.4 role access matrix — roles × the three AI permissions. */
  @Get("roles")
  async roles(@Req() req: AuthedRequest) {
    const rows = await this.prisma.role.findMany({
      where: { schoolId: req.user.schoolId },
      include: { permissions: true },
      orderBy: { id: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      isSystem: r.isSystem,
      ai: Object.fromEntries(
        AI_PERMISSIONS.map((p) => [p, r.permissions.some((rp) => rp.permission === p)]),
      ),
    }));
  }

  @Put("roles/:id")
  async setRoleAi(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const roleId = toInt(id, "id");
    const role = await this.prisma.role.findFirst({ where: { id: roleId, schoolId: req.user.schoolId } });
    // 200 {ok:false} was the old answer for a role belonging to another school.
    // Same reply as "that role does not exist", but with a success status the
    // caller has to look inside the body to interpret (§17.8).
    if (!role) throw new NotFoundException(`Role ${roleId} not found`);
    for (const perm of AI_PERMISSIONS) {
      const want = Boolean(body?.ai?.[perm]);
      if (want) {
        await this.prisma.rolePermission.upsert({
          where: { roleId_permission: { roleId, permission: perm } },
          create: { roleId, permission: perm, schoolId: req.user.schoolId },
          update: {},
        });
      } else {
        await this.prisma.rolePermission.deleteMany({ where: { roleId, permission: perm } });
      }
    }
    // permission cache is short-lived; clear it so the change lands immediately
    return { ok: true, known: ALL_PERMISSIONS.length };
  }
}

@Controller("ai/chat")
@RequirePermission(PERMISSIONS.AI_CHAT)
export class AiChatController {
  constructor(private readonly prisma: PrismaService) {}

  /** Recent conversations for this user — the Ask AI sidebar. */
  @Get("conversations")
  async conversations(@Req() req: AuthedRequest) {
    const rows = await this.prisma.aiChatLog.findMany({
      where: { userId: req.user.sub, role: "user" },
      orderBy: { id: "desc" },
      take: 100,
    });
    const seen = new Map<string, { conversationId: string; preview: string; at: Date }>();
    for (const r of rows) {
      if (!seen.has(r.conversationId)) {
        seen.set(r.conversationId, {
          conversationId: r.conversationId,
          preview: (r.content ?? "").slice(0, 80),
          at: r.createdAt,
        });
      }
    }
    return [...seen.values()].slice(0, 20);
  }

  @Get("history")
  async history(@Req() req: AuthedRequest, @Query("conversationId") conversationId?: string) {
    if (!conversationId) return [];
    const rows = await this.prisma.aiChatLog.findMany({
      where: { conversationId, userId: req.user.sub, role: { in: ["user", "assistant"] } },
      orderBy: { id: "asc" },
      take: 60,
    });
    return rows.map((r) => ({
      role: r.role,
      content: r.content,
      tools: r.toolsCalled,
      at: r.createdAt,
    }));
  }
}
