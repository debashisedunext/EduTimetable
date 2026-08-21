import { Controller, Post } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { DEMO_QUEUE } from "./demo.constants";

/**
 * Phase 0 plumbing proof (task 0.5): enqueues a job that the worker container
 * processes, with progress streamed back over Socket.IO — the exact pipeline
 * the Phase 2 solver will use.
 */
@Controller("demo-jobs")
export class DemoController {
  constructor(@InjectQueue(DEMO_QUEUE) private readonly queue: Queue) {}

  @Post()
  async start() {
    const job = await this.queue.add("demo", { steps: 20 });
    return { jobId: job.id };
  }
}
