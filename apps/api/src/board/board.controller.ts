/**
 * Draft Board endpoints (§7, tasks 3.1–3.7). Drag legality runs client-side
 * first against the shared BoardEngine; these endpoints are the authoritative
 * re-validation on drop-confirm (invariant 7) and the publish lifecycle.
 */
import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { requireFields, toInt, type AuthedRequest } from "../masters/crud.util";
import { BoardService, type CellExpectation, type CellRef } from "./board.service";
import { PublishService } from "./publish.service";

const cellRef = (o: any, prefix = ""): CellRef => ({
  classSectionId: toInt(o[`${prefix}classSectionId`] ?? o.classSectionId, "classSectionId"),
  day: toInt(o[`${prefix}day`] ?? o.day, "day"),
  period: toInt(o[`${prefix}period`] ?? o.period, "period"),
});
const expectation = (o: any): CellExpectation => ({
  subjectId: toInt(o?.subjectId, "expect.subjectId"),
  teacherId: toInt(o?.teacherId, "expect.teacherId"),
});

@Controller("timetable-configs/:id/board")
export class BoardController {
  constructor(
    private readonly board: BoardService,
    private readonly publishSvc: PublishService,
  ) {}

  /** SolverInput for the browser's BoardEngine — same rules, zero latency. */
  @Get("context")
  @RequirePermission(PERMISSIONS.TIMETABLE_EDIT)
  context(@Param("id") id: string) {
    return this.board.context(toInt(id, "id"));
  }

  @Post("move")
  @RequirePermission(PERMISSIONS.TIMETABLE_EDIT)
  move(@Param("id") id: string, @Body() body: any) {
    requireFields(body, ["from", "expect", "to"]);
    return this.board.move(toInt(id, "id"), cellRef(body.from), expectation(body.expect), {
      day: toInt(body.to?.day, "to.day"),
      period: toInt(body.to?.period, "to.period"),
    });
  }

  @Post("swap")
  @RequirePermission(PERMISSIONS.TIMETABLE_EDIT)
  swap(@Param("id") id: string, @Body() body: any) {
    requireFields(body, ["a", "expectA", "b", "expectB"]);
    return this.board.swap(
      toInt(id, "id"),
      cellRef(body.a),
      expectation(body.expectA),
      cellRef(body.b),
      expectation(body.expectB),
    );
  }

  @Post("place")
  @RequirePermission(PERMISSIONS.TIMETABLE_EDIT)
  place(@Param("id") id: string, @Body() body: any) {
    requireFields(body, ["classSectionId", "subjectId", "teacherId", "day", "period"]);
    return this.board.place(toInt(id, "id"), {
      classSectionId: toInt(body.classSectionId, "classSectionId"),
      subjectId: toInt(body.subjectId, "subjectId"),
      teacherId: toInt(body.teacherId, "teacherId"),
      day: toInt(body.day, "day"),
      period: toInt(body.period, "period"),
    });
  }

  @Post("remove")
  @RequirePermission(PERMISSIONS.TIMETABLE_EDIT)
  remove(@Param("id") id: string, @Body() body: any) {
    requireFields(body, ["from", "expect"]);
    return this.board.remove(toInt(id, "id"), cellRef(body.from), expectation(body.expect));
  }

  @Post("lock")
  @RequirePermission(PERMISSIONS.TIMETABLE_EDIT)
  lock(@Param("id") id: string, @Body() body: any) {
    requireFields(body, ["from", "locked"]);
    return this.board.setLock(toInt(id, "id"), cellRef(body.from), Boolean(body.locked));
  }

  // ---- publish lifecycle (task 3.7) ----

  @Get("publish/preview")
  @RequirePermission(PERMISSIONS.TIMETABLE_PUBLISH)
  preview(@Param("id") id: string) {
    return this.publishSvc.preview(toInt(id, "id"));
  }

  @Post("publish")
  @RequirePermission(PERMISSIONS.TIMETABLE_PUBLISH)
  publish(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.publishSvc.publish(toInt(id, "id"), req.user.sub ?? null);
  }

  @Post("draft-from-published")
  @RequirePermission(PERMISSIONS.TIMETABLE_EDIT)
  draftFromPublished(@Param("id") id: string) {
    return this.publishSvc.draftFromPublished(toInt(id, "id"));
  }
}
