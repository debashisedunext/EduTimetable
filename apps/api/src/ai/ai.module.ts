import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ReportsModule } from "../reports/reports.module";
import { ReadinessService } from "../readiness/readiness.service";
import { AiChatGateway } from "./ai-chat.gateway";
import { AiChatController, AiSettingsController } from "./ai-settings.controller";
import { AiChatService } from "./chat.service";
import { ExplainController } from "./explain.controller";
import { AiSettingsService } from "./settings.service";
import { AiToolsService } from "./tools";
import { DevAiToolsController } from "./dev-tools.controller";

/** Phase 5 explanation layer + Phase 7 assistant (§13). */
@Module({
  imports: [AuthModule, ReportsModule],
  // DevAiToolsController is dev-gated: it exists so the 9.10 suite can assert
  // tool scoping without an LLM in the loop (§17.8).
  controllers: [ExplainController, AiSettingsController, AiChatController, DevAiToolsController],
  providers: [
    ReadinessService,
    AiSettingsService,
    AiToolsService,
    AiChatService,
    AiChatGateway,
  ],
  exports: [AiSettingsService],
})
export class AiModule {}
