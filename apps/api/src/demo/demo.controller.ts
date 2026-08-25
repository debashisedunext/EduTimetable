import { Controller, Post, Req } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { DEMO_QUEUE } from "./demo.constants";
import type { AuthedRequest } from "../masters/crud.util";

/**
 * Phase 0 plumbing proof (task 0.5): enqueues a job that the worker container
 * processes, with progress streamed back over Socket.IO — the exact pipeline
 * the Phase 2 solver will use.
 */
@Controller("demo-jobs")
export class DemoController {
  constructor(@InjectQueue(DEMO_QUEUE) private readonly queue: Queue) {}

  @Post()
  async start(@Req() req: AuthedRequest) {
    // schoolId rides on every job so the gateway knows which school's clients
    // may see its progress (9.1 / §17).
    const job = await this.queue.add("demo", { steps: 20, schoolId: req.user.schoolId });
    return { jobId: job.id };
  }
}
