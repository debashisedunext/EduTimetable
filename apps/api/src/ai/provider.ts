/**
 * §5.7 / §13 — the LLM provider abstraction. Phase 5 uses it for plain-English
 * explanations; Phase 7's chat/tools plug in behind the same contract. The LLM
 * NEVER places slots or invents constraints — it only rephrases structured
 * results the rule engines produced (CLAUDE.md: deliberately narrow LLM use).
 *
 * Keys come from env for now (ANTHROPIC_API_KEY); the §13.2 AI Settings screen
 * (encrypted at rest, write-only) replaces that in Phase 7. With no key set,
 * every caller must degrade to template text — availability is a feature.
 */
import { Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";

export interface AiProvider {
  readonly name: string;
  available(): boolean;
  /** One-shot completion; callers keep outputs short and structured-in. */
  complete(system: string, user: string, maxTokens?: number): Promise<string>;
}

@Injectable()
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  private readonly logger = new Logger(AnthropicProvider.name);
  private readonly model = process.env.AI_MODEL ?? "claude-opus-5";
  private client: Anthropic | null = null;

  available(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }

  async complete(system: string, user: string, maxTokens = 800): Promise<string> {
    if (!this.available()) throw new Error("No ANTHROPIC_API_KEY configured");
    this.client ??= new Anthropic();
    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      thinking: { type: "adaptive" },
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    this.logger.log(`complete(${this.model}): ${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out`);
    return text.trim();
  }
}
