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
  /**
   * §13.5 — a drafted master-data proposal. Streamed to the client as its own
   * event rather than left inside the tool trace: the Apply button needs the
   * counts, the issues and the proposal id, and digging those out of a JSON
   * blob rendered for debugging would make the trace load-bearing.
   */
  onProposal: (p: Record<string, unknown>) => void;
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
    "CAPABILITY:",
    "- You can query and explain the timetable, and generate the standard reports.",
    "- You can NEVER place, move, swap, publish or delete a slot, and never delete or change anything that exists. If asked, explain that placement is done by the solver and the Draft Board, and point the user there.",
    p.permissions.includes(PERMISSIONS.MASTERS_MANAGE)
      ? [
          "- You CAN draft master data (classes, sections, subjects, teachers, curriculum, class teachers, subject mappings) with draftMasterData — both NEW rows and CHANGES to existing ones.",
          "  To change something, send its key plus only the fields that move: {employeeCode:'EDX-1042', maxPeriodsPerWeek:24}. Omitted fields are left alone, so never send a whole record to change one value.",
          "  A natural key cannot be changed — renaming a class or a subject creates a different one. Say so rather than attempting it.",
          "  Subject Mapping is keyed by (subject, class-section), so moving a subject to a different teacher IS a change there. Call listSubjectMappings first and send back the stored Periods/Week unchanged — it is a required column, and a guessed number rewrites it too.",
          "  A merged group's teacher and its member sections are part of what identifies it, so neither can be changed; say so and point to the Teacher Mapping screen.",
          "  You do not write it: the tool validates the rows and returns a preview, and the admin presses Apply. Say so — never claim you have added anything.",
          "  Send related sheets in ONE call: a class and its sections belong in the same draft, or the sections reference a class that does not exist yet.",
          "  NEVER invent a required value. If periods per week, an employee code, a section list or the academic year is not stated, ASK — a plausible invented number is worse than a question.",
          "  Before drafting, check what exists (listClassSections, listTeachers) so you can tell the user what is already there rather than proposing a duplicate.",
          "  After drafting, read back the counts and any problems the tool reported, and tell the user to press Apply.",
        ].join("\n")
      : "- You can NEVER add or change master data. If asked, point the user to the Setup Wizard or Import from Excel.",
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
      canWrite: p.permissions.includes(PERMISSIONS.MASTERS_MANAGE),
      userId: p.userId,
    };
    const toolDefs = TOOL_DEFS.filter(
      (t) =>
        (t.name !== "generateReport" || ctx.canReport) &&
        // §13.5 — a user without `masters.manage` is never even shown the
        // drafting tool, so the model cannot offer what they may not do.
        (t.name !== "draftMasterData" || ctx.canWrite),
    );

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
      messages.push({
        role: "assistant",
        text: turn.text,
        toolCalls: turn.toolCalls,
        providerRaw: turn.providerRaw,
      });

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
          if (call.name === "draftMasterData" && payload && typeof payload === "object") {
            events.onProposal(payload as Record<string, unknown>);
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
