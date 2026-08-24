import { Module } from "@nestjs/common";
import { ReadinessService } from "../readiness/readiness.service";
import { ExplainController } from "./explain.controller";
import { AnthropicProvider } from "./provider";

@Module({
  controllers: [ExplainController],
  providers: [AnthropicProvider, ReadinessService],
  exports: [AnthropicProvider],
})
export class AiModule {}
