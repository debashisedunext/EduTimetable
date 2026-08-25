import { Global, Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { EventsGateway } from "./events.gateway";
import { DEMO_QUEUE } from "../demo/demo.constants";

@Global()
@Module({
  // The gateway needs the queues, not to enqueue, but to read a job's data and
  // learn which school its progress events belong to (9.1 / §17).
  imports: [
    BullModule.registerQueue({ name: "solver" }),
    BullModule.registerQueue({ name: DEMO_QUEUE }),
  ],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class EventsModule {}
