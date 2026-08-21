import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useApi, useConfigCtx } from "../hooks";

interface SectionDiff {
  classSectionId: number;
  label: string;
  added: number;
  removed: number;
  changed: number;
  unallocated: number;
  details: string[];
}
interface Preview {
  draftCount: number;
  publishedCount: number;
  demandTotal: number;
  unallocatedTotal: number;
  changedTotal: number;
  unchangedSections: number;
  sections: SectionDiff[];
  currentVersion: number | null;
  currentPublishedAt: string | null;
  nextVersion: number;
}

/** Screen 6 (§8) — Publish Confirmation: reviewable diff vs. the live version,
 *  unallocated warnings, then ONE transaction flips draft→published (task 3.7). */
export function Publish() {
  const { current } = useConfigCtx();
  const navigate = useNavigate();
  const { data, refetch } = useApi<Preview>(
    current ? `/timetable-configs/${current.id}/board/publish/preview` : null,
  );
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ version: number; slotCount: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!current) return <p className="screen-sub">Select a timetable first.</p>;
  if (!data) return <p className="screen-sub">Computing diff…</p>;

  const publish = async () => {
    if (!window.confirm(`Publish v${data.nextVersion}? This replaces the live timetable for every teacher and class-section in one transaction.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ version: number; slotCount: number }>(
        `/timetable-configs/${current.id}/board/publish`,
        { method: "POST" },
      );
      setDone(res);
    } catch (e) {
      const msg = (e as Error).message.replace(/^\d+: /, "");
      try { setError(JSON.parse(msg).message ?? msg); } catch { setError(msg); }
    } finally {
      setBusy(false);
      refetch();
    }
  };

  if (done) {
    return (
      <div className="card" style={{ textAlign: "center", padding: 48 }}>
        <div style={{ fontSize: 40, marginBottom: 10 }}>🎉</div>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 600, marginBottom: 6 }}>
          v{done.version} is live
        </h2>
        <p className="screen-sub">{done.slotCount} slots published in one transaction — the draft board is now empty until you start the next revision.</p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 14 }}>
          <button className="btn" onClick={() => navigate("/matrix")}>View Allocation Matrix</button>
          <button className="btn btn-primary" onClick={() => navigate("/board")}>Back to Draft Board</button>
        </div>
      </div>
    );
  }

  const fmtDate = (d: string | null) =>
    d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null;

  return (
    <div>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 21, fontWeight: 600, marginBottom: 4 }}>Publish Confirmation</h2>
      <p className="screen-sub" style={{ marginBottom: 20 }}>
        Review changes before this draft replaces the live timetable for every teacher and class-section.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 22 }}>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--ink-faint)", marginBottom: 12 }}>Currently Published</div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600 }}>
            {data.currentVersion ? `v${data.currentVersion}` : "— none yet"}
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 2 }}>
            {data.currentVersion
              ? `Effective since ${fmtDate(data.currentPublishedAt)} · ${data.publishedCount} slots`
              : "This will be the first published version"}
          </div>
        </div>
        <div className="card" style={{ padding: 20, borderColor: "var(--accent)" }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--accent)", marginBottom: 12 }}>New Draft</div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600 }}>v{data.nextVersion}</div>
          <div style={{ fontSize: 12, color: "var(--ink-faint)", marginTop: 2 }}>
            {data.draftCount} / {data.demandTotal} required slots filled
            {data.unallocatedTotal > 0 ? ` · ${data.unallocatedTotal} unallocated` : " · complete"}
          </div>
        </div>
      </div>

      {data.unallocatedTotal > 0 && (
        <div className="card" style={{ borderColor: "var(--amber)", background: "var(--amber-bg)", marginBottom: 18, padding: 14 }}>
          <b style={{ color: "var(--amber)" }}>⚠ {data.unallocatedTotal} period(s) are still unallocated.</b>{" "}
          <span style={{ fontSize: 12.5 }}>You can publish anyway, but those classes will have empty slots — place them on the <Link to="/board">Draft Board</Link> first for a complete timetable.</span>
        </div>
      )}

      <div className="card" style={{ marginBottom: 22, padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: "var(--offwhite)" }}>
              <th style={th}>Change</th><th style={th}>Class-Section</th><th style={th}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {data.sections.map((s) => (
              <tr key={s.classSectionId} style={{ borderTop: "1px solid var(--line)" }}>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  {s.added > 0 && <span className="badge badge-ok" style={{ marginRight: 4 }}>{s.added} added</span>}
                  {s.changed > 0 && <span className="badge badge-ok" style={{ marginRight: 4 }}>{s.changed} changed</span>}
                  {s.removed > 0 && <span className="badge badge-neutral" style={{ marginRight: 4 }}>{s.removed} removed</span>}
                  {s.unallocated > 0 && <span className="badge badge-warn">{s.unallocated} unallocated</span>}
                </td>
                <td style={{ ...td, fontWeight: 700 }}>{s.label}</td>
                <td style={td}>
                  {s.details.slice(0, 4).join(" · ")}
                  {s.details.length > 4 ? ` · +${s.added + s.changed + s.removed - 4} more` : ""}
                </td>
              </tr>
            ))}
            {data.unchangedSections > 0 && (
              <tr style={{ borderTop: "1px solid var(--line)" }}>
                <td style={td}><span className="badge badge-neutral">Unchanged</span></td>
                <td style={{ ...td, fontWeight: 700 }}>{data.unchangedSections} section(s)</td>
                <td style={td}>No changes from {data.currentVersion ? `v${data.currentVersion}` : "the current draft"}</td>
              </tr>
            )}
            {data.sections.length === 0 && data.unchangedSections === 0 && (
              <tr><td style={td} colSpan={3}>Nothing to compare yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {error && <div className="card" style={{ borderColor: "var(--signal)", background: "var(--signal-bg)", color: "var(--signal)", padding: 12, marginBottom: 16, fontWeight: 600, fontSize: 12.5 }}>{error}</div>}

      <div style={{ display: "flex", gap: 10 }}>
        <Link to="/board" className="btn" style={{ textDecoration: "none" }}>Back to Draft Board</Link>
        <button className="btn btn-primary" onClick={publish} disabled={busy || data.draftCount === 0}>
          {busy ? "Publishing…" : `Confirm & Publish v${data.nextVersion}`}
        </button>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "left", padding: "9px 14px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-faint)" };
const td: React.CSSProperties = { padding: "9px 14px", verticalAlign: "top" };
