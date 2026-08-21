import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { io } from "socket.io-client";
import type { FeasibilityResult } from "@edutimetable/shared";
import { api, getToken } from "../api";
import { Card, ErrorNote } from "../components";
import { useApi, useConfigCtx } from "../hooks";

interface JobSummary {
  placedVariables: number;
  totalVariables: number;
  slotRows: number;
  unplaced: { label: string; reason: string }[];
  stats: { ms: number; steps: number; backtracks: number; restarts: number };
}

/** Screen 4 (§8.1): trigger + live progress over Socket.IO + result summary. */
export function Generate() {
  const { current } = useConfigCtx();
  const { data: readiness } = useApi<FeasibilityResult>(
    current ? `/timetable-configs/${current.id}/readiness` : null,
  );
  const { data: latest, refetch: refetchLatest } = useApi<any>(
    current ? `/timetable-configs/${current.id}/generate/latest` : null,
  );
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ placed: number; total: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const socket = io({ auth: { token: getToken() } });
    socket.on("solver:progress", (d: { placed: number; total: number }) => {
      setRunning(true);
      setProgress(d);
      setLog((l) => [...l.slice(-120), `placing… ${d.placed} / ${d.total} variables`]);
    });
    socket.on("solver:completed", (d: { result: JobSummary }) => {
      setRunning(false);
      setProgress(d.result ? { placed: d.result.placedVariables, total: d.result.totalVariables } : null);
      setLog((l) => [...l, `✓ complete — ${d.result?.slotRows ?? "?"} slots written in ${d.result?.stats?.ms ?? "?"}ms`]);
      refetchLatest();
    });
    socket.on("solver:failed", (d: { reason: string }) => {
      setRunning(false);
      setError(d.reason);
      setLog((l) => [...l, `✗ failed: ${d.reason}`]);
    });
    return () => { socket.disconnect(); };
  }, [refetchLatest]);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  if (!current) return <p className="screen-sub">Select a timetable first.</p>;

  const start = async () => {
    setError(null);
    setLog([`queued solver for ${current.name}…`]);
    setProgress(null);
    try {
      await api(`/timetable-configs/${current.id}/generate`, { method: "POST" });
      setRunning(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const result: JobSummary | null = latest?.result ?? null;
  const pct = progress ? Math.round((progress.placed / Math.max(1, progress.total)) * 100) : 0;

  return (
    <div style={{ maxWidth: 760 }}>
      <ErrorNote message={error} />

      <Card title={`Generate — ${current.name}`} sub="Phase B runs as a background job in the worker container; progress streams live. It is only offered once Phase A proves a solution exists (§4).">
        {readiness && !readiness.ready ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="badge badge-error">Not ready — {readiness.blockers.length} blocker(s)</span>
            <Link to="/readiness" style={{ fontSize: 13, color: "var(--brand)", fontWeight: 600 }}>
              Fix them on the Readiness Dashboard →
            </Link>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="badge badge-ok">✓ Feasible — a full solution is guaranteed to exist</span>
            <button className="btn btn-primary" onClick={start} disabled={running || !readiness?.ready}>
              {running ? "Generating…" : "⚡ Generate Timetable"}
            </button>
          </div>
        )}

        {(running || progress) && (
          <>
            <div className="progress-track" style={{ marginTop: 18 }}>
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="mono" style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 8 }}>
              {progress ? `${progress.placed} / ${progress.total} variables placed (${pct}%)` : "queued…"}
            </div>
          </>
        )}
        {log.length > 0 && (
          <div ref={logRef} style={{
            fontFamily: "var(--font-mono)", fontSize: 11.5, background: "var(--brand-deep)",
            color: "var(--steel-light)", borderRadius: 10, padding: "12px 14px",
            height: 150, overflowY: "auto", lineHeight: 1.7,
          }}>
            {log.map((l, i) => <div key={i} style={l.startsWith("✓") ? { color: "#7BE3C8" } : l.startsWith("✗") ? { color: "#FF9C93" } : undefined}>{l}</div>)}
          </div>
        )}
      </Card>

      {result && !running && (
        <Card title="Last run" sub={latest.state === "completed" ? "Draft written — review it on the Allocation Matrix." : `state: ${latest.state}`}>
          <div style={{ display: "flex", gap: 12, marginBottom: result.unplaced.length ? 14 : 0 }}>
            <Stat n={`${result.placedVariables}/${result.totalVariables}`} l="variables placed" />
            <Stat n={String(result.slotRows)} l="slot rows" />
            <Stat n={`${Math.round((result.placedVariables / Math.max(1, result.totalVariables)) * 100)}%`} l="fill" />
            <Stat n={`${result.stats.ms}ms`} l="solve time" />
          </div>
          {result.unplaced.length > 0 && (
            <>
              <p style={{ fontSize: 12.5, fontWeight: 700, color: "var(--amber)", marginBottom: 6 }}>
                {result.unplaced.length} period(s) need manual placement:
              </p>
              {result.unplaced.map((u, i) => (
                <div key={i} style={{ fontSize: 12.5, padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
                  <b>{u.label}</b> — <span style={{ color: "var(--ink-soft)" }}>{u.reason}</span>
                </div>
              ))}
            </>
          )}
          {latest?.failedReason && <ErrorNote message={latest.failedReason} />}
          <div style={{ marginTop: 12 }}>
            <Link to="/matrix" className="btn btn-primary" style={{ textDecoration: "none" }}>Open Allocation Matrix →</Link>
          </div>
        </Card>
      )}
    </div>
  );
}

function Stat({ n, l }: { n: string; l: string }) {
  return (
    <div style={{ flex: 1, background: "var(--offwhite)", borderRadius: 10, padding: 14, textAlign: "center" }}>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 700, color: "var(--brand)" }}>{n}</div>
      <div style={{ fontSize: 10, color: "var(--ink-faint)", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 2 }}>{l}</div>
    </div>
  );
}
