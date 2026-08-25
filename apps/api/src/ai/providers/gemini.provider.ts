/**
 * Google Gemini adapter (§13).
 *
 * Talks the Generative Language REST API directly rather than through an SDK.
 * That is a deliberate choice, not laziness: the surface we need is four
 * things — system instruction, contents, function declarations, SSE streaming —
 * all of which are stable, and `fetch` keeps the api image free of another
 * dependency whose major versions would need tracking alongside Anthropic's.
 * Everything Gemini-shaped is confined to this file.
 *
 * Two differences from Anthropic that the mapping has to absorb:
 *
 *   1. **No tool-call ids.** Gemini correlates a `functionCall` with its
 *      `functionResponse` by function *name*. Ids are synthesised here so the
 *      gateway's neutral contract still holds, and results are matched back by
 *      name on the way out.
 *
 *   2. **A stricter schema dialect.** Function parameters are an OpenAPI 3.0
 *      subset, not full JSON Schema — `minimum`, `maximum` and
 *      `additionalProperties` are rejected outright. §13.1's tool definitions
 *      use some of those, so they are translated (a numeric range becomes part
 *      of the description, which is what actually steers the model anyway)
 *      rather than silently dropped.
 */
import type {
  LlmChatRequest,
  LlmMessage,
  LlmProvider,
  LlmTool,
  LlmToolCall,
  LlmTurn,
} from "./types";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  /** Opaque token a thinking model attaches to its own parts; must be replayed
   *  verbatim or a follow-up request carrying a functionCall is rejected. */
  thoughtSignature?: string;
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}
interface GeminiChunk {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    /** Gemini 3.x is a thinking model; these are billed as output but are
     *  reported separately from candidatesTokenCount. */
    thoughtsTokenCount?: number;
  };
  error?: { message?: string; status?: string };
}

/**
 * JSON Schema → Gemini's OpenAPI subset.
 *
 * Unsupported keywords are removed rather than passed through, because Gemini
 * rejects the whole request when it meets one — a single `minimum` would take
 * the entire tool registry down. Constraints that carry meaning for the model
 * are folded into the description so nothing is actually lost.
 */
export function toGeminiSchema(schema: unknown): Record<string, unknown> | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (typeof src.type === "string") out.type = src.type.toUpperCase();
  if (typeof src.format === "string") out.format = src.format;
  if (Array.isArray(src.enum)) out.enum = src.enum.map(String);

  const notes: string[] = [];
  if (typeof src.description === "string") notes.push(src.description);
  if (typeof src.minimum === "number" || typeof src.maximum === "number") {
    const lo = src.minimum ?? "any";
    const hi = src.maximum ?? "any";
    notes.push(`range ${lo}–${hi}`);
  }
  if (notes.length > 0) out.description = notes.join("; ");

  if (src.items !== undefined) {
    const items = toGeminiSchema(src.items);
    if (items) out.items = items;
  }
  if (typeof src.properties === "object" && src.properties !== null) {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(src.properties as Record<string, unknown>)) {
      const mapped = toGeminiSchema(value);
      if (mapped) props[key] = mapped;
    }
    // Gemini rejects an OBJECT with an empty `properties`, which several §13.1
    // tools legitimately have (they take no arguments) — omit it entirely.
    if (Object.keys(props).length > 0) out.properties = props;
  }
  if (Array.isArray(src.required) && src.required.length > 0) out.required = src.required;

  return out;
}

/** §13.1 tool definitions → Gemini function declarations. */
export function toGeminiTools(tools: LlmTool[]) {
  if (tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => {
        const parameters = toGeminiSchema(t.input_schema);
        const hasProps =
          parameters && typeof parameters.properties === "object" &&
          Object.keys(parameters.properties as object).length > 0;
        return {
          name: t.name,
          description: t.description,
          // A declaration with no parameters must omit the key, not send an
          // empty object.
          ...(hasProps ? { parameters } : {}),
        };
      }),
    },
  ];
}

/** Neutral history → Gemini `contents`. */
export function toGeminiContents(messages: LlmMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", parts: [{ text: m.text }] });
      continue;
    }
    if (m.role === "assistant") {
      // Replay the model's own parts when we have them — they carry the
      // thought signatures Gemini 3.x demands back, and rebuilding the parts
      // from text + tool calls would silently drop them.
      const raw = Array.isArray(m.providerRaw) ? (m.providerRaw as GeminiPart[]) : null;
      if (raw && raw.length > 0) {
        out.push({ role: "model", parts: raw });
        continue;
      }
      const parts: GeminiPart[] = [];
      if (m.text.trim()) parts.push({ text: m.text });
      for (const call of m.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: call.args } });
      }
      if (parts.length > 0) out.push({ role: "model", parts });
      continue;
    }
    out.push({
      role: "user",
      parts: m.results.map((r) => ({
        functionResponse: {
          name: r.name,
          // The API requires an object here, so a JSON string is wrapped. The
          // error flag is passed through as data the model can read.
          response: r.isError ? { error: r.content } : { result: r.content },
        },
      })),
    });
  }
  return out;
}

export class GeminiLlmProvider implements LlmProvider {
  readonly id = "google";
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    baseUrl?: string | null,
  ) {
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  private async call(method: string, body: unknown, stream: boolean): Promise<Response> {
    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:${method}${stream ? "?alt=sse" : ""}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      let message = text.slice(0, 400);
      try {
        message = JSON.parse(text)?.error?.message ?? message;
      } catch {
        /* not JSON — use the raw body */
      }
      // Never let the key reach a log line or a UI error (§13.2).
      throw new Error(`Gemini ${res.status}: ${message.replaceAll(this.apiKey, "«key»")}`);
    }
    return res;
  }

  private requestBody(req: LlmChatRequest) {
    return {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages),
      ...(toGeminiTools(req.tools) ? { tools: toGeminiTools(req.tools) } : {}),
      generationConfig: { maxOutputTokens: req.maxTokens },
    };
  }

  async streamChat(req: LlmChatRequest, onText: (delta: string) => void): Promise<LlmTurn> {
    const res = await this.call("streamGenerateContent", this.requestBody(req), true);

    let text = "";
    let finishReason: string | undefined;
    const toolCalls: LlmToolCall[] = [];
    /** Every part the model emitted, kept verbatim for replay (see types.ts). */
    const modelParts: GeminiPart[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of readSse(res)) {
      if (chunk.error) throw new Error(`Gemini: ${chunk.error.message ?? chunk.error.status}`);
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        modelParts.push(part);
        if (typeof part.text === "string" && part.text.length > 0) {
          text += part.text;
          onText(part.text);
        }
        if (part.functionCall) {
          toolCalls.push({
            // Gemini has no call id; synthesise a stable one so the neutral
            // contract holds. Results are matched back by name.
            id: `${part.functionCall.name}-${toolCalls.length}`,
            name: part.functionCall.name,
            args: part.functionCall.args ?? {},
          });
        }
      }
      // Usage arrives cumulatively, the last chunk carrying the totals.
      if (chunk.usageMetadata) {
        usage.inputTokens = chunk.usageMetadata.promptTokenCount ?? usage.inputTokens;
        // Thinking tokens are billed as output but reported separately —
        // counting only `candidatesTokenCount` under-reports a Gemini 3.x turn
        // by an order of magnitude and would make the §13.2 budget meaningless.
        usage.outputTokens =
          (chunk.usageMetadata.candidatesTokenCount ?? 0) +
          (chunk.usageMetadata.thoughtsTokenCount ?? 0) || usage.outputTokens;
      }
      const reason = chunk.candidates?.[0]?.finishReason;
      if (reason && reason !== "STOP") finishReason = reason;
    }

    if (text.length === 0 && toolCalls.length === 0) {
      // An empty turn must not surface as a silent blank bubble. The usual
      // cause is MAX_TOKENS: a thinking model can spend the whole output
      // budget reasoning and return no answer at all.
      throw new Error(
        finishReason === "MAX_TOKENS"
          ? `Gemini returned no answer: the output budget was used up (${usage.outputTokens} tokens, most of them reasoning). Try a shorter question, or a lighter model such as gemini-3.5-flash-lite.`
          : `Gemini returned an empty response${finishReason ? ` (${finishReason})` : ""}.`,
      );
    }

    return { text, toolCalls, usage, providerRaw: modelParts };
  }

  async complete(system: string, user: string, maxTokens = 800): Promise<string> {
    const res = await this.call(
      "generateContent",
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      },
      false,
    );
    const json = (await res.json()) as GeminiChunk;
    return (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
  }

  /**
   * Ask Google what this key can use. Filtered to models that support
   * `generateContent`, which drops the embedding, text-to-speech, image and
   * video models — none of which the assistant can drive.
   */
  async listModels(): Promise<Array<{ id: string; label: string }>> {
    const res = await fetch(`${this.baseUrl}/models?pageSize=200`, {
      headers: { "x-goog-api-key": this.apiKey },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini ${res.status}: ${text.slice(0, 200).replaceAll(this.apiKey, "«key»")}`);
    }
    const json = (await res.json()) as {
      models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
    };
    return (json.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => ({
        id: (m.name ?? "").replace(/^models\//, ""),
        label: m.displayName || (m.name ?? "").replace(/^models\//, ""),
      }))
      .filter((m) => m.id.length > 0)
      .sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }));
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    const res = await this.call(
      "generateContent",
      {
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 1 },
      },
      false,
    );
    const json = (await res.json()) as GeminiChunk;
    return { ok: true, detail: json.candidates?.[0]?.finishReason ?? undefined };
  }
}

/**
 * Split a buffer into complete SSE events.
 *
 * The separator is a blank line, and the spec permits CRLF, LF or CR line
 * endings — Google uses **CRLF**, so a reader that only looks for "\n\n" finds
 * no boundary in "\r\n\r\n" (there is a \r between the two newlines) and
 * silently yields nothing at all: no text, no tool calls, no token counts, and
 * an empty answer bubble with no error to explain it. Exported so the framing
 * can be tested against real captured output.
 */
export function splitSseEvents(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  const separator = /\r\n\r\n|\n\n|\r\r/;
  let rest = buffer;
  for (;;) {
    const match = separator.exec(rest);
    if (!match) break;
    events.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }
  return { events, rest };
}

/** The JSON payload of one SSE event, or null for a comment or keep-alive. */
export function parseSseEvent(event: string): unknown | null {
  const data = event
    .split(/\r\n|\n|\r/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Read an `alt=sse` response as parsed JSON chunks. */
async function* readSse(res: Response): AsyncGenerator<GeminiChunk> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // A network chunk can split mid-event, so only whole events are consumed
    // and the remainder stays buffered for the next read.
    const { events, rest } = splitSseEvents(buffer);
    buffer = rest;
    for (const event of events) {
      const parsed = parseSseEvent(event);
      if (parsed) yield parsed as GeminiChunk;
    }
  }
  // A final event with no trailing blank line still counts.
  const parsed = parseSseEvent(buffer);
  if (parsed) yield parsed as GeminiChunk;
}
