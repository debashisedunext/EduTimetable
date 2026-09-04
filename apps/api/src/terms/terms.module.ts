/**
 * §25 Phase 26 — the session's terms.
 *
 * Exported for the same reason `DraftsModule` is: the board, the slots
 * endpoint, publish, the reports and the substitute engine all have to answer
 * "which term does this request mean?", and one resolver answering it is the
 * only way they cannot disagree.
 */
import { Module } from "@nestjs/common";
import { ConfigTermsController, TermsController } from "./terms.controller";
import { TermsService } from "./terms.service";

@Module({
  controllers: [TermsController, ConfigTermsController],
  providers: [TermsService],
  exports: [TermsService],
})
export class TermsModule {}
