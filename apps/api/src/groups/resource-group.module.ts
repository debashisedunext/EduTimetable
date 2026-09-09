/**
 * §30 — `ResourceGroupService`, available everywhere a timetable or a cohort row
 * is created.
 *
 * `@Global` for the same reason `FreezeModule` is: the failure mode is a new
 * write path that never asks which pool the row belongs to, and the ceremony of
 * adding an import is one more way somebody ends up not asking. Six modules
 * create these rows today — masters, import, sync, clone, onboarding and dev —
 * and the seventh is the one this is for.
 */
import { Global, Module } from "@nestjs/common";
import { ResourceGroupService } from "./resource-group.service";

@Global()
@Module({
  providers: [ResourceGroupService],
  exports: [ResourceGroupService],
})
export class ResourceGroupModule {}
