/**
 * §29.1 — `FreezeService`, available everywhere that writes an allocation.
 *
 * `@Global` rather than imported by seven modules, and the reason is the same
 * one that makes the service worth having at all: the failure mode here is a
 * new write path that never asks. Making the answer available without a wiring
 * step removes one of the ways somebody ends up not asking — the ceremony of
 * adding an import is exactly the kind of friction that turns into "I'll do it
 * later".
 *
 * Stateless and holding one injected dependency, so a singleton is the whole
 * of it. Never request-scoped: §17 is explicit that request scope cascades
 * through every injecting class and breaks the §14 budget.
 */
import { Global, Module } from "@nestjs/common";
import { FreezeService } from "./freeze.service";
import { UnlockService } from "./unlock.service";
import { InUseService } from "./in-use.service";
import { UnlockController } from "./unlock.controller";

@Global()
@Module({
  controllers: [UnlockController],
  providers: [FreezeService, UnlockService, InUseService],
  exports: [FreezeService, UnlockService, InUseService],
})
export class FreezeModule {}
