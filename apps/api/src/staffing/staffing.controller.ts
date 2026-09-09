/**
 * §29.2 — the staffing-change routes.
 *
 * Two controllers rather than one, because the two halves are addressed
 * differently and the §17.8 sweep cares: a change is created and listed under
 * its timetable (`/timetable-configs/:id/staffing-changes`, where `:id` is the
 * config), and read, edited or discarded by its own id
 * (`/staffing-changes/:id`). Folding them into one path would make `:id` mean
 * two things on the same controller.
 *
 * `timetable.publish` throughout (§29.1): whoever may put a week on the wall
 * may decide that a teacher's classes move. Nothing here writes a mapping, a
 * slot or a class teacher — this is the plan, and §29.4's apply is the write.
 */
import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { toInt, type AuthedRequest } from "../masters/crud.util";
import { StaffingService } from "./staffing.service";
import { StaffingPlanService, type PlanMode } from "./staffing-plan.service";
import { StaffingApplyService } from "./staffing-apply.service";

@Controller("timetable-configs/:id/staffing-changes")
@RequirePermission(PERMISSIONS.TIMETABLE_PUBLISH)
export class ConfigStaffingController {
  constructor(private readonly staffing: StaffingService) {}

  /** Every change made against this timetable, newest first. */
  @Get()
  list(@Param("id") id: string) {
    return this.staffing.list(toInt(id, "id"));
  }

  /**
   * Open a change.
   *
   * Deliberately allowed on a timetable that is NOT frozen: freezing is what
   * makes this necessary, not what makes it useful, and a school that never
   * freezes still has teachers resign.
   */
  @Post()
  create(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    return this.staffing.create(toInt(id, "id"), req.user.sub ?? null, body ?? {});
  }
}

@Controller("staffing-changes")
@RequirePermission(PERMISSIONS.TIMETABLE_PUBLISH)
export class StaffingChangesController {
  constructor(
    private readonly staffing: StaffingService,
    private readonly planner: StaffingPlanService,
    private readonly applier: StaffingApplyService,
  ) {}

  /** One change, with everything its released teachers currently carry. */
  @Get(":changeId")
  get(@Param("changeId") changeId: string) {
    return this.staffing.get(toInt(changeId, "changeId"));
  }

  @Put(":changeId")
  update(@Param("changeId") changeId: string, @Body() body: any) {
    return this.staffing.update(toInt(changeId, "changeId"), body ?? {});
  }

  /**
   * §29.3 — who would take each of these classes.
   *
   * A GET, because it is a question: nothing is written, nothing is stashed,
   * and asking twice gives the same answer against whatever the week says now.
   * `mode=replace` needs `toTeacherId`; `mode=redistribute` scores the change's
   * own receiving list.
   */
  @Get(":changeId/plan")
  plan(
    @Param("changeId") changeId: string,
    @Query("mode") mode?: string,
    @Query("toTeacherId") toTeacherId?: string,
    @Query("units") units?: string,
  ) {
    const chosen: PlanMode = mode === "redistribute" ? "redistribute" : "replace";
    return this.planner.preview(
      toInt(changeId, "changeId"),
      chosen,
      toTeacherId ? toInt(toTeacherId, "toTeacherId") : null,
      // Comma-separated `type:id` keys. Omitted means the whole release, which
      // is what a resignation means and what the screen sends by default.
      units ? units.split(",").map((k) => k.trim()).filter(Boolean) : null,
    );
  }

  /**
   * §29.4 — write it.
   *
   * The body carries the CHOICE (replace or redistribute, who, which units);
   * the plan itself is recomputed server-side, exactly as §21's auto-resolve
   * does. A preview held for five minutes is not what is true now, and it is
   * never the list of writes.
   */
  @Post(":changeId/apply")
  applyChange(@Req() req: AuthedRequest, @Param("changeId") changeId: string, @Body() body: any) {
    return this.applier.apply(toInt(changeId, "changeId"), req.user.sub ?? null, body ?? {});
  }

  /** §29.5 — put it back, from the record of what it did. */
  @Post(":changeId/revert")
  revertChange(@Param("changeId") changeId: string) {
    return this.applier.revert(toInt(changeId, "changeId"));
  }

  /** Discard an open plan. An applied one is kept for ever (§3.14's rule). */
  @Delete(":changeId")
  discard(@Param("changeId") changeId: string) {
    return this.staffing.discard(toInt(changeId, "changeId"));
  }
}
