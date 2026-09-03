import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { ImportModule } from "../import/import.module";
import { DevInterviewController, OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";
import { InterviewService } from "./interview.service";

/** §24 Phase 25.2-25.5 — the welcome screen, the guided setup, and the interview. */
@Module({
  // The wizard commits through the §16 pipeline, never its own writer; the
  // interview borrows the §13.2 provider contract, never a second one.
  imports: [ImportModule, AiModule],
  // DevInterviewController is dev-gated: it exists so the interview's merge step
  // can be asserted without an LLM in the loop (§17.8).
  controllers: [OnboardingController, DevInterviewController],
  providers: [OnboardingService, InterviewService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
