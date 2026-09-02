/**
 * §23 — the ERP sync endpoints.
 *
 * All of them are `masters.manage`, and all of them take the school from the
 * SESSION, never from the request: the ERP is read with the school's own code
 * (§15.1), so a body-supplied code would be a way to pull another school's
 * staff master into this one — and, since apply deletes, a way to delete this
 * one's.
 *
 * The unit of work is one master. That is what the screen offers, and it is
 * also the right transactional unit: syncing Teachers should not roll back
 * because the Subjects endpoint is down.
 */
import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Query, Req } from "@nestjs/common";
import { PERMISSIONS, SYNC_SHEETS, type SyncMode, type SyncSheet } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { type AuthedRequest } from "../masters/crud.util";
import { ErpSourceService } from "./erp-source.service";
import { SyncService } from "./sync.service";

@Controller("sync")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class SyncController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpSourceService,
    private readonly sync: SyncService,
  ) {}

  /** This session's school — its code is the only identifier the ERP shares. */
  private async school(req: AuthedRequest): Promise<{ id: number; code: string; name: string }> {
    const school = await this.prisma.school.findFirst({
      where: { id: req.user.schoolId },
      select: { id: true, code: true, name: true },
    });
    if (!school?.code) throw new NotFoundException("This school has no ERP code recorded (§15.1).");
    return school;
  }

  private sheetFrom(v: unknown): SyncSheet {
    const sheet = SYNC_SHEETS.find((s) => s === String(v));
    if (!sheet) {
      throw new BadRequestException(`Unknown master "${String(v)}". Expected one of: ${SYNC_SHEETS.join(", ")}.`);
    }
    return sheet;
  }

  private modeFrom(v: unknown): SyncMode {
    // Defaults to the key-preserving mode. `replace` re-mints every id, and a
    // destructive default is not something a missing field should select.
    return String(v) === "replace" ? "replace" : "refresh";
  }

  /**
   * What the screen draws before anything is pressed: per master, whether an
   * API is configured, how many rows we hold, and how the last run went.
   *
   * Deliberately does NOT call the ERP — this loads on every visit, and a page
   * that hangs because somebody's staff API is slow is a page nobody opens.
   */
  @Get("erp/status")
  async status(@Req() req: AuthedRequest) {
    const last = await this.sync.lastRuns();
    const held: Record<SyncSheet, number> = {
      "Academic Years": await this.prisma.academicYear.count(),
      Classes: await this.prisma.schoolClass.count(),
      "Class Sections": await this.prisma.classSection.count(),
      Subjects: await this.prisma.subject.count(),
      Teachers: await this.prisma.teacher.count(),
    };
    return {
      describe: this.erp.isConfigured() ? this.erp.describe() : "no API configured",
      configured: this.erp.isConfigured(),
      reason: this.erp.unconfiguredReason(),
      schoolName: (await this.school(req)).name,
      masters: SYNC_SHEETS.map((sheet) => ({
        sheet,
        configured: this.erp.isSheetConfigured(sheet),
        reason: this.erp.unconfiguredReason(sheet),
        endpoint: this.erp.endpointPath(sheet),
        held: held[sheet],
        lastRun: (last as any)[sheet] ?? null,
      })),
    };
  }

  /**
   * Call every configured endpoint for real and report what came back. The
   * first thing to run after wiring up a new ERP, and the thing to run when a
   * card says it cannot read.
   */
  @Get("erp/probe")
  async probe(@Req() req: AuthedRequest) {
    return this.erp.probe((await this.school(req)).code, req.user.erpUserId);
  }

  /**
   * What one master's sync would do — including everything it would delete.
   * Writes nothing. This is where the confirmation's numbers come from.
   */
  @Post("erp/preview")
  async preview(@Req() req: AuthedRequest, @Body() body: any) {
    const school = await this.school(req);
    return this.sync.preview(school.code, this.sheetFrom(body?.sheet), this.modeFrom(body?.mode), req.user.erpUserId);
  }

  /**
   * Do it. The plan is recomputed here from the ERP and our own tables — the
   * request names the master, the mode and the confirmation, never the rows,
   * so a stale preview can never become the list of writes (§16's rule, §21's).
   */
  @Post("erp/apply")
  async apply(@Req() req: AuthedRequest, @Body() body: any) {
    const school = await this.school(req);
    return this.sync.apply({
      schoolId: school.id,
      schoolCode: school.code,
      schoolName: school.name,
      sheet: this.sheetFrom(body?.sheet),
      mode: this.modeFrom(body?.mode),
      confirm: body?.confirm,
      fingerprint: body?.fingerprint,
      userId: req.user.sub ?? null,
      // §23.8 — WHO pressed the button, forwarded so the ERP's own audit log
      // can name them. Identity propagated, never a credential replayed.
      actingErpUserId: req.user.erpUserId ?? null,
    });
  }

  /**
   * Re-read `ERP_API_FILE` from disk.
   *
   * Integrating an ERP is an edit-and-check loop against somebody else's live
   * API, and restarting the whole service between attempts is a poor loop. The
   * file is read by the server, never written by it, so this changes nothing
   * but which endpoints the next request calls.
   */
  @Post("erp/reload")
  async reload() {
    this.erp.reloadMapping();
    return { ok: true, configured: this.erp.isConfigured(), describe: this.erp.describe() };
  }

  /** The run history — every sync, including the failed and refused ones. */
  @Get("erp/logs")
  async logs(@Query("sheet") sheet?: string, @Query("limit") limit?: string) {
    const wanted = sheet ? SYNC_SHEETS.find((s) => s === sheet) : undefined;
    return this.sync.runs(wanted, Number(limit) || 25);
  }
}
