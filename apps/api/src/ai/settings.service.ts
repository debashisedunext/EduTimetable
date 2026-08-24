/**
 * §13.2 — provider configuration, key custody, usage and budget.
 * The plaintext key leaves this service in exactly one direction: into the
 * Anthropic client. It is never returned by an endpoint, never logged.
 */
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaService } from "../prisma/prisma.service";
import { decryptSecret, encryptSecret, maskKey } from "./crypto.util";

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
    const envKey = Boolean(process.env.ANTHROPIC_API_KEY);
    const features = { ...DEFAULT_FEATURES, ...((s?.features as object) ?? {}) };
    const usage = await this.usage(schoolId);
    return {
      provider: s?.provider ?? "anthropic",
      model: s?.model ?? "claude-opus-5",
      apiBaseUrl: s?.apiBaseUrl ?? null,
      monthlyTokenBudget: s?.monthlyTokenBudget ?? null,
      features,
      isActive: s?.isActive ?? true,
      hasKey: Boolean(s?.apiKeyEncrypted) || envKey,
      keySource: s?.apiKeyEncrypted ? "database" : envKey ? "environment" : "none",
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
    const data: any = {
      provider: (body.provider as any) ?? current?.provider ?? "anthropic",
      model: body.model ?? current?.model ?? "claude-opus-5",
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
    return process.env.ANTHROPIC_API_KEY ?? null;
  }

  async client(schoolId: number): Promise<{ client: Anthropic; model: string } | null> {
    const key = await this.resolveKey(schoolId);
    if (!key) return null;
    const s = await this.raw(schoolId);
    return {
      client: new Anthropic({ apiKey: key, ...(s?.apiBaseUrl ? { baseURL: s.apiBaseUrl } : {}) }),
      model: s?.model ?? process.env.AI_MODEL ?? "claude-opus-5",
    };
  }

  /** §13.2 "Test Connection" — a 1-token ping with the supplied or stored key. */
  async testConnection(schoolId: number, candidateKey?: string) {
    const key = candidateKey?.trim() || (await this.resolveKey(schoolId));
    if (!key) throw new BadRequestException("No API key configured — paste one to test");
    const s = await this.raw(schoolId);
    const model = s?.model ?? "claude-opus-5";
    try {
      const client = new Anthropic({ apiKey: key, ...(s?.apiBaseUrl ? { baseURL: s.apiBaseUrl } : {}) });
      const res = await client.messages.create({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      });
      return { ok: true, model, stopReason: res.stop_reason };
    } catch (e) {
      // surface the provider's message but never echo the key back
      return { ok: false, model, error: (e as Error).message.replace(key, "«key»") };
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
    // Claude Opus 5 list price, for an indicative figure only
    const estimatedCostUsd = (inputTokens / 1_000_000) * 5 + (outputTokens / 1_000_000) * 25;
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
