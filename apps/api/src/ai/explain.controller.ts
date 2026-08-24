/**
 * Task 5.6 — plain-English explanation of feasibility results (§5.7). The LLM
 * is fed ONLY the structured blocker list the Feasibility Engine produced and
 * asked to rephrase; with no provider configured it degrades to the engine's
 * own template text, so the feature never blocks on an API key.
 */
import { Body, Controller, Post, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { ReadinessService } from "../readiness/readiness.service";
import { toInt, type AuthedRequest } from "../masters/crud.util";
import { AnthropicProvider } from "./provider";

const SYSTEM = `You explain school-timetabling feasibility results to a non-technical school administrator.
Rules:
- Use ONLY the blockers/warnings provided in the JSON. NEVER invent, infer, or speculate about constraints not listed.
- Plain English, short sentences, no jargon. Group related items. Name the exact teacher/class/subject and the exact fix from each item.
- Order by impact: what unblocks generation first.
- End with one sentence saying what will happen once the listed items are fixed.
- Keep it under 180 words.`;

@Controller("ai")
export class ExplainController {
  constructor(
    private readonly readiness: ReadinessService,
    private readonly provider: AnthropicProvider,
  ) {}

  @Post("explain-readiness")
  @RequirePermission(PERMISSIONS.TIMETABLE_GENERATE)
  async explainReadiness(@Req() _req: AuthedRequest, @Body() body: any) {
    const configId = toInt(body?.configId, "configId");
    const result = await this.readiness.getReadiness(configId);
    if (result.ready && result.blockers.length === 0) {
      return {
        source: "template",
        text: `All checks pass — the score is ${result.score}%. A complete, conflict-free timetable is guaranteed to exist; you can generate whenever you like.${result.warnings.length > 0 ? ` There are ${result.warnings.length} non-blocking warning(s) worth a look for a nicer result.` : ""}`,
      };
    }
    // the engine's messages are already specific — they ARE the fallback
    const template = [
      `Generation is blocked at ${result.score}%. Fix these first:`,
      ...result.blockers.map((b, i) => `${i + 1}. ${b.message}`),
      ...(result.warnings.length > 0 ? [`Warnings (non-blocking): ${result.warnings.map((w) => w.message).join(" ")}`] : []),
    ].join("\n");
    if (!this.provider.available()) {
      return { source: "template", text: template };
    }
    try {
      const text = await this.provider.complete(
        SYSTEM,
        JSON.stringify({ score: result.score, blockers: result.blockers, warnings: result.warnings }),
      );
      return { source: "llm", text };
    } catch {
      return { source: "template", text: template };
    }
  }
}
