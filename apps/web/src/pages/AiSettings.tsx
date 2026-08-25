import { useEffect, useState } from "react";
import { api } from "../api";
import { asMessage, Card, DataTable, ErrorNote } from "../components";
import { inputStyle } from "./Timetables";

interface Usage {
  since: string; inputTokens: number; outputTokens: number; totalTokens: number;
  conversations: number; questions: number; estimatedCostUsd: number;
}
interface ProviderCatalogEntry {
  id: string; label: string; implemented: boolean; defaultModel: string;
  models: Array<{ id: string; label: string }>; envKeys: string[];
}
interface Settings {
  provider: string; model: string; apiBaseUrl: string | null;
  /** The server's catalogue — which providers are wired and what models each
   *  offers. Kept there, not here, so adding one is a single change (§13.2). */
  providers: ProviderCatalogEntry[];
  envKeyName: string | null;
  monthlyTokenBudget: number | null;
  features: { chat: boolean; reports: boolean; nl_data_entry: boolean; conflict_explain: boolean };
  isActive: boolean; hasKey: boolean; keySource: string; keyHint: string | null;
  encryptionKeySource: string; usage: Usage; budgetExceeded: boolean;
}
interface RoleRow { id: number; name: string; isSystem: boolean; ai: Record<string, boolean> }

const AI_PERMS = [
  { key: "ai.chat", label: "Ask AI", desc: "see and use the chat" },
  { key: "ai.reports", label: "AI reports", desc: "generate report files from chat" },
  { key: "ai.configure", label: "Configure", desc: "this screen: keys, budget, access" },
];

/** Where each provider issues API keys, so an admin never has to go hunting.
 *  Whether a provider is actually wired comes from the server's catalogue, not
 *  from here — this is only the "where do I get a key" guidance. */
const KEY_SOURCES = [
  {
    value: "anthropic",
    label: "Anthropic (Claude)",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyLabel: "Anthropic Console → Settings → API Keys",
    keyPrefix: "sk-ant-…",
    hint: "Requires prepaid credit under Plans & Billing. A Claude.ai Pro/Max subscription does NOT include API access.",
  },
  {
    value: "openai",
    label: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    keyLabel: "OpenAI Platform → API keys",
    keyPrefix: "sk-…",
    hint: "Requires a funded billing account on the OpenAI Platform (separate from ChatGPT Plus).",
  },
  {
    value: "google",
    label: "Google (Gemini)",
    keyUrl: "https://aistudio.google.com/apikey",
    keyLabel: "Google AI Studio → Get API key",
    keyPrefix: "AIza…",
    hint: "Google AI Studio issues the key. Vertex AI on Google Cloud uses service-account credentials instead, not a key.",
  },
  {
    value: "azure_openai",
    label: "Azure OpenAI",
    keyUrl: "https://portal.azure.com/#browse/Microsoft.CognitiveServices%2Faccounts",
    keyLabel: "Azure Portal → your Azure OpenAI resource → Keys and Endpoint",
    keyPrefix: "32-char hex",
    hint: "Azure keys are per-resource: also paste that resource's endpoint into API base URL below, and use your deployment name as the model.",
  },
] as const;

const FEATURES = [
  { key: "chat", name: "Ask AI chat", desc: "Conversational queries over the timetable (§13.1)." },
  { key: "reports", name: "Report generation from chat", desc: "Let the assistant render the standard reports." },
  { key: "conflict_explain", name: "Plain-English conflict explanations", desc: "Rephrase feasibility blockers on the Readiness screen (§5.7)." },
  { key: "nl_data_entry", name: "Natural-language data entry", desc: "Parse bulk entry from a sentence, with a confirmation screen. Still experimental." },
] as const;

/** Screen 12 (§13.4) — AI Settings: provider, write-only key, budget meter,
 *  feature toggles and the role access matrix. Requires ai.configure. */
export function AiSettings() {
  const [s, setS] = useState<Settings | null>(null);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; error?: string; model?: string } | null>(null);
  /** Models fetched from the provider itself — authoritative over the
   *  catalogue, which is only ever as current as the last release (§13.2). */
  const [live, setLive] = useState<{ source: string; models: Array<{ id: string; label: string }>; error?: string } | null>(null);

  const load = () => {
    api<Settings>("/ai/settings").then(setS).catch((e) => setError(asMessage(e)));
    api<RoleRow[]>("/ai/settings/roles").then(setRoles).catch(() => {});
  };
  useEffect(load, []);

  if (error && !s) return <ErrorNote message={error} />;
  if (!s) return <p className="screen-sub">Loading AI settings…</p>;

  const save = async (patch: Record<string, unknown>, msg: string) => {
    try {
      const next = await api<Settings>("/ai/settings", { method: "PUT", body: JSON.stringify(patch) });
      setS(next);
      setError(null);
      setNote(msg);
      setTimeout(() => setNote(null), 3500);
    } catch (e) { setError(asMessage(e)); }
  };

  const testConnection = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api("/ai/settings/test", { method: "POST", body: JSON.stringify({ apiKey: keyInput || undefined }) }));
    } catch (e) { setTest({ ok: false, error: asMessage(e) }); } finally { setTesting(false); }
  };

  const toggleRole = async (role: RoleRow, perm: string, on: boolean) => {
    const next = { ...role.ai, [perm]: on };
    setRoles((rs) => rs.map((r) => (r.id === role.id ? { ...r, ai: next } : r)));
    try {
      await api(`/ai/settings/roles/${role.id}`, { method: "PUT", body: JSON.stringify({ ai: next }) });
      setNote(`${role.name}: ${perm} ${on ? "granted" : "revoked"}`);
      setTimeout(() => setNote(null), 3000);
    } catch (e) { setError(asMessage(e)); load(); }
  };

  const catalogue = s.providers.find((p) => p.id === s.provider);
  const modelOptions = live?.models?.length ? live.models : (catalogue?.models ?? []);
  const provider = KEY_SOURCES.find((p) => p.value === s.provider);
  const wired = catalogue?.implemented ?? false;
  const budgetPct = s.monthlyTokenBudget
    ? Math.min(100, Math.round((s.usage.totalTokens / s.monthlyTokenBudget) * 100))
    : 0;

  return (
    <div>
      <ErrorNote message={error} />
      {note && (
        <div className="card" style={{ borderColor: "#34a06a", background: "#eefaf2", color: "#1d6b45", padding: 10, marginBottom: 14, fontWeight: 600, fontSize: 12.5 }}>
          {note}
        </div>
      )}
      {s.budgetExceeded && (
        <div className="card" style={{ borderColor: "var(--signal)", background: "var(--signal-bg)", color: "var(--signal)", padding: 12, marginBottom: 16, fontWeight: 600, fontSize: 12.5 }}>
          ⚠ Monthly token budget reached — chat is disabled until the budget is raised or the month rolls over.
        </div>
      )}

      <div className="ai-settings-grid">
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <Card title="Provider & model" sub="The key is encrypted with AES-256-GCM and is write-only — it is never sent back to this screen.">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div className="field">
                <label>Provider</label>
                <select style={inputStyle} value={s.provider} onChange={(e) => save({ provider: e.target.value }, "Provider updated")}>
                  {s.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                      {p.id === "anthropic" ? " — recommended" : p.implemented ? "" : " — not yet wired"}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Model</label>
                {/* Models follow the provider — a Claude model selected against
                    Gemini would fail at the first request. Switching provider
                    resets this to that provider's default, server-side. */}
                <select style={inputStyle} value={s.model} onChange={(e) => save({ model: e.target.value }, "Model updated")}>
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                  {!modelOptions.some((m) => m.id === s.model) && (
                    <option value={s.model}>{s.model} (custom)</option>
                  )}
                </select>
                <button
                  className="btn"
                  style={{ border: "1px solid var(--line)", marginTop: 6, fontSize: 11 }}
                  onClick={async () => {
                    try {
                      setLive(await api("/ai/settings/models"));
                    } catch (e) {
                      setError(asMessage(e));
                    }
                  }}
                  title="Ask the provider which models this key can use"
                >
                  ⟳ Refresh from provider
                </button>
                {live && (
                  <div style={{ fontSize: 10.5, color: live.error ? "var(--amber)" : "var(--ink-faint)", marginTop: 4, lineHeight: 1.5 }}>
                    {live.source === "provider"
                      ? `${live.models.length} model(s) reported by ${catalogue?.label ?? "the provider"}.`
                      : `Showing the built-in list${live.error ? ` — ${live.error}` : " — add a key to ask the provider directly."}`}
                  </div>
                )}
              </div>
            </div>
            {provider && (
              <div style={{
                display: "flex", gap: 10, alignItems: "flex-start", padding: "11px 13px", marginBottom: 14,
                background: wired ? "var(--steel-pale)" : "var(--amber-bg)",
                border: `1px solid ${wired ? "var(--steel-light)" : "var(--amber)"}`,
                borderRadius: 9,
              }}>
                <div style={{ fontSize: 15 }}>{wired ? "🔑" : "⚠"}</div>
                <div style={{ flex: 1, fontSize: 11.5, lineHeight: 1.55, color: "var(--ink-soft)" }}>
                  {!wired && (
                    <div style={{ fontWeight: 700, color: "var(--amber)", marginBottom: 3 }}>
                      The assistant does not speak {provider.label} yet — a key will be stored but not used.
                      Anthropic (Claude) and Google (Gemini) are both wired.
                    </div>
                  )}
                  <div>
                    Get a key: <a href={provider.keyUrl} target="_blank" rel="noreferrer"
                      style={{ color: "var(--brand)", fontWeight: 700 }}>{provider.keyLabel} ↗</a>
                    {" "}· keys look like <span className="mono">{provider.keyPrefix}</span>
                  </div>
                  <div style={{ color: "var(--ink-faint)", marginTop: 2 }}>{provider.hint}</div>
                  {s.keySource === "environment" && s.envKeyName && (
                    <div style={{ color: "var(--ink-faint)", marginTop: 2 }}>
                      Currently using the <span className="mono">{s.envKeyName}</span> environment
                      variable. A key saved here takes precedence over it.
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="field">
              <label>API key {s.hasKey && <span className="chip" style={{ marginLeft: 6 }}>{s.keySource === "database" ? `stored ${s.keyHint}` : "from environment"}</span>}</label>
              <div className="key-row">
                <input type="password" style={inputStyle} placeholder={s.hasKey ? "•••••••••• (enter a new key to replace)" : "sk-ant-…"}
                  value={keyInput} onChange={(e) => setKeyInput(e.target.value)} autoComplete="off" />
                <button className="btn btn-secondary" onClick={testConnection} disabled={testing}>
                  {testing ? "Testing…" : "Test Connection"}
                </button>
                <button className="btn btn-primary" disabled={!keyInput.trim()}
                  onClick={() => { save({ apiKey: keyInput.trim() }, "API key saved (encrypted)"); setKeyInput(""); }}>
                  Save key
                </button>
              </div>
              {test && (
                <div className="conn-status" style={{ color: test.ok ? "var(--accent)" : "var(--signal)" }}>
                  <span className="conn-dot" style={{ background: test.ok ? "var(--accent)" : "var(--signal)" }} />
                  {test.ok ? `Connected — ${test.model} responded to a 1-token ping.` : `Failed: ${test.error}`}
                </div>
              )}
            </div>

            <div className="field">
              <label>API base URL <span style={{ fontWeight: 400, color: "var(--ink-faint)" }}>— only for Azure or a self-hosted gateway</span></label>
              <div className="key-row">
                <input style={inputStyle} id="base-url-input" placeholder="https://my-resource.openai.azure.com"
                  defaultValue={s.apiBaseUrl ?? ""} />
                <button className="btn btn-secondary" onClick={() => {
                  const el = document.getElementById("base-url-input") as HTMLInputElement;
                  save({ apiBaseUrl: el.value.trim() || null }, el.value.trim() ? "Base URL saved" : "Base URL cleared");
                }}>Save</button>
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 8 }}>
                Encryption key: {s.encryptionKeySource}.
                {s.keySource === "database" && (
                  <> · <button className="tool-trace" onClick={() => save({ apiKey: "" }, "Stored key removed")}>remove stored key</button></>
                )}
              </div>
            </div>
          </Card>

          <Card title="Features" sub="Each LLM use case can be switched off independently (§13.2).">
            {FEATURES.map((f) => (
              <div key={f.key} className="toggle-row">
                <div>
                  <div className="toggle-name">{f.name}</div>
                  <div className="toggle-desc">{f.desc}</div>
                </div>
                <label className="switch">
                  <input type="checkbox" checked={s.features[f.key]}
                    onChange={(e) => save({ features: { [f.key]: e.target.checked } }, `${f.name} ${e.target.checked ? "enabled" : "disabled"}`)} />
                  <span className="track" />
                </label>
              </div>
            ))}
          </Card>

          <Card title="Role access" sub="Server-enforced on every AI endpoint and on the chat socket — hiding the nav item is only cosmetic (§13.3).">
            <div className="perm-table">
              <DataTable
                headers={["Role", ...AI_PERMS.map((p) => p.label)]}
                rows={roles.map((r) => [
                  r.name,
                  ...AI_PERMS.map((p) => (
                    <input key={p.key} type="checkbox" checked={Boolean(r.ai[p.key])}
                      onChange={(e) => toggleRole(r, p.key, e.target.checked)} />
                  )),
                ])}
              />
            </div>
            <p style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 8 }}>
              {AI_PERMS.map((p) => `${p.label} — ${p.desc}`).join(" · ")}
            </p>
          </Card>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <Card title="Usage this month" sub={`Since ${s.usage.since}, from the ai_chat_log audit trail.`}>
            {s.monthlyTokenBudget ? (
              <>
                <div className="usage-meter-track">
                  <div className="usage-meter-fill" style={{ width: `${budgetPct}%` }} />
                </div>
                <div style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>
                  {s.usage.totalTokens.toLocaleString()} / {s.monthlyTokenBudget.toLocaleString()} tokens ({budgetPct}%)
                </div>
              </>
            ) : (
              <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>No monthly budget set — usage is unlimited.</div>
            )}
            <div className="usage-stats">
              <div className="usage-stat"><div className="n">{s.usage.questions}</div><div className="l">questions</div></div>
              <div className="usage-stat"><div className="n">{s.usage.conversations}</div><div className="l">conversations</div></div>
              <div className="usage-stat"><div className="n">${s.usage.estimatedCostUsd}</div><div className="l">est. cost</div></div>
            </div>
            <div className="field" style={{ marginTop: 14 }}>
              <label>Monthly token budget</label>
              <div className="key-row">
                <input type="number" style={inputStyle} placeholder="none"
                  defaultValue={s.monthlyTokenBudget ?? ""} id="budget-input" />
                <button className="btn btn-secondary" onClick={() => {
                  const el = document.getElementById("budget-input") as HTMLInputElement;
                  const v = el.value.trim();
                  save({ monthlyTokenBudget: v === "" ? null : Number(v) }, "Budget updated");
                }}>Save</button>
              </div>
            </div>
          </Card>

          <Card title="What the assistant may call" sub="The complete whitelist — there is no other data path.">
            <ToolList />
          </Card>
        </div>
      </div>
    </div>
  );
}

function ToolList() {
  const [tools, setTools] = useState<{ name: string; description: string }[]>([]);
  useEffect(() => { api<{ name: string; description: string }[]>("/ai/settings/tools").then(setTools).catch(() => {}); }, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {tools.map((t) => (
        <div key={t.name}>
          <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--brand)" }}>{t.name}</span>
          <div style={{ fontSize: 11, color: "var(--ink-faint)", lineHeight: 1.45 }}>{t.description}</div>
        </div>
      ))}
    </div>
  );
}
