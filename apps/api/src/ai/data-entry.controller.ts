/**
 * §13.5 — applying what the assistant drafted.
 *
 * One endpoint, and it takes a proposal ID rather than rows. The rows live in
 * a school-scoped server-side stash and are re-validated at the moment of the
 * write, so nothing a browser holds can become a write — the same rule §16's
 * commit follows by re-parsing the uploaded file.
 *
 * `masters.manage`, not a new AI permission: the authority to add a teacher is
 * the one the Setup Wizard already requires. The assistant is a different way
 * to exercise it, never a way around it.
 */
import { Body, Controller, Post, Req } from "@nestjs/common";
import { PERMISSIONS, COMMON_SUBJECTS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { Get } from "@nestjs/common";
import { type AuthedRequest } from "../masters/crud.util";
import { AiDataEntryService } from "./data-entry.service";

@Controller("ai/data-entry")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class AiDataEntryController {
  constructor(private readonly dataEntry: AiDataEntryService) {}

  /** The subject catalogue behind the multi-select picker. Static reference. */
  @Get("common-subjects")
  commonSubjects() {
    return COMMON_SUBJECTS;
  }

  /** Write a drafted proposal. The school comes from the session, always. */
  @Post("apply")
  async apply(@Req() req: AuthedRequest, @Body() body: { proposalId?: string }) {
    return this.dataEntry.apply(req.user.schoolId, String(body?.proposalId ?? ""), req.user.sub ?? null);
  }
}
