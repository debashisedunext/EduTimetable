/**
 * §13.2 — provider configuration, key custody, usage and budget.
 *
 * The plaintext key leaves this service in exactly one direction: into the
 * configured provider's adapter. It is never returned by an endpoint, never
 * logged, and never echoed in an error message.
 *
 * Which provider that is comes from `ai_settings.provider`; the adapters live
 * behind the neutral contract in ./providers, so this service — and the chat
 * gateway above it — do not know or care whether they are talking to Claude or
 * Gemini.
 */
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { decryptSecret, encryptSecret, maskKey } from "../common/crypto.util";
import { PROVIDERS, createProvider, envKeyFor, providerInfo, type LlmProvider } from "./providers";

export interface AiFeatures {
  chat: boolean;
  reports: boolean;
  nl_data_entry: boolean;
  conflict_explain: boolean;
}

const DEFAULT_FEATURES: AiFeatures = {
  chat: true,
  reports: true,
  nl_data_entry: false,
  conflict_explain: true,
};

@Injectable()
export class AiSettingsService {
  private readonly logger = new Logger(AiSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async raw(schoolId: number) {
    return this.prisma.aiSettings.findUnique({ where: { schoolId } });
  }

  /** Safe projection for the UI — no key material, ever. */
  async get(schoolId: number) {
    const s = await this.raw(schoolId);
    const info = providerInfo(s?.provider);
    const envKey = Boolean(envKeyFor(info.id));
    const features = { ...DEFAULT_FEATURES, ...((s?.features as object) ?? {}) };
    const usage = await this.usage(schoolId);
    return {
      provider: info.id,
      model: s?.model ?? info.defaultModel,
      /** The catalogue the AI Settings screen renders — one source of truth. */
      providers: PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        implemented: p.implemented,
        defaultModel: p.defaultModel,
        models: p.models,
        envKeys: p.envKeys,
      })),
      apiBaseUrl: s?.apiBaseUrl ?? null,
      monthlyTokenBudget: s?.monthlyTokenBudget ?? null,
      features,
      isActive: s?.isActive ?? true,
      hasKey: Boolean(s?.apiKeyEncrypted) || envKey,
      keySource: s?.apiKeyEncrypted ? "database" : envKey ? "environment" : "none",
      /** Which env var supplied the fallback key, so the screen can say so. */
      envKeyName: s?.apiKeyEncrypted ? null : (info.envKeys.find((n) => process.env[n]) ?? null),
      keyHint: s?.apiKeyEncrypted ? maskKey(decryptSecret(s.apiKeyEncrypted)) : null,
      encryptionKeySource: process.env.AI_ENCRYPTION_KEY ? "AI_ENCRYPTION_KEY" : "derived from JWT_SECRET (set AI_ENCRYPTION_KEY in production)",
      updatedAt: s?.updatedAt ?? null,
      usage,
      budgetExceeded: this.overBudget(s?.monthlyTokenBudget ?? null, usage.totalTokens),
    };
  }

  async update(
    schoolId: number,
    userId: number,
    body: {
      provider?: string;
      model?: string;
      apiKey?: string | null;
      apiBaseUrl?: string | null;
      monthlyTokenBudget?: number | null;
      features?: Partial<AiFeatures>;
      isActive?: boolean;
    },
  ) {
    const current = await this.raw(schoolId);
    const features = { ...DEFAULT_FEATURES, ...((current?.features as object) ?? {}), ...(body.features ?? {}) };
    const provider = providerInfo((body.provider as string) ?? current?.provider);
    // Switching provider without naming a model would otherwise leave a Claude
    // model selected against Gemini, which fails at the first request with a
    // confusing "model not found". Fall back to the new provider's default.
    const switchedProvider = body.provider !== undefined && body.provider !== current?.provider;
    const model =
      body.model ?? (switchedProvider ? provider.defaultModel : (current?.model ?? provider.defaultModel));
    const data: any = {
      provider: provider.id as any,
      model,
      apiBaseUrl: body.apiBaseUrl === undefined ? (current?.apiBaseUrl ?? null) : body.apiBaseUrl || null,
      monthlyTokenBudget:
        body.monthlyTokenBudget === undefined
          ? (current?.monthlyTokenBudget ?? null)
          : body.monthlyTokenBudget === null
            ? null
            : Math.max(0, Math.round(Number(body.monthlyTokenBudget))),
      features,
      isActive: body.isActive ?? current?.isActive ?? true,
      updatedById: userId,
    };
    // empty string = "clear the key"; undefined = "leave it alone"
    if (body.apiKey !== undefined) {
      data.apiKeyEncrypted = body.apiKey ? encryptSecret(body.apiKey.trim()) : null;
    }
    await this.prisma.aiSettings.upsert({
      where: { schoolId },
      create: { schoolId, ...data },
      update: data,
    });
    return this.get(schoolId);
  }

  /** Plaintext key for the gateway: DB first, env fallback. Never returned to a client. */
  async resolveKey(schoolId: number): Promise<string | null> {
    const s = await this.raw(schoolId);
    if (s?.apiKeyEncrypted) {
      try {
        return decryptSecret(s.apiKeyEncrypted);
      } catch {
        this.logger.error("stored API key could not be decrypted — AI_ENCRYPTION_KEY may have changed");
        return null;
      }
    }
    // Falls back to whichever env var this provider uses — ANTHROPIC_API_KEY
    // for Claude, GEMINI_API_KEY / GOOGLE_API_KEY for Gemini.
    return envKeyFor(s?.provider);
  }

  /** The configured provider's adapter, or null when no key is available. */
  async client(schoolId: number): Promise<LlmProvider | null> {
    const key = await this.resolveKey(schoolId);
    if (!key) return null;
    const s = await this.raw(schoolId);
    const info = providerInfo(s?.provider);
    return createProvider(info.id, key, s?.model ?? info.defaultModel, s?.apiBaseUrl ?? null);
  }

  /** §13.2 "Test Connection" — the cheapest round trip the provider offers. */
  async testConnection(schoolId: number, candidateKey?: string) {
    const key = candidateKey?.trim() || (await this.resolveKey(schoolId));
    if (!key) throw new BadRequestException("No API key configured — paste one to test");
    const s = await this.raw(schoolId);
    const info = providerInfo(s?.provider);
    const model = s?.model ?? info.defaultModel;
    try {
      const provider = createProvider(info.id, key, model, s?.apiBaseUrl ?? null);
      const res = await provider.ping();
      return { ok: true, provider: info.id, model, stopReason: res.detail };
    } catch (e) {
      // Surface the provider's own message — it is the useful part — but never
      // echo the key, which some providers include in their error text.
      return {
        ok: false,
        provider: info.id,
        model,
        error: (e as Error).message.replaceAll(key, "«key»"),
      };
    }
  }

  private monthStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  /** Month-to-date aggregates from ai_chat_log — drives the meter and the cutoff. */
  async usage(schoolId: number) {
    const since = this.monthStart();
    const [agg, conversations, messages] = await Promise.all([
      this.prisma.aiChatLog.aggregate({
        where: { schoolId, createdAt: { gte: since } },
        _sum: { inputTokens: true, outputTokens: true },
      }),
      this.prisma.aiChatLog.findMany({
        where: { schoolId, createdAt: { gte: since } },
        distinct: ["conversationId"],
        select: { conversationId: true },
      }),
      this.prisma.aiChatLog.count({ where: { schoolId, createdAt: { gte: since }, role: "user" } }),
    ]);
    const inputTokens = agg._sum.inputTokens ?? 0;
    const outputTokens = agg._sum.outputTokens ?? 0;
    // List price of the configured provider's flagship model — indicative only,
    // and wrong for a school that switched provider mid-month.
    const { price } = providerInfo((await this.raw(schoolId))?.provider);
    const estimatedCostUsd =
      (inputTokens / 1_000_000) * price.inputPerMillionUsd +
      (outputTokens / 1_000_000) * price.outputPerMillionUsd;
    return {
      since: since.toISOString().slice(0, 10),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      conversations: conversations.length,
      questions: messages,
      estimatedCostUsd: Math.round(estimatedCostUsd * 100) / 100,
    };
  }

  overBudget(budget: number | null, totalTokens: number) {
    return budget !== null && budget > 0 && totalTokens >= budget;
  }

  async assertWithinBudget(schoolId: number) {
    const s = await this.raw(schoolId);
    if (!s?.monthlyTokenBudget) return;
    const { totalTokens } = await this.usage(schoolId);
    if (this.overBudget(s.monthlyTokenBudget, totalTokens)) {
      throw new BadRequestException(
        `This school has used ${totalTokens.toLocaleString()} of its ${s.monthlyTokenBudget.toLocaleString()} monthly AI token budget. An administrator can raise the budget on the AI Settings screen.`,
      );
    }
  }

  async log(entry: {
    schoolId: number;
    userId: number;
    conversationId: string;
    role: "user" | "assistant" | "tool";
    content: string;
    toolsCalled?: unknown;
    inputTokens?: number;
    outputTokens?: number;
  }) {
    await this.prisma.aiChatLog.create({
      data: {
        schoolId: entry.schoolId,
        userId: entry.userId,
        conversationId: entry.conversationId,
        role: entry.role,
        content: entry.content.slice(0, 60_000),
        toolsCalled: (entry.toolsCalled as any) ?? undefined,
        inputTokens: entry.inputTokens ?? 0,
        outputTokens: entry.outputTokens ?? 0,
      },
    });
  }
}
