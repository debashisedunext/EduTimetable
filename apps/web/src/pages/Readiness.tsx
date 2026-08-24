import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import type { FeasibilityIssue, FeasibilityResult } from "@edutimetable/shared";
import { api, getToken } from "../api";
import { Card } from "../components";
import { useApi, useConfigCtx } from "../hooks";

/** Task 1.13 — Readiness Dashboard: the live §4 blocker/warning panel. */
export function Readiness() {
  const { current } = useConfigCtx();
  const { data, refetch, loading } = useApi<FeasibilityResult>(
    current ? `/timetable-configs/${current.id}/readiness` : null,
  );

  // Live loop (task 1.12): any master-data edit anywhere invalidates → refetch.
  useEffect(() => {
    const socket = io({ auth: { token: getToken() } });
    socket.on("readiness:invalidated", () => refetch());
    return () => {
      socket.disconnect();
    };
  }, [refetch]);

  if (!current) return <p className="screen-sub">Select a timetable first (Timetables screen).</p>;
  if (loading && !data) return <p className="screen-sub">Checking feasibility…</p>;
  if (!data) return null;

  return (
    <div style={{ maxWidth: 880 }}>
      <div style={{ display: "flex", gap: 18, marginBottom: 18 }}>
        <div style={{ width: 190, background: "var(--brand-deep)", borderRadius: 14, padding: 22, textAlign: "center", flexShrink: 0 }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 44, fontWeight: 700, color: "#fff" }}>{data.score}%</div>
          <div style={{ fontSize: 11.5, color: "var(--steel-light)", textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 2 }}>
            {data.ready ? "Ready to generate" : "Not ready"}
          </div>
          <div style={{ width: "100%", height: 6, background: "#1B3A6B", borderRadius: 4, marginTop: 14, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${data.score}%`, background: data.ready ? "var(--accent)" : "var(--amber)", borderRadius: 4 }} />
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10, justifyContent: "center" }}>
          <SummaryRow kind="err" count={data.blockers.length} label="blockers — must be fixed before generation" />
          <SummaryRow kind="warn" count={data.warnings.length} label="warnings — generation possible, review advised" />
          <div style={{ fontSize: 12, color: "var(--ink-faint)" }}>
            {data.stats.classSections} class-sections · {data.stats.teachers} teachers ·{" "}
            {data.stats.totalRequiredSlots} required of {data.stats.totalAvailableSlots} available slots · updates live on every edit
          </div>
        </div>
      </div>

      {data.ready && (
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="badge badge-ok" style={{ fontSize: 13 }}>✓ 100% feasible</span>
            <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>
              A complete, conflict-free timetable is mathematically guaranteed to exist. The Generate button unlocks in Phase 2.
            </span>
          </div>
        </Card>
      )}

      <ExplainPanel configId={current.id} issueCount={data.blockers.length + data.warnings.length} />

      {[...data.blockers, ...data.warnings].map((issue, i) => (
        <IssueRow key={i} issue={issue} />
      ))}
    </div>
  );
}

/** Task 5.6 — LLM rephrasing of the structured feasibility result (§5.7).
 *  Degrades to the engine's own template text when no provider is configured. */
function ExplainPanel({ configId, issueCount }: { configId: number; issueCount: number }) {
  const [state, setState] = useState<{ source: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setState(null); }, [configId, issueCount]);

  const explain = async () => {
    setBusy(true);
    try {
      setState(await api<{ source: string; text: string }>("/ai/explain-readiness", {
        method: "POST",
        body: JSON.stringify({ configId }),
      }));
    } catch {
      setState({ source: "error", text: "Explanation unavailable right now — the itemized list below has the same information." });
    } finally { setBusy(false); }
  };

  return (
    <div style={{ margin: "6px 0 16px" }}>
      {!state ? (
        <button className="btn btn-secondary" onClick={explain} disabled={busy}>
          {busy ? "Thinking…" : "✨ Explain in plain English"}
        </button>
      ) : (
        <Card>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ fontSize: 18 }}>✨</div>
            <div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: 13.5, lineHeight: 1.55 }}>{state.text}</div>
              <div style={{ fontSize: 10.5, color: "var(--ink-faint)", marginTop: 8 }}>
                {state.source === "llm"
                  ? "Written by the AI from the engine's structured result — it never invents constraints (§5.7)."
                  : "Engine template text (no AI provider configured — set ANTHROPIC_API_KEY to enable AI phrasing)."}
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function SummaryRow({ kind, count, label }: { kind: "err" | "warn"; count: number; label: string }) {
  const color = kind === "err" ? "var(--signal)" : "var(--amber)";
  const bg = count === 0 ? "var(--paper)" : kind === "err" ? "var(--signal-bg)" : "var(--amber-bg)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderRadius: 10, border: "1px solid var(--line)", background: bg }}>
      <span style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, color: count === 0 ? "var(--accent)" : color }}>{count}</span>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
    </div>
  );
}

function IssueRow({ issue }: { issue: FeasibilityIssue }) {
  const isErr = issue.severity === "blocker";
  return (
    <div style={{ display: "flex", gap: 12, padding: "13px 16px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--paper)", marginBottom: 10, alignItems: "flex-start" }}>
      <div style={{
        width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", flexShrink: 0, fontWeight: 700,
        background: isErr ? "var(--signal-bg)" : "var(--amber-bg)", color: isErr ? "var(--signal)" : "var(--amber)",
      }}>
        {isErr ? "!" : "⚠"}
      </div>
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-faint)" }}>
          <span className="mono">{issue.code}</span> · {issue.entity.label}
        </div>
        <div style={{ fontSize: 13, marginTop: 3, lineHeight: 1.45 }}>{issue.message}</div>
        {issue.fix && (
          <div style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600, marginTop: 5 }}>Fix: {issue.fix}</div>
        )}
      </div>
    </div>
  );
}
