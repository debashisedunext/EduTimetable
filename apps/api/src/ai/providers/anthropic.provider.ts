/**
 * Anthropic adapter (§13). The default provider, and the one the grounding
 * prompt and tool registry were designed against.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  LlmChatRequest,
  LlmMessage,
  LlmProvider,
  LlmTurn,
} from "./types";

/** Models that take `thinking: { type: "adaptive" }` rather than a token budget. */
const ADAPTIVE_THINKING = /^claude-(opus-5|sonnet-5|fable-5|opus-4-[678]|sonnet-4-6)/;

function toAnthropic(messages: LlmMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => {
    if (m.role === "user") return { role: "user", content: m.text };
    if (m.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.text.trim()) blocks.push({ type: "text", text: m.text });
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      }
      return { role: "assistant", content: blocks.length > 0 ? blocks : m.text || "…" };
    }
    // Tool results travel back as a user turn — Anthropic's convention.
    return {
      role: "user",
      content: m.results.map(
        (r): Anthropic.ToolResultBlockParam => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        }),
      ),
    };
  });
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly id = "anthropic";
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
    baseUrl?: string | null,
  ) {
    this.client = new Anthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  }

  private thinking() {
    return ADAPTIVE_THINKING.test(this.model)
      ? ({ thinking: { type: "adaptive" } } as const)
      : {};
  }

  async streamChat(req: LlmChatRequest, onText: (delta: string) => void): Promise<LlmTurn> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: req.maxTokens,
      ...this.thinking(),
      system: req.system,
      tools: req.tools as unknown as Anthropic.Tool[],
      messages: toAnthropic(req.messages),
    });
    stream.on("text", onText);
    const final = await stream.finalMessage();

    return {
      text: final.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join(""),
      toolCalls: final.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> })),
      usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens },
    };
  }

  async complete(system: string, user: string, maxTokens = 800): Promise<string> {
    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      ...this.thinking(),
      system,
      messages: [{ role: "user", content: user }],
    });
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
    return { ok: true, detail: res.stop_reason ?? undefined };
  }
}
