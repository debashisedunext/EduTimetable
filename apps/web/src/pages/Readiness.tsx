import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import type { FeasibilityIssue, FeasibilityResult } from "@edutimetable/shared";
import { api, getToken } from "../api";
import { asMessage, Card, ErrorNote } from "../components";
import { useApi, useConfigCtx } from "../hooks";

type Outcome = "fixed" | "applied-not-resolved" | "already-resolved" | "changed" | "stale" | "refused";
interface AutoFixResult {
  runId: number | null;
  scoreBefore: number;
  scoreAfter: number;
  fixed: number;
  outcomes: Array<{ key: string; code: string; outcome: Outcome; detail?: string }>;
}

/**
 * §21 — "do not ask again" for the straightforward fixes.
 *
 * Per browser and per timetable, in localStorage rather than in the database,
 * because it is a prompting preference and nothing else: the server is never
 * told about it and never applies anything it was not explicitly given. The
 * worst a cleared browser can do is ask once more.
 */
const DONT_ASK_KEY = (configId: number) => `edutimetable.autofix.dontAsk.${configId}`;

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

  const [panel, setPanel] = useState(false);
  const [result, setResult] = useState<AutoFixResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A new reading of the dashboard is a new conversation: outcomes from the
  // last run must not colour rows that have since been recomputed.
  useEffect(() => { setResult(null); }, [current?.id]);

  if (!current) return <p className="screen-sub">Select a timetable first (Timetables screen).</p>;
  if (loading && !data) return <p className="screen-sub">Checking feasibility…</p>;
  if (!data) return null;

  const issues = [...data.blockers, ...data.warnings];
  const fixable = issues.filter((i) => i.remedy);
  const safe = fixable.filter((i) => i.remedy!.kind !== "relax");
  const loosening = fixable.filter((i) => i.remedy!.kind === "relax");
  const outcomeByKey = new Map((result?.outcomes ?? []).map((o) => [o.key, o]));
  const dontAsk = (() => {
    try { return localStorage.getItem(DONT_ASK_KEY(current.id)) === "1"; } catch { return false; }
  })();

  /**
   * §21 — what "do not ask again" actually does: applies the straightforward
   * fixes with no drawer, then opens the drawer only if there are limit
   * changes left, which are never swept up by a standing consent.
   */
  const quickApply = async () => {
    setBusy(true);
    setError(null);
    try {
      if (safe.length > 0) {
        const r = await api<AutoFixResult>(`/timetable-configs/${current.id}/auto-fix`, {
          method: "POST",
          body: JSON.stringify({ apply: safe.map((i) => ({ key: i.key, changes: i.remedy!.changes })) }),
        });
        setResult(r);
        refetch();
      }
      if (loosening.length > 0) setPanel(true);
    } catch (e) {
      setError(asMessage(e));
    } finally {
      setBusy(false);
    }
  };

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

      {fixable.length > 0 && !panel && (
        <Card>
          <ErrorNote message={error} />
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button className="btn btn-primary" disabled={busy}
              onClick={() => (dontAsk ? quickApply() : setPanel(true))}>
              {busy ? "Resolving…" : `⚡ Auto-resolve ${fixable.length} issue${fixable.length === 1 ? "" : "s"}`}
            </button>
            <span style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5, flex: 1, minWidth: 280 }}>
              {fixable.length} of {issues.length} have a fix that can be applied for you
              {loosening.length > 0 && `, ${loosening.length} of which loosen a rule and will be shown first`}.
              The rest need a decision only you can make — a room that does not exist, a curriculum that is too full.
              {dontAsk && safe.length > 0 && (
                <>
                  {" "}
                  <b>Not asking again</b> for the {safe.length} straightforward one{safe.length === 1 ? "" : "s"}.{" "}
                  <a href="#" onClick={(e) => {
                    e.preventDefault();
                    try { localStorage.removeItem(DONT_ASK_KEY(current.id)); } catch { /* private mode */ }
                    refetch();
                  }}>Ask me again</a>
                </>
              )}
            </span>
          </div>
        </Card>
      )}

      {panel && (
        <AutoFixPanel
          configId={current.id}
          issues={dontAsk ? loosening : fixable}
          lastRunId={result?.runId ?? null}
          onDone={(r) => { setResult(r); setPanel(false); refetch(); }}
          onClose={() => setPanel(false)}
        />
      )}

      {result && (
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span className="badge badge-ok" style={{ fontSize: 13 }}>
              ✓ {result.fixed} fixed
            </span>
            <span style={{ fontSize: 13 }}>
              Readiness {result.scoreBefore}% → <b>{result.scoreAfter}%</b>
            </span>
            {result.runId !== null && (
              <UndoButton configId={current.id} runId={result.runId} onDone={() => { setResult(null); refetch(); }} />
            )}
          </div>
        </Card>
      )}

      <ExplainPanel configId={current.id} issueCount={data.blockers.length + data.warnings.length} />

      {issues.map((issue, i) => (
        <IssueRow key={issue.key ?? i} issue={issue} outcome={outcomeByKey.get(issue.key ?? "")?.outcome} />
      ))}

      {/* A row that was fixed no longer appears above — it is gone from the
          engine's answer. Showing it here, green, is what makes the run
          readable: "these nine went away, and here is what is left." */}
      {(result?.outcomes ?? []).filter((o) => o.outcome === "fixed").map((o) => (
        <div key={o.key} style={{
          display: "flex", gap: 12, padding: "11px 16px", borderRadius: 10, marginBottom: 10, alignItems: "center",
          border: "1px solid var(--accent)", background: "color-mix(in srgb, var(--accent) 8%, var(--paper))",
        }}>
          <span style={{ color: "var(--accent)", fontWeight: 700 }}>✓</span>
          <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)" }}>{o.code}</span>
          <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>resolved</span>
        </div>
      ))}
    </div>
  );
}

/**
 * §21 review drawer.
 *
 * Nothing is applied without being shown first. `complete` and `redistribute`
 * are separated because they carry different weight: one fills in a blank, the
 * other moves a teacher's classes to somebody else, and an admin deserves to
 * see which is which before pressing anything.
 */
function AutoFixPanel({ configId, issues, onDone, onClose }: {
  configId: number;
  issues: FeasibilityIssue[];
  lastRunId: number | null;
  onDone: (r: AutoFixResult) => void;
  onClose: () => void;
}) {
  const dontAskStored = (() => {
    try { return localStorage.getItem(DONT_ASK_KEY(configId)) === "1"; } catch { return false; }
  })();
  const [dontAsk, setDontAsk] = useState(dontAskStored);
  // Relax remedies start unticked: everything else is a default yes, a limit
  // change is a deliberate one.
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(issues.filter((i) => i.remedy?.kind !== "relax").map((i) => i.key ?? "")),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => ({
    complete: issues.filter((i) => i.remedy?.kind === "complete"),
    redistribute: issues.filter((i) => i.remedy?.kind === "redistribute"),
    relax: issues.filter((i) => i.remedy?.kind === "relax"),
  }), [issues]);

  /**
   * §21 — "do not ask again" reaches the first two groups and no further.
   *
   * The limit changes are shown as one card rather than one question each,
   * because nine dialogs is not consent, it is attrition. But it is still a
   * card you have to look at: a resolver free to loosen limits can take any
   * school to 100% without changing one real thing.
   */
  const [relaxOpen, setRelaxOpen] = useState(false);

  const toggle = (key: string) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (dontAsk) { try { localStorage.setItem(DONT_ASK_KEY(configId), "1"); } catch { /* private mode */ } }
      const apply = issues
        .filter((i) => chosen.has(i.key ?? ""))
        .map((i) => ({ key: i.key, changes: i.remedy!.changes }));
      const r = await api<AutoFixResult>(`/timetable-configs/${configId}/auto-fix`, {
        method: "POST",
        body: JSON.stringify({ apply }),
      });
      onDone(r);
    } catch (e) {
      setError(asMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Auto-resolve"
      sub="Every change is shown before it is made, and the whole run can be undone."
      actions={<button className="btn btn-secondary" onClick={onClose}>Cancel</button>}
    >
      <ErrorNote message={error} />

      {(["complete", "redistribute"] as const).map((kind) =>
        groups[kind].length === 0 ? null : (
          <div key={kind} style={{ marginBottom: 16 }}>
            <div className="section-label" style={{ display: "block", marginBottom: 8 }}>
              {kind === "complete"
                ? `Fills in missing data — ${groups[kind].length}`
                : `Moves teaching to somebody with room — ${groups[kind].length}`}
            </div>
            {groups[kind].map((i) => (
              <label key={i.key} style={{
                display: "flex", gap: 10, padding: "9px 12px", marginBottom: 6, borderRadius: 8,
                border: "1px solid var(--line)", background: "var(--offwhite)", cursor: "pointer", alignItems: "flex-start",
              }}>
                <input type="checkbox" checked={chosen.has(i.key ?? "")} onChange={() => toggle(i.key ?? "")}
                  style={{ marginTop: 3 }} />
                <span>
                  <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-faint)" }}>{i.code}</span>
                  <span style={{ fontSize: 13, display: "block", marginTop: 2 }}>{i.remedy!.summary}</span>
                </span>
              </label>
            ))}
          </div>
        ),
      )}

      {groups.relax.length > 0 && (
        <div style={{
          border: "1px solid var(--amber)", borderRadius: 10, padding: 14, marginBottom: 16,
          background: "var(--amber-bg, #FDF4E3)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <b style={{ fontSize: 13, color: "var(--amber)" }}>
              {groups.relax.length} change{groups.relax.length === 1 ? "" : "s"} that loosen a rule
            </b>
            <button className="btn btn-secondary" style={{ padding: "3px 10px", fontSize: 11.5 }}
              onClick={() => setRelaxOpen((v) => !v)}>
              {relaxOpen ? "Hide" : "Review"}
            </button>
            <span style={{ fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.5, flex: 1, minWidth: 260 }}>
              These raise a cap or lower a floor. They will make the score go up whether or not the school
              changes — so they are never applied on your behalf, however the box below is set.
            </span>
          </div>
          {relaxOpen && (
            <div style={{ marginTop: 12 }}>
              {groups.relax.map((i) => (
                <label key={i.key} style={{
                  display: "flex", gap: 10, padding: "9px 12px", marginBottom: 6, borderRadius: 8,
                  border: "1px solid var(--line)", background: "var(--paper)", cursor: "pointer", alignItems: "flex-start",
                }}>
                  <input type="checkbox" checked={chosen.has(i.key ?? "")} onChange={() => toggle(i.key ?? "")}
                    style={{ marginTop: 3 }} />
                  <span>
                    <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-faint)" }}>{i.code}</span>
                    <span style={{ fontSize: 13, display: "block", marginTop: 2 }}>{i.remedy!.summary}</span>
                  </span>
                </label>
              ))}
              <button className="btn btn-secondary" style={{ padding: "4px 12px", fontSize: 12 }}
                onClick={() => setChosen((prev) => {
                  const next = new Set(prev);
                  const allOn = groups.relax.every((i) => next.has(i.key ?? ""));
                  for (const i of groups.relax) {
                    if (allOn) next.delete(i.key ?? ""); else next.add(i.key ?? "");
                  }
                  return next;
                })}>
                {groups.relax.every((i) => chosen.has(i.key ?? "")) ? "Untick all" : "Accept all of these"}
              </button>
            </div>
          )}
        </div>
      )}

      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, marginBottom: 14 }}>
        <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
        Do not ask again for this timetable — apply these straight away next time.
        <span style={{ color: "var(--ink-faint)" }}>
          (Changes that loosen a limit are always shown.)
        </span>
      </label>

      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn-primary" disabled={busy || chosen.size === 0} onClick={run}>
          {busy ? "Applying…" : `Apply ${chosen.size} fix${chosen.size === 1 ? "" : "es"}`}
        </button>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Card>
  );
}

function UndoButton({ configId, runId, onDone }: { configId: number; runId: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <>
      <button className="btn btn-secondary" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          const r = await api<{ reversed: number; skipped: string[] }>(
            `/timetable-configs/${configId}/auto-fix/${runId}/undo`, { method: "POST" },
          );
          setNote(r.skipped.length ? `Undid ${r.reversed}; ${r.skipped.length} had been edited since` : null);
          onDone();
        } catch (e) { setNote(asMessage(e)); } finally { setBusy(false); }
      }}>
        {busy ? "Undoing…" : "Undo this run"}
      </button>
      {note && <span style={{ fontSize: 12, color: "var(--amber)" }}>{note}</span>}
    </>
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

function IssueRow({ issue, outcome }: { issue: FeasibilityIssue; outcome?: Outcome }) {
  const isErr = issue.severity === "blocker";
  // §21: a row that survived its own remedy is the one worth flagging — the
  // change was made and the issue is still here, which is a remedy bug.
  const note =
    outcome === "applied-not-resolved" ? "Applied, but this is still failing"
    : outcome === "stale" ? "Skipped — the data had changed"
    : outcome === "changed" ? "Skipped — the recommendation had changed"
    : null;
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
        {note && (
          <div style={{ fontSize: 12, color: "var(--amber)", fontWeight: 600, marginTop: 4 }}>{note}</div>
        )}
        {!issue.remedy && (
          <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 4 }}>
            Needs you — auto-resolve has no safe answer for this one.
          </div>
        )}
      </div>
    </div>
  );
}
