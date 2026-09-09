/**
 * §26.1 — choosing a few things out of many, in a table cell.
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
import { useMemo, useState } from "react";
import { useAnchored } from "../../ui/anchored";

export interface Pickable {
  name: string;
  /** §26.2 — higher first, so the common ones are nearest the cursor. */
  priority?: number;
}

/**
 * Written for subjects; §27.9 gave it a second caller — which classes a teacher
 * takes. The two cells have the same shape (a few chosen out of many, in a
 * table cell, at a school where "many" is twenty subjects or sixteen classes),
 * so it is one control with a `noun` rather than two that drift apart.
 */
export function ChipPicker({
  all,
  chosen,
  onToggle,
  label,
  noun = "subject",
  nounPlural,
  keepOrder = false,
  collapseAll = false,
}: {
  all: Pickable[];
  chosen: string[];
  onToggle: (name: string) => void;
  /** Names the teacher this cell is about, for the screen reader. */
  label: string;
  noun?: string;
  /** Its plural, where adding an "s" is wrong — "class" → "classes". */
  nounPlural?: string;
  /**
   * Summarise a long selection into one chip (§27.9, §27.16).
   *
   * The classes cell starts with every class TICKED — a teacher takes their
   * whole wing until somebody says otherwise — and rendering that as sixteen
   * chips in every one of 122 rows would rebuild exactly the wall §26.1 pulled
   * down for subjects.
   *
   * "All N" was only half of it, and the half that showed up second: remove ONE
   * class and the cell went straight from a single chip to fifteen, which is
   * the same wall arriving the moment somebody uses the control. So the summary
   * covers both — every one of them, or simply a lot of them — and the list
   * itself lives in the picker, where it is searchable and cannot push the row
   * off the screen. A short selection still shows its chips, because at two or
   * three the names ARE the summary.
   */
  collapseAll?: boolean;
  /**
   * Keep the given order instead of sorting by priority.
   *
   * Classes have one right order — the ladder — and Pre-Nursery through Class
   * 12 sorted alphabetically ("Class 10" before "Class 2") is the classic way
   * to make a class list unreadable.
   */
  keepOrder?: boolean;
}) {
  /**
   * Fixed-positioned, because the step's table lives in a `Scroll`
   * (`overflow: auto`) that would clip an absolutely-positioned panel and
   * scroll it away with the rows. `useAnchored` owns that, and the dismissal
   * rules that come with it.
   */
  const { open, toggle, close, panelProps } = useAnchored(262);
  const [query, setQuery] = useState("");

  const ordered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = all
      .filter((s) => s.name.trim() !== "" && (q === "" || s.name.toLowerCase().includes(q)));
    // Priority first, then alphabetical — a stable order, so the list does not
    // reshuffle under the cursor as things are ticked.
    return keepOrder
      ? out
      : [...out].sort((a, b) => (b.priority ?? 3) - (a.priority ?? 3) || a.name.localeCompare(b.name));
  }, [all, query, keepOrder]);

  const plural = nounPlural ?? `${noun}s`;
  const everything = collapseAll && all.length > 3 && chosen.length === all.length;
  /**
   * The threshold. Four is where a row of chips stops reading as a list of
   * names and starts reading as a block of colour — and it is also the point
   * where the summary ("11 of 14 classes") carries more than the names do,
   * since what a person checks at a glance is whether this row was narrowed.
   */
  const summarised = collapseAll && !everything && chosen.length > 3;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, padding: "3px 2px" }}>
      {everything || summarised ? (
        <button
          onClick={(e) => { setQuery(""); toggle(e); }}
          aria-expanded={open}
          aria-label={`${chosen.length} of ${all.length} ${plural} for ${label} — open to change`}
          // The names are still ON the element, so a hover answers "which ones?"
          // without opening anything — the summary hides the list, it does not
          // hide the answer.
          title={everything ? `Every ${noun} — open to remove any` : chosen.join(", ")}
          style={{
            font: "500 10.5px/1 Inter", padding: "4px 9px", borderRadius: 20, cursor: "pointer",
            border: "1px solid var(--brand)", whiteSpace: "nowrap",
            background: "var(--steel-pale)", color: "var(--brand-dark)",
          }}
        >
          {everything ? `All ${all.length} ${plural}` : `${chosen.length} of ${all.length} ${plural}`}
          <span aria-hidden style={{ opacity: 0.6, marginLeft: 5 }}>✎</span>
        </button>
      ) : chosen.map((name) => (
        <button
          key={name}
          onClick={() => onToggle(name)}
          title={`${name} — click to remove`}
          style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            font: "500 10.5px/1 Inter", padding: "4px 6px 4px 8px", borderRadius: 20, cursor: "pointer",
            border: "1px solid var(--brand)", background: "var(--brand)", color: "#fff",
            /*
              A name never breaks mid-name. Without this "Computer Science" wrapped
              INSIDE its own pill — two lines of white text in a rounded blue box,
              with the ＋ pushed onto a third — and every row in the table grew to
              match. A chip is a label, and a label that wraps has stopped being one.
            */
            whiteSpace: "nowrap",
          }}
        >
          {name}
          <span aria-hidden style={{ opacity: 0.7, fontSize: 11 }}>×</span>
        </button>
      ))}

      {/* The summary chip IS the opener, so a second one beside it would be two
          controls doing one thing. */}
      {!(everything || summarised) && (
        <button
          onClick={(e) => { setQuery(""); toggle(e); }}
          aria-expanded={open}
          aria-label={chosen.length === 0 ? `Add a ${noun} for ${label}` : `Add another ${noun} for ${label}`}
          style={{
            font: "500 10.5px/1 Inter", padding: "4px 8px", borderRadius: 20, cursor: "pointer",
            border: `1px dashed ${open ? "var(--brand)" : "var(--line)"}`,
            background: "var(--paper)", color: open ? "var(--brand)" : "var(--ink-faint)",
          }}
        >
          {chosen.length === 0 ? `＋ Add a ${noun}` : "＋"}
        </button>
      )}

      {panelProps && (
        <div
          {...panelProps}
          // `overflow: hidden` so a long list is clipped by the panel's own
          // rounded border rather than spilling past it.
          style={{ ...panelProps.style, width: 236, display: "flex", flexDirection: "column", overflow: "hidden" }}
        >
          <input
            autoFocus
            value={query}
            placeholder={`Search ${plural}…`}
            aria-label={`Search ${plural}`}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter takes the top match, so a two-subject teacher is two
              // keystrokes and a return rather than a hunt down the list.
              if (e.key === "Enter" && ordered[0]) { onToggle(ordered[0].name); setQuery(""); }
              if (e.key === "Escape") close();
            }}
            style={{
              margin: 7, padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 7,
              fontSize: 12, fontFamily: "inherit", background: "var(--offwhite)",
            }}
          />
          {/*
            `minHeight: 0` is load-bearing, not tidiness. A flex item defaults to
            `min-height: auto`, which refuses to shrink below its content — so
            without it a fourteen-class list ignores the panel's `maxHeight`
            entirely and grows down the page instead of scrolling inside it.
          */}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 5px 6px" }}>
            {ordered.length === 0 && (
              <div style={{ padding: "8px 8px 10px", fontSize: 11.5, color: "var(--ink-faint)" }}>
                {all.length === 0 ? `No ${plural} yet — add them on an earlier step.` : `No ${noun} matches that.`}
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
