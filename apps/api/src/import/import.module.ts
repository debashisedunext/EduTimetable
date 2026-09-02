import { Module } from "@nestjs/common";
import { ReadinessService } from "../readiness/readiness.service";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";

/** §16 master-data import (Phase 8). */
@Module({
  controllers: [ImportController],
  providers: [ImportService, ReadinessService],
  // §13.5 — the AI data-entry path is a third source into this same
  // pipeline, so it reuses the service rather than growing a second one.
  exports: [ImportService],
})
export class ImportModule {}
