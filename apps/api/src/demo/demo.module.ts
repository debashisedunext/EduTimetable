import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { DemoController } from "./demo.controller";
import { DEMO_QUEUE } from "./demo.constants";

@Module({
  imports: [BullModule.registerQueue({ name: DEMO_QUEUE })],
  controllers: [DemoController],
})
export class DemoModule {}
