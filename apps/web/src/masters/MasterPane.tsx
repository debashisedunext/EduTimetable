/**
 * §8.5 — the shape every master screen now has: the list, and the form beside it.
 *
 * Reported as *"for every edit I have to scroll down"*, which is exactly what a
 * table with its form underneath does once the table is as long as a real
 * school's. Pressing Edit scrolled the form into view and the row out of it, so
 * while you typed you could no longer see the thing you were editing.
 *
 * §8.1c had already met this and drawn the right conclusion for the manual
 * Curriculum step — *"at 14 classes × 8 subjects a form below the table means
 * pressing Edit scrolls the row off the screen"* — and then edited in the row,
 * which works when a row has three fields. A subject has eight, so in-row is
 * not available here: the answer is the other half of the same idea, which is
 * to put the form where scrolling cannot take it away.
 *
 * **One component, not four.** The four masters had four copies of the same
 * table-then-form arrangement, which is why the fix had to be made four times
 * and why it will not drift now that it is made once.
 *
 * The form pane is a fixed 340px and the list takes the rest, rather than a
 * percentage split: a form's width is set by its widest control and does not
 * get better with more room, while a table with six columns always does.
 */
import type { ReactNode } from "react";

export function MasterPane({ title, sub, actions, list, formTitle, formSub, form }: {
  title: string;
  sub?: string;
  /** Anything that belongs to the LIST — a filter, a count, a link. */
  actions?: ReactNode;
  list: ReactNode;
  /** Says what the form is about to do, which is the thing Edit used to say by
   *  scrolling: "Editing Class 5-A" versus "Add a class-section". */
  formTitle: string;
  formSub?: string;
  form: ReactNode;
}) {
  return (
    <div className="master-split">
      <section className="master-col">
        <header style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{title}</h2>
            {sub && <p>{sub}</p>}
          </div>
          {actions}
        </header>
        <div className="master-scroll">{list}</div>
      </section>

      <aside className="master-col">
        {/*
          The form's heading is the state indicator. Before this, "am I adding
          or editing?" was answered only by the label on a button that was
          usually below the fold — which is how somebody ends up renaming a
          class they meant to create.
        */}
        <header>
          <h2>{formTitle}</h2>
          {formSub && <p>{formSub}</p>}
        </header>
        <div className="master-scroll">{form}</div>
      </aside>
    </div>
  );
}

/** A stacked field pair for the 340px form column. */
export function PaneField({ label, hint, children }: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 11 }}>
      <label style={{
        display: "block", fontSize: 11.5, fontWeight: 600, color: "var(--ink-soft)", marginBottom: 4,
      }}>
        {label}
      </label>
      {children}
      {hint && (
        <p style={{ fontSize: 10.5, color: "var(--ink-faint)", marginTop: 3, lineHeight: 1.45 }}>{hint}</p>
      )}
    </div>
  );
}

/**
 * Save and Cancel, at the bottom of the form column.
 *
 * Not sticky: the form pane is short enough to fit in every master here, and a
 * sticky footer inside a 340px column costs more height than it saves. If one
 * ever outgrows the pane its own scrollbar carries the buttons, which is the
 * ordinary behaviour and not a surprise.
 */
export function PaneActions({ editing, disabled, onSave, onCancel, saveLabel, addLabel }: {
  editing: boolean;
  disabled?: boolean;
  onSave: () => void;
  onCancel: () => void;
  saveLabel?: string;
  addLabel?: string;
}) {
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
      <button className="btn btn-primary" style={{ fontSize: 12.5, flex: 1 }} disabled={disabled} onClick={onSave}>
        {editing ? (saveLabel ?? "✓ Save changes") : (addLabel ?? "＋ Add")}
      </button>
      {editing && (
        <button className="btn" style={{ fontSize: 12.5, border: "1px solid var(--line)" }} onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}
