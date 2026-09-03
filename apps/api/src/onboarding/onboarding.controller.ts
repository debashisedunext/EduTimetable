/**
 * §15.3 Phase 25.2 — the welcome screen's state, and the guided setup's draft.
 *
 * Ordinary session-guarded endpoints: by this point somebody is inside a school,
 * whether they arrived through the ERP or through a password. Everything is
 * scoped by the ambient tenant context like any other query (§17) — there is no
 * school id in any path here, because a session belongs to exactly one school
 * and taking one would invite passing somebody else's.
 *
 * `masters.manage` guards the draft but NOT the state: a teacher must be able
 * to load the app, and `GET /me/onboarding` is read on every page load. It
 * returns counts about their own school and nothing else.
 */
import {
  BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Req,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { type AuthedRequest } from "../masters/crud.util";
import { OnboardingService } from "./onboarding.service";
import { InterviewService } from "./interview.service";

@Controller()
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly interviewer: InterviewService,
  ) {}

  /** Is this school new, has this person waved the prompt away, is there a draft? */
  @Get("me/onboarding")
  state(@Req() req: AuthedRequest) {
    return this.onboarding.stateFor(req.user.schoolId, req.user.sub);
  }

  /** "I'll do this later" — remembered per user, not per school. */
  @Post("me/onboarding/dismiss")
  dismiss(@Req() req: AuthedRequest) {
    return this.onboarding.dismiss(req.user.sub);
  }

  @Get("onboarding/session")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  async draft(@Req() req: AuthedRequest) {
    return (await this.onboarding.draftFor(req.user.schoolId, req.user.sub)) ?? { empty: true };
  }

  @Put("onboarding/session")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  save(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    return this.onboarding.save(req.user.schoolId, req.user.sub, {
      currentStep: typeof body.currentStep === "number" ? body.currentStep : undefined,
      answers: (body.answers as Record<string, unknown>) ?? undefined,
      mode: body.mode === "ai" ? "ai" : body.mode === "wizard" ? "wizard" : undefined,
    });
  }

  /** What committing this step would create — same pipeline, dry. */
  @Get("onboarding/preview/:step")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  preview(@Req() req: AuthedRequest, @Param("step") step: string) {
    return this.onboarding.preview(req.user.schoolId, req.user.sub, Number(step));
  }

  /** Commit this step's answers, through the §16 importer and nothing else. */
  @Post("onboarding/commit/:step")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  commit(@Req() req: AuthedRequest, @Param("step") step: string) {
    return this.onboarding.commit(req.user.schoolId, req.user.sub, Number(step));
  }

  /** Step 11: write the settings and mark the guided setup done. */
  @Post("onboarding/finish")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  finish(@Req() req: AuthedRequest) {
    return this.onboarding.finish(req.user.schoolId, req.user.sub);
  }

  @Delete("onboarding/session")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  discard(@Req() req: AuthedRequest) {
    return this.onboarding.discard(req.user.schoolId, req.user.sub);
  }

  /**
   * §24.6 — one turn of the conversational setup.
   *
   * BOTH permissions, and neither is redundant: `masters.manage` because this
   * fills in the same draft the wizard does and the conversation is only worth
   * having if the person can commit it, `ai.chat` because it spends the school's
   * AI budget. A person with one and not the other is told which is missing.
   */
  @Post("onboarding/interview")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE, PERMISSIONS.AI_CHAT)
  interview(
    @Req() req: AuthedRequest,
    @Body() body: { message?: unknown; conversationId?: unknown },
  ) {
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (message === "") throw new BadRequestException("Say something for the assistant to answer.");
    const conversationId =
      typeof body?.conversationId === "string" && body.conversationId.trim() !== ""
        ? body.conversationId.trim().slice(0, 64)
        : `setup-${req.user.schoolId}-${req.user.sub}`;
    return this.interviewer.turn(req.user.schoolId, req.user.sub, conversationId, message.slice(0, 4000));
  }
}

/**
 * Dev-only seam for the interview's merge step (§17.8, mirroring `/dev/ai-tool`).
 *
 * The property worth testing is *"does a model's report become the same answers
 * the wizard produces?"*, and that is not a property of the model. Driving it
 * through a real provider would make a deterministic check depend on an LLM
 * choosing to cooperate — flaky, paid, and indirect. This runs the same
 * `applyLearned` the conversation runs, under the same session-derived school,
 * so it is a faithful seam rather than a shortcut: it cannot be handed a school,
 * and it cannot write master data, because `applyLearned` only ever touches the
 * caller's own draft.
 */
@Controller("dev")
export class DevInterviewController {
  constructor(
    private readonly interviewer: InterviewService,
    private readonly config: ConfigService,
  ) {}

  @Post("interview-turn")
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  run(@Req() req: AuthedRequest, @Body() body: { learned?: unknown; replace?: unknown }) {
    if (this.config.get("NODE_ENV") === "production") throw new NotFoundException();
    const replace = Array.isArray(body?.replace)
      ? body.replace.filter((k): k is string => typeof k === "string")
      : [];
    return this.interviewer.applyLearned(req.user.schoolId, req.user.sub, body?.learned, replace);
  }
}
