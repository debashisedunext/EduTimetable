/**
 * §13.1/13.3 — the AI Gateway: conversation state, the Anthropic tool-use loop
 * with streaming and adaptive thinking, grounded-answers-only prompting, and
 * per-message audit logging with token counts.
 *
 * Hard rules encoded here:
 *  - the model receives NO scope arguments; the gateway injects school + view
 *    scope into every tool execution, so a prompt cannot widen access,
 *  - the model may only call the §13.1 whitelist — never SQL, never writes,
 *  - every turn is written to ai_chat_log with the tools it actually ran.
 */
import { Injectable, Logger } from "@nestjs/common";
import type Anthropic from "@anthropic-ai/sdk";
import { PERMISSIONS, type Permission, type ViewScope } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AiSettingsService } from "./settings.service";
import { AiToolsService, TOOL_DEFS, type ToolContext } from "./tools";

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

  /** Replay a stored conversation as Anthropic messages (user/assistant text only). */
  private async history(conversationId: string, schoolId: number): Promise<Anthropic.MessageParam[]> {
    const rows = await this.prisma.aiChatLog.findMany({
      where: { conversationId, schoolId, role: { in: ["user", "assistant"] } },
      orderBy: { id: "asc" },
      take: 40,
    });
    return rows
      .filter((r) => (r.content ?? "").trim().length > 0)
      .map((r) => ({ role: r.role === "user" ? "user" : "assistant", content: r.content as string }) as Anthropic.MessageParam);
  }

  async ask(p: AskParams, events: AskEvents): Promise<{ answer: string; tools: string[] }> {
    const resolved = await this.settings.client(p.schoolId);
    if (!resolved) {
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

    const messages: Anthropic.MessageParam[] = [
      ...(await this.history(p.conversationId, p.schoolId)),
      { role: "user", content: p.question },
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
      const stream = resolved.client.messages.stream({
        model: resolved.model,
        max_tokens: 4096,
        thinking: { type: "adaptive" },
        system: systemPrompt(p),
        tools: toolDefs as unknown as Anthropic.Tool[],
        messages,
      });

      stream.on("text", (delta) => {
        answer += delta;
        events.onDelta(delta);
      });

      const final = await stream.finalMessage();
      inputTokens += final.usage.input_tokens;
      outputTokens += final.usage.output_tokens;

      if (final.stop_reason !== "tool_use") {
        messages.push({ role: "assistant", content: final.content });
        break;
      }

      messages.push({ role: "assistant", content: final.content });
      const results: Anthropic.ToolResultBlockParam[] = [];

      for (const block of final.content) {
        if (block.type !== "tool_use") continue;
        const args = (block.input ?? {}) as Record<string, any>;
        let ok = true;
        let payload: unknown;
        try {
          payload = await this.tools.execute(block.name, args, ctx, p.timetableConfigId);
          if (payload && typeof payload === "object" && (payload as any).reportCard) {
            events.onCard(payload as Record<string, unknown>);
          }
        } catch (e) {
          ok = false;
          payload = { error: (e as Error).message };
        }
        toolsUsed.push({ name: block.name, args });
        const text = JSON.stringify(payload);
        events.onTool({
          name: block.name,
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
          toolsCalled: [{ name: block.name, args, ok }],
        });
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: text.slice(0, 60_000),
          ...(ok ? {} : { is_error: true }),
        });
      }
      messages.push({ role: "user", content: results });
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
      `conversation ${p.conversationId}: ${toolsUsed.length} tool call(s), ${inputTokens} in / ${outputTokens} out`,
    );
    return { answer, tools: toolsUsed.map((t) => t.name) };
  }
}
