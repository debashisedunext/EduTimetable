/**
 * §15.3 Phase 25.4 — the small pieces steps 6–11 share.
 *
 * Four of the six remaining steps are grids, and a grid somebody types a whole
 * staff list into is a different thing from a form: it has to survive Tab,
 * Enter, and — the one that actually saves the twenty minutes — a column pasted
 * straight out of the spreadsheet the school already keeps.
 */
import React from "react";

export const label = {
  display: "block", font: "600 11px/1.4 Inter", textTransform: "uppercase" as const,
  letterSpacing: "0.06em", color: "var(--steel)", marginBottom: 5,
};

export const input = {
  width: "100%", padding: "8px 11px", border: "1px solid var(--line)", borderRadius: 8,
  fontSize: 13.5, background: "var(--paper)", color: "var(--ink)",
};

/** A cell input: no border of its own, so a grid reads as a grid. */
export const cell: React.CSSProperties = {
  width: "100%", padding: "6px 8px", border: "1px solid transparent", borderRadius: 6,
  fontSize: 12.5, background: "transparent", color: "var(--ink)", outlineOffset: -1,
};

export const th: React.CSSProperties = {
  textAlign: "left", font: "600 10px/1.3 Inter", textTransform: "uppercase",
  letterSpacing: "0.07em", color: "var(--steel)", padding: "8px 9px",
  borderBottom: "1px solid var(--line)", background: "var(--offwhite)",
  position: "sticky", top: 0, zIndex: 1, whiteSpace: "nowrap",
};

export const td: React.CSSProperties = {
  padding: "1px 3px", borderBottom: "1px solid var(--line)", verticalAlign: "middle",
};

export function Heading({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <>
      <h2 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 22, margin: "0 0 4px" }}>{title}</h2>
      {children && (
        <p style={{ fontSize: 13.5, color: "var(--ink-soft)", margin: "0 0 14px" }}>{children}</p>
      )}
    </>
  );
}

export function Scroll({ children, max = 320 }: { children: React.ReactNode; max?: number }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "auto", maxHeight: max }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>{children}</table>
    </div>
  );
}

export function LinkButton({ onClick, tone = "brand", children }: {
  onClick: () => void; tone?: "brand" | "danger"; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} style={{
      border: "none", background: "none", cursor: "pointer", fontSize: 11.5, padding: "3px 5px",
      color: tone === "danger" ? "var(--signal)" : "var(--brand)",
    }}>{children}</button>
  );
}

/**
 * A column pasted out of Excel fills down from the cell it was dropped in.
 *
 * This is the single feature that makes a 120-teacher staff list bearable, and
 * it costs one paste handler. Without it the honest advice for any real school
 * would be "use the Excel importer instead", which makes the guided setup a toy.
 *
 * Excel copies a column as newline-separated text (rows within it tab-separated,
 * which is why only the first field of each line is taken — pasting a whole
 * block into one column should fill that column, not scatter across it).
 */
export function pasteColumn(
  e: React.ClipboardEvent,
  index: number,
  apply: (values: string[], startIndex: number) => void,
): void {
  const text = e.clipboardData.getData("text/plain");
  const lines = text.split(/\r\n|\r|\n/).map((l) => l.split("\t")[0].trim()).filter((l) => l !== "");
  // One value is an ordinary paste — let the browser do it, or the caret
  // position and undo history are both lost for no gain.
  if (lines.length < 2) return;
  e.preventDefault();
  apply(lines, index);
}
