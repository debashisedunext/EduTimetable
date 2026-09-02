/**
 * §21 — Auto-resolve endpoints, hung off the timetable config like the rest of
 * the readiness surface.
 *
 * `masters.manage`, not `timetable.edit`: this writes teachers, class-sections
 * and mappings. Somebody allowed to drag a lesson around is not thereby
 * allowed to reassign a teacher's classes.
 */
import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { toInt, type AuthedRequest } from "../masters/crud.util";
import { AutoFixService, type AutoFixRequest } from "./auto-fix.service";

@Controller("timetable-configs/:id/auto-fix")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class AutoFixController {
  constructor(private readonly autoFix: AutoFixService) {}

  /** Apply the remedies the admin consented to, and report what became of each. */
  @Post()
  async apply(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const configId = toInt(id, "id");
    await this.autoFix.assertOwned(configId);
    const requested: AutoFixRequest[] = Array.isArray(body?.apply) ? body.apply : [];
    return this.autoFix.apply(configId, req.user.schoolId, req.user.sub ?? null, requested);
  }

  @Get("runs")
  async runs(@Param("id") id: string) {
    const configId = toInt(id, "id");
    await this.autoFix.assertOwned(configId);
    return this.autoFix.runs(configId);
  }

  @Post(":runId/undo")
  async undo(@Req() req: AuthedRequest, @Param("id") id: string, @Param("runId") runId: string) {
    const configId = toInt(id, "id");
    await this.autoFix.assertOwned(configId);
    return this.autoFix.undo(configId, req.user.schoolId, toInt(runId, "runId"));
  }
}
