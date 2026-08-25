/**
 * Provider registry (§13.2) — one place that knows which providers exist, what
 * they are called, which models they offer, where their keys come from and what
 * their tokens cost.
 *
 * The AI Settings screen reads this through `GET /ai/settings`, so adding a
 * provider is a change here plus an adapter, not a hunt through the UI.
 */
import type { LlmProvider, TokenPrice } from "./types";
import { AnthropicLlmProvider } from "./anthropic.provider";
import { GeminiLlmProvider } from "./gemini.provider";

export * from "./types";
export { AnthropicLlmProvider } from "./anthropic.provider";
export { GeminiLlmProvider } from "./gemini.provider";

export interface ModelInfo {
  id: string;
  label: string;
  /** List price for THIS model. Lite and flagship models differ severalfold,
   *  so a single per-provider figure would misreport the usage meter. */
  price?: TokenPrice;
}

export interface ProviderInfo {
  id: string;
  label: string;
  /** false = selectable in the UI but with no adapter behind it yet. */
  implemented: boolean;
  defaultModel: string;
  /**
   * A *fallback* list, not the truth.
   *
   * Hardcoding model names means the catalogue is only ever as current as
   * whoever last edited this file — which is exactly how it came to offer
   * Gemini 2.5 months after 3.x shipped. `GET /ai/settings/models` asks the
   * provider what the school's own key can actually use; this list is what the
   * screen falls back to when there is no key yet, or the provider cannot be
   * reached.
   */
  models: ModelInfo[];
  /** Environment variables consulted, in order, when no key is stored. */
  envKeys: string[];
  /** Used when a model is not in the list above and has no price of its own. */
  price: TokenPrice;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    implemented: true,
    defaultModel: "claude-opus-5",
    models: [
      { id: "claude-opus-5", label: "Claude Opus 5 — most capable" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5 — balanced" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 — fastest" },
    ],
    envKeys: ["ANTHROPIC_API_KEY"],
    price: { inputPerMillionUsd: 5, outputPerMillionUsd: 25 },
  },
  {
    id: "google",
    label: "Google (Gemini)",
    implemented: true,
    // Google's own description: "our latest and most capable Flash model, built
    // for complex coding, agentic workflows, and reliable multi-step
    // execution" — which is what a tool-calling assistant is.
    defaultModel: "gemini-3.7-flash",
    models: [
      {
        id: "gemini-3.7-flash",
        label: "Gemini 3.7 Flash — most capable, agentic",
        price: { inputPerMillionUsd: 0.75, outputPerMillionUsd: 3.75 },
      },
      {
        id: "gemini-3.5-flash",
        label: "Gemini 3.5 Flash — balanced",
        price: { inputPerMillionUsd: 1.5, outputPerMillionUsd: 9 },
      },
      {
        id: "gemini-3.5-flash-lite",
        label: "Gemini 3.5 Flash-Lite — fastest, most cost-effective",
        price: { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5 },
      },
      { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite — previous lite" },
    ],
    // GEMINI_API_KEY is the name Google's own tooling uses; GOOGLE_API_KEY is
    // accepted too because plenty of deployments already set that one.
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    price: { inputPerMillionUsd: 0.75, outputPerMillionUsd: 3.75 },
  },
  {
    id: "openai",
    label: "OpenAI",
    implemented: false,
    defaultModel: "gpt-5",
    models: [{ id: "gpt-5", label: "GPT-5" }],
    envKeys: ["OPENAI_API_KEY"],
    price: { inputPerMillionUsd: 5, outputPerMillionUsd: 15 },
  },
  {
    id: "azure_openai",
    label: "Azure OpenAI",
    implemented: false,
    defaultModel: "gpt-5",
    models: [{ id: "gpt-5", label: "your deployment name" }],
    envKeys: ["AZURE_OPENAI_API_KEY"],
    price: { inputPerMillionUsd: 5, outputPerMillionUsd: 15 },
  },
];

export const providerInfo = (id: string | null | undefined): ProviderInfo =>
  PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];

/**
 * List price for a specific model, falling back to the provider's headline
 * figure for anything not in the catalogue (a newly released model, or one
 * discovered live from the provider).
 */
export const priceFor = (providerId: string | null | undefined, model: string | null | undefined): TokenPrice => {
  const info = providerInfo(providerId);
  return info.models.find((m) => m.id === model)?.price ?? info.price;
};

/** The key an unconfigured school falls back to, per provider. */
export const envKeyFor = (id: string | null | undefined): string | null => {
  for (const name of providerInfo(id).envKeys) {
    const value = process.env[name];
    if (value) return value;
  }
  return null;
};

/**
 * Build the adapter for a school's configured provider. Throws for a provider
 * that has no adapter, rather than quietly answering as a different one.
 */
export function createProvider(
  id: string,
  apiKey: string,
  model: string,
  baseUrl?: string | null,
): LlmProvider {
  switch (id) {
    case "anthropic":
      return new AnthropicLlmProvider(apiKey, model, baseUrl);
    case "google":
      return new GeminiLlmProvider(apiKey, model, baseUrl);
    default:
      throw new Error(
        `The '${providerInfo(id).label}' provider is not wired yet — choose Anthropic or Google on the AI Settings screen.`,
      );
  }
}
