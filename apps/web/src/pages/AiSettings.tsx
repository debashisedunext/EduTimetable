import { useEffect, useState } from "react";
import { api } from "../api";
import { asMessage, Card, DataTable, ErrorNote } from "../components";
import { inputStyle } from "./Timetables";

interface Usage {
  since: string; inputTokens: number; outputTokens: number; totalTokens: number;
  conversations: number; questions: number; estimatedCostUsd: number;
}
interface Settings {
  provider: string; model: string; apiBaseUrl: string | null;
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
                  <option value="anthropic">Anthropic (recommended)</option>
                  <option value="openai">OpenAI</option>
                  <option value="google">Google</option>
                  <option value="azure_openai">Azure OpenAI</option>
                </select>
              </div>
              <div className="field">
                <label>Model</label>
                <select style={inputStyle} value={s.model} onChange={(e) => save({ model: e.target.value }, "Model updated")}>
                  <option value="claude-opus-5">claude-opus-5</option>
                  <option value="claude-sonnet-5">claude-sonnet-5</option>
                  <option value="claude-haiku-4-5-20251001">claude-haiku-4.5</option>
                </select>
              </div>
            </div>
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
