/**
 * The provider-neutral LLM contract (§13, extended for Google Gemini).
 *
 * Before this, the chat gateway spoke Anthropic's message shape directly, which
 * made "choose your provider" on the AI Settings screen a dropdown that could
 * only really pick one thing. This is the seam: the gateway drives conversations
 * in these terms, and each provider translates them to and from its own wire
 * format.
 *
 * The shape is deliberately the *intersection* of what the assistant needs, not
 * the union of what providers offer: a system prompt, a turn-by-turn history,
 * a whitelisted tool list, streamed text, and token counts. Anything a single
 * provider does uniquely (Anthropic's thinking blocks, Gemini's safety
 * settings) stays inside that provider's adapter.
 */

/** A tool the model may call. JSON Schema in, because that is what §13.1 defines. */
export interface LlmTool {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface LlmToolCall {
  /**
   * Correlates a call with its result. Anthropic supplies one; Gemini matches
   * on function name instead, so its adapter synthesises an id and maps back.
   */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmToolResult {
  id: string;
  name: string;
  /** JSON, already truncated by the caller. */
  content: string;
  isError?: boolean;
}

export type LlmMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls?: LlmToolCall[] }
  | { role: "tool"; results: LlmToolResult[] };

export interface LlmTurn {
  text: string;
  toolCalls: LlmToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmChatRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  maxTokens: number;
}

export interface LlmProvider {
  /** Matches the `AiProvider` enum value stored on ai_settings. */
  readonly id: string;
  readonly model: string;

  /** One assistant turn, streaming text as it arrives. */
  streamChat(req: LlmChatRequest, onText: (delta: string) => void): Promise<LlmTurn>;

  /** One-shot completion with no tools — the §5.7 explanation path. */
  complete(system: string, user: string, maxTokens?: number): Promise<string>;

  /** The §13.2 "Test Connection" ping: cheapest possible round trip. */
  ping(): Promise<{ ok: boolean; detail?: string }>;
}

/** Cost estimation is per provider; these are list prices, indicative only. */
export interface TokenPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}
