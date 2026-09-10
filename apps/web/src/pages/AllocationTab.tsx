import { StepAllocation } from "../onboarding/steps/Allocation";

/**
 * §31.10 — the Master Grid's Lesson Grid tab: the Allocation grid itself.
 *
 * ## Embedded, not rebuilt
 *
 * §31.5 said this screen was read-only, and gave the reason: §27 makes the
 * Allocation grid the **one writer** for curriculum and mappings, and a second
 * editor over the same rows is how two answers to "how many periods does 1-A
 * get?" come into existence.
 *
 * That argument is against *re-implementing* an editor, not against reaching
 * the existing one from a second door. `pages/AllocationEntry.tsx` is
 * twenty-three lines — `<GuidedSetup startAt={9} />` — and the grid underneath
 * it takes three props. So this renders the real component, edits the same
 * draft answers, and commits through the same `commitAllocation`. There is
 * still exactly one editor and exactly one commit path; §31.5's read-only
 * claim now covers the four *timetable* tabs, where placement edits still
 * belong on the Board with the rules engine and the §29.1 freeze guard.
 *
 * ## What is deliberately not passed
 *
 * **`onFocusMode`.** It exists so the step can ask the wizard's shell to fold
 * its chrome away; here the vertical tab rail *is* the frame and there is
 * nothing left to fold. The Focus button renders only when the prop is given,
 * so omitting it removes the control without touching `Allocation.tsx` — which
 * is the whole point of embedding rather than forking.
 *
 * ## Height
 *
 * `StepAllocation` is a flex column that scrolls inside itself, so it needs a
 * parent with a definite height rather than the Master Grid's own scrolling
 * pane — nesting one scroller in another gives two scrollbars and a sticky
 * header that sticks to the wrong box (§8.5's `DataTable` trap).
 */
export function AllocationTab({
  answers,
  onChange,
  loading,
  error,
}: {
  /** The guided setup's draft. `any` to match `StepAllocation`'s own signature —
   *  a narrower type here would only be cast away at the call below. */
  answers: Record<string, any> | null;
  onChange: (patch: Record<string, any>) => void;
  loading: boolean;
  error: string | null;
}) {
  const frame: React.CSSProperties = {
    height: "74vh",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  };

  if (loading) {
    return <div style={{ ...frame, padding: 20 }}><p className="screen-sub">Loading the allocation…</p></div>;
  }
  if (error) {
    return (
      <div style={{ ...frame, padding: 20 }}>
        <p className="screen-sub" style={{ color: "var(--signal)" }}>{error}</p>
      </div>
    );
  }
  if (!answers || !Array.isArray(answers.wings) || (answers.wings as unknown[]).length === 0) {
    /*
      §27.12 — `GET /onboarding/session` falls back to answers rebuilt from the
      school, so a school that finished its setup months ago still opens this
      full. Reaching here means the school genuinely has no wings yet, and the
      honest thing is to say which screen makes one rather than draw an empty
      grid that looks broken.
    */
    return (
      <div style={{ ...frame, padding: 20 }}>
        <p className="screen-sub">
          This school has no timetable to allocate yet. Create one on the Timetables screen, or run
          the guided setup.
        </p>
      </div>
    );
  }

  return (
    <div style={frame}>
      <StepAllocation answers={answers} onChange={onChange} />
    </div>
  );
}
