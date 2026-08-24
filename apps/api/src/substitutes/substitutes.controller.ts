import { Body, Controller, Delete, Get, Param, Post, Query, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { requireFields, toInt, type AuthedRequest } from "../masters/crud.util";
import { SubstitutesService } from "./substitutes.service";

/** Substitute Center API (§6, §8.2) — all endpoints gated on substitute.manage. */
@Controller("absences")
@RequirePermission(PERMISSIONS.SUBSTITUTE_MANAGE)
export class SubstitutesController {
  constructor(private readonly svc: SubstitutesService) {}

  @Get()
  list(@Req() req: AuthedRequest, @Query("date") date?: string) {
    return this.svc.listAbsences(req.user.schoolId, date);
  }

  @Post()
  report(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["teacherId", "date"]);
    return this.svc.reportAbsence(req.user.schoolId, {
      teacherId: toInt(body.teacherId, "teacherId"),
      date: String(body.date),
      reason: body.reason ? String(body.reason) : undefined,
    });
  }

  @Delete(":id")
  remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.svc.removeAbsence(req.user.schoolId, toInt(id, "id"));
  }

  /** §6.1 matching plan: affected slots, ranked candidates, suggested assignment. */
  @Get(":id/plan")
  plan(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.svc.plan(req.user.schoolId, toInt(id, "id"));
  }

  /** §6.2 Confirm All — writes date-scoped overlay rows, never touches the base grid. */
  @Post(":id/confirm")
  confirm(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    requireFields(body, ["assignments"]);
    const assignments = Array.isArray(body.assignments)
      ? body.assignments.map((a: any) => ({
          slotId: String(a.slotId),
          substituteTeacherId: toInt(a.substituteTeacherId, "substituteTeacherId"),
        }))
      : [];
    return this.svc.confirm(req.user.schoolId, toInt(id, "id"), assignments, req.user.sub ?? null);
  }
}
