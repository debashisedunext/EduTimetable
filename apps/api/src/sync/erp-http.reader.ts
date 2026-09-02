/**
 * §23.6 — reading the masters from the ERP's REST API. The only source.
 *
 * WHAT AN ERP HAS TO PROVIDE. Nothing exotic: up to five read endpoints, each
 * returning a JSON array of records for one school, plus one that resolves a
 * school code to the ERP's own id. No particular field names, no envelope, no
 * pagination style — all of that is described in the mapping file rather than
 * demanded of the ERP, so integrating is filling in JSON, not changing code.
 *
 * Masters arrive one at a time. An ERP that has a staff endpoint today and a
 * sections endpoint next month syncs teachers today; the masters with no
 * endpoint say "not configured" on their own card and block nothing else.
 *
 * Configure with:
 *   ERP_API_BASE_URL=https://erp.example.com/api/v1
 *   ERP_API_FILE=/path/endpoints.json  (the mapping — endpoints AND auth)
 *   ERP_API_CLIENT_SECRET=…            (OAuth2; the secret never goes in the file)
 *   ERP_API_TOKEN / ERP_API_KEY_HEADER + ERP_API_KEY   (static-token modes)
 *
 * Authentication is described in the mapping's `auth` block and handled by
 * `erp-auth.ts` — see §23.8 there for why the ERP's SSO token cannot simply be
 * replayed, and what is propagated instead.
 *
 * Then run `GET /sync/erp/probe`, which calls every endpoint and reports the
 * status, the record count and any field whose path did not resolve — by name,
 * with the path it looked at.
 */
import { readFileSync } from "node:fs";
import { Logger } from "@nestjs/common";
import {
  fillTemplate,
  mapRecord,
  missingFields,
  pick,
  pickList,
  type SyncSheet,
} from "@edutimetable/shared";
import { ErpAuthenticator, type ErpAuthConfig } from "./erp-auth";
import type { ErpReader } from "./erp-reader";

export interface ErpEndpoint {
  /** Appended to the base URL. `{schoolId}` and `{page}` are substituted. */
  path: string;
  /** Where the array of records is in the response body. "" = the body IS it. */
  list: string;
  /** our field key → dotted path within one record */
  fields: Record<string, string>;
  /**
   * How to page, when the ERP pages. Omit for an endpoint that returns
   * everything: a school's masters are hundreds of rows, not millions.
   */
  page?: {
    /** first page number — 1 for most APIs, 0 for some */
    from: number;
    /** path to the last page number, or to the total count */
    lastPagePath?: string;
    totalPath?: string;
    /** page size, if the ERP takes one; substituted as {size} */
    size?: number;
    /** hard stop, so a misread page field cannot loop forever */
    max: number;
  };
}

export interface ErpApiMapping {
  /** §23.8 — how we authenticate. Omitted = the pre-§23.8 static-token mode. */
  auth?: ErpAuthConfig;
  /** Resolves OUR schools.code to the ERP's own school id. */
  school: { path: string; pick: string } | null;
  /**
   * Partial on purpose. A master with no entry here is **not configured**, and
   * says so on its own card — the other four still sync.
   */
  sheets: Partial<Record<SyncSheet, ErpEndpoint>>;
}

/**
 * Nothing, until somebody says otherwise.
 *
 * This shipped with plausible Laravel-shaped guesses (`/staff`, `/sections`,
 * `data.0.id`) and that was a mistake: a guessed path produces a 404 and a
 * connection error, which reads as "the ERP is broken" when the truth is "no
 * endpoint was ever configured for this master". A blank that names itself is
 * strictly more useful than a guess that fails.
 *
 * `scripts/erp-api.example.json` holds a worked example to copy.
 */
export const DEFAULT_ERP_API: ErpApiMapping = { school: null, sheets: {} };

let cached: ErpApiMapping | null = null;

export function erpApiMapping(): ErpApiMapping {
  if (cached) return cached;
  const path = process.env.ERP_API_FILE;
  let merged = DEFAULT_ERP_API;
  if (path) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ErpApiMapping>;
      merged = { auth: raw.auth, school: raw.school ?? null, sheets: { ...(raw.sheets ?? {}) } };
      new Logger("ErpApiMapping").log(
        `ERP endpoints loaded from ${path}: ${Object.keys(merged.sheets).join(", ") || "none"}`,
      );
    } catch (e) {
      // Loud: silently falling back to "nothing configured" because a config
      // file had a typo is how a sync reports "0 rows" and nobody knows why.
      throw new Error(`ERP_API_FILE ${path} could not be read: ${(e as Error).message}`);
    }
  }
  cached = merged;
  return merged;
}

export function resetErpApiCache(): void {
  cached = null;
}

/** The endpoint for one master, or null when nobody has configured it yet. */
export function endpointFor(sheet: SyncSheet): ErpEndpoint | null {
  const ep = erpApiMapping().sheets[sheet];
  return ep && ep.path ? ep : null;
}

export class ErpHttpReader implements ErpReader {
  private readonly logger = new Logger(ErpHttpReader.name);
  private readonly auth = new ErpAuthenticator(erpApiMapping().auth);

  describe(): string {
    return `REST API at ${process.env.ERP_API_BASE_URL ?? "(ERP_API_BASE_URL unset)"} · ${this.auth.describe()}`;
  }

  /** Why we could not authenticate at all, said as what to set. */
  authProblem(): string | null {
    return this.auth.unconfiguredReason();
  }

  /**
   * One GET, with a timeout and a readable failure.
   *
   * GET only, and nothing else is exposed: a sync has no business writing to
   * the ERP, and the surface that cannot do it is the one that never will.
   *
   * A 401 is retried EXACTLY once, after throwing the cached access token away
   * (§23.8). A rotated or early-expired credential then self-heals instead of
   * failing a sync that would succeed a second later. Once, not in a loop: if
   * the credential is genuinely wrong, hammering somebody's token endpoint is
   * how an integration gets blocked.
   *
   * `actingUser` is threaded as a PARAMETER, never stored on the reader: this
   * object is shared by every request and every school, and a field holding
   * "who asked" would report one admin's name on another's sync (§17).
   */
  private async get(path: string, actingUser?: string | null, retried = false): Promise<unknown> {
    const base = process.env.ERP_API_BASE_URL;
    if (!base) throw new Error("ERP_API_BASE_URL is not set.");
    const url = `${base.replace(/\/$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
    const timeoutMs = Number(process.env.ERP_API_TIMEOUT_MS ?? 20_000);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: await this.auth.headers(actingUser),
        signal: ac.signal,
      });
    } catch (e) {
      const msg = (e as Error).name === "AbortError"
        ? `timed out after ${timeoutMs}ms`
        : (e as Error).message;
      throw new Error(`GET ${path} — ${msg}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 && !retried && this.auth.canRetryAfter401()) {
      this.logger.warn(`GET ${path} → 401; refreshing the ERP access token and retrying once`);
      this.auth.invalidate();
      return this.get(path, actingUser, true);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      // 401/403 is the commonest first failure and deserves to say so.
      const hint = res.status === 401 || res.status === 403
        ? ` — the ERP rejected our credentials (${this.auth.describe()}); check they may read masters`
        : "";
      throw new Error(`GET ${path} → ${res.status} ${res.statusText}${hint}${body ? ` · ${body}` : ""}`);
    }
    try {
      return await res.json();
    } catch {
      throw new Error(`GET ${path} did not return JSON — check the path and any Accept header the ERP requires`);
    }
  }

  /** The endpoint this master would call, for the screen and the run log. */
  pathFor(sheet: SyncSheet): string | null {
    return endpointFor(sheet)?.path ?? null;
  }

  private require(sheet: SyncSheet): ErpEndpoint {
    const ep = endpointFor(sheet);
    if (!ep) {
      throw new Error(
        `No API endpoint is configured for ${sheet}. Add it to ERP_API_FILE (see scripts/erp-api.example.json).`,
      );
    }
    return ep;
  }

  async resolveSchool(code: string, actingUser?: string | null): Promise<string | number> {
    const { school } = erpApiMapping();
    if (!school?.path) {
      throw new Error(
        "No school-lookup endpoint is configured. Set `school` in ERP_API_FILE — it turns this school's code into " +
          "the id the ERP knows it by, and every other request needs it.",
      );
    }
    const body = await this.get(fillTemplate(school.path, { code }), actingUser);
    const id = pick(body, school.pick);
    if (id === undefined || id === null) {
      throw new Error(
        `The ERP returned no school for code "${code}" at "${school.path}" (looked for "${school.pick}"). ` +
          `That code is the contract between the two systems (§15.1).`,
      );
    }
    return id as string | number;
  }

  /** Every record for one master, following pagination when configured. */
  async fetchSheet(sheet: SyncSheet, schoolId: string | number, actingUser?: string | null): Promise<Record<string, unknown>[]> {
    const ep = this.require(sheet);
    const out: Record<string, unknown>[] = [];
    for (const records of await this.pages(ep, schoolId, actingUser)) {
      for (const r of records) out.push(mapRecord(r, ep.fields));
    }
    return out;
  }

  async sample(sheet: SyncSheet, schoolId: string | number, actingUser?: string | null) {
    const ep = this.require(sheet);
    const body = await this.get(fillTemplate(ep.path, { schoolId, page: ep.page?.from ?? 1, size: ep.page?.size ?? 100 }), actingUser);
    const raw = pickList(body, ep.list);
    return { raw: raw.slice(0, 5), missing: raw.length === 0 ? [] : missingFields(raw[0], ep.fields) };
  }

  private async pages(ep: ErpEndpoint, schoolId: string | number, actingUser?: string | null): Promise<unknown[][]> {
    const vars = { schoolId, page: ep.page?.from ?? 1, size: ep.page?.size ?? 100 };
    const first = await this.get(fillTemplate(ep.path, vars), actingUser);
    const pages: unknown[][] = [pickList(first, ep.list)];
    if (!ep.page) return pages;

    // How many more, from whichever field the ERP publishes.
    let last = ep.page.from;
    if (ep.page.lastPagePath) {
      last = Number(pick(first, ep.page.lastPagePath) ?? ep.page.from);
    } else if (ep.page.totalPath && ep.page.size) {
      last = ep.page.from + Math.ceil(Number(pick(first, ep.page.totalPath) ?? 0) / ep.page.size) - 1;
    }
    // A hard stop, always: a misread page field must not loop against somebody
    // else's production API until something times out.
    const stop = Math.min(last, ep.page.from + ep.page.max - 1);
    // `stop < last`, not `>`: the cap bit when it held us BELOW the last page.
    // Written the other way round this warning could never fire, which is the
    // one circumstance it exists for.
    if (stop < last) this.logger.warn(`${ep.path}: page cap ${ep.page.max} reached — some records were not read`);
    for (let p = ep.page.from + 1; p <= stop; p++) {
      pages.push(pickList(await this.get(fillTemplate(ep.path, { ...vars, page: p }), actingUser), ep.list));
    }
    return pages;
  }

  async close(): Promise<void> {
    /* stateless */
  }
}
