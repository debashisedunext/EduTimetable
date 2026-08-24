import { Module } from "@nestjs/common";
import { ReadinessService } from "../readiness/readiness.service";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";

/** §16 master-data import (Phase 8). */
@Module({
  controllers: [ImportController],
  providers: [ImportService, ReadinessService],
})
export class ImportModule {}
