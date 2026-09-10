import { GROUPED_SCOPE, wingScope, type WingAnswer } from "@edutimetable/shared";
import { StepAllocation, type AllocationCellFacts } from "../onboarding/steps/Allocation";

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
  wing,
  individual = false,
  onSelectCell,
  toolbarHost,
}: {
  /** The guided setup's draft. `any` to match `StepAllocation`'s own signature —
   *  a narrower type here would only be cast away at the call below. */
  answers: Record<string, any> | null;
  onChange: (patch: Record<string, any>) => void;
  loading: boolean;
  error: string | null;
  /** The timetable the top bar has selected — this grid must not offer a second choice. */
  wing: string | null;
  /**
   * §30.9 — whether that timetable stands alone in a §30 resource pool.
   *
   * It decides which OTHER wings this grid may see, and that is not cosmetic:
   * `computeLoads` sums a teacher's periods across every wing it is handed, so
   * a teacher taking six periods in the main school and four in an individual
   * timetable was shown at ten against one weekly limit. The two timetables
   * share nothing — not a room, not a class, not that teacher's capacity — so
   * the honest figure in each is its own.
   */
  individual?: boolean;
  onSelectCell: (facts: AllocationCellFacts | null) => void;
  /** §31.10 — the host's toolbar, so this tab does not draw a second one. */
  toolbarHost: HTMLElement | null;
}) {
  /*
    §31.10 — fills what the host leaves, rather than claiming 74vh of its own.

    A fixed height here plus the strip below it overflowed `.content` and put
    the strip off the bottom of the page. The host is a flex column with a real
    height, so `flex: 1` takes exactly what is left after the toolbar and the
    strip — and `minHeight: 0` is what lets it SHRINK to that, since a flex
    item's default `min-height: auto` refuses to go below its content.
  */
  const frame: React.CSSProperties = {
    flex: 1,
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

  /*
    The top bar's timetable and the guided setup's wings are the same thing by
    name (§3.10a: a wing IS a config, created by name on step 3), and
    `answersFromSchool` rebuilds them from the configs — so they normally match.
    When they do not, showing wing 0 while the top bar names another is a lie
    the reader has no way to catch, so this says so instead.
  */
  const names = (answers.wings as Array<{ name: string }>).map((w) => w.name);
  const known = wing !== null
    && names.some((n) => n.trim().toLowerCase() === wing.trim().toLowerCase());
  if (wing !== null && !known) {
    return (
      <div style={{ ...frame, padding: 20 }}>
        <p className="screen-sub">
          <strong>{wing}</strong> is not part of the guided setup&rsquo;s plan yet, so there is
          nothing to allocate for it here. Open the guided setup to add it, or pick another
          timetable above.
        </p>
      </div>
    );
  }

  /*
    §30.9 — the wings this timetable competes with, and no others.

    Narrowed here rather than inside `StepAllocation`, for the reason the
    guided setup narrows in one place too: `wings` is read by
    `suggestCurriculum`, `suggestMappings`, `computeLoads` and `coverageGaps`,
    and a filter at each of them is four chances to forget one.

    A draft written before §30.9 has no `individual` flag on any wing, which
    reads as grouped — which is what every wing was.
  */
  const want = individual && wing ? wingScope({ name: wing, individual: true }) : GROUPED_SCOPE;
  const scoped = {
    ...answers,
    wings: (answers.wings as WingAnswer[]).filter((w) => wingScope(w) === want),
  };

  return (
    <div style={frame}>
      {/*
        §31.10 — `compact`, which is the one visual difference from
        `/allocation`: percentage columns instead of content-sized ones, and
        the room out of the cell. Twenty subjects then fit without a
        horizontal scrollbar, which was the whole point of putting the grid
        here rather than linking to it.
      */}
      <StepAllocation
        answers={scoped}
        onChange={onChange}
        density="compact"
        wing={wing}
        onSelectCell={onSelectCell}
        toolbarHost={toolbarHost}
      />
    </div>
  );
}
