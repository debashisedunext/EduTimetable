/**
 * §26.2 — where a subject belongs in the day, as one set of controls.
 *
 * Used by the manual Subjects master and by the guided setup's Subjects step,
 * because those are two doors into the same four database columns and a school
 * that meets different words on each has been told something untrue about how
 * the product thinks.
 *
 * The four are not equal, and the layout says so. **Category and priority** are
 * chosen for nearly every subject, so they sit in the row. **The lunch rules**
 * are set by almost nobody — most schools have one or two subjects with a
 * physical reason to care — so they live behind a ⋯ button, with the row
 * showing a summary when they are not at their defaults. Four more columns in a
 * table that already has Code / Lab / Double period would make the common case
 * pay for the rare one.
 */
import { LUNCH_LABEL, type SubjectDefaults } from "@edutimetable/shared";
import { useAnchored } from "../ui/anchored";

export type Placement = SubjectDefaults;

/** Everything a row needs to describe itself, all optional (= not stated). */
export interface PlacementValue {
  category?: Placement["category"];
  priority?: number;
  lunchRule?: Placement["lunchRule"];
  gapAfterLunch?: boolean;
}

const select: React.CSSProperties = {
  width: "100%", padding: "5px 7px", border: "1px solid transparent", borderRadius: 6,
  fontSize: 12, fontFamily: "inherit", background: "transparent", color: "var(--ink)",
};

/**
 * The lunch rules in one short phrase, or null when there is nothing to say.
 *
 * Null rather than "Any time" deliberately: a row that reads "any time, no gap"
 * for every subject is eleven words of noise that make the two rows which DO
 * carry a rule harder to spot, not easier.
 */
export function lunchSummary(v: PlacementValue): string | null {
  const rule = v.lunchRule ?? "any";
  const gap = v.gapAfterLunch ?? false;
  if (rule === "any" && !gap) return null;
  const parts: string[] = [];
  if (rule !== "any") parts.push(rule === "before" ? "before lunch" : "after lunch");
  if (gap) parts.push("not straight after lunch");
  return parts.join(" · ");
}

export function CategorySelect({ value, onChange }: {
  value: Placement["category"];
  onChange: (v: Placement["category"]) => void;
}) {
  return (
    <select
      style={{ ...select, color: value === "co_scholastic" ? "var(--steel)" : "var(--ink)" }}
      value={value}
      aria-label="Category"
      onChange={(e) => onChange(e.target.value as Placement["category"])}
    >
      <option value="scholastic">Scholastic</option>
      <option value="co_scholastic">Co-scholastic</option>
    </select>
  );
}

/**
 * 1–5, shown as a number rather than stars.
 *
 * Stars would imply quality; this is about *when in the day*, and a school
 * setting Games to 1 is not saying Games is bad. The label under it says so in
 * words on both screens.
 */
export function PrioritySelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <select
      style={{ ...select, fontVariantNumeric: "tabular-nums" }}
      value={value}
      aria-label="Priority — higher is earlier in the day"
      title="Higher is placed earlier in the day. A preference, not a rule."
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {[5, 4, 3, 2, 1].map((n) => (
        <option key={n} value={n}>{n}{n === 5 ? " — earliest" : n === 1 ? " — latest" : ""}</option>
      ))}
    </select>
  );
}

/** The two rules almost nobody sets, behind a button that shows when they are. */
export function LunchRules({ value, onChange }: {
  value: PlacementValue;
  onChange: (patch: PlacementValue) => void;
}) {
  const { open, toggle, panelProps } = useAnchored(190);
  const summary = lunchSummary(value);

  return (
    <>
      <button
        onClick={toggle}
        aria-expanded={open}
        aria-label="Lunch placement rules"
        title={summary ?? "Set when in the day this subject may be taught"}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5, maxWidth: "100%",
          font: "500 11px/1.3 Inter", padding: "4px 8px", borderRadius: 7, cursor: "pointer",
          border: `1px solid ${summary ? "var(--brand)" : "var(--line)"}`,
          background: summary ? "var(--steel-pale)" : "var(--paper)",
          color: summary ? "var(--brand)" : "var(--ink-faint)",
        }}
      >
        <span aria-hidden>⋯</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {summary ?? "Any time"}
        </span>
      </button>

      {panelProps && (
        <div {...panelProps} style={{ ...panelProps.style, width: 268, padding: 12 }}>
          <label style={{ display: "block", font: "600 11px/1.4 Inter", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--steel)", marginBottom: 5 }}>
            When in the day
          </label>
          <select
            style={{ ...select, border: "1px solid var(--line)", background: "var(--paper)" }}
            value={value.lunchRule ?? "any"}
            aria-label="Which side of lunch"
            onChange={(e) => onChange({ lunchRule: e.target.value as Placement["lunchRule"] })}
          >
            {(["any", "before", "after"] as const).map((r) => (
              <option key={r} value={r}>{LUNCH_LABEL[r]}</option>
            ))}
          </select>

          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 11, fontSize: 12.5, cursor: "pointer" }}>
            <input
              type="checkbox"
              style={{ marginTop: 2 }}
              checked={value.gapAfterLunch ?? false}
              onChange={(e) => onChange({ gapAfterLunch: e.target.checked })}
            />
            <span>
              Never in the period straight after lunch
              <span style={{ display: "block", color: "var(--ink-faint)", fontSize: 11.5, marginTop: 2 }}>
                For games and dance — children cannot run on a full stomach.
              </span>
            </span>
          </label>

          <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 11, lineHeight: 1.5 }}>
            These are <strong>hard</strong> rules. Readiness refuses to generate a school where they
            cannot all be met, and says which one does not fit.
          </p>
        </div>
      )}
    </>
  );
}
