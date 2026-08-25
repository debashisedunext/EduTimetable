import { Body, Controller, NotFoundException, Post, Req } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Permission, SessionTokenPayload } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../auth/permissions.service";
import { ScopeService } from "../auth/scope.service";
import { AiToolsService, TOOL_DEFS } from "./tools";

/**
 * Dev-only seam for running one §13.1 tool directly (Phase 9.10, §17.8).
 *
 * The isolation suite has to prove that the AI tools answer only about the
 * caller's own school — invariant 9's real claim. Normally a tool runs only
 * when a model decides to call it, which makes the assertion depend on an LLM
 * choosing to cooperate: a flaky, paid, and fundamentally indirect test of a
 * property that is not about the model at all. The scoping happens in the tool
 * registry, so that is where the test should reach.
 *
 * This does not widen the attack surface even in dev: it runs the *same*
 * registry, under the *same* server-side context, and the tools are read-only
 * by construction. What it cannot do is accept a school — `ToolContext` is
 * built here from the session, exactly as `AiChatGateway` builds it, so a
 * caller cannot ask about anyone else. That is the property under test.
 */
@Controller("dev")
export class DevAiToolsController {
  constructor(
    private readonly tools: AiToolsService,
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly scopes: ScopeService,
    private readonly config: ConfigService,
  ) {}

  @Post("ai-tool")
  async run(
    @Req() req: { user: SessionTokenPayload },
    @Body() body: { name?: string; args?: Record<string, unknown>; timetableConfigId?: number | null },
  ) {
    if (this.config.get("NODE_ENV") === "production") throw new NotFoundException();

    const name = String(body?.name ?? "");
    if (!TOOL_DEFS.some((t) => t.name === name)) throw new NotFoundException(`No such tool: ${name}`);

    const user = await this.prisma.user.findUnique({ where: { id: req.user.sub } });
    const perms = (await this.permissions.getForRole(user!.roleId)) as Permission[];
    const scope = await this.scopes.resolve(perms, user?.teacherId ?? null);

    // Resolved through the scoped client exactly as `AiChatGateway` does, which
    // is what makes this a faithful seam rather than a shortcut into the
    // registry: a config from another school is silently ignored, never
    // queried. Passing the raw id straight through would test a code path the
    // real assistant does not have.
    const requested = Number(body?.timetableConfigId) || null;
    const config = requested
      ? await this.prisma.timetableConfig.findFirst({ where: { id: requested } })
      : null;

    const ctx = {
      // From the session, never from the request body — the point of the test.
      schoolId: req.user.schoolId,
      scope,
      canReport: perms.includes("ai.reports" as Permission),
    };

    try {
      return { tool: name, result: await this.tools.execute(name, (body?.args ?? {}) as Record<string, any>, ctx, config?.id ?? null) };
    } catch (e) {
      // A tool that throws is not a server error: `AiChatService` catches it
      // and hands `{error}` back to the model as the tool's result, which is
      // how "no timetable selected" becomes a follow-up question rather than a
      // dead conversation. Mirrored here so this seam reports what the
      // assistant would actually see.
      return { tool: name, result: { error: (e as Error).message } };
    }
  }
}
