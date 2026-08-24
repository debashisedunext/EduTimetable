import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ReportsModule } from "../reports/reports.module";
import { ReadinessService } from "../readiness/readiness.service";
import { AiChatGateway } from "./ai-chat.gateway";
import { AiChatController, AiSettingsController } from "./ai-settings.controller";
import { AiChatService } from "./chat.service";
import { ExplainController } from "./explain.controller";
import { AnthropicProvider } from "./provider";
import { AiSettingsService } from "./settings.service";
import { AiToolsService } from "./tools";

/** Phase 5 explanation layer + Phase 7 assistant (§13). */
@Module({
  imports: [AuthModule, ReportsModule],
  controllers: [ExplainController, AiSettingsController, AiChatController],
  providers: [
    AnthropicProvider,
    ReadinessService,
    AiSettingsService,
    AiToolsService,
    AiChatService,
    AiChatGateway,
  ],
  exports: [AnthropicProvider, AiSettingsService],
})
export class AiModule {}
