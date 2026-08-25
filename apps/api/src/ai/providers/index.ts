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

export interface ProviderInfo {
  id: string;
  label: string;
  /** false = selectable in the UI but with no adapter behind it yet. */
  implemented: boolean;
  defaultModel: string;
  models: Array<{ id: string; label: string }>;
  /** Environment variables consulted, in order, when no key is stored. */
  envKeys: string[];
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
    defaultModel: "gemini-2.5-pro",
    models: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro — most capable" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash — balanced" },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite — fastest" },
    ],
    // GEMINI_API_KEY is the name Google's own tooling uses; GOOGLE_API_KEY is
    // accepted too because plenty of deployments already set that one.
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    price: { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10 },
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
