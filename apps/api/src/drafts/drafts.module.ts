/**
 * §22 Phase 17 — the draft registry.
 *
 * Exported rather than kept private: the board, publish and the slots endpoint
 * all need to answer "which draft does this request mean?", and they must all
 * answer it the same way. One resolver, several call sites.
 */
import { Module } from "@nestjs/common";
import { DraftsController } from "./drafts.controller";
import { DraftsService } from "./drafts.service";

@Module({
  controllers: [DraftsController],
  providers: [DraftsService],
  exports: [DraftsService],
})
export class DraftsModule {}
