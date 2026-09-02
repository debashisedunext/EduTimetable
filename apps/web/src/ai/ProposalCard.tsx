/**
 * §13.5 — the confirmation screen for a drafted batch.
 *
 * This card is the thing that makes an assistant safe near a masters table.
 * The model proposes; nothing is written until somebody reads this and presses
 * Apply. So it has to be readable rather than reassuring: what would be added,
 * what already exists, and every problem with the exact cell and the fix — the
 * same `Sheet!C7` references the Excel importer produces, because it is the
 * same validator talking.
 */
import { useState } from "react";
import { api } from "../api";
import { asMessage } from "../components";

export interface Proposal {
  proposalId: string | null;
  ok: boolean;
  sheets: { sheet: string; title: string; read: number; create: number; skip: number; errors: number }[];
  totals: { read: number; create: number; skip: number; errors: number };
  issues: { sheet: string; row: number | null; cell?: string; message: string; fix: string; severity: string }[];
  /** §13.5 Phase B — existing rows whose values would change */
  updates?: { sheet: string; label: string; id: number; changes: { field: string; from: unknown; to: unknown }[] }[];
  summary: string;
  /** set once applied, so a card cannot offer the same write twice */
  applied?: string;
}

const show = (v: unknown) =>
  v === null || v === undefined || v === "" ? "—"
    : v === true ? "yes" : v === false ? "no"
    : Array.isArray(v) ? (v.length ? v.join(", ") : "—")
    : String(v);

export function ProposalCard({ proposal, onApplied }: { proposal: Proposal; onApplied: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(proposal.applied ?? null);

  const errors = proposal.issues.filter((i) => i.severity === "error");
  const warnings = proposal.issues.filter((i) => i.severity !== "error");

  const apply = async () => {
    if (!proposal.proposalId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ created: Record<string, number>; updated?: number; message?: string }>(
        "/ai/data-entry/apply",
        { method: "POST", body: JSON.stringify({ proposalId: proposal.proposalId }) },
      );
      const n = Object.values(res.created ?? {}).reduce((a, b) => a + b, 0);
      const u = res.updated ?? 0;
      const bits = [];
      if (n > 0) bits.push(`added ${n} row${n === 1 ? "" : "s"}`);
      if (u > 0) bits.push(`changed ${u}`);
      const msg = bits.length > 0
        ? `${bits.join(", ")}.`.replace(/^./, (c) => c.toUpperCase())
        : (res.message ?? "Nothing to do.");
      setDone(msg);
      proposal.applied = msg;
      onApplied(msg);
    } catch (e) {
      setError(asMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      border: `1px solid ${proposal.ok ? "var(--line)" : "var(--signal)"}`,
      borderRadius: 10, padding: "12px 14px", marginTop: 9, background: "var(--paper)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>
          {!proposal.ok ? "Cannot be written yet"
            : (proposal.updates ?? []).length > 0 && proposal.totals.create > 0 ? "Ready to add and change"
            : (proposal.updates ?? []).length > 0 ? "Ready to change"
            : "Ready to add"}
        </span>
        <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>{proposal.summary}</span>
      </div>

      {/* Per master: what would happen. `skip` is the duplicate answer. */}
      {proposal.sheets.length > 0 && (
        <div style={{ display: "grid", gap: 4, marginBottom: 9 }}>
          {proposal.sheets.filter((s) => s.read > 0).map((s) => (
            <div key={s.sheet} style={{ display: "flex", gap: 8, fontSize: 12.5, alignItems: "baseline" }}>
              <strong style={{ minWidth: 120 }}>{s.sheet}</strong>
              {s.create > 0 && <span className="badge badge-ok">{s.create} new</span>}
              {s.skip > 0 && <span className="badge" style={{ background: "var(--steel-pale)", color: "var(--steel)" }}>
                {s.skip} already exist
              </span>}
              {s.errors > 0 && <span className="badge badge-error">{s.errors} with errors</span>}
            </div>
          ))}
        </div>
      )}

      {/* Phase B — the field-level diff. A change to something that already
          exists is the half of this feature that needs reading carefully, so it
          is shown value by value rather than as a count. */}
      {(proposal.updates ?? []).length > 0 && (
        <div style={{ marginBottom: 9 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em",
            color: "var(--ink-faint)", marginBottom: 4 }}>
            Changes to existing rows
          </div>
          {(proposal.updates ?? []).slice(0, 12).map((u, n) => (
            <div key={n} style={{ fontSize: 12, padding: "5px 0", borderTop: "1px solid var(--line)" }}>
              <span style={{ fontWeight: 600 }}>{u.label}</span>
              <span className="mono" style={{ color: "var(--ink-faint)", marginLeft: 6, fontSize: 10.5 }}>{u.sheet}</span>
              {u.changes.map((c) => (
                <div key={c.field} className="mono" style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 2 }}>
                  {c.field}: {show(c.from)} → <strong style={{ color: "var(--ink)" }}>{show(c.to)}</strong>
                </div>
              ))}
            </div>
          ))}
          {(proposal.updates ?? []).length > 12 && (
            <div style={{ fontSize: 11.5, color: "var(--ink-faint)", paddingTop: 4 }}>
              …and {(proposal.updates ?? []).length - 12} more
            </div>
          )}
        </div>
      )}

      {errors.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {errors.slice(0, 8).map((i, n) => (
            <div key={n} style={{ fontSize: 12, padding: "5px 0", borderTop: "1px solid var(--line)" }}>
              <span className="mono" style={{ color: "var(--signal)", marginRight: 6 }}>
                {i.sheet}{i.cell ? `!${i.cell}` : i.row ? ` row ${i.row}` : ""}
              </span>
              {i.message}
              <div style={{ color: "var(--ink-faint)", marginTop: 2 }}>→ {i.fix}</div>
            </div>
          ))}
          {errors.length > 8 && (
            <div style={{ fontSize: 11.5, color: "var(--ink-faint)", paddingTop: 4 }}>
              …and {errors.length - 8} more
            </div>
          )}
        </div>
      )}

      {warnings.length > 0 && (
        <details style={{ fontSize: 12, marginBottom: 8 }}>
          <summary style={{ cursor: "pointer", color: "var(--amber)" }}>
            {warnings.length} note{warnings.length === 1 ? "" : "s"}
          </summary>
          {warnings.slice(0, 10).map((i, n) => (
            <div key={n} style={{ padding: "4px 0", color: "var(--ink-soft)" }}>
              <span className="mono" style={{ marginRight: 6 }}>{i.sheet}</span>{i.message}
            </div>
          ))}
        </details>
      )}

      {error && <div style={{ fontSize: 12, color: "var(--signal)", marginBottom: 8 }}>{error}</div>}

      {done ? (
        <div style={{ fontSize: 12.5 }}>
          <span className="badge badge-ok">Applied</span> {done}
        </div>
      ) : proposal.ok && proposal.proposalId ? (
        <button className="btn btn-primary" style={{ padding: "6px 14px", fontSize: 12.5 }}
          onClick={apply} disabled={busy}>
          {busy ? "Writing…" : applyLabel(proposal)}
        </button>
      ) : (
        <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
          Nothing has been written. Tell the assistant what to correct and it will draft again.
        </div>
      )}
    </div>
  );
}

/** What the button promises, counting adds and changes separately. */
function applyLabel(p: Proposal): string {
  const adds = p.totals.create;
  const changes = (p.updates ?? []).length;
  const bits: string[] = [];
  if (adds > 0) bits.push(`add ${adds}`);
  if (changes > 0) bits.push(`change ${changes}`);
  return `✓ Apply — ${bits.join(" and ")} row${adds + changes === 1 ? "" : "s"}`;
}
