import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
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
/** §22 — a named draft, as the picker needs it. */
interface DraftRow {
  id: number;
  draftNo: number;
  label: string | null;
  status: "draft" | "published" | "archived" | "discarded";
  generationPct: number | null;
}

interface Preview {
  draftCount: number;
  publishedCount: number;
  /** §22 — which draft this diff is for */
  draftId: number | null;
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
  // §22 — the draft to publish. It can arrive three ways, and they have to
  // agree: deep-linked from the Draft Board's Compare row, chosen in the picker
  // below, or left to the server when a school has only one. The URL is kept in
  // step with the picker so a refresh or a shared link still means this draft.
  const [params, setParams] = useSearchParams();
  const draftQ = params.get("draftId");
  const draftId = draftQ && /^\d+$/.test(draftQ) ? Number(draftQ) : null;
  const { data: drafts } = useApi<DraftRow[]>(
    current ? `/timetable-configs/${current.id}/drafts` : null,
  );
  const { data, refetch } = useApi<Preview>(
    current
      ? `/timetable-configs/${current.id}/board/publish/preview${draftId !== null ? `?draftId=${draftId}` : ""}`
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ version: number; slotCount: number; draftNo: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!current) return <p className="screen-sub">Select a timetable first.</p>;
  if (!data) return <p className="screen-sub">Computing diff…</p>;

  // Publishing is what MAKES a draft the published one, so only a draft that
  // still holds a week can be published. Publishing flips its rows in place
  // (§22.4), so a draft that has already been published — or been archived by
  // a later publish — has no draft rows left and would publish nothing.
  const publishable = (drafts ?? []).filter((d) => d.status === "draft");
  // Whatever the server actually diffed, until the reader picks something else.
  const shownDraftId = draftId ?? data.draftId ?? null;
  const shown = (drafts ?? []).find((d) => d.id === shownDraftId) ?? null;
  const chooseDraft = (id: number) => {
    const next = new URLSearchParams(params);
    next.set("draftId", String(id));
    setParams(next, { replace: true });
  };

  const publish = async () => {
    // Name the draft in the confirmation. "Publish v3?" is not a question a
    // person with five drafts can answer.
    const which = shown ? `Draft #${shown.draftNo}${shown.label ? ` — ${shown.label}` : ""}` : "this draft";
    if (!window.confirm(
      `Publish ${which} as v${data.nextVersion}?\n\n` +
        `This replaces the live timetable for every teacher and class-section in one transaction. ` +
        `Your other drafts are untouched.`,
    )) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ version: number; slotCount: number }>(
        `/timetable-configs/${current.id}/board/publish`,
        // Send the draft that is ON SCREEN, not only one that came in the URL:
        // otherwise arriving from the nav and picking a draft would publish
        // whichever the server thought was current, not the one being reviewed.
        { method: "POST", body: JSON.stringify(shownDraftId !== null ? { draftId: shownDraftId } : {}) },
      );
      setDone({ ...res, draftNo: shown?.draftNo ?? null });
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
        <p className="screen-sub">
          {done.draftNo !== null ? `Draft #${done.draftNo} · ` : ""}
          {done.slotCount} slots published in one transaction.
          {" "}Your other drafts are untouched — the school keeps them for the next revision (§22.4).
        </p>
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
      <p className="screen-sub" style={{ marginBottom: 14 }}>
        Review changes before this draft replaces the live timetable for every teacher and class-section.
      </p>

      {/* §22 — WHICH draft is being published. Without this the screen showed a
          version number and a diff for a draft it never named, and a school
          with five of them had no way to tell which one it was about to make
          live, nor to choose a different one without going back to the Board. */}
      {publishable.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
          <span className="section-label">Publish</span>
          <select
            value={shownDraftId ?? ""}
            onChange={(e) => chooseDraft(Number(e.target.value))}
            style={{ padding: "8px 11px", border: "1px solid var(--brand)", borderRadius: 8, fontWeight: 700, fontSize: 13, color: "var(--brand)", background: "var(--steel-pale)" }}
          >
            {publishable.map((d) => (
              <option key={d.id} value={d.id}>
                Draft #{d.draftNo}{d.label ? ` — ${d.label}` : ""}
                {d.generationPct !== null ? ` · ${d.generationPct}%` : ""}
              </option>
            ))}
          </select>
          <Link to="/board" style={{ fontSize: 12.5, color: "var(--brand)", fontWeight: 600 }}>
            Compare them on the Draft Board →
          </Link>
        </div>
      )}

      {/* A draft that is already published, or was archived by a later publish,
          has no draft rows left (§22.4 flips them in place) — so it would
          publish nothing. Say that, rather than leaving a disabled button. */}
      {shown && shown.status !== "draft" && (
        <div className="card" style={{ borderColor: "var(--amber)", background: "var(--amber-bg, #FBF0DE)", padding: "12px 14px", marginBottom: 20, fontSize: 12.5 }}>
          <strong>Draft #{shown.draftNo} is {shown.status}</strong> — publishing flips a draft's rows in place, so this one
          has no working copy left to publish. Pick an editable draft above, or regenerate this one on the Generate screen.
        </div>
      )}

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
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--accent)", marginBottom: 12 }}>
            Publishing {shown ? `Draft #${shown.draftNo}` : "this draft"}
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600 }}>
            {shown ? `Draft #${shown.draftNo}` : "Draft"} → v{data.nextVersion}
            {shown?.label && <span style={{ fontSize: 13, fontWeight: 400, color: "var(--ink-soft)" }}> · {shown.label}</span>}
          </div>
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
          {busy
            ? "Publishing…"
            : `Confirm & Publish ${shown ? `Draft #${shown.draftNo} ` : ""}as v${data.nextVersion}`}
        </button>
        {data.draftCount === 0 && (
          <span style={{ alignSelf: "center", fontSize: 12, color: "var(--ink-faint)" }}>
            Nothing to publish — this draft holds no lessons.
          </span>
        )}
      </div>
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "left", padding: "9px 14px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-faint)" };
const td: React.CSSProperties = { padding: "9px 14px", verticalAlign: "top" };
