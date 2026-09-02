import { Module } from "@nestjs/common";
import { SyncController } from "./sync.controller";
import { SyncService } from "./sync.service";
import { ErpSourceService } from "./erp-source.service";
import { ReadinessService } from "../readiness/readiness.service";

// `CacheKeysService` is not listed: RedisModule is @Global and exports it.
// Re-providing it here would build a second instance with its own Redis client.
/** §23 — ERP master-data sync. The §16 import pipeline with a different source. */
@Module({
  controllers: [SyncController],
  providers: [SyncService, ErpSourceService, ReadinessService],
  exports: [SyncService, ErpSourceService],
})
export class SyncModule {}
