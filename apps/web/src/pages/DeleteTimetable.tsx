/**
 * §3.13 — delete a timetable, and show exactly what goes with it first.
 *
 * A timetable is not one row. Deleting it takes every draft's placements, the
 * draft registry, the extra classes, the periods and the auto-resolve history —
 * and *detaches*, without deleting, the class-sections. "Delete this timetable?"
 * cannot be answered honestly without that list, so the list is the screen: the
 * server counts it, and this renders the counts it was given rather than any it
 * worked out for itself.
 *
 * The name must be typed to confirm. Not ceremony — the list above it is
 * genuinely long, the action cannot be undone, and the cards on this page are
 * three lines apart. Typing "Primary Wing" is the difference between deleting
 * the timetable you meant and the one below it.
 */
import { useEffect, useState } from "react";
import { api } from "../api";
import { asMessage, Card, ErrorNote } from "../components";
import type { TimetableConfigSummary } from "../hooks";
import { inputStyle } from "./Timetables";

interface DeletionLine {
  label: string;
  count: number;
  effect: "deleted" | "detached";
}
interface DeletionPlan {
  configId: number;
  name: string;
  academicYear: string;
  lines: DeletionLine[];
  blocked: string | null;
}

export function DeleteTimetable({
  config,
  onDone,
  onCancel,
}: {
  config: TimetableConfigSummary;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [plan, setPlan] = useState<DeletionPlan | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<DeletionPlan>(`/timetable-configs/${config.id}/deletion`)
      .then((p) => { if (live) setPlan(p); })
      .catch((e) => { if (live) setError(asMessage(e)); });
    return () => { live = false; };
  }, [config.id]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/timetable-configs/${config.id}`, { method: "DELETE" });
      onDone();
    } catch (e) {
      // The server re-plans before it writes, so a refusal here is the real
      // rule speaking — surface it rather than the button's own guess.
      setError(asMessage(e));
      setBusy(false);
    }
  };

  // Nothing is at stake in a count of zero, and six "0 rows" lines bury the one
  // line that matters.
  const lines = (plan?.lines ?? []).filter((l) => l.count > 0);
  const matches = typed.trim().toLowerCase() === config.name.trim().toLowerCase();

  return (
    <Card>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 17, margin: 0 }}>
        Delete <span style={{ color: "var(--signal)" }}>{config.name}</span>?
      </h2>
      <p style={{ fontSize: 12.5, color: "var(--ink-soft)", margin: "4px 0 12px" }}>
        {config.academicYear} · this cannot be undone.
      </p>

      <ErrorNote message={error} />

      {plan?.blocked && (
        <div style={{
          borderLeft: "3px solid var(--signal)", background: "var(--signal-bg)",
          padding: "11px 13px", borderRadius: "0 8px 8px 0", fontSize: 13, marginBottom: 12,
        }}>
          {plan.blocked}
        </div>
      )}

      {plan && !plan.blocked && (
        <>
          <div style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
            {lines.length === 0 && (
              <div style={{ padding: "10px 13px", fontSize: 13, color: "var(--ink-soft)" }}>
                Nothing has been built in this timetable yet — only the timetable itself goes.
              </div>
            )}
            {lines.map((l, i) => (
              <div key={l.label} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "9px 13px", fontSize: 13,
                borderBottom: i < lines.length - 1 ? "1px solid var(--line)" : "none",
                background: l.effect === "detached" ? "var(--offwhite)" : "var(--paper)",
              }}>
                <strong className="mono" style={{
                  minWidth: 62, textAlign: "right",
                  color: l.effect === "detached" ? "var(--ink-soft)" : "var(--signal)",
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {l.count.toLocaleString()}
                </strong>
                <span style={{ color: "var(--ink-soft)" }}>{l.label}</span>
                <span style={{ flex: 1 }} />
                <span className="chip" style={{ fontSize: 11 }}>
                  {l.effect === "detached" ? "kept, unassigned" : "deleted"}
                </span>
              </div>
            ))}
          </div>

          <p style={{ fontSize: 12.5, color: "var(--ink-soft)", margin: "0 0 6px" }}>
            Classes, subjects, teachers, rooms and the curriculum are <strong>not</strong> touched —
            only this timetable and what was placed inside it.
          </p>

          <label style={{ display: "block", fontSize: 12.5, margin: "12px 0 5px" }}>
            Type <strong>{config.name}</strong> to confirm
          </label>
          <input
            style={{ ...inputStyle, maxWidth: 320 }}
            value={typed}
            autoFocus
            placeholder={config.name}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && matches && !busy) void confirm(); }}
          />
        </>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        {plan && !plan.blocked && (
          <button
            className="btn"
            disabled={!matches || busy}
            onClick={() => void confirm()}
            style={{
              background: matches ? "var(--signal)" : "var(--offwhite)",
              color: matches ? "#fff" : "var(--ink-faint)",
              border: `1px solid ${matches ? "var(--signal)" : "var(--line)"}`,
            }}
          >
            {busy ? "Deleting…" : "Delete permanently"}
          </button>
        )}
        <button className="btn" style={{ border: "1px solid var(--line)" }} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </Card>
  );
}
