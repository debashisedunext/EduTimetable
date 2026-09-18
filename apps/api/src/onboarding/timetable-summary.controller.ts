/**
 * §38 — the Published summary's one route.
 *
 * A controller of its own rather than a method on `TimetableConfigsController`,
 * and the reason is structural rather than stylistic: the service lives in
 * `OnboardingModule` (it is the guided setup's last step), while that
 * controller lives in `MastersModule` — so putting the route there means
 * `MastersModule` importing `OnboardingModule`, which already reaches back into
 * masters. Nest lets several controllers share a prefix, so the route keeps the
 * URL it should have and the modules keep their direction.
 *
 * `UnlockController` (§29.8) is the same shape for the same reason.
 *
 * Under `/timetable-configs/:id/` so §17.8's sweep classifies it without
 * anybody having to decide, and `reports.view` rather than `masters.manage`:
 * reading a finished week is not editing one, which is the call §37 made for
 * the Teacher Requirement report.
 */
import { Controller, Get, Param } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { toInt } from "../masters/crud.util";
import { TimetableSummaryService } from "./timetable-summary.service";

@Controller("timetable-configs")
export class TimetableSummaryController {
  constructor(private readonly summaries: TimetableSummaryService) {}

  @Get(":id/summary")
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  summary(@Param("id") id: string) {
    return this.summaries.forConfig(toInt(id, "id"));
  }
}
