/**
 * §29.2 — staffing changes.
 *
 * Its own module rather than a corner of `MastersModule`: this is not master
 * data. It is a decided, validated, reversible act on a published week, and it
 * will grow the §29.3 engine and the §29.4 apply beside it.
 */
import { Module } from "@nestjs/common";
import { MastersModule } from "../masters/masters.module";
import { ConfigStaffingController, StaffingChangesController } from "./staffing.controller";
import { StaffingService } from "./staffing.service";
import { StaffingPlanService } from "./staffing-plan.service";
import { StaffingApplyService } from "./staffing-apply.service";

@Module({
  // For `ReadinessService`, which `MastersModule` owns and exports: a staffing
  // change alters the published week, so the readiness cache is stale the
  // moment it returns. Imported rather than re-provided — two instances would
  // mean two caches, and one of them would always be the stale one somebody
  // was looking at.
  imports: [MastersModule],
  controllers: [ConfigStaffingController, StaffingChangesController],
  providers: [StaffingService, StaffingPlanService, StaffingApplyService],
  exports: [StaffingService, StaffingPlanService, StaffingApplyService],
})
export class StaffingModule {}
