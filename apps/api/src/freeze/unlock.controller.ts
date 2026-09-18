/**
 * §29.8 — the unlock grant's routes.
 *
 * Under `/timetable-configs/:id/` rather than a prefix of their own, for the
 * §17.8 reason: the sweep classifies a route by the resource it hangs off, and
 * a grant is unambiguously about one timetable.
 *
 * `timetable.publish`, and deliberately **no new permission**. §29.1 decided
 * this for freeze/unfreeze with an argument that applies more strongly here: a
 * scoped grant is *narrower* than the unfreeze that permission already grants,
 * so inventing `timetable.unlock` would mean a §15.2 registry entry and a
 * per-role decision for every school that already exists, bought for a
 * distinction nobody has asked for.
 */
import { Body, Controller, Get, NotFoundException, Param, Post, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { toInt, type AuthedRequest } from "../masters/crud.util";
import { DEFAULT_UNLOCK_MINUTES, UnlockService } from "./unlock.service";

@Controller("timetable-configs")
export class UnlockController {
  constructor(
    private readonly unlocks: UnlockService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 404 unless this timetable belongs to the caller's school — BEFORE the
   * `:unlockId` in the path is parsed.
   *
   * The order is the point, and it is `drafts.controller.ts`'s lesson word for
   * word: a stranger must be told "no such timetable" rather than "malformed
   * id". §17.8's sweep found this the first time it ran — both sessions got the
   * same 400 from `toInt`, and it reported, correctly, that it could no longer
   * tell scoping apart from a route that refuses everybody. A route that
   * refuses everyone proves nothing.
   */
  private async ownConfig(id: string): Promise<number> {
    const configId = toInt(id, "id");
    const found = await this.prisma.timetableConfig.findFirst({
      where: { id: configId },
      select: { id: true },
    });
    if (!found) throw new NotFoundException(`Timetable ${configId} not found`);
    return configId;
  }

  /** Live and recent grants on this timetable. */
  @Get(":id/unlocks")
  @RequirePermission(PERMISSIONS.TIMETABLE_PUBLISH)
  list(@Param("id") id: string) {
    return this.unlocks.list(toInt(id, "id"));
  }

  /** What may be unlocked, and how many lessons each one opens. */
  @Get(":id/unlocks/options")
  @RequirePermission(PERMISSIONS.TIMETABLE_PUBLISH)
  options(@Param("id") id: string) {
    return this.unlocks.options(toInt(id, "id"));
  }

  /**
   * Open a grant.
   *
   * `expiresInMinutes` omitted takes the default; an explicit `null` means
   * "until somebody closes it". The two are deliberately distinguishable —
   * invariant 7's shape — because an unlock with no end is a real choice a
   * school may make, and it must not be reachable by forgetting a field.
   */
  @Post(":id/unlocks")
  @RequirePermission(PERMISSIONS.TIMETABLE_PUBLISH)
  open(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const mins =
      body?.expiresInMinutes === undefined
        ? DEFAULT_UNLOCK_MINUTES
        : body.expiresInMinutes === null
          ? null
          : toInt(body.expiresInMinutes, "expiresInMinutes");
    return this.unlocks.open(toInt(id, "id"), req.user.sub, {
      reason: String(body?.reason ?? ""),
      classSectionIds: Array.isArray(body?.classSectionIds) ? body.classSectionIds.map(Number) : [],
      teacherIds: Array.isArray(body?.teacherIds) ? body.teacherIds.map(Number) : [],
      expiresInMinutes: mins,
    });
  }

  /** Close a grant and relock what it opened. */
  @Post(":id/unlocks/:unlockId/close")
  @RequirePermission(PERMISSIONS.TIMETABLE_PUBLISH)
  async close(@Req() req: AuthedRequest, @Param("id") id: string, @Param("unlockId") unlockId: string) {
    const configId = await this.ownConfig(id);
    return this.unlocks.close(configId, toInt(unlockId, "unlockId"), req.user.sub);
  }

  /** What one grant was actually used for. */
  @Get(":id/unlocks/:unlockId/events")
  @RequirePermission(PERMISSIONS.TIMETABLE_PUBLISH)
  async events(@Param("id") id: string, @Param("unlockId") unlockId: string) {
    const configId = await this.ownConfig(id);
    return this.unlocks.events(configId, toInt(unlockId, "unlockId"));
  }
}
