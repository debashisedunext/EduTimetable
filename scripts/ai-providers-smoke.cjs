/**
 * Google Gemini wired into AI Settings (§13.2), against the LIVE stack.
 *
 *   docker compose exec api node /app/scripts/ai-providers-smoke.cjs
 *
 * Proves the provider choice is real rather than a dropdown that always ends up
 * at Claude:
 *
 *   1. CATALOGUE — the server tells the UI which providers are wired and what
 *      models each offers, so the screen cannot drift from the gateway.
 *   2. SWITCH    — choosing Gemini stores it, and resets the model to a Gemini
 *      one (a Claude model against Gemini fails at the first request).
 *   3. KEY       — the key is encrypted at rest, never echoed, and per-provider.
 *   4. USED      — a Gemini key is actually *sent to Google*: the connection
 *      test reaches generativelanguage.googleapis.com and reports what it says.
 *      With a real key this passes; with a fake one it fails with Google's own
 *      message — either way it proves the request left for the right vendor.
 *   5. RESTORE   — the school's original settings are put back.
 *
 * Set GEMINI_API_KEY in the environment to exercise the live-key path.
 */
const { createRequire } = require("node:module");
const { PrismaClient } = createRequire("/app/apps/api/package.json")("@prisma/client");

const API = process.env.API_INTERNAL || "http://localhost:3000";
const LIVE_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null;
const FAKE_KEY = "AIzaSyFAKE-not-a-real-google-key-000000000";

let failed = 0;
const check = (ok, l, x = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${l}${x ? ` — ${x}` : ""}`);
  if (!ok) failed = 1;
};

async function sessionFor(payload) {
  const r = await fetch(`${API}/api/dev/erp-token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const { token } = await r.json();
  const cb = await fetch(`${API}/api/sso/callback?token=${token}`, { redirect: "manual" });
  return (cb.headers.get("location") || "").split("#token=")[1];
}

async function call(method, path, token, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

(async () => {
  const prisma = new PrismaClient();
  const admin = await sessionFor({ erpUserId: "ERP-1", erpRole: "ADMIN", name: "Admin A", email: "a@a.test" });
  const before = (await call("GET", "/ai/settings", admin)).json;
  const school = await prisma.school.findFirst({ orderBy: { id: "asc" } });

  // ---------------------------------------------------------- 1. CATALOGUE
  console.log("The server owns the provider catalogue:");
  const providers = before?.providers ?? [];
  check(providers.length >= 4, "settings carry the provider list", providers.map((p) => p.id).join(", "));
  const gemini = providers.find((p) => p.id === "google");
  check(gemini?.implemented === true, "Google (Gemini) is marked as wired", gemini?.label);
  check((gemini?.models ?? []).length > 0, "and offers models", (gemini?.models ?? []).map((m) => m.id).join(", "));
  check(
    (gemini?.envKeys ?? []).includes("GEMINI_API_KEY"),
    "with its own environment fallback keys",
    (gemini?.envKeys ?? []).join(" / "),
  );
  const anthropic = providers.find((p) => p.id === "anthropic");
  check(anthropic?.implemented === true, "Anthropic is still wired", anthropic?.defaultModel);
  check(providers.some((p) => p.id === "openai" && !p.implemented), "and unwired providers say so");

  // ------------------------------------------------------------- 2. SWITCH
  console.log("\nSwitching provider takes the model with it:");
  // Establish the starting point rather than assuming it — this school may
  // already be on any provider, and a test that depends on ambient state
  // reports a bug that is not there.
  const start = await call("PUT", "/ai/settings", admin, {
    provider: "anthropic",
    model: "claude-opus-5",
  });
  check(start.json?.provider === "anthropic" && start.json?.model === "claude-opus-5",
    "starting from Anthropic", `${start.json?.provider} / ${start.json?.model}`);

  const switched = await call("PUT", "/ai/settings", admin, { provider: "google" });
  check(switched.json?.provider === "google", "provider is Gemini", switched.json?.provider);
  check(
    (gemini?.models ?? []).some((m) => m.id === switched.json?.model),
    "the model reset to a Gemini one rather than staying on Claude",
    switched.json?.model,
  );

  const pickFlash = await call("PUT", "/ai/settings", admin, { model: "gemini-2.5-flash" });
  check(pickFlash.json?.model === "gemini-2.5-flash", "a specific Gemini model can be chosen", pickFlash.json?.model);
  check(pickFlash.json?.provider === "google", "and the provider stays put", pickFlash.json?.provider);

  // ---------------------------------------------------------------- 3. KEY
  console.log("\nThe key is stored the same way, whichever provider it is for:");
  const stored = await call("PUT", "/ai/settings", admin, { apiKey: FAKE_KEY });
  check(stored.status === 200, "stored a Gemini-shaped key", `${stored.status}`);
  check(!stored.text.includes(FAKE_KEY), "the response contains no key material");
  check(stored.json?.keyHint && !stored.json.keyHint.includes("not-a-real"),
    "only a masked hint comes back", stored.json?.keyHint);

  const row = await prisma.aiSettings.findUnique({ where: { schoolId: school.id } });
  const ciphertext = Buffer.from(row.apiKeyEncrypted).toString("utf8");
  check(!ciphertext.includes(FAKE_KEY), "the database holds ciphertext only",
    `${row.apiKeyEncrypted.length} bytes, AES-256-GCM`);

  // --------------------------------------------------------------- 4. USED
  console.log("\nThe key is actually sent to Google, not quietly to Anthropic:");
  const badTest = await call("POST", "/ai/settings/test", admin);
  check(badTest.json?.provider === "google", "the test targeted Gemini", badTest.json?.provider);
  check(badTest.json?.ok === false, "a fake key is rejected", "as expected");
  check(
    /Gemini|API key|API_KEY|generativelanguage|invalid/i.test(badTest.json?.error ?? ""),
    "and the failure is Google's own message, so the request really went there",
    (badTest.json?.error ?? "").slice(0, 90),
  );
  check(!JSON.stringify(badTest.json).includes(FAKE_KEY), "the key is not echoed in the error");

  if (LIVE_KEY) {
    const liveTest = await call("POST", "/ai/settings/test", admin, { apiKey: LIVE_KEY });
    check(liveTest.json?.ok === true, "a real Gemini key connects",
      `${liveTest.json?.model} · ${liveTest.json?.stopReason ?? "ok"}`);
  } else {
    console.log("  INFO  no GEMINI_API_KEY in the environment — live-key path not exercised");
  }

  // ------------------------------------------------------------ 5. RESTORE
  console.log("\nRestore:");
  await call("PUT", "/ai/settings", admin, {
    provider: before.provider,
    model: before.model,
    apiKey: "",
  });
  const after = (await call("GET", "/ai/settings", admin)).json;
  check(after?.provider === before.provider && after?.model === before.model,
    "the school's original provider and model are back", `${after?.provider} / ${after?.model}`);
  check(after?.keySource !== "database", "and the test key is gone", after?.keySource);

  await prisma.$disconnect();
  console.log(failed ? "\nSOME AI PROVIDER CHECKS FAILED" : "\nALL AI PROVIDER CHECKS PASSED");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(1); });
