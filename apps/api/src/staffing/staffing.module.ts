/**
 * §29.2 — staffing changes.
 *
 * Its own module rather than a corner of `MastersModule`: this is not master
 * data. It is a decided, validated, reversible act on a published week, and it
 * will grow the §29.3 engine and the §29.4 apply beside it.
 */
import { Module } from "@nestjs/common";
import { MastersModule } from "../masters/masters.module";
import { DraftsModule } from "../drafts/drafts.module";
import {
  ConfigStaffingController, StaffingChangesController, TeacherRequirementController,
} from "./staffing.controller";
import { StaffingService } from "./staffing.service";
import { StaffingPlanService } from "./staffing-plan.service";
import { StaffingApplyService } from "./staffing-apply.service";
import { TeacherRequirementService } from "./teacher-requirement.service";

@Module({
  // For `ReadinessService`, which `MastersModule` owns and exports: a staffing
  // change alters the published week, so the readiness cache is stale the
  // moment it returns. Imported rather than re-provided — two instances would
  // mean two caches, and one of them would always be the stale one somebody
  // was looking at.
  /*
    §29.6 — `DraftsModule` for `currentId`, which is the app's one definition of
    "the draft everything else is showing" (invariant 3). A staffing change on
    an unpublished timetable acts on that draft, and re-deriving "newest draft
    with rows" here would be a second answer to a question the Board, the Master
    Grid and this screen all have to agree on.
  */
  imports: [MastersModule, DraftsModule],
  controllers: [ConfigStaffingController, StaffingChangesController, TeacherRequirementController],
  providers: [StaffingService, StaffingPlanService, StaffingApplyService, TeacherRequirementService],
  exports: [StaffingService, StaffingPlanService, StaffingApplyService, TeacherRequirementService],
})
export class StaffingModule {}
