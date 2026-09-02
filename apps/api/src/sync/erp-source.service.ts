/**
 * §23 — the ERP connection, and whether it works. Master by master.
 *
 * The sync reads the ERP's REST API and nothing else (§23.6). It used to also
 * offer a direct read of the ERP's database; that came out, because two sources
 * meant two things to keep correct for one job, and an integration that needs
 * database credentials to somebody else's production server is a harder
 * conversation than one that needs a read token.
 *
 * The unit of configuration is **one master**, not the whole feature. An ERP
 * with a staff endpoint and no sections endpoint syncs teachers today and says
 * "not configured" on the Class Sections card — rather than failing as a whole
 * and leaving somebody to work out which of five endpoints was the problem.
 *
 * `probe()` is the diagnostic: call every configured endpoint for real, report
 * what came back, and name whatever did not fit — beside the ERP's own record,
 * because a wrong field name is only obvious next to the thing it missed.
 */
import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { SYNC_SHEETS, type SyncSheet } from "@edutimetable/shared";
import { endpointFor, ErpHttpReader, erpApiMapping, resetErpApiCache } from "./erp-http.reader";
import type { ErpReader } from "./erp-reader";

export interface SheetStatus {
  sheet: SyncSheet;
  /** somebody has given this master an endpoint */
  configured: boolean;
  /** the path it calls, so a wrong mapping is visible without reading a file */
  endpoint: string | null;
  /** the endpoint answered AND every declared field resolved */
  ok: boolean;
  rowsSeen: number;
  /** our fields the declared paths did not produce */
  missingColumns: string[];
  error: string | null;
  /** one record as the ERP returned it */
  sample: unknown;
}

export interface ProbeResult {
  describe: string;
  /** base URL and school lookup are set — without them nothing can run */
  configured: boolean;
  connected: boolean;
  erpSchoolId: string | number | null;
  error: string | null;
  sheets: SheetStatus[];
}

@Injectable()
export class ErpSourceService {
  private readonly logger = new Logger(ErpSourceService.name);
  private reader: ErpHttpReader | null = null;

  /** The reader, built once. Stateless, so one instance serves every school. */
  private readerFor(): ErpHttpReader {
    if (!this.reader) {
      this.reader = new ErpHttpReader();
      this.logger.log(`ERP source: ${this.reader.describe()}`);
    }
    return this.reader;
  }

  /**
   * Enough configuration to talk to the ERP at all: a base URL, a school
   * lookup, and credentials it can actually present (§23.8).
   *
   * Defined as "nothing to complain about" rather than its own list of checks,
   * so the boolean the screen greys a button on and the sentence it prints can
   * never disagree.
   */
  isConfigured(): boolean {
    return this.unconfiguredReason() === null;
  }

  /** Does this one master have an endpoint? */
  isSheetConfigured(sheet: SyncSheet): boolean {
    return this.isConfigured() && endpointFor(sheet) !== null;
  }

  endpointPath(sheet: SyncSheet): string | null {
    return endpointFor(sheet)?.path ?? null;
  }

  describe(): string {
    return this.readerFor().describe();
  }

  /** Drop the cached endpoint file so the next request re-reads it from disk. */
  reloadMapping(): void {
    resetErpApiCache();
    // The reader captures the `auth` block when it is constructed, so reloading
    // the file without rebuilding it would re-read the endpoints and go on
    // authenticating with the old credentials — the confusing half-reload.
    void this.reader?.close();
    this.reader = null;
    this.logger.log(`ERP endpoint mapping reloaded from ${process.env.ERP_API_FILE ?? "(no ERP_API_FILE)"}`);
  }

  /**
   * Why nothing can run, said as what to do about it — or null when it can.
   *
   * Two different absences, and conflating them is what made the old screen
   * unhelpful: no base URL is "nobody has set this up", no endpoint for this
   * master is "this one master is not wired yet, the others are fine".
   */
  unconfiguredReason(sheet?: SyncSheet): string | null {
    // §23.8 — a missing client secret is reported here, once, rather than as
    // five identical connection failures on five cards.
    const auth = process.env.ERP_API_BASE_URL ? this.readerFor().authProblem() : null;
    if (auth) return auth;
    if (!process.env.ERP_API_BASE_URL) {
      return (
        "No API integration has been set up. Set ERP_API_BASE_URL to the ERP's REST API and describe its " +
        "endpoints in ERP_API_FILE (see scripts/erp-api.example.json)."
      );
    }
    if (!erpApiMapping().school?.path) {
      return (
        "No school-lookup endpoint is configured. Set `school` in ERP_API_FILE — it turns this school's code " +
        "into the id the ERP knows it by, and every other request needs it."
      );
    }
    if (sheet && !endpointFor(sheet)) {
      return `No API integration has been done for ${sheet}. Add its endpoint to ERP_API_FILE and it will sync from here.`;
    }
    return null;
  }

  private require(sheet?: SyncSheet): ErpReader {
    const why = this.unconfiguredReason(sheet);
    if (why) throw new ServiceUnavailableException(why);
    return this.readerFor();
  }

  async resolveSchool(code: string, actingUser?: string | null): Promise<string | number> {
    try {
      return await this.require().resolveSchool(code, actingUser);
    } catch (e) {
      if (e instanceof ServiceUnavailableException) throw e;
      throw new ServiceUnavailableException(explainConnection(e as Error));
    }
  }

  async fetchSheet(sheet: SyncSheet, erpSchoolId: string | number, actingUser?: string | null): Promise<Record<string, unknown>[]> {
    try {
      return await this.require(sheet).fetchSheet(sheet, erpSchoolId, actingUser);
    } catch (e) {
      if (e instanceof ServiceUnavailableException) throw e;
      throw new ServiceUnavailableException(explainConnection(e as Error));
    }
  }

  /**
   * Call every configured endpoint against the real ERP and report what
   * happened, writing nothing. The first thing to run after pointing this at a
   * new deployment, and the thing to run again when a card says it cannot read.
   */
  async probe(code: string, actingUser?: string | null): Promise<ProbeResult> {
    const blank = (sheet: SyncSheet, error: string | null): SheetStatus => ({
      sheet,
      configured: endpointFor(sheet) !== null,
      endpoint: this.endpointPath(sheet),
      ok: false,
      rowsSeen: 0,
      missingColumns: [],
      error,
      sample: null,
    });

    const base: ProbeResult = {
      describe: process.env.ERP_API_BASE_URL ? this.describe() : "no API configured",
      configured: this.isConfigured(),
      connected: false,
      erpSchoolId: null,
      error: this.unconfiguredReason(),
      sheets: SYNC_SHEETS.map((s) => blank(s, endpointFor(s) ? null : this.unconfiguredReason(s))),
    };
    if (!base.configured) return base;

    const reader = this.readerFor();
    let erpSchoolId: string | number;
    try {
      erpSchoolId = await reader.resolveSchool(code, actingUser);
      base.connected = true;
      base.erpSchoolId = erpSchoolId;
    } catch (e) {
      base.error = explainConnection(e as Error);
      return base;
    }

    base.sheets = [];
    for (const sheet of SYNC_SHEETS) {
      if (!endpointFor(sheet)) {
        base.sheets.push(blank(sheet, this.unconfiguredReason(sheet)));
        continue;
      }
      try {
        const { raw, missing } = await reader.sample(sheet, erpSchoolId, actingUser);
        base.sheets.push({
          ...blank(sheet, null),
          ok: missing.length === 0,
          rowsSeen: raw.length,
          missingColumns: missing,
          // The ERP's own first record. A mapping that reads the wrong field is
          // only obvious next to what actually came back.
          sample: raw[0] ?? null,
        });
      } catch (e) {
        base.sheets.push(blank(sheet, explainConnection(e as Error)));
      }
    }
    return base;
  }

  async close(): Promise<void> {
    await this.reader?.close();
    this.reader = null;
  }
}

/**
 * A failure, said in terms of what to do about it.
 *
 * A driver's own text — "401 Unauthorized", "fetch failed" — is accurate and
 * useless: a symptom with no remedy, which is exactly what the §4 message
 * contract rules out. These are the failures an operator actually meets when
 * pointing this at an ERP for the first time.
 */
export function explainConnection(e: Error): string {
  const raw = e.message;
  const base = process.env.ERP_API_BASE_URL ?? "the configured base URL";

  // §23.8 — the authenticator's own messages already name the setting to fix
  // (which env var holds the secret, which mapping key is missing). Wrapping
  // them in "check ERP_API_BASE_URL" would bury the useful half.
  if (/No API endpoint is configured|No school-lookup endpoint|refused our credentials|token endpoint|No access token at/i.test(raw)) {
    return firstUsefulLine(raw);
  }
  if (/\b401\b|\b403\b|Unauthorized|Forbidden/i.test(raw)) {
    return `${firstUsefulLine(raw)} — set ERP_API_TOKEN (or ERP_API_KEY_HEADER + ERP_API_KEY) to a service account that may read masters.`;
  }
  if (/\b404\b|Not Found/i.test(raw)) {
    return `${firstUsefulLine(raw)} — that path does not exist under ${base}. Correct it in ERP_API_FILE (§23.6).`;
  }
  if (/ECONNREFUSED|ENOTFOUND|getaddrinfo|timed out|fetch failed/i.test(raw)) {
    return `Cannot reach ${base}. Check ERP_API_BASE_URL and that this container can see the ERP's network.`;
  }
  if (/did not return JSON|expected a list|unknown placeholder/i.test(raw)) {
    return `${firstUsefulLine(raw)} — the response shape differs from the mapping. Correct it in ERP_API_FILE (§23.6).`;
  }
  return firstUsefulLine(raw);
}

/**
 * A driver's message as one readable line. NOT `split("\n")[0]`: several
 * drivers' messages BEGIN with a newline, so the first line is empty — which
 * would make the probe say a request failed and refuse to say why.
 */
export function firstUsefulLine(message: string): string {
  const lines = message.split("\n").map((l) => l.trim()).filter(Boolean);
  const driver = lines.find((l) =>
    /GET |expected a list|No API endpoint|No school-lookup|placeholder|refused our credentials|token endpoint|access token/i.test(l));
  return (driver ?? lines[lines.length - 1] ?? message).slice(0, 300);
}
