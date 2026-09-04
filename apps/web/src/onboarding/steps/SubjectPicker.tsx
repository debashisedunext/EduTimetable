/**
 * §26.1 — choosing a few subjects out of many, in a table cell.
 *
 * The Teachers step used to render EVERY subject in the school as a toggle chip
 * in EVERY teacher row. At the reference school that is 22 chips × 122 rows: a
 * wall of grey, most of it about subjects the teacher does not teach, and the
 * one fact the cell exists to show — what this teacher *does* teach — buried
 * inside it. Past about eight subjects the step stops being usable.
 *
 * So the cell shows only what is chosen, and the choosing happens in a popover.
 * Three consequences worth stating, because they are the point:
 *
 *  - **The cell's size stops depending on the school's subject count.** Eight
 *    subjects or forty, a teacher of two subjects has a two-chip cell.
 *  - **The list is searchable**, which is the only interaction that scales:
 *    with forty subjects, reading is slower than typing three letters.
 *  - **Priority orders the list** (§26.2), so the subjects a school teaches
 *    most of are the ones already under the cursor.
 */
import { useEffect, useMemo, useRef, useState } from "react";

export interface PickableSubject {
  name: string;
  /** §26.2 — higher first, so the common subjects are nearest the cursor. */
  priority?: number;
}

export function SubjectPicker({
  all,
  chosen,
  onToggle,
  label,
}: {
  all: PickableSubject[];
  chosen: string[];
  onToggle: (name: string) => void;
  /** Names the teacher this cell is about, for the screen reader. */
  label: string;
}) {
  /**
   * `null` when closed; the viewport coordinates to open at when not.
   *
   * **Fixed, not absolute**, and that is forced rather than chosen: the step's
   * table lives in a `Scroll` (`overflow: auto`, max-height 340), so an
   * absolutely-positioned panel is clipped by it — cut off at the container's
   * edge and scrolled away with the rows. The same trap the §8.1d nav flyout
   * hit, with the same answer: measure the button and position against the
   * viewport.
   */
  const [at, setAt] = useState<{ left: number; top: number; up: boolean } | null>(null);
  const open = at !== null;
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement | null>(null);

  const PANEL_H = 262;
  const openAt = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (open) { setAt(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    // Flip above the button when there is no room below, so a teacher near the
    // bottom of the list is not choosing from a panel hanging off the screen.
    const up = r.bottom + PANEL_H > window.innerHeight && r.top > PANEL_H;
    setQuery("");
    setAt({ left: r.left, top: up ? r.top - 4 : r.bottom + 4, up });
  };

  // Close on an outside click or Escape — a popover dismissable only by the
  // button that opened it is a trap in a grid of a hundred rows, where the
  // natural move is to click the next cell. And on scroll, because a panel
  // positioned against the viewport would otherwise sail away from its row.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setAt(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setAt(null); };
    const shut = () => setAt(null);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    // `true` — the table's own scroller does not bubble a scroll event.
    window.addEventListener("scroll", shut, true);
    window.addEventListener("resize", shut);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", shut, true);
      window.removeEventListener("resize", shut);
    };
  }, [open]);

  const ordered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter((s) => s.name.trim() !== "" && (q === "" || s.name.toLowerCase().includes(q)))
      // Priority first, then alphabetical — a stable order, so the list does not
      // reshuffle under the cursor as things are ticked.
      .sort((a, b) => (b.priority ?? 3) - (a.priority ?? 3) || a.name.localeCompare(b.name));
  }, [all, query]);

  return (
    <div ref={box} style={{ position: "relative", display: "flex", flexWrap: "wrap", gap: 3, padding: "3px 2px" }}>
      {chosen.map((name) => (
        <button
          key={name}
          onClick={() => onToggle(name)}
          title={`${name} — click to remove`}
          style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            font: "500 10.5px/1 Inter", padding: "4px 6px 4px 8px", borderRadius: 20, cursor: "pointer",
            border: "1px solid var(--brand)", background: "var(--brand)", color: "#fff",
          }}
        >
          {name}
          <span aria-hidden style={{ opacity: 0.7, fontSize: 11 }}>×</span>
        </button>
      ))}

      <button
        onClick={openAt}
        aria-expanded={open}
        aria-label={chosen.length === 0 ? `Add a subject for ${label}` : `Add another subject for ${label}`}
        style={{
          font: "500 10.5px/1 Inter", padding: "4px 8px", borderRadius: 20, cursor: "pointer",
          border: `1px dashed ${open ? "var(--brand)" : "var(--line)"}`,
          background: "var(--paper)", color: open ? "var(--brand)" : "var(--ink-faint)",
        }}
      >
        {chosen.length === 0 ? "＋ Add a subject" : "＋"}
      </button>

      {at && (
        <div
          style={{
            position: "fixed", left: at.left, top: at.top, zIndex: 210,
            transform: at.up ? "translateY(-100%)" : undefined,
            width: 236, maxHeight: PANEL_H, display: "flex", flexDirection: "column",
            background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 10,
            boxShadow: "0 12px 30px rgba(11,31,68,.18)",
          }}
        >
          <input
            autoFocus
            value={query}
            placeholder="Search subjects…"
            aria-label="Search subjects"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter takes the top match, so a two-subject teacher is two
              // keystrokes and a return rather than a hunt down the list.
              if (e.key === "Enter" && ordered[0]) { onToggle(ordered[0].name); setQuery(""); }
            }}
            style={{
              margin: 7, padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 7,
              fontSize: 12, fontFamily: "inherit", background: "var(--offwhite)",
            }}
          />
          <div style={{ overflowY: "auto", padding: "0 5px 6px" }}>
            {ordered.length === 0 && (
              <div style={{ padding: "8px 8px 10px", fontSize: 11.5, color: "var(--ink-faint)" }}>
                {all.length === 0 ? "No subjects yet — add them on the previous step." : "No subject matches that."}
              </div>
            )}
            {ordered.map((s) => {
              const on = chosen.includes(s.name);
              return (
                <button
                  key={s.name}
                  onClick={() => onToggle(s.name)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                    padding: "6px 8px", border: "none", borderRadius: 7, cursor: "pointer",
                    background: on ? "var(--steel-pale)" : "transparent",
                    color: on ? "var(--brand)" : "var(--ink)",
                    font: `${on ? 600 : 400} 12px/1.3 Inter`,
                  }}
                >
                  <span aria-hidden style={{ width: 12, color: on ? "var(--brand)" : "var(--line)" }}>
                    {on ? "✓" : "＋"}
                  </span>
                  {s.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
