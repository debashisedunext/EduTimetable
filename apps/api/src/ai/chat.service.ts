/**
 * §13.1/13.3 — the AI Gateway: conversation state, a provider-neutral tool-use
 * loop with streaming, grounded-answers-only prompting, and per-message audit
 * logging with token counts.
 *
 * The loop is expressed in the ./providers contract, not in any one vendor's
 * message shape, so the same grounding prompt, the same whitelisted tools and
 * the same audit trail apply whether the school chose Claude or Gemini.
 *
 * Hard rules encoded here:
 *  - the model receives NO scope arguments; the gateway injects school + view
 *    scope into every tool execution, so a prompt cannot widen access,
 *  - the model may only call the §13.1 whitelist — never SQL, never writes,
 *  - every turn is written to ai_chat_log with the tools it actually ran.
 */
import { Injectable, Logger } from "@nestjs/common";
import { PERMISSIONS, type Permission, type ViewScope } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AiSettingsService } from "./settings.service";
import { AiToolsService, TOOL_DEFS, type ToolContext } from "./tools";
import type { LlmMessage, LlmToolResult } from "./providers";

export interface AskParams {
  schoolId: number;
  userId: number;
  userName: string;
  permissions: Permission[];
  scope: ViewScope;
  conversationId: string;
  question: string;
  timetableConfigId: number | null;
  timetableName: string | null;
}

export interface AskEvents {
  onDelta: (text: string) => void;
  onTool: (t: { name: string; args: Record<string, unknown>; ok: boolean; summary: string }) => void;
  onCard: (card: Record<string, unknown>) => void;
}

const MAX_TOOL_ROUNDS = 6;

function systemPrompt(p: AskParams): string {
  return [
    "You are the timetable assistant inside the Edunext school ERP. You answer questions about this school's timetable for a staff user.",
    "",
    "GROUNDING — this is absolute:",
    "- Answer ONLY from the results of the tools available to you. Never guess, extrapolate, or fill gaps from general knowledge.",
    "- Every number, name, day, period or room you state must come from a tool result in this conversation.",
    "- If the tools do not contain the answer, say plainly what you do not have and which detail you would need. Never invent it.",
    "- If a tool returns an error about permissions or scope, tell the user that data is outside their access — do not try other tools to work around it.",
    "",
    "CAPABILITY — you are read-only:",
    "- You can query and explain the timetable, and generate the standard reports.",
    "- You can NEVER place, move, swap, publish or delete a slot, and never change master data. If asked, explain that placement is done by the solver and the Draft Board, and point the user there.",
    "",
    "STYLE:",
    "- Be brief and concrete. Lead with the answer, then the supporting detail.",
    "- For lists of 3+ rows use a compact markdown table.",
    "- Use the school's own labels ('Class 5-A', 'P3', teacher names) rather than ids.",
    "- Resolve names to ids with listTeachers / listClassSections before calling the grid tools.",
    "",
    `CONTEXT: the user is ${p.userName}.`,
    p.timetableConfigId
      ? `The conversation is about the "${p.timetableName}" timetable (id ${p.timetableConfigId}); omit timetable_config_id to use it.`
      : "No timetable is selected — call getTimetableConfigs if a question needs one.",
    p.permissions.includes(PERMISSIONS.AI_REPORTS)
      ? "This user may generate report files."
      : "This user may NOT generate report files — answer in chat instead and do not call generateReport.",
  ].join("\n");
}

@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AiSettingsService,
    private readonly tools: AiToolsService,
  ) {}

  /** Replay a stored conversation (user/assistant text only, no tool traffic). */
  private async history(conversationId: string, schoolId: number): Promise<LlmMessage[]> {
    const rows = await this.prisma.aiChatLog.findMany({
      where: { conversationId, schoolId, role: { in: ["user", "assistant"] } },
      orderBy: { id: "asc" },
      take: 40,
    });
    return rows
      .filter((r) => (r.content ?? "").trim().length > 0)
      .map((r) =>
        r.role === "user"
          ? ({ role: "user", text: r.content as string } as const)
          : ({ role: "assistant", text: r.content as string } as const),
      );
  }

  async ask(p: AskParams, events: AskEvents): Promise<{ answer: string; tools: string[] }> {
    const provider = await this.settings.client(p.schoolId);
    if (!provider) {
      throw new Error(
        "No AI provider key is configured. An administrator can add one on the AI Settings screen (Intelligence → AI Settings).",
      );
    }
    await this.settings.assertWithinBudget(p.schoolId);

    const ctx: ToolContext = {
      schoolId: p.schoolId,
      scope: p.scope,
      canReport: p.permissions.includes(PERMISSIONS.AI_REPORTS),
    };
    const toolDefs = TOOL_DEFS.filter((t) => t.name !== "generateReport" || ctx.canReport);

    const messages: LlmMessage[] = [
      ...(await this.history(p.conversationId, p.schoolId)),
      { role: "user", text: p.question },
    ];
    await this.settings.log({
      schoolId: p.schoolId,
      userId: p.userId,
      conversationId: p.conversationId,
      role: "user",
      content: p.question,
    });

    let answer = "";
    const toolsUsed: Array<{ name: string; args: Record<string, unknown> }> = [];
    let inputTokens = 0;
    let outputTokens = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const turn = await provider.streamChat(
        {
          system: systemPrompt(p),
          messages,
          tools: toolDefs,
          maxTokens: 4096,
        },
        (delta) => {
          answer += delta;
          events.onDelta(delta);
        },
      );
      inputTokens += turn.usage.inputTokens;
      outputTokens += turn.usage.outputTokens;
      messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });

      if (turn.toolCalls.length === 0) break;

      const results: LlmToolResult[] = [];
      for (const call of turn.toolCalls) {
        const args = call.args ?? {};
        let ok = true;
        let payload: unknown;
        try {
          payload = await this.tools.execute(call.name, args, ctx, p.timetableConfigId);
          if (payload && typeof payload === "object" && (payload as any).reportCard) {
            events.onCard(payload as Record<string, unknown>);
          }
        } catch (e) {
          ok = false;
          payload = { error: (e as Error).message };
        }
        toolsUsed.push({ name: call.name, args });
        const text = JSON.stringify(payload);
        events.onTool({
          name: call.name,
          args,
          ok,
          summary: ok ? `${text.length.toLocaleString()} bytes` : String((payload as any).error),
        });
        await this.settings.log({
          schoolId: p.schoolId,
          userId: p.userId,
          conversationId: p.conversationId,
          role: "tool",
          content: text.slice(0, 20_000),
          toolsCalled: [{ name: call.name, args, ok }],
        });
        results.push({
          id: call.id,
          name: call.name,
          content: text.slice(0, 60_000),
          ...(ok ? {} : { isError: true }),
        });
      }
      messages.push({ role: "tool", results });
    }

    await this.settings.log({
      schoolId: p.schoolId,
      userId: p.userId,
      conversationId: p.conversationId,
      role: "assistant",
      content: answer,
      toolsCalled: toolsUsed,
      inputTokens,
      outputTokens,
    });
    this.logger.log(
      `conversation ${p.conversationId} [${provider.id}/${provider.model}]: ` +
        `${toolsUsed.length} tool call(s), ${inputTokens} in / ${outputTokens} out`,
    );
    return { answer, tools: toolsUsed.map((t) => t.name) };
  }
}
