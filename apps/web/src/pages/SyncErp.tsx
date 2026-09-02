/**
 * §23 — Sync masters from the ERP.
 *
 * One card per master, one button each. That shape is the point: an ERP grows
 * its endpoints one at a time, so Teachers can sync today while Class Sections
 * still says nobody has wired it up — rather than the whole screen failing and
 * leaving somebody to work out which of five endpoints was the problem.
 *
 * A sync here can delete. So nothing is written until the admin has seen the
 * count of what goes with it, and for a destructive run they type the school's
 * name — because "this will remove data" is a warning nobody reads and "this
 * removes 486 subject mappings and 2,240 published timetable rows" is a fact
 * somebody acts on.
 */
import { useState } from "react";
import { api } from "../api";
import { asMessage, Card, ErrorNote } from "../components";
import { useApi } from "../hooks";

/** The five masters. The server is the authority on the list; this mirrors it. */
type Sheet = "Academic Years" | "Classes" | "Class Sections" | "Subjects" | "Teachers";
type Mode = "refresh" | "replace";

interface Run {
  id: number; sheet: string; mode: string; status: string; endpoint: string | null;
  fetched: number; created: number; updated: number; deleted: number;
  durationMs: number; error: string | null; detail: any; createdAt: string;
}
interface MasterStatus {
  sheet: Sheet; configured: boolean; reason: string | null;
  endpoint: string | null; held: number; lastRun: Run | null;
}
interface Status {
  describe: string; configured: boolean; reason: string | null;
  schoolName: string; masters: MasterStatus[];
}
interface ImpactLine { label: string; count: number; effect: "deleted" | "cleared" }
interface Impact { rows: number; lines: ImpactLine[]; blocked: string | null; publishedSlots: number }
interface FieldChange { field: string; from: unknown; to: unknown }
interface RowPlan { key: string; label: string; verdict: "new" | "update" | "unchanged" | "remove"; changes: FieldChange[] }
interface Preview {
  sheet: Sheet; mode: Mode; endpoint: string | null;
  plan: { read: number; create: number; update: number; unchanged: number; remove: number; rows: RowPlan[] };
  impact: Impact; warnings: string[]; confirmRequired: boolean; fingerprint: string;
}

const show = (v: unknown) =>
  v === null || v === undefined || v === "" ? "—" : v === true ? "yes" : v === false ? "no" : String(v);

const when = (iso: string) => new Date(iso).toLocaleString();

export function SyncErp() {
  const { data: status, refetch, loading } = useApi<Status>("/sync/erp/status");
  const { data: logs, refetch: refetchLogs } = useApi<Run[]>("/sync/erp/logs?limit=25");
  const [open, setOpen] = useState<Sheet | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<Sheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reset = () => { setPreview(null); setTyped(""); setError(null); };

  const runPreview = async (sheet: Sheet, m: Mode) => {
    // The mode is not kept in state: `preview.mode` is what the server actually
    // planned, and a second source of truth for it could disagree with the
    // impact figures on screen.
    setBusy(sheet); reset(); setDone(null); setOpen(sheet);
    try {
      setPreview(await api<Preview>("/sync/erp/preview", {
        method: "POST", body: JSON.stringify({ sheet, mode: m }),
      }));
    } catch (e) {
      setError(asMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(preview.sheet); setError(null);
    try {
      const res = await api<{ status: string; created: number; updated: number; deleted: number; error: string | null; unresolved: string[] }>(
        "/sync/erp/apply",
        {
          method: "POST",
          body: JSON.stringify({
            sheet: preview.sheet, mode: preview.mode,
            confirm: typed, fingerprint: preview.fingerprint,
          }),
        },
      );
      if (res.status === "ok") {
        setDone(
          `${preview.sheet}: ${res.created} added, ${res.updated} updated, ${res.deleted} removed.` +
            (res.unresolved?.length ? ` ${res.unresolved.length} could not be filed.` : ""),
        );
        setOpen(null); reset();
      } else {
        // A refusal is an outcome, not an exception — it is logged like any
        // other run, and the reason is the thing worth reading.
        setError(res.error ?? "The sync was refused.");
      }
      await refetch(); await refetchLogs();
    } catch (e) {
      setError(asMessage(e));
      await refetchLogs();
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <p className="screen-sub">Loading…</p>;

  const nameMatches = typed.trim().toLowerCase() === (status?.schoolName ?? "").trim().toLowerCase();

  return (
    <div style={{ maxWidth: 980 }}>
      <ErrorNote message={error} />

      <Card
        title="Sync masters from the ERP"
        sub="The ERP is the record of who and what exists — staff, classes, sections, subjects, sessions. The timetable keeps its own scheduling settings, and a sync never touches them."
      >
        {!status?.configured ? (
          <div style={{ fontSize: 13 }}>
            <span className="badge badge-error">No API integration done</span>
            <p style={{ marginTop: 8, color: "var(--ink-soft)" }}>{status?.reason}</p>
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px", marginTop: 8 }}>
              <strong>To connect the ERP</strong>
              <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-soft)", marginTop: 4 }}>
                ERP_API_BASE_URL=https://erp.example.com/api/v1<br />
                ERP_API_FILE=/path/to/erp-api.json<br />
                ERP_API_CLIENT_SECRET=…
              </div>
              <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 6 }}>
                The mapping file describes the ERP&apos;s existing endpoints, field names and
                authentication — copy <code>scripts/erp-api.example.json</code>. The ERP is not
                asked to change, and each master can be added on its own. The client secret goes
                in the environment, never in the file.
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12 }}>
            <span className="badge badge-ok">API configured</span>
            <span className="mono" style={{ color: "var(--ink-faint)" }}>{status.describe}</span>
            <button className="btn" style={{ border: "1px solid var(--line)", marginLeft: "auto" }} onClick={refetch}>
              Refresh
            </button>
          </div>
        )}

        {done && (
          <p style={{ marginTop: 14, fontSize: 13 }}>
            <span className="badge badge-ok">Synced</span> {done}
          </p>
        )}
      </Card>

      {(status?.masters ?? []).map((m) => (
        <Card key={m.sheet} title={m.sheet}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", fontSize: 12.5 }}>
            {m.configured ? (
              <span className="chip mono" style={{ fontSize: 11 }}>{m.endpoint}</span>
            ) : (
              <span className="badge badge-warn">No API integration done</span>
            )}
            <span style={{ color: "var(--ink-faint)" }}>
              {m.held} row{m.held === 1 ? "" : "s"} here
            </span>
            {m.lastRun && (
              <span style={{ color: "var(--ink-faint)" }}>
                last sync {when(m.lastRun.createdAt)} —{" "}
                <span className={`badge ${m.lastRun.status === "ok" ? "badge-ok" : "badge-error"}`}>
                  {m.lastRun.status}
                </span>
              </span>
            )}
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button
                className="btn btn-secondary"
                disabled={!m.configured || busy !== null}
                onClick={() => runPreview(m.sheet, "refresh")}
              >
                {busy === m.sheet ? "Reading the ERP…" : "Sync"}
              </button>
              <button
                className="btn"
                style={{ border: "1px solid var(--signal)", color: "var(--signal)" }}
                disabled={!m.configured || busy !== null}
                onClick={() => runPreview(m.sheet, "replace")}
                title="Delete everything here and re-insert from the ERP"
              >
                Replace all
              </button>
            </span>
          </div>

          {!m.configured && m.reason && (
            <p style={{ fontSize: 12, color: "var(--ink-soft)", margin: "8px 0 0" }}>{m.reason}</p>
          )}

          {m.lastRun?.error && (
            <p className="mono" style={{ fontSize: 11.5, color: "var(--signal)", margin: "8px 0 0" }}>
              {m.lastRun.error}
            </p>
          )}

          {open === m.sheet && preview && (
            <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
              <p style={{ fontSize: 13, margin: "0 0 8px" }}>
                {preview.mode === "replace" ? (
                  <>
                    <strong>Replace all</strong> — delete the {preview.plan.remove} row(s) here and insert{" "}
                    {preview.plan.create} from the ERP. <em>Every id changes.</em>
                  </>
                ) : (
                  <>
                    <strong>{preview.plan.create}</strong> to add · <strong>{preview.plan.update}</strong> to update ·{" "}
                    <strong>{preview.plan.remove}</strong> to remove · {preview.plan.unchanged} already match
                  </>
                )}
              </p>

              {preview.warnings.map((w) => (
                <p key={w} style={{ fontSize: 12, color: "var(--amber)", margin: "4px 0" }}>⚠ {w}</p>
              ))}

              {/* The alert. Not "this deletes data" — the actual rows. */}
              {preview.impact.blocked ? (
                <p style={{ fontSize: 13, color: "var(--signal)", margin: "8px 0" }}>
                  <span className="badge badge-error">Refused</span> {preview.impact.blocked}
                </p>
              ) : preview.confirmRequired ? (
                <div style={{ border: "1px solid var(--signal)", borderRadius: 8, padding: "10px 12px", margin: "8px 0" }}>
                  <strong style={{ color: "var(--signal)" }}>
                    This deletes {preview.plan.remove} {preview.sheet} row(s)
                  </strong>
                  {preview.impact.lines.length > 0 ? (
                    <ul style={{ margin: "6px 0 0 18px", fontSize: 12.5 }}>
                      {preview.impact.lines.map((l) => (
                        <li key={l.label}>
                          <strong>{l.count}</strong> {l.label}
                          {l.effect === "cleared" ? " (cleared, not deleted)" : ""}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p style={{ fontSize: 12.5, margin: "6px 0 0", color: "var(--ink-soft)" }}>
                      Nothing else refers to these rows.
                    </p>
                  )}
                  {preview.impact.publishedSlots > 0 && (
                    <p style={{ fontSize: 12.5, margin: "8px 0 0", color: "var(--signal)" }}>
                      <strong>{preview.impact.publishedSlots}</strong> of those are in a <strong>published</strong>{" "}
                      timetable — the one teachers are using today.
                    </p>
                  )}
                  <p style={{ fontSize: 12.5, margin: "10px 0 4px" }}>
                    Type <strong>{status?.schoolName}</strong> to confirm:
                  </p>
                  <input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={status?.schoolName}
                    style={{ padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 6, width: 280 }}
                  />
                </div>
              ) : null}

              {/* Only what would change — listing the unchanged hundreds would
                  bury the four rows that matter. */}
              {preview.plan.rows.filter((r) => r.verdict !== "unchanged").slice(0, 25).map((r) => (
                <div key={`${r.verdict}-${r.key}`} style={{ fontSize: 12, padding: "4px 0", borderTop: "1px solid var(--line)" }}>
                  <span
                    className={`badge ${r.verdict === "new" ? "badge-ok" : r.verdict === "remove" ? "badge-error" : "badge-warn"}`}
                    style={{ marginRight: 8 }}
                  >
                    {r.verdict === "new" ? "add" : r.verdict === "remove" ? "remove" : "update"}
                  </span>
                  {r.label}
                  {r.changes.map((c) => (
                    <span key={c.field} className="mono" style={{ marginLeft: 10, color: "var(--ink-soft)", fontSize: 11 }}>
                      {c.field}: {show(c.from)} → <strong>{show(c.to)}</strong>
                    </span>
                  ))}
                </div>
              ))}
              {preview.plan.rows.filter((r) => r.verdict !== "unchanged").length > 25 && (
                <div style={{ fontSize: 11.5, color: "var(--ink-faint)", paddingTop: 4 }}>
                  …and {preview.plan.rows.filter((r) => r.verdict !== "unchanged").length - 25} more
                </div>
              )}

              <p style={{ fontSize: 11.5, color: "var(--ink-faint)", margin: "10px 0" }}>
                Scheduling settings are never overwritten: periods per day, period patterns, class-teacher rules and
                lab flags stay exactly as they are.
              </p>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn btn-primary"
                  onClick={apply}
                  disabled={
                    busy !== null ||
                    Boolean(preview.impact.blocked) ||
                    (preview.confirmRequired && !nameMatches) ||
                    preview.plan.create + preview.plan.update + preview.plan.remove === 0
                  }
                >
                  {busy ? "Syncing…" : preview.mode === "replace" ? "Delete and re-insert" : "Apply"}
                </button>
                <button className="btn" style={{ border: "1px solid var(--line)" }} onClick={() => { setOpen(null); reset(); }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </Card>
      ))}

      <Card title="Sync history" sub="Every run, including the ones that failed or were refused.">
        {(logs ?? []).length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--ink-faint)" }}>Nothing has been synced yet.</p>
        ) : (
          (logs ?? []).map((r) => (
            <div key={r.id} style={{ fontSize: 12, padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <span
                className={`badge ${r.status === "ok" ? "badge-ok" : r.status === "blocked" ? "badge-warn" : "badge-error"}`}
                style={{ marginRight: 8 }}
              >
                {r.status}
              </span>
              <strong>{r.sheet}</strong>{" "}
              <span style={{ color: "var(--ink-faint)" }}>
                {r.mode} · {when(r.createdAt)} · {r.durationMs}ms
              </span>
              {r.status === "ok" && (
                <span style={{ marginLeft: 10 }}>
                  {r.created} added, {r.updated} updated, {r.deleted} removed, {r.fetched} read
                </span>
              )}
              {r.error && (
                <div className="mono" style={{ color: "var(--signal)", fontSize: 11, marginTop: 3 }}>{r.error}</div>
              )}
              {r.detail?.unresolved?.length > 0 && (
                <div style={{ color: "var(--amber)", fontSize: 11, marginTop: 3 }}>
                  could not be filed: {r.detail.unresolved.slice(0, 5).join(", ")}
                </div>
              )}
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
