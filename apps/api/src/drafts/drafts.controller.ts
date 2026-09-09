/**
 * §22 Phase 17 — draft registry endpoints, hung off the timetable config like
 * the rest of the board surface.
 *
 * `timetable.generate` for creating and discarding (a draft is the product of a
 * generation), `timetable.edit` for reading and renaming. Publishing a draft
 * stays on the publish endpoint with `timetable.publish` — choosing which of
 * five drafts the school lives with is exactly the decision that permission is
 * for.
 */
import { Body, Controller, Delete, Get, Param, Post, Put } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { toInt } from "../masters/crud.util";
import { DraftsService } from "./drafts.service";
import { FreezeService } from "../freeze/freeze.service";

@Controller("timetable-configs/:id/drafts")
export class DraftsController {
  constructor(
    private readonly drafts: DraftsService,
    private readonly freeze: FreezeService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.TIMETABLE_EDIT)
  list(@Param("id") id: string) {
    return this.drafts.list(toInt(id, "id"));
  }

  @Post()
  @RequirePermission(PERMISSIONS.TIMETABLE_GENERATE)
  async create(@Param("id") id: string, @Body() body: any) {
    // §29.1 — a draft is the route to publishing a different week (§22), so it
    // waits for the thaw. Listing and reading drafts are untouched.
    await this.freeze.assertConfigs([toInt(id, "id")], "the timetable");
    return this.drafts.create(toInt(id, "id"), {
      label: body?.label ?? null,
      copyFromDraftId: body?.copyFromDraftId != null ? toInt(body.copyFromDraftId, "copyFromDraftId") : null,
      copyPublished: Boolean(body?.copyPublished),
    });
  }

  /*
   * The `:draftId` routes below all resolve the CONFIG and check it belongs to
   * this school BEFORE parsing the draft id. Order matters twice over: a
   * stranger must be told "no such timetable" rather than "malformed id", and
   * the §17.8 sweep needs the owner and the stranger to get different answers
   * or the route is reported as proving nothing.
   */
  @Put(":draftId")
  @RequirePermission(PERMISSIONS.TIMETABLE_EDIT)
  async rename(@Param("id") id: string, @Param("draftId") draftId: string, @Body() body: any) {
    const configId = await this.ownConfig(id);
    await this.freeze.assertConfigs([configId], "the timetable");
    return this.drafts.rename(configId, toInt(draftId, "draftId"), body?.label ?? null);
  }

  @Post(":draftId/archive")
  @RequirePermission(PERMISSIONS.TIMETABLE_EDIT)
  async archive(@Param("id") id: string, @Param("draftId") draftId: string, @Body() body: any) {
    const configId = await this.ownConfig(id);
    await this.freeze.assertConfigs([configId], "the timetable");
    return this.drafts.archive(configId, toInt(draftId, "draftId"), body?.archived !== false);
  }

  /** Re-read the numbers from the stored grid — the masters may have moved. */
  @Post(":draftId/recompute")
  @RequirePermission(PERMISSIONS.TIMETABLE_EDIT)
  async recompute(@Param("id") id: string, @Param("draftId") draftId: string) {
    const configId = await this.ownConfig(id);
    return this.drafts.recompute(configId, toInt(draftId, "draftId"));
  }

  @Delete(":draftId")
  @RequirePermission(PERMISSIONS.TIMETABLE_GENERATE)
  async discard(@Param("id") id: string, @Param("draftId") draftId: string) {
    const configId = await this.ownConfig(id);
    await this.freeze.assertConfigs([configId], "the timetable");
    return this.drafts.discard(configId, toInt(draftId, "draftId"));
  }

  /** 404 unless this timetable belongs to the caller's school. */
  private async ownConfig(id: string): Promise<number> {
    const configId = toInt(id, "id");
    await this.drafts.assertConfigOwned(configId);
    return configId;
  }
}
