import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { io } from "socket.io-client";
import type { FeasibilityResult } from "@edutimetable/shared";
import { api, getToken } from "../api";
import { Card, ErrorNote } from "../components";
import { useApi, useConfigCtx } from "../hooks";

interface ObjectiveScore {
  teacherGaps: number;
  peakDailyLoad: number;
  roomChanges: number;
  weighted: number;
}
interface JobSummary {
  mode?: "fast" | "optimized";
  placedVariables: number;
  totalVariables: number;
  slotRows: number;
  unplaced: { label: string; reason: string }[];
  stats: { ms: number; steps: number; backtracks: number; restarts: number };
  objective?: {
    weights: { teacherGaps: number; dailyLoadBalance: number; roomChanges: number };
    before: ObjectiveScore;
    after: ObjectiveScore;
    improvement: string;
    optimization: { attempted: boolean; adopted: boolean; status: string; detail: string; wallTimeSec?: number };
  };
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
  // Phase 6 (§5.6): fast feasibility vs CP-SAT soft optimization
  const [mode, setMode] = useState<"fast" | "optimized">("fast");
  const [weights, setWeights] = useState({ teacherGaps: 5, dailyLoadBalance: 2, roomChanges: 1 });
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const socket = io({ auth: { token: getToken() } });
    socket.on("solver:progress", (d: { placed: number; total: number; phase?: string }) => {
      setRunning(true);
      setProgress(d);
      setLog((l) => [
        ...l.slice(-120),
        d.phase === "optimizing"
          ? "feasible draft found — handing it to CP-SAT for soft optimization…"
          : `placing… ${d.placed} / ${d.total} variables`,
      ]);
    });
    socket.on("solver:completed", (d: { result: JobSummary }) => {
      setRunning(false);
      setProgress(d.result ? { placed: d.result.placedVariables, total: d.result.totalVariables } : null);
      setLog((l) => {
        const next = [...l, `✓ complete — ${d.result?.slotRows ?? "?"} slots written in ${d.result?.stats?.ms ?? "?"}ms`];
        const opt = d.result?.objective;
        if (opt?.optimization?.attempted) next.push(`${opt.optimization.adopted ? "✓" : "·"} CP-SAT ${opt.optimization.status}: ${opt.optimization.detail}`);
        return next;
      });
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
    setLog([`queued ${mode === "optimized" ? "optimized (CP-SAT)" : "fast"} solver for ${current.name}…`]);
    setProgress(null);
    try {
      await api(`/timetable-configs/${current.id}/generate`, {
        method: "POST",
        body: JSON.stringify({ mode, weights }),
      });
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

        {readiness?.ready && (
          <div style={{ marginTop: 18, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
            <div className="section-label" style={{ display: "block", marginBottom: 10 }}>Generation mode (§5.6)</div>
            <div className="radio-row" style={{ marginBottom: weights && mode === "optimized" ? 14 : 0 }}>
              <label className={`radio-opt${mode === "fast" ? " selected" : ""}`}>
                <input type="radio" name="genmode" checked={mode === "fast"} onChange={() => setMode("fast")} />
                <div>
                  <div className="radio-opt-title">Fast — feasibility</div>
                  <div className="radio-opt-desc">The custom CSP engine alone: a complete conflict-free timetable, as quickly as possible.</div>
                </div>
              </label>
              <label className={`radio-opt${mode === "optimized" ? " selected" : ""}`}>
                <input type="radio" name="genmode" checked={mode === "optimized"} onChange={() => setMode("optimized")} />
                <div>
                  <div className="radio-opt-title">Optimized — nicer timetable</div>
                  <div className="radio-opt-desc">
                    Solves fast first, then hands the model to OR-Tools CP-SAT to reduce teacher gaps, flatten daily
                    load, and cluster lab periods. The result is kept only if it passes the same hard-constraint
                    checks and scores better — so this can never be worse than Fast.
                  </div>
                </div>
              </label>
            </div>
            {mode === "optimized" && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                <WeightSlider label="Teacher gaps" hint="free periods between classes" value={weights.teacherGaps}
                  onChange={(v) => setWeights({ ...weights, teacherGaps: v })} />
                <WeightSlider label="Daily load balance" hint="flatten each teacher's busiest day" value={weights.dailyLoadBalance}
                  onChange={(v) => setWeights({ ...weights, dailyLoadBalance: v })} />
                <WeightSlider label="Room changes" hint="cluster lab periods together" value={weights.roomChanges}
                  onChange={(v) => setWeights({ ...weights, roomChanges: v })} />
              </div>
            )}
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

          {result.objective && (
            <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <span className="section-label">Timetable quality (§5.6)</span>
                <span className={`badge ${result.mode === "optimized" ? "badge-ok" : "badge-neutral"}`}>
                  {result.mode === "optimized" ? "optimized" : "fast"}
                </span>
                {result.objective.optimization.attempted && (
                  <span className={`badge ${result.objective.optimization.adopted ? "badge-ok" : "badge-warn"}`}>
                    CP-SAT {result.objective.optimization.status}
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                <Metric label="Teacher gaps" before={result.objective.before.teacherGaps} after={result.objective.after.teacherGaps} />
                <Metric label="Peak daily load" before={result.objective.before.peakDailyLoad} after={result.objective.after.peakDailyLoad} />
                <Metric label="Room changes" before={result.objective.before.roomChanges} after={result.objective.after.roomChanges} />
              </div>
              <p style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 8 }}>
                {result.objective.optimization.detail}
                {result.objective.optimization.wallTimeSec !== undefined && ` · CP-SAT ${result.objective.optimization.wallTimeSec.toFixed(1)}s`}
              </p>
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <Link to="/matrix" className="btn btn-primary" style={{ textDecoration: "none" }}>Open Allocation Matrix →</Link>
          </div>
        </Card>
      )}
    </div>
  );
}

function WeightSlider({ label, hint, value, onChange }: { label: string; hint: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 700, marginBottom: 3 }}>
        <span>{label}</span>
        <span className="mono" style={{ color: "var(--brand)" }}>{value}</span>
      </div>
      <input type="range" min={0} max={10} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: "100%" }} />
      <div style={{ fontSize: 10.5, color: "var(--ink-faint)" }}>{hint}</div>
    </div>
  );
}

/** before → after for one objective term; unchanged renders as a single figure. */
function Metric({ label, before, after }: { label: string; before: number; after: number }) {
  const better = after < before;
  return (
    <div style={{ flex: 1, background: "var(--offwhite)", borderRadius: 10, padding: 12, textAlign: "center" }}>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 700, color: better ? "#1d6b45" : "var(--brand)" }}>
        {before === after ? after : <>{before} → {after}</>}
      </div>
      <div style={{ fontSize: 10, color: "var(--ink-faint)", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 2 }}>
        {label}{better ? ` · −${before - after}` : ""}
      </div>
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
