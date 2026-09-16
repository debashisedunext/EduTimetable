import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  stats: { ms: number; steps: number; backtracks: number; restarts: number; shortTeacherDays?: number };
  objective?: {
    weights: { teacherGaps: number; dailyLoadBalance: number; roomChanges: number };
    before: ObjectiveScore;
    after: ObjectiveScore;
    improvement: string;
    optimization: { attempted: boolean; adopted: boolean; status: string; detail: string; wallTimeSec?: number };
  };
}

/** §22 — a named draft, as the picker needs it. */
interface DraftRow {
  id: number;
  draftNo: number;
  label: string | null;
  status: "draft" | "published" | "archived" | "discarded";
  placedLessons: number | null;
  generationPct: number | null;
  generatedAt: string | null;
}

/** §22.2 — kept in step with MAX_LIVE_DRAFTS on the server. */
const MAX_LIVE_DRAFTS = 5;

/** Screen 4 (§8.1): trigger + live progress over Socket.IO + result summary. */
export function Generate() {
  const { current } = useConfigCtx();
  const { data: readiness } = useApi<FeasibilityResult>(
    current ? `/timetable-configs/${current.id}/readiness` : null,
  );
  const { data: latest, refetch: refetchLatest } = useApi<any>(
    current ? `/timetable-configs/${current.id}/generate/latest` : null,
  );
  // §22.2 — which draft this run writes into. A new one by default, so no
  // button press can destroy work somebody did by hand; but a school at the
  // five-draft cap needs to be able to say "overwrite that one" without
  // throwing a draft away first, which is what used to be the only way out.
  const { data: drafts, refetch: refetchDrafts } = useApi<DraftRow[]>(
    current ? `/timetable-configs/${current.id}/drafts` : null,
  );
  const [target, setTarget] = useState<"new" | number>("new");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ placed: number; total: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Phase 6 (§5.6): fast feasibility vs CP-SAT soft optimization
  const [mode, setMode] = useState<"fast" | "optimized">("fast");
  const [weights, setWeights] = useState({ teacherGaps: 5, dailyLoadBalance: 2, roomChanges: 1 });
  const logRef = useRef<HTMLDivElement>(null);

  /**
   * §5.7 — is there room for two columns?
   *
   * A media query would be tidier, but the two things that depend on it are
   * inline styles on elements this file builds — the grid's own tracks and the
   * log's height — and a CSS class for each would put the breakpoint in a
   * second file that has to agree with this one.
   *
   * `useLayoutEffect`, not `useEffect` (§8.1d): the first paint would otherwise
   * be the one-column layout on every load, snapping to two after it.
   */
  const [wide, setWide] = useState(
    typeof window === "undefined" ? true : window.innerWidth >= 1100,
  );
  useLayoutEffect(() => {
    const mq = window.matchMedia("(min-width: 1100px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

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
      refetchDrafts();
    });
    socket.on("solver:failed", (d: { reason: string }) => {
      setRunning(false);
      setError(d.reason);
      setLog((l) => [...l, `✗ failed: ${d.reason}`]);
    });
    return () => { socket.disconnect(); };
  }, [refetchLatest, refetchDrafts]);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  if (!current) return <p className="screen-sub">Select a timetable first.</p>;

  const live = (drafts ?? []).filter((d) => d.status !== "discarded");
  const atCap = live.length >= MAX_LIVE_DRAFTS;
  const chosen = typeof target === "number" ? live.find((d) => d.id === target) ?? null : null;
  // At the cap "New draft" is not an option, so there is nothing to fall back
  // to — the choice has to be made rather than defaulted, because every
  // remaining option overwrites a week somebody may still want.
  const mustChoose = atCap && target === "new";

  const start = async () => {
    setError(null);
    setLog([
      `queued ${mode === "optimized" ? "optimized (CP-SAT)" : "fast"} solver for ${current.name}` +
        `${chosen ? ` → Draft #${chosen.draftNo}` : " → a new draft"}…`,
    ]);
    setProgress(null);
    try {
      await api(`/timetable-configs/${current.id}/generate`, {
        method: "POST",
        body: JSON.stringify({ mode, weights, ...(chosen ? { draftId: chosen.id } : {}) }),
      });
      setRunning(true);
      refetchDrafts();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const result: JobSummary | null = latest?.result ?? null;
  const pct = progress ? Math.round((progress.placed / Math.max(1, progress.total)) * 100) : 0;

  /**
   * §5.7 — two columns: what you SET on the left, what comes BACK on the right.
   *
   * This was one 760px column on a 2,000px screen, so half the page was empty
   * while the log — the tallest thing here and the one somebody actually reads
   * while waiting — sat below the fold behind the mode radios they had already
   * finished with.
   *
   * The split is the page's own grammar rather than a way to fill space: the
   * left column is every decision taken before pressing Generate, and the
   * right is the run. Nothing on the right can be acted on until something on
   * the left has been.
   *
   * `minmax(0, …)` on both tracks, because a grid child's default `min-width:
   * auto` refuses to shrink below its content — the log's long lines would
   * otherwise push the column wider than its track and the page would scroll
   * sideways, which is the §31 rule about wide content in its own container.
   *
   * One column below 1100px: at that width two columns are two narrow columns,
   * and the radio descriptions are already three lines each.
   */
  const twoCol: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: wide ? "minmax(0, 460px) minmax(0, 1fr)" : "minmax(0, 1fr)",
    gap: 18,
    alignItems: "start",
  };

  return (
    <div style={twoCol}>
      <div style={{ minWidth: 0 }}>
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
            <button className="btn btn-primary" onClick={start} disabled={running || !readiness?.ready || mustChoose}>
              {running ? "Generating…" : "⚡ Generate Timetable"}
            </button>
          </div>
        )}

        {readiness?.ready && drafts && (
          <div style={{ marginTop: 18, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
            <div className="section-label" style={{ display: "block", marginBottom: 10 }}>
              Write into (§22)
            </div>
            <select
              value={typeof target === "number" ? String(target) : "new"}
              onChange={(e) => setTarget(e.target.value === "new" ? "new" : Number(e.target.value))}
              style={{ ...selectStyle, borderColor: mustChoose ? "var(--signal)" : "var(--line)" }}
            >
              <option value="new" disabled={atCap}>
                {atCap
                  ? `＋ A new draft — not available, ${live.length} of ${MAX_LIVE_DRAFTS} in use`
                  : `＋ A new draft (Draft #${Math.max(0, ...live.map((d) => d.draftNo)) + 1})`}
              </option>
              {live.map((d) => (
                <option key={d.id} value={d.id}>
                  Draft #{d.draftNo}
                  {d.label ? ` · ${d.label}` : ""}
                  {d.status !== "draft" ? ` · ${d.status}` : ""}
                  {d.generationPct !== null ? ` · ${d.generationPct}% filled` : " · empty"}
                </option>
              ))}
            </select>
            <p style={{ fontSize: 11.5, color: mustChoose ? "var(--signal)" : "var(--ink-faint)", margin: "6px 0 0" }}>
              {mustChoose
                ? `All ${MAX_LIVE_DRAFTS} draft slots are in use. Choose which draft to generate into — its current week is replaced — or discard one on the Board first.`
                : chosen === null
                  ? "A fresh draft, so nothing you have already generated or edited by hand is touched."
                  : chosen.status === "published"
                    ? `Replaces Draft #${chosen.draftNo}'s working copy. The published timetable stays live and unchanged until you publish again.`
                    : `Replaces Draft #${chosen.draftNo}'s current week. Pinned 🔒 cells and extra classes survive; everything else is re-solved.`}
            </p>

            <div className="section-label" style={{ display: "block", margin: "18px 0 10px" }}>Generation mode (§5.6)</div>
            <div className="radio-row" style={{ marginBottom: weights && mode === "optimized" ? 14 : 0 }}>
              <label className={`radio-opt${mode === "fast" ? " selected" : ""}`}>
                <input type="radio" name="genmode" checked={mode === "fast"} onChange={() => setMode("fast")} />
                <div>
                  <div className="radio-opt-title">Fast — feasibility</div>
                  <div className="radio-opt-desc">The CSP engine alone — a complete, conflict-free timetable as quickly as possible.</div>
                </div>
              </label>
              <label className={`radio-opt${mode === "optimized" ? " selected" : ""}`}>
                <input type="radio" name="genmode" checked={mode === "optimized"} onChange={() => setMode("optimized")} />
                <div>
                  <div className="radio-opt-title">Optimized — nicer timetable</div>
                  {/* Shortened for the 460px column (§5.7). The claim that
                      decides the choice — never worse than Fast — is kept;
                      the mechanism behind it is on the hover. */}
                  <div className="radio-opt-desc"
                    title="Solves fast first, then hands the model to OR-Tools CP-SAT to reduce teacher gaps, flatten daily load and cluster lab periods. The result is replayed through the same hard-constraint checks and adopted only if it verifies and scores better.">
                    Solves fast, then lets CP-SAT cut teacher gaps and flatten daily load. Kept only
                    if it passes the same checks and scores better — never worse than Fast.
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

      </Card>
      </div>

      {/*
        The right column: the RUN. Progress, the live log and whatever the last
        one produced — the things that appear because of a press rather than
        before it.
      */}
      <div style={{ minWidth: 0 }}>
      {/*
        §5.7 — before the first run, the right column says what is about to be
        built.

        Not filler: on a school that has never generated there is no log and no
        result, and the column would be the blank half this layout exists to
        remove. These four numbers are the ones somebody checks before pressing
        a button that rewrites a week, and they are already in the readiness
        payload — no second request, and no second opinion about what the
        timetable contains.
      */}
      {!running && log.length === 0 && !result && readiness && (
        <Card title="What will be generated"
          sub="Phase A has already counted this. Generate places every required period into the week below.">
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: 10,
          }}>
            <Stat n={String(readiness.stats.classSections)} l="class-sections" />
            <Stat n={String(readiness.stats.teachers)} l="teachers" />
            <Stat n={String(readiness.stats.totalRequiredSlots)} l="periods required" />
            <Stat n={String(readiness.stats.totalAvailableSlots)} l="periods available" />
          </div>
          {readiness.warnings.length > 0 && (
            <p style={{ fontSize: 12.5, color: "var(--amber)", margin: "12px 0 0", lineHeight: 1.6 }}>
              {readiness.warnings.length} warning(s) — none of them stops a generation.{" "}
              <Link to="/readiness" style={{ color: "var(--brand)", fontWeight: 600 }}>See what they are →</Link>
            </p>
          )}
        </Card>
      )}
      {(running || progress || log.length > 0) && (
        <Card title={running ? "Running" : "Solver log"}
          sub={running ? "Streaming from the worker container." : "The last run's output."}>
          {(running || progress) && (
            <>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="mono" style={{ fontSize: 12, color: "var(--ink-soft)", margin: "6px 0 10px" }}>
                {progress ? `${progress.placed} / ${progress.total} variables placed (${pct}%)` : "queued…"}
              </div>
            </>
          )}
          {log.length > 0 && (
            /*
              Taller than it was, because it has a column to itself now. It was
              150px under a stack of controls — the one thing somebody watches
              while waiting, shown eight lines at a time.
            */
            <div ref={logRef} style={{
              fontFamily: "var(--font-mono)", fontSize: 11.5, background: "var(--brand-deep)",
              color: "var(--steel-light)", borderRadius: 10, padding: "12px 14px",
              height: wide ? 320 : 180, overflowY: "auto", lineHeight: 1.7,
              // §31's rule: wide content scrolls inside its own box, never the page.
              overflowX: "auto", whiteSpace: "pre",
            }}>
              {log.map((l, i) => <div key={i} style={l.startsWith("✓") ? { color: "#7BE3C8" } : l.startsWith("✗") ? { color: "#FF9C93" } : undefined}>{l}</div>)}
            </div>
          )}
        </Card>
      )}

      {result && !running && (
        <Card title="Last run" sub={latest.state === "completed" ? "Draft written — review it on the Allocation Matrix." : `state: ${latest.state}`}>
          {/* A wrapping grid, not a flex row: five stat boxes in a 1fr column
              overflowed sideways the moment the page became two columns. */}
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))",
            gap: 10, marginBottom: result.unplaced.length ? 14 : 0,
          }}>
            <Stat n={`${result.placedVariables}/${result.totalVariables}`} l="variables placed" />
            <Stat n={String(result.slotRows)} l="slot rows" />
            <Stat n={`${Math.round((result.placedVariables / Math.max(1, result.totalVariables)) * 100)}%`} l="fill" />
            <Stat n={`${result.stats.ms}ms`} l="solve time" />
            {/* §20: 0 is the promise. Anything else is a school-data fact the
                admin should see, not something to bury. */}
            <Stat n={String(result.stats.shortTeacherDays ?? 0)} l="short teacher-days" />
          </div>
          {(result.stats.shortTeacherDays ?? 0) > 0 && (
            <p style={{ fontSize: 12.5, color: "var(--amber)", marginBottom: 12, lineHeight: 1.6 }}>
              {result.stats.shortTeacherDays} teacher-day(s) came out below the teacher's minimum periods/day.
              A complete timetable was preferred over a perfectly shaped one — the Readiness Dashboard names
              the teachers whose numbers do not divide into whole days.
            </p>
          )}
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
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
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

const selectStyle: React.CSSProperties = {
  width: "100%", maxWidth: 460, padding: "8px 10px", border: "1px solid var(--line)",
  borderRadius: 8, fontSize: 13, fontFamily: "inherit", background: "var(--paper)",
};
