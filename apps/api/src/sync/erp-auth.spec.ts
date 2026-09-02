/**
 * §23.8 — the ERP API credential.
 *
 * These test the parts that are easy to get subtly wrong and impossible to
 * notice: a token cached past its expiry, five concurrent syncs minting five
 * tokens, a response shape the provider nests differently, and — the one that
 * matters most — a secret leaking into a message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErpAuthenticator } from "./erp-auth";

const SECRET = "s3cr3t-do-not-print";

function tokenResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? "Unauthorized" : "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const config = {
  mode: "oauth2" as const,
  tokenUrl: "https://erp.test/oauth/token",
  clientId: "edutimetable",
  clientSecretEnv: "TEST_ERP_SECRET",
  scope: "masters:read",
};

describe("§23.8 OAuth2 client credentials", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.TEST_ERP_SECRET = SECRET;
    process.env.ERP_API_BASE_URL = "https://erp.test/api/v1";
    fetchMock = vi.fn(async () =>
      tokenResponse({ access_token: "tok-1", token_type: "Bearer", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TEST_ERP_SECRET;
    delete process.env.ERP_API_BASE_URL;
  });

  it("fetches a token and sends it as a bearer", async () => {
    const auth = new ErpAuthenticator(config);
    expect((await auth.headers()).Authorization).toBe("Bearer tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://erp.test/oauth/token");
    expect(String(init.body)).toContain("grant_type=client_credentials");
    expect(String(init.body)).toContain("scope=masters%3Aread");
  });

  it("reuses the cached token rather than minting one per request", async () => {
    const auth = new ErpAuthenticator(config);
    await auth.headers();
    await auth.headers();
    await auth.headers();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mints ONE token for concurrent callers, not one each", async () => {
    // Five masters can sync at once. Five simultaneous grants is the kind of
    // thing a provider rate-limits, or counts as five sessions.
    const auth = new ErpAuthenticator(config);
    await Promise.all([auth.headers(), auth.headers(), auth.headers(), auth.headers(), auth.headers()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes WHILE the token is still valid, not once it has expired", async () => {
    // The property, stated precisely: with a 3600s token we re-fetch at 3580s
    // — while the ERP would still accept the old one. A token that expires
    // between our check and the ERP's is a 401 in the middle of a sync, and
    // the 30s margin is what covers the request and any clock skew.
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(async () =>
        tokenResponse({ access_token: `tok-${fetchMock.mock.calls.length}`, expires_in: 3600 }));
      const auth = new ErpAuthenticator(config);
      await auth.headers();

      vi.advanceTimersByTime(3_560_000); // 3560s — inside the margin, still ours
      expect((await auth.headers()).Authorization).toBe("Bearer tok-1");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(20_000); // 3580s — 20s of real life left, refresh anyway
      expect((await auth.headers()).Authorization).toBe("Bearer tok-2");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache forever when the ERP omits expires_in", async () => {
    fetchMock.mockImplementation(async () => tokenResponse({ access_token: "tok-x" }));
    const auth = new ErpAuthenticator(config);
    await auth.headers();
    // Cached, but on a bounded assumed lifetime rather than indefinitely.
    await auth.headers();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidate() forces the next request to re-fetch — the 401 retry path", async () => {
    const auth = new ErpAuthenticator(config);
    await auth.headers();
    auth.invalidate();
    await auth.headers();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.canRetryAfter401()).toBe(true);
  });

  it("sends HTTP Basic when the provider wants it, and never in the body", async () => {
    const auth = new ErpAuthenticator({ ...config, style: "basic" });
    await auth.headers();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe(
      "Basic " + Buffer.from(`edutimetable:${SECRET}`).toString("base64"));
    expect(String(init.body)).not.toContain("client_secret");
  });

  it("reads the token from wherever the provider puts it", async () => {
    fetchMock.mockImplementation(async () =>
      tokenResponse({ result: { credentials: { jwt: "nested-tok", ttl: 900 } } }));
    const auth = new ErpAuthenticator({
      ...config, accessTokenPath: "result.credentials.jwt", expiresInPath: "result.credentials.ttl",
    });
    expect((await auth.headers()).Authorization).toBe("Bearer nested-tok");
  });

  it("says which setting to fix when the ERP refuses the credentials", async () => {
    fetchMock.mockImplementation(async () =>
      tokenResponse({ error: "invalid_client" }, 401));
    const auth = new ErpAuthenticator(config);
    await expect(auth.headers()).rejects.toThrow(/auth.clientId.*TEST_ERP_SECRET|TEST_ERP_SECRET/s);
  });

  it("NEVER puts the secret in an error message", async () => {
    // The one failure with a blast radius beyond this feature: these messages
    // are shown on screen and written to `erp_sync_runs.error`.
    fetchMock.mockImplementation(async () => tokenResponse({ error: "invalid_client" }, 401));
    const auth = new ErpAuthenticator(config);
    const err = await auth.headers().catch((e: Error) => e.message);
    expect(err).not.toContain(SECRET);
    expect(err).toContain("TEST_ERP_SECRET");
  });

  it("names the missing piece rather than failing at request time", async () => {
    delete process.env.TEST_ERP_SECRET;
    expect(new ErpAuthenticator(config).unconfiguredReason()).toMatch(/TEST_ERP_SECRET/);
    expect(new ErpAuthenticator({ ...config, tokenUrl: undefined }).unconfiguredReason()).toMatch(/tokenUrl/);
    expect(new ErpAuthenticator({ ...config, clientId: undefined }).unconfiguredReason()).toMatch(/clientId/);
  });

  it("refuses to name a token response that carries no token", async () => {
    fetchMock.mockImplementation(async () => tokenResponse({ nothing: "here" }));
    const auth = new ErpAuthenticator(config);
    await expect(auth.headers()).rejects.toThrow(/access token.*accessTokenPath/s);
  });

  it("resolves a relative tokenUrl against the API base", async () => {
    const auth = new ErpAuthenticator({ ...config, tokenUrl: "/oauth/token" });
    await auth.headers();
    expect(fetchMock.mock.calls[0][0]).toBe("https://erp.test/api/v1/oauth/token");
  });
});

describe("§23.8 acting user", () => {
  afterEach(() => {
    delete process.env.ERP_API_TOKEN;
  });

  it("carries who pressed Sync, and omits the header for an unattended run", async () => {
    process.env.ERP_API_TOKEN = "static";
    const auth = new ErpAuthenticator({ mode: "bearer", actingUserHeader: "X-ERP-Acting-User" });
    expect((await auth.headers("E-100"))["X-ERP-Acting-User"]).toBe("E-100");
    // A scheduled sync has no user, and that absence is meaningful to the ERP.
    expect("X-ERP-Acting-User" in (await auth.headers(null))).toBe(false);
  });

  it("adds no header at all when the ERP has not asked for one", async () => {
    process.env.ERP_API_TOKEN = "static";
    const auth = new ErpAuthenticator({ mode: "bearer" });
    expect(await auth.headers("E-100")).toEqual({ Accept: "application/json", Authorization: "Bearer static" });
  });
});

describe("§23.8 modes", () => {
  afterEach(() => {
    delete process.env.ERP_API_TOKEN;
    delete process.env.ERP_API_KEY;
    delete process.env.ERP_API_KEY_HEADER;
  });

  it("falls back to the pre-§23.8 static token when no auth block is configured", async () => {
    // A deployment configured before this existed must keep working untouched.
    process.env.ERP_API_TOKEN = "legacy";
    const auth = new ErpAuthenticator();
    expect(auth.mode()).toBe("bearer");
    expect((await auth.headers()).Authorization).toBe("Bearer legacy");
  });

  it("supports a header-key API", async () => {
    process.env.ERP_API_KEY_HEADER = "X-Api-Key";
    process.env.ERP_API_KEY = "abc";
    const auth = new ErpAuthenticator({ mode: "bearer" });
    expect((await auth.headers())["X-Api-Key"]).toBe("abc");
  });

  it("sends nothing, and never retries a 401, on an unauthenticated API", async () => {
    const auth = new ErpAuthenticator({ mode: "none" });
    expect(await auth.headers()).toEqual({ Accept: "application/json" });
    // Nothing to refresh: retrying would just repeat the same rejected request.
    expect(auth.canRetryAfter401()).toBe(false);
  });
});
