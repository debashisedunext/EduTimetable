import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { ImportModule } from "../import/import.module";
import { TermsModule } from "../terms/terms.module";
import { ReadinessService } from "../readiness/readiness.service";
import { DevInterviewController, OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";
import { SetupProgressService } from "./setup-progress.service";
import { InterviewService } from "./interview.service";
import { TimetableSummaryService } from "./timetable-summary.service";
import { TimetableSummaryController } from "./timetable-summary.controller";
import { DraftsModule } from "../drafts/drafts.module";

/** §24 Phase 25.2-25.5 — the welcome screen, the guided setup, and the interview. */
@Module({
  // The wizard commits through the §16 pipeline, never its own writer; the
  // interview borrows the §13.2 provider contract, never a second one.
  // §25: the session step writes the school's terms right after the importer
  // creates the year — through the one resolver, never a second writer.
  // §38 — the summary resolves §29.6's week scope, which needs the draft
  // registry to say which draft is current (invariant 3).
  imports: [ImportModule, AiModule, TermsModule, DraftsModule],
  // DevInterviewController is dev-gated: it exists so the interview's merge step
  // can be asserted without an LLM in the loop (§17.8).
  controllers: [OnboardingController, DevInterviewController, TimetableSummaryController],
  // §3.10d — detaching a class-section changes what Readiness has to say, so
  // the cached score is dropped at the point of the write. Provided directly,
  // as `ImportModule`, `AiModule` and `SyncModule` all do.
  providers: [OnboardingService, SetupProgressService, InterviewService, ReadinessService, TimetableSummaryService],
  // §38 — the Published summary hangs off `/timetable-configs/:id`, which is a
  // different module's controller, so the service is exported rather than the
  // route being moved to where the service happens to live.
  exports: [OnboardingService, TimetableSummaryService],
})
export class OnboardingModule {}
