/**
 * §23.8 — authenticating to a secured ERP API.
 *
 * The ERP's API is protected, and the credential is described in the mapping
 * file rather than coded, the same way its endpoints are — so moving from a
 * static key to OAuth2 is configuration, not a release.
 *
 * WHY NOT THE SSO TOKEN. The obvious idea is to present the ERP's own SSO token
 * back to it. It cannot work, for three reasons that are all facts about this
 * app rather than opinions:
 *
 *   1. It is single-use. `AuthService` burns the `jti` in Redis and refuses a
 *      replay (§15.1); an ERP worth trusting does the same.
 *   2. It is a *login* credential with a short `exp`. A sync happens minutes or
 *      hours after login, and the nightly job has no user and no token at all.
 *   3. We do not keep it. `/sso/callback` verifies it and discards it in favour
 *      of our own session JWT — which the ERP has no reason to trust, because
 *      we signed it.
 *
 * What survives from SSO is the useful part: WHO asked. `actingUser` puts the
 * ERP user id of the admin who pressed Sync on the outgoing request, so the
 * ERP's own audit log can name them — identity propagated, not a credential
 * replayed.
 *
 * Three modes:
 *   oauth2  — client-credentials grant against the ERP's token endpoint
 *   bearer  — a static long-lived token (ERP_API_TOKEN), the original mode
 *   none    — an open API, for a stand-in or an internal network
 */
import { Logger } from "@nestjs/common";
import { pick } from "@edutimetable/shared";

export type ErpAuthMode = "oauth2" | "bearer" | "none";

export interface ErpAuthConfig {
  mode?: ErpAuthMode;
  /** oauth2: the token endpoint. Absolute, or a path under ERP_API_BASE_URL. */
  tokenUrl?: string;
  clientId?: string;
  /**
   * oauth2: the env var holding the secret. The SECRET ITSELF IS NEVER IN THIS
   * FILE — the mapping is committed to the repo, environment is not.
   */
  clientSecretEnv?: string;
  scope?: string;
  /** some providers require an explicit audience on the grant */
  audience?: string;
  /** how the client authenticates: form body (default) or HTTP Basic */
  style?: "post" | "basic";
  /** where the token and its lifetime live in the response */
  accessTokenPath?: string;
  expiresInPath?: string;
  /** header carrying the ERP user id of whoever triggered the sync */
  actingUserHeader?: string;
}

/** A token with the moment it stops being usable. */
interface CachedToken {
  value: string;
  /** epoch ms, already reduced by the safety margin below */
  goodUntil: number;
}

/**
 * Refresh this long before the ERP would expire the token.
 *
 * Not politeness: a token that expires between our check and the ERP's is a
 * 401 in the middle of a sync. Thirty seconds covers clock skew and the request
 * itself, and the 401 retry below covers the rest.
 */
const SAFETY_MARGIN_MS = 30_000;

/** Used when the ERP's response omits `expires_in` — never "cache forever". */
const ASSUMED_LIFETIME_S = 300;

export class ErpAuthenticator {
  private readonly logger = new Logger(ErpAuthenticator.name);
  private token: CachedToken | null = null;
  /** In-flight fetch, shared so five parallel masters mint one token, not five. */
  private inFlight: Promise<CachedToken> | null = null;

  constructor(private readonly config: ErpAuthConfig = {}) {}

  mode(): ErpAuthMode {
    if (this.config.mode) return this.config.mode;
    // No `auth` block: fall back to the original static-token behaviour, so a
    // deployment configured before §23.8 keeps working untouched.
    return process.env.ERP_API_TOKEN || process.env.ERP_API_KEY ? "bearer" : "none";
  }

  /** One line for the screen: how we authenticate, and as whom. */
  describe(): string {
    switch (this.mode()) {
      case "oauth2":
        return `OAuth2 client credentials as "${this.config.clientId ?? "(no clientId)"}"`;
      case "bearer":
        return process.env.ERP_API_KEY_HEADER ? `API key header ${process.env.ERP_API_KEY_HEADER}` : "static bearer token";
      default:
        return "no authentication";
    }
  }

  /**
   * Why this cannot authenticate, said as what to set — or null when it can.
   *
   * Reported per deployment rather than thrown per request, so the Sync screen
   * can say "the client secret is not set" instead of every master reporting a
   * connection failure.
   */
  unconfiguredReason(): string | null {
    if (this.mode() !== "oauth2") return null;
    if (!this.config.tokenUrl) return 'OAuth2 is configured but `auth.tokenUrl` is missing from ERP_API_FILE.';
    if (!this.config.clientId) return 'OAuth2 is configured but `auth.clientId` is missing from ERP_API_FILE.';
    const envName = this.secretEnvName();
    if (!process.env[envName]) {
      return `The ERP client secret is not set. Put it in the ${envName} environment variable — never in ERP_API_FILE, which is committed.`;
    }
    return null;
  }

  private secretEnvName(): string {
    return this.config.clientSecretEnv || "ERP_API_CLIENT_SECRET";
  }

  /**
   * Headers for one outgoing request.
   *
   * `actingUser` is the ERP user id of whoever pressed the button, when a
   * person did. A scheduled run omits it, and that absence is meaningful — the
   * ERP can tell an unattended sync from an admin's.
   */
  async headers(actingUser?: string | null): Promise<Record<string, string>> {
    const h: Record<string, string> = { Accept: "application/json" };

    if (this.mode() === "oauth2") {
      h.Authorization = `Bearer ${await this.accessToken()}`;
    } else if (this.mode() === "bearer") {
      if (process.env.ERP_API_TOKEN) h.Authorization = `Bearer ${process.env.ERP_API_TOKEN}`;
      const keyHeader = process.env.ERP_API_KEY_HEADER;
      if (keyHeader && process.env.ERP_API_KEY) h[keyHeader] = process.env.ERP_API_KEY;
    }

    const actHeader = this.config.actingUserHeader;
    if (actHeader && actingUser) h[actHeader] = actingUser;
    return h;
  }

  /**
   * Throw the cached token away.
   *
   * Called on a 401 so a rotated or revoked credential self-heals on the retry
   * rather than failing a sync that would succeed a second later.
   */
  invalidate(): void {
    this.token = null;
  }

  /** True when a 401 is worth one retry — there is a token to re-fetch. */
  canRetryAfter401(): boolean {
    return this.mode() === "oauth2";
  }

  private async accessToken(): Promise<string> {
    const why = this.unconfiguredReason();
    if (why) throw new Error(why);

    if (this.token && Date.now() < this.token.goodUntil) return this.token.value;
    // Share one fetch between concurrent callers: five masters syncing at once
    // must not mint five tokens, which some providers rate-limit or treat as
    // five sessions.
    if (!this.inFlight) {
      this.inFlight = this.fetchToken().finally(() => { this.inFlight = null; });
    }
    this.token = await this.inFlight;
    return this.token.value;
  }

  private async fetchToken(): Promise<CachedToken> {
    const base = process.env.ERP_API_BASE_URL ?? "";
    const raw = this.config.tokenUrl!;
    const url = /^https?:\/\//i.test(raw)
      ? raw
      : `${base.replace(/\/$/, "")}${raw.startsWith("/") ? "" : "/"}${raw}`;

    const secret = process.env[this.secretEnvName()]!;
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    if (this.config.scope) body.set("scope", this.config.scope);
    if (this.config.audience) body.set("audience", this.config.audience);

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    if (this.config.style === "basic") {
      headers.Authorization =
        "Basic " + Buffer.from(`${this.config.clientId}:${secret}`).toString("base64");
    } else {
      body.set("client_id", this.config.clientId!);
      body.set("client_secret", secret);
    }

    const timeoutMs = Number(process.env.ERP_API_TIMEOUT_MS ?? 20_000);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body, signal: ac.signal });
    } catch (e) {
      const msg = (e as Error).name === "AbortError" ? `timed out after ${timeoutMs}ms` : (e as Error).message;
      throw new Error(`Could not reach the ERP token endpoint ${url} — ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // The provider's own error body, which for a client-credentials grant is
      // usually `invalid_client` — the one word that says which end is wrong.
      // Never echo the secret; only ever the name of the variable holding it.
      const text = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(
        `The ERP refused our credentials (${res.status} ${res.statusText}${text ? ` · ${text}` : ""}). ` +
          `Check auth.clientId in ERP_API_FILE and the secret in ${this.secretEnvName()}.`,
      );
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new Error(`The ERP token endpoint ${url} did not return JSON.`);
    }

    const value = pick(payload, this.config.accessTokenPath || "access_token");
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `No access token at "${this.config.accessTokenPath || "access_token"}" in the ERP's token response. ` +
          `Set auth.accessTokenPath in ERP_API_FILE to where it actually is.`,
      );
    }

    const lifetimeRaw = Number(pick(payload, this.config.expiresInPath || "expires_in"));
    const lifetime = Number.isFinite(lifetimeRaw) && lifetimeRaw > 0 ? lifetimeRaw : ASSUMED_LIFETIME_S;
    const goodUntil = Date.now() + Math.max(lifetime * 1000 - SAFETY_MARGIN_MS, 1_000);
    this.logger.log(`ERP access token obtained, valid ${lifetime}s`);
    return { value, goodUntil };
  }
}
