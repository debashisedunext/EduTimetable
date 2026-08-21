import type { ReactNode } from "react";

export function Card({ title, sub, children, actions }: { title?: string; sub?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="card" style={{ marginBottom: 18 }}>
      {(title || actions) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: sub ? 2 : 12 }}>
          {title && <h2 style={{ fontFamily: "var(--font-display)", fontSize: 16.5, fontWeight: 600 }}>{title}</h2>}
          {actions}
        </div>
      )}
      {sub && <p className="screen-sub">{sub}</p>}
      {children}
    </div>
  );
}

export function DataTable({ headers, rows, empty }: { headers: string[]; rows: ReactNode[][]; empty?: string }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} style={thStyle}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={headers.length} style={{ ...tdStyle, color: "var(--ink-faint)" }}>{empty ?? "Nothing here yet."}</td></tr>
          ) : (
            rows.map((r, i) => (
              <tr key={i}>{r.map((c, j) => <td key={j} style={tdStyle}>{c}</td>)}</tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left", fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em",
  color: "var(--ink-faint)", fontWeight: 700, padding: "9px 12px", borderBottom: "1px solid var(--line)",
};
const tdStyle: React.CSSProperties = { padding: "9px 12px", borderBottom: "1px solid var(--line)", fontSize: 13 };

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 5 }}>{hint}</div>}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div style={{ background: "var(--signal-bg)", color: "var(--signal)", border: "1px solid var(--signal)", borderRadius: 8, padding: "9px 12px", fontSize: 12.5, marginBottom: 12 }}>
      {message}
    </div>
  );
}

/** Row-level ✎ / 🗑 pair used on every master-data directory table. */
export function RowActions({ onEdit, onDelete }: { onEdit?: () => void; onDelete?: () => void }) {
  const btn: React.CSSProperties = { border: "1px solid var(--line)", padding: "4px 9px", fontSize: 11.5, borderRadius: 7, background: "var(--paper)", cursor: "pointer" };
  return (
    <span style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
      {onEdit && <button style={btn} title="Edit" onClick={onEdit}>✎ Edit</button>}
      {onDelete && <button style={{ ...btn, color: "var(--signal)" }} title="Delete" onClick={onDelete}>🗑</button>}
    </span>
  );
}

export function confirmDelete(label: string) {
  return window.confirm(`Delete ${label}? This cannot be undone. If it is still referenced (curriculum, mappings, slots), the delete will be refused.`);
}

/** Unwrap the API helper's "409: {json}" error strings to the server message. */
export const asMessage = (e: unknown) => {
  const raw = e instanceof Error ? e.message : String(e);
  const stripped = raw.replace(/^\d+: /, "");
  try { return JSON.parse(stripped).message ?? stripped; } catch { return stripped; }
};
