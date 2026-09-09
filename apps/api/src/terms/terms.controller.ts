/**
 * §25 Phase 26 — the terms of a session.
 *
 * Hung off the academic year, because that is what a term belongs to: terms are
 * the school's calendar, so every wing shares them and none of them owns them.
 * A second controller hangs the read off a timetable, which is what every
 * timetable screen actually has in its hand.
 *
 * Permissions match the Academic Year screens they live on: reading needs only
 * `timetable.generate` (the term selector appears on the Board and the Matrix,
 * which anybody who can generate can open), while writing the calendar is
 * `masters.manage` — a term boundary decides which timetable a Tuesday in
 * October belongs to.
 */
import { Body, Controller, Get, Param, Put, Query } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { toInt } from "../masters/crud.util";
import { TermsService } from "./terms.service";

@Controller("academic-years/:id/terms")
export class TermsController {
  constructor(private readonly terms: TermsService) {}

  /** The session's terms. An empty list means it runs as a whole year. */
  @Get()
  @RequirePermission(PERMISSIONS.TIMETABLE_GENERATE)
  list(@Param("id") id: string) {
    return this.terms.list(toInt(id, "id"));
  }

  /*
   * There is deliberately no "propose N terms" endpoint. Splitting a session
   * evenly is `splitSession` in `packages/shared`, which runs unchanged in the
   * browser and on the server — the same arrangement as the feasibility engine
   * and the board engine. An endpoint wrapping it would be a second path to one
   * answer, and the guided setup could not use it anyway: at its session step
   * the academic year does not exist yet.
   */

  /**
   * Save the whole set. An empty array turns the session back into a whole year.
   *
   * PUT rather than POST because it replaces: the rules that matter here — no
   * overlaps, at least two terms — are about the set, and a screen saving one
   * row at a time would walk through illegal states and could stop in one.
   */
  @Put()
  @RequirePermission(PERMISSIONS.MASTERS_MANAGE)
  replace(@Param("id") id: string, @Body() body: any) {
    const rows = Array.isArray(body?.terms) ? body.terms : [];
    return this.terms.replace(toInt(id, "id"), rows);
  }
}

/**
 * The same list, reached from a timetable rather than from a session.
 *
 * Every screen that shows a grid has a config id in its hand and no reason to
 * know which session it belongs to; making each one fetch the config first to
 * find the year to fetch the terms is three requests to answer "which terms?".
 *
 * **Session-only, no permission** — the §10.5 `/me/colors` argument exactly.
 * Every role needs this list: an admin on the Board, a teacher on My Timetable,
 * Front Office in the Substitute Center. No single permission is common to them
 * (a Principal holds `timetable.view.all`, a Teacher holds `.own` and `.class`,
 * and the guard is AND, not OR), and a role that could not read it would show
 * the wrong term's timetable with no way to tell — worse than not showing one.
 * Names, ids and dates only, scoped like everything else by the ambient tenant
 * context (§17); a term boundary discloses nothing the school calendar does not.
 */
@Controller("timetable-configs/:id/terms")
export class ConfigTermsController {
  constructor(private readonly terms: TermsService) {}

  @Get()
  async list(@Param("id") id: string, @Query("on") on?: string) {
    const configId = toInt(id, "id");
    const terms = await this.terms.forConfig(configId);
    return {
      terms,
      /**
       * The term this timetable opens on — today's, or the first one when today
       * is in the holidays. Sent with the list so a screen never has to
       * re-implement the rule, and `null` for a year-wise session, which is how
       * the selector knows to hide itself entirely.
       */
      currentTermId: terms.length === 0 ? null : await this.terms.resolve(configId, null, on ?? null),
    };
  }
}
