import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  blockSections, buildCoverage, cellEvents, initialsOf, pivotCellKey, pivotSlots,
  rowWindow, scrollTopFor, SLOT,
  type GridPivot, type RowWindow, type SlotTuple,
} from "@edutimetable/shared";
import { api } from "../api";
import { useApi, useConfigCtx } from "../hooks";
import { guardUnsaved } from "../unsaved-guard";
import { commitAllocation } from "../onboarding/commit-allocation";
import { AllocationTab } from "./AllocationTab";
import type { AllocationCellFacts } from "../onboarding/steps/Allocation";
import { useColors } from "../colors-context";

/**
 * §31 Phase 44 — the Master Grid.
 *
 * The whole school's week on one screen, pivoted five ways, with no horizontal
 * scroll. Stage 1: the grid. The strip that explains a clicked cell is stage 2.
 *
 * ## The one number that decides the whole design
 *
 * Five working days × eleven periods is **55 columns**. On a 1,920px screen,
 * less the nav and the page inset, the grid gets about 1,600px; less a row
 * header, that is **27 pixels a column**. Twenty-seven pixels holds two or
 * three characters — which is why the cells here carry initials and short
 * codes rather than names, and why §10.5's colour is doing half the work: a
 * cell that shows three characters and a hue is showing two facts, not one.
 *
 * Everything else follows from that number. The tab rail is **vertical**
 * because horizontal tabs would cost a row of school and vertical ones cost
 * 34px of width the row header wanted anyway. Breaks get a hairline column
 * because they carry no cell and the real periods want their width back.
 *
 * ## Why this is not the Allocation Matrix with more dropdowns
 *
 * They read the same payload and answer different questions. The Matrix has
 * wide cells that name the subject *and* the teacher, and it is where somebody
 * reads one class's week. This has narrow cells and shows the *shape* of the
 * whole school's week at once. Adding pivots to the Matrix and calling it done
 * would have made its cells too small for what it is for.
 *
 * ## Read-only, deliberately
 *
 * The reference product edits from this screen — a period count, a teacher
 * dropdown. §27 makes the Allocation grid the **one writer** for curriculum and
 * mappings, and a second editor over the same rows is how two answers to "how
 * many periods does 1-A get?" come into existence. Placement edits belong on
 * the Board, where the rules engine, the legality highlighting and the §29.1
 * freeze guard live — and a 27px cell is the worst drag target in the app.
 */

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** §22 — a named draft, as the picker needs it. */
interface DraftRow {
  id: number;
  draftNo: number;
  label: string | null;
  status: "draft" | "published" | "archived" | "discarded";
  generationPct: number | null;
}

interface SlotsPayload {
  status: string;
  draftId: number | null;
  workingDays: number[];
  periods: {
    periodNumber: number | null; startTime: string; endTime?: string;
    isBreak: boolean; breakName: string | null; isExtra?: boolean;
    isActivity?: boolean; activityTeacher?: string | null; activityRoom?: string | null;
  }[];
  sections: { id: number; label: string }[];
  subjects: Record<string, string>;
  teachers: Record<string, string>;
  /** §31 — the same people at 27px. Absent on a payload cached before Phase 44. */
  teacherInitials?: Record<string, string>;
  rooms: Record<string, string>;
  blocks: Record<string, { name: string; options: { subject: string; teacher: string; room: string }[] }>;
  /** [classSectionId, day, period, subjectId, teacherId, roomId, mergedGroupId, locked, substituted, electiveBlockId] */
  slots: Array<Array<number | null>>;
}

/**
 * §31 — everything the grid needs that a **placement** does not carry.
 *
 * `/slots` says where the lessons ended up; this says what the school intended
 * and who the rows are. The Lesson grid tab is this payload rendered directly;
 * the strip reads the rest of it. One request rather than four, because a
 * strip that fetched on click would make clicking expensive — and clicking
 * idly is how this screen is meant to be used.
 */
interface ContextPayload {
  sections: { id: number; classId: number; label: string; homeRoom: string | null; classTeacher: string | null }[];
  subjects: { id: number; name: string }[];
  /** [classId, subjectId, periodsPerWeek] */
  cells: Array<[number, number, number]>;
  weekCapacity: number;
  /** §28.1/§29.3 — the cap, and what this person carries in the pool's OTHER timetables. */
  teachers: Record<string, { cap: number; elsewhere: number; elsewhereIn: string[] }>;
}

/** §31.10 — the Readiness Dashboard's own answer, as the strip's tail needs it. */
interface ReadinessIssue {
  code: string;
  severity: "blocker" | "warning";
  message: string;
  fix?: string;
  entity?: { type: string; id: number; label: string };
}
interface ReadinessPayload {
  score: number;
  ready: boolean;
  blockers: ReadinessIssue[];
  warnings: ReadinessIssue[];
  stats: {
    classSections: number;
    teachers: number;
    totalRequiredSlots: number;
    totalAvailableSlots: number;
  };
}

/**
 * What the strip is pointed at.
 *
 * Two kinds, because the tabs ask different questions. On the four timetable
 * tabs a selection is a **cell** — a row entity at a day and period. On the
 * Lesson grid it is a **lesson** — a class-section and a subject, with no time
 * in it at all. One strip, two vocabularies (§31.4).
 */
type Selection =
  | { kind: "cell"; rowKey: number; day: number; period: number }
  /**
   * §31.10 — the Lesson Grid tab's selection carries the FACTS, not ids.
   *
   * The grid there edits draft answers, and the facts are read from its own
   * model. Storing ids and looking them up here would mean re-deriving merged
   * groups and class teachers from the same draft — a second derivation, free
   * to disagree with the grid the strip sits under, and certain to disagree the
   * moment somebody edits without saving.
   */
  | { kind: "lesson"; facts: AllocationCellFacts };

/**
 * One block of the strip: a label, an optional big line, and detail under it.
 *
 * Deliberately a small shape rather than a field per fact. The two vocabularies
 * have almost nothing in common — a timetable cell has a clock and a teacher's
 * load, a lesson-grid cell has every section sharing the lesson — and a union
 * type carrying both would leave every renderer asking which half it had.
 */
interface StripGroup {
  label: string;
  primary?: string;
  swatch?: { bg: string; fg: string } | null;
  lines?: string[];
  chips?: Array<{ text: string; swatch?: { bg: string; fg: string } | null; title?: string }>;
}

/**
 * The five tabs.
 *
 * Four of them are `GridPivot`s — one entity against day-and-period, differing
 * only in which field of the tuple names the row, which is why the grouping
 * lives once in `packages/shared` rather than four times here. `lesson` is the
 * odd one out and reads a different endpoint entirely.
 */
type Tab = GridPivot | "lesson";

/*
  §31.10 — the Lesson grid leads.

  It is the only editable tab and the one somebody opens to DO something; the
  other four report on what it produced. The tab that changes the school comes
  before the tabs that describe it.

  The screen still OPENS on Whole. First in a list and selected by default are
  different claims, and landing straight in an editor is not what somebody who
  came to look at the week asked for.
*/
const TABS: Array<{ key: Tab; label: string; hint: string }> = [
  { key: "lesson", label: "Lesson grid", hint: "Class-sections × subjects — periods per week, editable" },
  { key: "section", label: "Whole", hint: "Every class-section's week — the complete timetable" },
  { key: "teacher", label: "Teachers", hint: "Every teacher's week, one row each" },
  { key: "room", label: "Classrooms", hint: "Which class is in each room, period by period" },
  { key: "subject", label: "Subjects", hint: "When each subject is taught, and by whom" },
];

/** What one cell draws: three characters, a colour, and the two markers that
 *  survive at this width as borders rather than as glyphs. */
interface CellFace {
  text: string;
  swatch: { bg: string; fg: string } | null;
  title: string;
  locked: boolean;
  substituted: boolean;
}

/** "Mathematics" → "Mat"; "Social Science" → "SS"; "ICT" → "ICT". */
const abbr = (name: string) => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].length <= 4 ? words[0] : words[0].slice(0, 3);
  return words.map((w) => w[0]).join("").slice(0, 3).toUpperCase();
};

/**
 * "Class 5-A" → "5-A"; "Pre-Nursery-A" → "Pre-A".
 *
 * Split on the LAST hyphen, because class names contain them — the same trap
 * `classOfLabel` documents in §10.5.
 */
const shortSection = (label: string) => {
  const cut = label.lastIndexOf("-");
  const cls = (cut > 0 ? label.slice(0, cut) : label).replace(/^class\s+/i, "").trim();
  const sec = cut > 0 ? label.slice(cut + 1).trim() : "";
  const head = cls.length <= 3 ? cls : cls.slice(0, 3);
  return sec ? `${head}-${sec}` : head;
};

/**
 * §31.8 — the two sticky header rows, which sit INSIDE the scrolling pane and
 * therefore cover its first rows.
 *
 * 24 + 24. Not a new guess: the second header row's `top: 24` is already
 * committed to the first one being 24 tall, so this is that same number read
 * once more rather than a second opinion about it.
 */
const HEADER_H = 48;

/**
 * A first guess at a row's height, used for exactly one frame.
 *
 * Not a second opinion about the CSS — the measurement below always wins, and
 * a wrong guess costs one corrected frame. What it buys is that the FIRST
 * paint is already windowed: starting from "unmeasured" would draw the whole
 * 6,832-cell grid once and then shrink it, which is the frame this stage
 * exists to remove.
 */
const FALLBACK_ROW_H = 23;

/**
 * §31.8 — the scroll state the window arithmetic needs, and nothing else.
 *
 * Deliberately does NOT compute the window: the row count comes from the
 * filtered list, which is not known until well past the component's early
 * returns, and a hook cannot be called there. State here, arithmetic where the
 * total exists.
 *
 * `rowHeight` is **measured from a rendered row**, and the measurement always
 * wins. §10.6's rule: when a layout's correctness depends on two independently
 * computed heights agreeing, pick the structure where only one height exists —
 * and here the spacers must reserve exactly what the undrawn rows would have
 * occupied, or the scrollbar lies. It starts at `FALLBACK_ROW_H` rather than at
 * zero purely so the FIRST paint is already windowed; see the note there.
 */
function useRowViewport(pane: HTMLDivElement | null, layoutKey: unknown) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [rowHeight, setRowHeight] = useState(FALLBACK_ROW_H);
  /*
    Which layout the stored height was measured in.

    The ref callback below is attached to whichever row is drawn first, and
    that row CHANGES as the window slides — so React detaches and reattaches
    the ref on every scroll frame. Reading `offsetHeight` there would force a
    synchronous layout on every one of them, which is most of the cost this
    whole stage exists to remove. The epoch makes it measure once per layout
    instead: the observer below bumps it when the pane resizes, and only then
    does the next attach take a reading.
  */
  const epoch = useRef(0);
  const measuredAt = useRef(-1);

  /*
    The two tables have the same row height today, and this is what stops that
    being an assumption. Switching tab swaps one table for another; re-measuring
    then costs one `offsetHeight` and removes the coupling entirely.
  */
  useLayoutEffect(() => {
    epoch.current += 1;
  }, [layoutKey]);

  /*
    The NODE, not a ref object — and this was a real bug, not a tidy-up.

    With `[paneRef]` as the dependency the effect ran exactly once, on mount,
    and a plain ref never changes identity so it never ran again. On mount this
    component has no pane: it early-returns "Loading the grid…" until `/slots`
    arrives, so the div appears on a LATER render. The observer was therefore
    never attached, `viewportHeight` stayed 0 for the life of the screen, and
    `rowWindow` drew `ceil(0 / rowHeight) + 1 + overscan` rows — **seven of
    fifty-six**, on every tab that uses this pane. A callback ref makes the node
    a state value, so the effect runs when it actually exists and again whenever
    a tab switch remounts it.

    `useLayoutEffect`, not `useEffect` — §8.1d's lesson, for the same reason it
    was learned there. A passive effect runs after paint, so the first frame
    would be computed for a viewport of zero: seven rows, then thirty-six a
    frame later, which reads as the grid filling itself in on every visit.
  */
  useLayoutEffect(() => {
    if (!pane) return;
    const el = pane;
    const measure = () => {
      setViewportHeight(el.clientHeight);
      // A resize can change a row's height — a narrower pane wraps a long
      // teacher name — so the stored height stops being trusted.
      epoch.current += 1;
    };
    measure();
    // The pane is `74vh`, so it changes with the window and with the browser's
    // own chrome appearing. A one-off measurement would be wrong for the rest
    // of the visit.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pane]);

  return {
    scrollTop,
    viewportHeight,
    rowHeight,
    onScroll: () => setScrollTop(pane?.scrollTop ?? 0),
    /** Ref callback for the first drawn row — the one height there is. */
    measureRow: (el: HTMLTableRowElement | null) => {
      if (!el || measuredAt.current === epoch.current) return;
      const h = el.offsetHeight;
      if (h <= 0) return;
      measuredAt.current = epoch.current;
      if (h !== rowHeight) setRowHeight(h);
    },
  };
}

/**
 * The spacer standing in for rows that were not drawn.
 *
 * One `<td>` spanning the table rather than a bare `<tr>`: an empty row has no
 * cells to give it height, and browsers collapse it — which puts the scrollbar
 * back to the height of only the drawn rows.
 */
function Spacer({ height, span }: { height: number; span: number }) {
  if (height <= 0) return null;
  return (
    <tr aria-hidden>
      <td colSpan={span} style={{ height, padding: 0, border: 0 }} />
    </tr>
  );
}

/** An index that stays inside the list, or null when it would not — which is
 *  what makes an arrow key at the edge do nothing instead of wrapping. */
const clamp = (i: number, len: number): number | null =>
  len === 0 || i < 0 || i >= len ? null : i;

export function MasterGrid() {
  const { current } = useConfigCtx();
  const colors = useColors();
  const [tab, setTab] = useState<Tab>("section");
  const [status, setStatus] = useState<"draft" | "published">("draft");
  const [draftId, setDraftId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  // §31.6 — what the strip is explaining. Cleared when the tab changes, since
  // a cell selected on the Teachers tab names a row the Subjects tab does not
  // have; keeping it would leave the strip describing something invisible.
  const [selected, setSelected] = useState<Selection | null>(null);
  /** The scrolling pane, as a state value — see `useRowViewport`. */
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null);
  // §31.8 — scroll state for the windowed body. A hook, so it sits with the
  // other hooks and above every early return; the window itself is computed
  // further down, where the filtered row count exists.
  const view = useRowViewport(paneEl, tab);

  /*
    §31.10 — the Allocation grid's draft, held HERE rather than in the tab.

    That is what makes moving between the five tabs free: the tab unmounts, the
    work does not. Only leaving the screen is guarded. It is fetched lazily —
    four of the five tabs never need it, and `GET /onboarding/session` on every
    visit would be a request nobody reads (§14).
  */
  const [alloc, setAlloc] = useState<Record<string, any> | null>(null);
  const [allocLoading, setAllocLoading] = useState(false);
  const [allocError, setAllocError] = useState<string | null>(null);
  const [edits, setEdits] = useState(0);
  const [saving, setSaving] = useState(false);
  /**
   * §31.10 — where the Allocation grid's own controls are drawn.
   *
   * State rather than a ref: the grid portals into this node, and a portal
   * needs a render to happen once the node exists. A ref would be populated
   * after the render that could have used it, so the controls would appear one
   * interaction late.
   */
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  /** Which draft keys are owed to the server. A ref, so a fast second edit in
   *  the same tick does not send yesterday's set — the wizard's own reasoning. */
  const allocTouched = useRef<Set<string>>(new Set());
  /**
   * Where the guided setup was when we found it.
   *
   * Sent back on save so a side edit here never MOVES anybody's setup. Omitting
   * it entirely looked right — the server keeps the stored step when it is
   * resuming — but for a school whose setup is finished the row is not
   * "resuming", and the step would silently reset to 1: the next resume would
   * open at Academic Year instead of where they left off.
   */
  const allocStep = useRef<number | null>(null);

  useEffect(() => {
    if (tab !== "lesson" || alloc !== null || allocLoading) return;
    setAllocLoading(true);
    api<{ empty?: boolean; prefilled?: boolean; currentStep?: number; answers?: Record<string, any> }>("/onboarding/session")
      .then((d) => {
        setAlloc(d.answers ?? {});
        allocTouched.current.clear();
        allocStep.current = typeof d.currentStep === "number" ? d.currentStep : null;
        /*
          §27.12 — a draft rebuilt from the school is NOT saved yet, so every
          key is owed. Without this the first Save commits from a stored draft
          that does not have them and reports "there is nothing to create yet"
          while the grid on screen is full.
        */
        if (d.empty && d.prefilled && d.answers) {
          for (const k of Object.keys(d.answers)) allocTouched.current.add(k);
        }
        setAllocError(null);
      })
      .catch((e) => setAllocError(e instanceof Error ? e.message : String(e)))
      .finally(() => setAllocLoading(false));
  }, [tab, alloc, allocLoading]);

  const patchAlloc = (p: Record<string, any>) => {
    for (const k of Object.keys(p)) allocTouched.current.add(k);
    setAlloc((a) => ({ ...(a ?? {}), ...p }));
    setEdits((n) => n + 1);
    setSaved(null);
  };

  const dirty = edits > 0;

  /*
    §31.10 — leaving the screen with unsaved work says so; changing tab does
    not. `guardUnsaved` rather than a router blocker: `main.tsx` mounts a plain
    `<BrowserRouter>`, and `useBlocker` needs a data router.
  */
  useEffect(() => {
    if (!dirty) return;
    const release = guardUnsaved(() =>
      window.confirm(`${edits} unsaved change${edits === 1 ? "" : "s"} to the allocation. Leave and lose them?`),
    );
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", onUnload);
    return () => { release(); window.removeEventListener("beforeunload", onUnload); };
  }, [dirty, edits]);

  const saveAlloc = async () => {
    if (!alloc || saving) return;
    setSaving(true);
    setAllocError(null);
    try {
      /*
        The answers go up FIRST, and only the touched keys. The server commits
        from the STORED draft, so an answer still in the browser is one the
        commit cannot see — `commitAllocation` documents that precondition and
        this is where it is met.

        `currentStep` is the one the draft already had, never step 9: editing a
        cell here must not move somebody's guided setup to a step they were not
        on.
      */
      const keys = [...allocTouched.current];
      const delta: Record<string, any> = {};
      for (const k of keys) delta[k] = alloc[k];
      await api("/onboarding/session", {
        method: "PUT",
        body: JSON.stringify({
          answers: delta,
          mode: "wizard",
          ...(allocStep.current !== null ? { currentStep: allocStep.current } : {}),
        }),
      });
      allocTouched.current.clear();
      await commitAllocation(alloc);
      setEdits(0);
      setSaved("Saved");
      // The other four tabs read the curriculum this just wrote, and the
      // server sweeps its cache on the commit — so refetch rather than leave
      // them describing the school as it was a moment ago.
      refetchContext();
      // The score, the totals and the issue list are all downstream of what was
      // just written — a summary still describing the school as it was before
      // the save is the one thing worse than no summary.
      refetchReadiness();
    } catch (e) {
      setAllocError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const { data: drafts } = useApi<DraftRow[]>(
    current ? `/timetable-configs/${current.id}/drafts` : null,
  );
  const { data } = useApi<SlotsPayload>(
    current
      ? `/timetable-configs/${current.id}/slots?status=${status}` +
        `${status === "draft" && draftId !== null ? `&draftId=${draftId}` : ""}`
      : null,
  );
  // Fetched on every tab, not only the Lesson grid: since §31.6 the strip
  // reads the class's curriculum, its home room, its class teacher and the
  // teacher's cap out of it, and those are wanted on all five.
  const { data: context, refetch: refetchContext } = useApi<ContextPayload>(
    current ? `/timetable-configs/${current.id}/context` : null,
  );
  /**
   * §31.10 — the four figures at the end of the strip.
   *
   * `timetable.generate`, not `timetable.view.all` like the rest of this
   * screen, so somebody who may only READ the week gets a 403 here. That is
   * not an error to show: the summary simply does not appear, and the strip is
   * exactly what it was. `useApi` hands back `null` data with the message, so
   * every read below is already guarded.
   */
  const { data: readiness, refetch: refetchReadiness } = useApi<ReadinessPayload>(
    current ? `/timetable-configs/${current.id}/readiness` : null,
  );
  const [showIssues, setShowIssues] = useState(false);

  /*
    A selection names a row of the tab it was made on, so it cannot survive a
    change of tab: cell 44 on Teachers is a different person from cell 44 on
    Classrooms, and the strip would go on describing something no longer on
    screen. Same for a change of draft or status — the week underneath it is a
    different week.
  */
  useEffect(() => setSelected(null), [tab, status, draftId]);
  /*
    ...and put the pane back to the top. Switching from 122 teachers scrolled
    to the bottom to 20 subjects would otherwise leave the reader past the end
    of the new list — the browser clamps the DOM scroll, but our copy of it
    would stay stale until the next scroll event, so the window would be
    computed for a position nothing is at.
  */
  useEffect(() => {
    if (paneEl) paneEl.scrollTop = 0;
  }, [tab, status, draftId, search, paneEl]);

  // One pass over the tuples, grouped by whichever field names the row for
  // this tab. The grouping itself is `pivotSlots` in `packages/shared`, where
  // it is unit-tested against every §4.9 and §4.10 shape — see the note there
  // about why it is one function and not four.
  const grid = useMemo(
    () => (!data || tab === "lesson" ? null : pivotSlots(data.slots, tab)),
    [data, tab],
  );

  if (!current) return <p className="screen-sub">Select a timetable first.</p>;
  if (!data) return <p className="screen-sub">Loading the grid…</p>;

  const liveDrafts = (drafts ?? []).filter((d) => d.status !== "discarded");
  const shownDraftId = draftId ?? data.draftId ?? null;
  const shownDraft = liveDrafts.find((d) => d.id === shownDraftId) ?? null;

  const teacherName = (id: number | null | undefined) =>
    id === null || id === undefined ? null : (data.teachers[String(id)] ?? null);
  /** The school's own initials, or derived — one function, so a payload cached
   *  before this field existed still agrees with a fresh one. */
  const teacherShort = (id: number | null | undefined) => {
    if (id === null || id === undefined) return null;
    const key = String(id);
    return initialsOf(data.teachers[key], data.teacherInitials?.[key]);
  };
  const sectionLabel = (id: number | null | undefined) =>
    id === null || id === undefined ? null : (data.sections.find((s) => s.id === id)?.label ?? null);

  /**
   * What one event looks like in this tab's cell.
   *
   * Colour the thing the cell is *about* (§10.5): in a class-section's row the
   * cell is about the subject, and in a teacher's, a room's or a subject's row
   * it is about the class — keyed on the class, so 5-A/5-B/5-C read as one
   * family rather than spending three palette slots saying one thing.
   *
   * **No emoji markers in the text**, unlike the Matrix. A 🔗 or a 🔒 is about
   * eleven pixels of a twenty-seven pixel cell, and spending 40% of the width
   * on a marker leaves no room for the fact the cell exists to carry. They move
   * to the border and the tooltip; a substitution keeps its cyan, because that
   * is an existing meaning and existing meanings outrank colour (§10.5).
   */
  const describe = (event: SlotTuple[]): CellFace => {
    const s = event[0];
    const [csId, day, period, subjectId, teacherId, roomId, , locked, substituted, blockId] = s;
    const block = blockId !== null && blockId !== undefined ? data.blocks?.[String(blockId)] : undefined;
    const subject = subjectId !== null && subjectId !== undefined ? data.subjects[String(subjectId)] : null;
    const room = roomId !== null && roomId !== undefined ? data.rooms[String(roomId)] : null;
    const cls = sectionLabel(csId);
    // Every section attending, for a §4.10 group. One name for an ordinary
    // lesson, which is the same code path saying the same thing.
    const attending = event.map((e) => sectionLabel(e[SLOT.classSectionId])).filter(Boolean) as string[];
    const face = {
      locked: locked === 1,
      substituted: substituted === 1,
      title: [
        `${DAY_NAMES[day as number]} · P${period}`,
        attending.length > 1 ? attending.join(", ") : cls,
        // A §4.9 member row has no subject of its own — the block's name is
        // what is true of it, and "—" would read as a gap in a full week.
        block && !subject ? `${block.name} (elective)` : subject,
        teacherName(teacherId),
        room,
        attending.length > 1 ? `Taught together as one lesson (§4.10)` : null,
        block && subject ? `Option in ${block.name}` : null,
        locked === 1 ? "Pinned" : null,
      ].filter(Boolean).join(" · "),
    };

    if (tab === "section") {
      // §10.5 — a block in a CLASS row is several subjects at once and belongs
      // to none of them, so it keeps the steel tint rather than borrowing one
      // option's colour.
      if (block && !subject) return { ...face, text: abbr(block.name), swatch: null };
      return { ...face, text: abbr(subject ?? "?"), swatch: colors.subject(subject) };
    }
    if (tab === "teacher" || tab === "room") {
      // A §4.9 option row belongs to no single section — this person is taking
      // French while two colleagues take Sanskrit next door — so the honest
      // label is the subject, in that subject's own colour (§10.5).
      if (cls === null) return { ...face, text: abbr(subject ?? block?.name ?? "?"), swatch: colors.subject(subject) };
      // "5×4" — Class 5, four sections at once. Three characters for what a
      // list of four labels could never fit, and the tooltip names them all.
      const text = attending.length > 1
        ? `${shortSection(cls).split("-")[0]}\u00d7${attending.length}`
        : shortSection(cls);
      return { ...face, text, swatch: colors.classOf(cls) };
    }
    // Subjects: the row IS the subject, so colouring by it would paint every
    // row one flat colour. The cell answers "who is teaching it, and to whom".
    return { ...face, text: teacherShort(teacherId) ?? "\u00b7", swatch: colors.classOf(cls) };
  };

  /**
   * §31.8 — the arrowed-to row may not be in the DOM at all.
   *
   * The keys move the selection through the DATA; windowing means the row they
   * land on can be outside the drawn slice. Without this, ArrowDown past the
   * bottom of the screen selects a row nobody can see and the grid looks frozen
   * while the strip changes underneath it.
   */
  const bringRowIntoView = (index: number) => {
    const want = scrollTopFor(index, {
      rowHeight: view.rowHeight,
      scrollTop: view.scrollTop,
      viewportHeight: view.viewportHeight,
      headerHeight: HEADER_H,
    });
    if (want !== null && paneEl) paneEl.scrollTop = want;
  };

  /**
   * §31.6 — arrow keys move the selection.
   *
   * The strip explains one cell, and the useful reading is across a row: this
   * teacher's Monday, then their Tuesday. Reaching for the mouse fifty-five
   * times to do that is not reading, so the keys move the selection and the
   * strip follows.
   *
   * Left and right skip **breaks and activity bands**, because those columns
   * hold no cell — landing on one would blank the strip for a column nobody
   * can select by clicking either.
   */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (!keys.includes(e.key) || !selected) return;
    e.preventDefault();
    const dRow = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    const dCol = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;

    /*
      §31.10 — the Lesson Grid tab does its own keyboard navigation, inside the
      Allocation grid, and that pane is not even rendered here. Reaching this
      with a lesson selection would mean two handlers moving one cursor.
    */
    if (selected.kind === "lesson") return;

    // The selectable columns, flattened across the week in the order they are
    // drawn — so ArrowRight at Friday's last period simply stops, rather than
    // wrapping to Monday, which would read as the grid jumping.
    const selectable = days.flatMap((d) =>
      columns.filter((p) => !p.isBreak && !p.isActivity && p.periodNumber !== null)
        .map((p) => ({ day: d, period: p.periodNumber as number })),
    );
    const rowAt = visibleRows.findIndex((r) => r.key === selected.rowKey);
    const colAt = selectable.findIndex((c) => c.day === selected.day && c.period === selected.period);
    const nextRow = clamp(rowAt + dRow, visibleRows.length);
    const nextCol = clamp(colAt + dCol, selectable.length);
    if (nextRow === null || nextCol === null) return;
    setSelected({
      kind: "cell",
      rowKey: visibleRows[nextRow].key,
      day: selectable[nextCol].day,
      period: selectable[nextCol].period,
    });
    bringRowIntoView(nextRow);
  };


  /**
   * §31.6 — the sentence under the grid.
   *
   * Four groups widening outwards from the cell to its context: what the cell
   * is, whose class, whose lesson, and what else that class studies. Nothing
   * here costs a request — every fact is already in `/slots` or `/context`,
   * which is what makes clicking cheap enough to do idly.
   *
   * A **strip and not a popover**, deliberately. A popover over a 27px cell
   * covers the neighbours you are comparing it with, and comparing is almost
   * always why the cell was clicked — the same argument §8.5 made for putting
   * a master's form beside its list rather than below it.
   */
  const stripForCell = (sel: Extract<Selection, { kind: "cell" }>): StripGroup[] | null => {
    const entries = grid?.get(pivotCellKey(sel.rowKey, sel.day, sel.period)) ?? [];
    const period = data.periods.find((p) => p.periodNumber === sel.period);
    const when = `${DAY_NAMES[sel.day]} · P${sel.period}`
      + (period ? ` · ${period.startTime}–${period.endTime ?? ""}` : "");
    const rowName = rows.find((r) => r.key === sel.rowKey)?.label ?? "";

    if (entries.length === 0) {
      // A free period is a fact too, and the strip is the only place with room
      // to say whose it is.
      return [{ label: "The cell", primary: "Free", lines: [when, rowName] }];
    }

    const events = cellEvents(entries, tab as GridPivot);
    // Several events in one cell — a subject taught to sixteen sections at once
    // — cannot be described as one lesson, so the strip lists them instead of
    // choosing. This is the case the grid draws as a bare count, and the whole
    // reason the count needs somewhere to expand.
    if (events.length > 1) {
      return [
        { label: "The cell", primary: `${events.length} lessons`, lines: [when, rowName] },
        {
          label: "Running at once",
          chips: events.map((e) => {
            const [csId, , , subjectId, teacherId, roomId] = e[0];
            const cls = sectionLabel(csId);
            const subject = subjectId !== null ? data.subjects[String(subjectId)] : null;
            return {
              text: `${cls ? shortSection(cls) : (subject ?? "?")} ${teacherShort(teacherId) ?? ""}`.trim(),
              swatch: colors.classOf(cls),
              title: [cls, subject, teacherName(teacherId), roomId !== null ? data.rooms[String(roomId)] : null]
                .filter(Boolean).join(" · "),
            };
          }),
        },
      ];
    }

    const event = events[0];
    const [csId, , , subjectId, teacherId, roomId, , locked, substituted, blockId] = event[0];
    const block = blockId !== null && blockId !== undefined ? data.blocks?.[String(blockId)] : undefined;
    const subject = subjectId !== null && subjectId !== undefined ? data.subjects[String(subjectId)] : null;
    const room = roomId !== null && roomId !== undefined ? data.rooms[String(roomId)] : null;
    // Every section in the cell: a §4.10 group's members, or the one section.
    const attending = event.map((e) => sectionLabel(e[SLOT.classSectionId])).filter(Boolean) as string[];
    const groups: StripGroup[] = [];

    // §31.7 — how this class is doing for this subject, said only when it is
    // not doing fine. The class-section is the one in the cell; for a §4.9
    // option row (no section of its own) it is the block's first member.
    const coverageSectionId = csId ?? blockSections(data.slots, blockId ?? -1)[0] ?? null;
    const coverageLine = (() => {
      if (coverageSectionId === null || subjectId === null || subjectId === undefined) return "";
      const owed = context?.cells.find(
        ([c, sid]) => c === context.sections.find((x) => x.id === coverageSectionId)?.classId && sid === subjectId,
      )?.[2] ?? 0;
      if (owed === 0 || !coverage.comparable(coverageSectionId, subjectId)) return "";
      const got = coverage.placedAt(coverageSectionId, subjectId);
      return got === owed ? "" : `${got} of ${owed} placed this week`;
    })();

    groups.push({
      label: "The cell",
      primary: subject ?? block?.name ?? "Lesson",
      swatch: subject ? colors.subject(subject) : null,
      lines: [
        when,
        [room, locked === 1 ? "pinned" : null, substituted === 1 ? "substitute" : null]
          .filter(Boolean).join(" · "),
        coverageLine,
      ].filter(Boolean),
    });

    /*
      The class. A §4.9 option row belongs to no class-section at all
      (invariant 9), so the honest answer is the block's members — otherwise
      the group would read "—" for a lesson forty children are sitting in.
    */
    const memberLabels = block && csId === null
      ? blockSections(data.slots, blockId!).map((id) => sectionLabel(id)).filter(Boolean) as string[]
      : attending;
    if (memberLabels.length > 0) {
      const first = context?.sections.find((x) => x.label === memberLabels[0]) ?? null;
      groups.push({
        label: memberLabels.length > 1 ? "The classes" : "The class",
        primary: memberLabels.length > 2
          ? `${memberLabels.length} sections`
          : memberLabels.join(", "),
        swatch: colors.classOf(memberLabels[0]),
        lines: [
          memberLabels.length > 2 ? memberLabels.join(", ") : "",
          // §19 — the home room explains most of the cells in this row at once.
          first?.homeRoom ? `Home room ${first.homeRoom}` : "",
          first?.classTeacher ? `Class teacher ${first.classTeacher}` : "",
          attending.length > 1 ? "Taught together as one lesson (§4.10)" : "",
        ].filter(Boolean),
      });
    }

    if (teacherId !== null && teacherId !== undefined) {
      const cap = context?.teachers[String(teacherId)];
      // Their week in THIS timetable, counted from the tuples on screen. The
      // pool's other timetables are named separately rather than added in:
      // CLAUDE.md records what a single blended figure costs — "a line round
      // one wing reads 67% where the truth is 87%" — and they are two limits
      // with two different fixes.
      const mine = data.slots.filter((x) => x[SLOT.teacherId] === teacherId);
      const here = cellEvents(mine, "teacher").length;
      const sections = new Set(mine.map((x) => x[SLOT.classSectionId]).filter((x) => x !== null)).size;
      groups.push({
        label: "The teacher",
        primary: teacherName(teacherId) ?? "—",
        lines: [
          `${teacherShort(teacherId)} · ${here}${cap ? ` of ${cap.cap}` : ""} periods here`,
          `${sections} class-section${sections === 1 ? "" : "s"}`,
          cap && cap.elsewhere > 0
            ? `and ${cap.elsewhere} more in ${cap.elsewhereIn.join(", ")}`
            : "",
        ].filter(Boolean),
      });
    }

    // §4.9 — this cell genuinely is several lessons, and the grid has room for
    // none of them.
    if (block) {
      groups.push({
        label: "Running inside it",
        chips: block.options.map((o) => ({
          text: `${abbr(o.subject)} ${initialsOf(o.teacher)}`,
          swatch: colors.subject(o.subject),
          title: `${o.subject} — ${o.teacher} (${o.room})`,
        })),
      });
    }

    // What else this class studies. The curriculum, so it is what they are
    // OWED rather than what happens to be placed — stage 3 puts the two side
    // by side, and only where they differ.
    const contextSection = context?.sections.find((x) => x.id === coverageSectionId)
      ?? context?.sections.find((x) => x.label === memberLabels[0])
      ?? null;
    if (contextSection && context) {
      const owed = context.cells
        .filter(([c]) => c === contextSection.classId)
        .map(([, sid, n]) => ({
          id: sid,
          name: context.subjects.find((x) => x.id === sid)?.name ?? "?",
          periods: n,
        }))
        .sort((a, b) => b.periods - a.periods);
      if (owed.length > 0) {
        groups.push({
          label: `${contextSection.label.replace(/-[^-]*$/, "")} studies`,
          chips: owed.map((o) => {
            // §31.7 — the same rule as the Lesson grid: two numbers only when
            // they differ, and the chip drops the subject's colour when they
            // do, because a red chip in a row of coloured ones is the point.
            const short = coverage.comparable(contextSection.id, o.id)
              && coverage.placedAt(contextSection.id, o.id) !== o.periods;
            const got = coverage.placedAt(contextSection.id, o.id);
            return {
              text: short ? `${abbr(o.name)} ${got}/${o.periods}` : `${abbr(o.name)} ${o.periods}`,
              swatch: short ? { bg: "var(--signal-bg)", fg: "var(--signal)" } : colors.subject(o.name),
              title: short
                ? `${o.name} — ${got} placed of ${o.periods} a week for ${contextSection.label}`
                : `${o.name} — ${o.periods} periods a week`,
            };
          }),
        });
      }
    }
    return groups;
  };

  /**
   * §31.10 — the Lesson Grid tab's strip, which asks a different question.
   *
   * The four timetable tabs describe a PLACEMENT: a lesson at a day and a
   * period. This describes a LESSON the school intends — no clock in it at all
   * — and it is read from the grid's own draft rather than from the server, so
   * it cannot contradict an edit that has not been saved yet.
   *
   * The one thing it does ask the server for is §31.7's placed-against-required,
   * which is genuinely about the *saved* week. Mapped by name, because the
   * draft holds names and the payload holds ids: a subject that exists only in
   * the draft has no id, no placements, and correctly gets no line.
   */
  const stripForFacts = (f: AllocationCellFacts): StripGroup[] => {
    const groups: StripGroup[] = [];
    const swatch = colors.subject(f.subject);

    // §31.7 — only when they differ, and only where the comparison is honest.
    const sectionId = context?.sections.find((x) => x.label === f.section)?.id ?? null;
    const subjectId = context?.subjects.find((x) => x.name === f.subject)?.id ?? null;
    const placed = sectionId !== null && subjectId !== null
      && coverage.comparable(sectionId, subjectId)
      ? coverage.placedAt(sectionId, subjectId)
      : null;
    const short = placed !== null && f.periodsPerWeek > 0 && placed !== f.periodsPerWeek;

    groups.push({
      label: "The lesson",
      primary: f.subject,
      swatch,
      lines: [
        f.periodsPerWeek > 0
          ? `${f.periodsPerWeek} period${f.periodsPerWeek === 1 ? "" : "s"} a week`
          : "Not taught to this class",
        // Periods are a CLASS fact (§27) — the grid's rows are sections, and
        // the strip is where that is said out loud rather than implied.
        f.periodsPerWeek > 0 ? `for every section of ${f.className}` : "",
        short ? `${placed} of ${f.periodsPerWeek} placed in the shown week` : "",
      ].filter(Boolean),
    });

    groups.push({
      label: f.sharedWith.length > 1 ? "The classes" : "The class",
      primary: f.sharedWith.length > 2 ? `${f.sharedWith.length} sections` : f.sharedWith.join(", "),
      swatch: colors.classOf(f.section),
      lines: [
        f.sharedWith.length > 2 ? f.sharedWith.join(", ") : "",
        // §4.10 — one lesson, several sections. The grid draws a ⛓ in the cell;
        // this is where it says what the chain means.
        f.sharedWith.length > 1 ? "Taught together as one lesson (§4.10)" : "",
        // §31.10 — the room, which left the cell so twenty subjects could fit.
        f.room ? `Room ${f.room}` : "",
      ].filter(Boolean),
    });

    groups.push({
      label: "The teacher",
      primary: f.teacherName ?? "Nobody yet",
      lines: f.teacherName
        ? [
          `${f.teacherInitials}${f.isClassTeacher ? " · class teacher" : ""}`,
          "Click the cell to change who takes it",
        ]
        : ["Click the cell to give this lesson a teacher"],
    });

    if (f.studies.length > 0) {
      const total = f.studies.reduce((n, x) => n + x.periods, 0);
      groups.push({
        label: `${f.className} studies`,
        chips: f.studies.map((x) => ({
          text: `${abbr(x.subject)} ${x.periods}`,
          swatch: colors.subject(x.subject),
          title: `${x.subject} — ${x.periods} periods a week`,
        })),
        lines: [
          f.capacity > 0
            ? `${total} of ${f.capacity} periods a week${total > f.capacity ? " — over" : ""}`
            : `${total} periods a week`,
        ],
      });
    }
    return groups;
  };

  // Every column the Matrix draws, so the two screens describe the same week:
  // breaks and §28.3 activity bands included, the zero period excluded.
  const columns = data.periods.filter((p) => p.periodNumber !== 0);
  const perDay = columns.length;
  const days = data.workingDays;
  const teachingCols = columns.filter((p) => !p.isBreak && !p.isActivity).length * days.length;
  const breakCols = columns.filter((p) => p.isBreak).length * days.length;
  const actCols = columns.filter((p) => p.isActivity).length * days.length;

  /**
   * Column widths as percentages, so "no horizontal scroll" is a property of
   * the layout rather than a hope about the viewport.
   *
   * `minWidth` below is the honest limit: on a genuinely narrow screen the
   * table scrolls sideways rather than shrinking a cell to a width no
   * character fits in. A grid that lies about what it is showing is worse than
   * one that scrolls.
   */
  const HEADER_PCT = 7.5;
  const BREAK_PCT = 0.6;
  const ACT_PCT = 1.1;
  const teachPct = teachingCols
    ? (100 - HEADER_PCT - breakCols * BREAK_PCT - actCols * ACT_PCT) / teachingCols
    : 1;
  const minWidth = 120 + teachingCols * 24 + breakCols * 9 + actCols * 18;

  const q = search.trim().toLowerCase();
  const named = (m: Record<string, string>) =>
    Object.entries(m)
      .map(([id, label]) => ({ key: Number(id), label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  /**
   * The rows for this tab.
   *
   * Teachers, rooms and subjects come from the payload's dictionaries, which
   * hold only the ids the slots reference — so a room nobody is timetabled in
   * has no row. That is deliberate: forty empty rows would push the rows that
   * say something off the screen, and "which rooms are unused" is a question
   * §10.4's room utilization report already answers properly.
   */
  const rows: Array<{ key: number; label: string }> =
    tab === "section" ? data.sections.map((s) => ({ key: s.id, label: s.label }))
    : tab === "teacher" ? named(data.teachers)
    : tab === "room" ? named(data.rooms)
    : tab === "subject" ? named(data.subjects)
    : (context?.sections ?? []).map((s) => ({ key: s.id, label: s.label }));
  const visibleRows = q ? rows.filter((r) => r.label.toLowerCase().includes(q)) : rows;

  const teachingPeriodNumbers = new Set(
    columns.filter((p) => !p.isBreak && !p.isExtra && !p.isActivity && p.periodNumber !== null)
      .map((p) => p.periodNumber),
  );
  /*
    §31.7 — what each class-section actually has, against what it is owed.
    Built from the SAME `teachingPeriodNumbers` the fill rate uses, so the two
    figures on this screen cannot disagree about which periods are the week.
  */
  const coverage = buildCoverage({ slots: data.slots, teachingPeriods: teachingPeriodNumbers });
  /*
    §31.8 — which rows to draw. 122 teachers x 56 columns is 6,832 cells, and
    the Matrix gets away with ~2,750; this does not. `rowWindow` is degenerate
    for a list shorter than the pane, so a small school renders exactly what it
    rendered before windowing existed — one code path, always exercised.
  */
  const win: RowWindow = rowWindow({
    total: visibleRows.length,
    rowHeight: view.rowHeight,
    scrollTop: view.scrollTop,
    viewportHeight: view.viewportHeight,
    headerHeight: HEADER_H,
  });
  const capacity = data.sections.length * days.length * teachingPeriodNumbers.size;
  const filled = data.slots.filter(
    (s) => s[SLOT.classSectionId] !== null && teachingPeriodNumbers.has(s[SLOT.period]),
  ).length;

  return (
    /*
      §31.10 — the screen fills its pane and nothing below it scrolls away.

      It was a plain block whose grid pane was `maxHeight: 74vh`. Add the
      toolbar, the staffing banner, the load rail and an 86px strip and the
      total passed 100vh, so the PAGE scrolled — and the first thing off the
      bottom was the strip, which is the half that explains the cell you just
      clicked. `.content` is a flex child of a 100vh column, so `height: 100%`
      here resolves against a real number: the box takes what is left after the
      toolbar, the grid takes what is left after the strip, and only the grid
      scrolls.
    */
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12, flexWrap: "wrap", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {status === "draft" && liveDrafts.length > 0 && (
            <select
              value={shownDraftId ?? ""}
              onChange={(e) => setDraftId(Number(e.target.value))}
              style={{ padding: "8px 11px", border: "1px solid var(--brand)", borderRadius: 8, fontWeight: 700, fontSize: 13, color: "var(--brand)", background: "var(--steel-pale)" }}
            >
              {liveDrafts.map((d) => (
                <option key={d.id} value={d.id}>
                  Draft #{d.draftNo}{d.label ? ` — ${d.label}` : ""}
                  {d.generationPct !== null ? ` · ${d.generationPct}%` : ""}
                </option>
              ))}
            </select>
          )}
          <select value={status} onChange={(e) => setStatus(e.target.value as "draft" | "published")}
            style={{ padding: "8px 11px", border: "1px solid var(--line)", borderRadius: 8, fontWeight: 600, fontSize: 13 }}>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
          </select>
          {/*
            §31.10 — this filter narrows `visibleRows`, which the Lesson Grid
            tab does not use: that tab renders the Allocation grid's own rows
            and has its own filter. Leaving it on screen there was a box that
            did nothing, so it is hidden and the grid's own is hoisted up beside
            these controls instead.
          */}
          {tab !== "lesson" && (
            <>
              <input placeholder={`Filter ${TABS.find((t) => t.key === tab)!.label.toLowerCase()}…`} value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ padding: "8px 12px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12.5, width: 200 }} />
              {q && (
                <span className="chip mono">{visibleRows.length} of {rows.length}</span>
              )}
            </>
          )}
          {/* The Allocation grid's controls land here — see `toolbarHost`. */}
          {tab === "lesson" && (
            <div ref={setToolbarSlot} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }} />
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {tab === "lesson" ? (
            <>
              {allocError && (
                <span className="chip mono" style={{ background: "var(--signal-bg)", color: "var(--signal)" }}
                  title={allocError}>
                  {allocError.slice(0, 60)}
                </span>
              )}
              {saved && !dirty && (
                <span className="chip mono" style={{ background: "var(--accent-bg)", color: "var(--accent)" }}>
                  {saved}
                </span>
              )}
              {/* §31.10 — one deliberate act. The wizard saves on Next; a tab
                  has no Next, and auto-saving a grid that takes single digits
                  with no Enter would commit half-typed numbers. */}
              <button
                onClick={saveAlloc}
                disabled={!dirty || saving}
                style={{
                  border: "none", borderRadius: 8, padding: "8px 15px",
                  font: "700 12.5px/1 Inter, sans-serif",
                  cursor: dirty && !saving ? "pointer" : "default",
                  background: dirty ? "var(--brand)" : "var(--steel-pale)",
                  color: dirty ? "#fff" : "var(--ink-faint)",
                }}
              >
                {saving ? "Saving…"
                  : dirty ? `● Save ${edits} change${edits === 1 ? "" : "s"}`
                  : "Saved"}
              </button>
            </>
          ) : (
            <span className="chip mono">{filled} / {capacity} placed ({capacity ? Math.round((filled / capacity) * 100) : 0}%)</span>
          )}
          <span className="chip mono">
            {data.status}
            {status === "draft" && shownDraft ? ` #${shownDraft.draftNo}` : ""}
          </span>
        </div>
      </div>

      <div style={{
        display: "flex", alignItems: "stretch", gap: 0, border: "1px solid var(--line)",
        borderRadius: 12, overflow: "hidden", background: "var(--paper)",
        flex: 1, minHeight: 0,
      }}>
        {/* The tab rail is vertical because horizontal tabs cost a row of
            school and these cost 34px of width the row header wanted anyway. */}
        <div style={{ display: "flex", flexDirection: "column", background: "var(--offwhite)", borderRight: "1px solid var(--line)", flex: "0 0 34px" }}>
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              title={t.hint}
              aria-pressed={tab === t.key}
              style={{
                writingMode: "vertical-rl", transform: "rotate(180deg)",
                border: "none", cursor: "pointer", padding: "14px 0", flex: "1 1 auto",
                // Enough for the longest label turned on its side. Without it a
                // short grid gives the rail a short height and "Lesson grid"
                // is clipped to "Lesson g" with nothing saying so.
                minHeight: 96,
                background: tab === t.key ? "var(--brand)" : "transparent",
                color: tab === t.key ? "#fff" : "var(--steel)",
                fontWeight: 700, fontSize: 11, letterSpacing: "0.05em",
                fontFamily: "inherit", whiteSpace: "nowrap",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* The grid and the strip are one column: the strip must sit UNDER the
            scrolling pane and beside the rail, never inside the scroll — a
            strip that scrolled away with the rows would be explaining a cell
            you can no longer see. */}
        <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
          {tab === "lesson" ? (
            /*
              §31.10 — the real Allocation grid, outside the Master Grid's own
              scrolling pane: it scrolls inside itself, and nesting one
              scroller in another gives two scrollbars and a sticky header
              stuck to the wrong box.
            */
            <AllocationTab
              answers={alloc}
              onChange={patchAlloc}
              loading={allocLoading}
              error={allocError}
              wing={current?.name ?? null}
              onSelectCell={(facts) => setSelected(facts ? { kind: "lesson", facts } : null)}
              toolbarHost={toolbarSlot}
            />
          ) : (
          <div
            ref={setPaneEl}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onScroll={view.onScroll}
          /* §31.6 — the strip is meant to be read ACROSS a row, and reaching
             for the mouse 55 times to do it is not reading. `tabIndex` makes
             the pane focusable so the arrow keys have somewhere to land; the
             outline is suppressed because the selected CELL is the visible
             focus, and a second ring round the whole pane would be noise. */
          style={{ flex: "1 1 auto", minWidth: 0, overflow: "auto", maxHeight: "74vh", outline: "none" }}
        >
          {(
            <table style={{ borderCollapse: "separate", borderSpacing: 0, tableLayout: "fixed", width: "100%", minWidth, fontSize: 10 }}>
              <colgroup>
                <col style={{ width: `${HEADER_PCT}%` }} />
                {days.map((d) =>
                  columns.map((p, i) => (
                    <col key={`${d}:${i}`} style={{
                      width: `${p.isBreak ? BREAK_PCT : p.isActivity ? ACT_PCT : teachPct}%`,
                    }} />
                  )),
                )}
              </colgroup>
              <thead>
                <tr>
                  <th style={cornerTh}>{TABS.find((t) => t.key === tab)!.label}</th>
                  {days.map((d) => (
                    <th key={d} colSpan={perDay} style={{
                      position: "sticky", top: 0, zIndex: 3, background: "var(--brand)", color: "#fff",
                      padding: "5px 2px", fontSize: 9.5, letterSpacing: "0.06em",
                      borderRight: "2px solid var(--brand-dark)",
                    }}>
                      {DAY_NAMES[d]}
                    </th>
                  ))}
                </tr>
                <tr>
                  <th style={{ ...cornerTh, top: 24 }} />
                  {days.map((d) =>
                    columns.map((p, i) => (
                      <th key={`${d}:${i}`} title={
                        p.isActivity ? `${p.breakName ?? "Activity"} · ${p.startTime}–${p.endTime ?? ""}`
                        : p.isBreak ? `${p.breakName ?? "Break"} · ${p.startTime}–${p.endTime ?? ""}`
                        : `P${p.periodNumber} · ${p.startTime}–${p.endTime ?? ""}`
                      } style={{
                        position: "sticky", top: 24, zIndex: 3,
                        background: p.isActivity ? "var(--accent-bg)" : p.isBreak ? "var(--offwhite)" : p.isExtra ? "var(--amber-bg, #FDF4E3)" : "var(--steel-pale)",
                        color: p.isActivity ? "var(--accent)" : p.isExtra ? "var(--amber)" : "var(--brand)",
                        padding: "3px 1px", fontSize: 8.5, fontFamily: "var(--font-mono)",
                        borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                        borderLeft: p.isExtra ? "2px solid var(--amber)" : undefined,
                        overflow: "hidden",
                      }}>
                        {/* A break carries no cell, so it carries no label
                            either — the column is a hairline and its name is
                            on the tooltip. */}
                        {p.isBreak ? "" : p.isActivity ? "◆" : p.isExtra ? `X${p.periodNumber}` : p.periodNumber}
                      </th>
                    )),
                  )}
                </tr>
              </thead>
              <tbody>
                <Spacer height={win.padTop} span={1 + days.length * perDay} />
                {visibleRows.slice(win.start, win.end).map((row, i) => (
                  // The first drawn row is the one that is measured — see
                  // `useRowViewport`. Any row would do; the first is the one
                  // guaranteed to exist whenever the body is not empty.
                  <tr key={row.key} ref={i === 0 ? view.measureRow : undefined}>
                    <th title={row.label} style={rowTh}>
                      {row.label}
                    </th>
                    {days.map((d) =>
                      columns.map((p, i) => {
                        if (p.isBreak) {
                          return <td key={`${d}:${i}`} style={{ background: "var(--offwhite)", borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }} />;
                        }
                        if (p.isActivity) {
                          return <td key={`${d}:${i}`} style={{
                            background: "var(--accent-bg)", borderLeft: "2px solid var(--accent)",
                            borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                          }} />;
                        }
                        const here = grid?.get(pivotCellKey(row.key, d, p.periodNumber)) ?? [];
                        return (
                          <Cell
                            key={`${d}:${i}`}
                            events={cellEvents(here, tab)}
                            describe={describe}
                            selected={
                              selected?.kind === "cell" && selected.rowKey === row.key
                              && selected.day === d && selected.period === p.periodNumber
                            }
                            onSelect={() =>
                              setSelected({ kind: "cell", rowKey: row.key, day: d, period: p.periodNumber as number })
                            }
                          />
                        );
                      }),
                    )}
                  </tr>
                ))}
                <Spacer height={win.padBottom} span={1 + days.length * perDay} />
              </tbody>
            </table>
          )}
          {visibleRows.length === 0 && (
            <p className="screen-sub" style={{ padding: 20 }}>
              {q ? `Nothing matches “${search}”.` : "Nothing to show for this timetable yet."}
            </p>
          )}
          </div>
          )}
          <Strip
            groups={
              selected === null ? null
              : selected.kind === "cell" ? stripForCell(selected)
              : stripForFacts(selected.facts)
            }
            readiness={readiness}
            onShowIssues={() => setShowIssues(true)}
          />
        </div>
      </div>

      {showIssues && readiness && (
        <IssueDrawer readiness={readiness} onClose={() => setShowIssues(false)} />
      )}
    </div>
  );
}

/**
 * One cell.
 *
 * One event renders itself; several render a **count**, which is the honest
 * answer at this width and the one §10.6's subject cards already settled on.
 * English at Monday P1 across sixteen sections — a real number on the
 * reference school — is one fact, "sixteen", and picking an arbitrary one of
 * the sixteen to name would be a smaller answer that reads like the whole one.
 *
 * "Event", not "lesson": §4.10 collapsing already happened in `cellEvents`, so
 * this component never has to know that a teacher's four rows can be one
 * lesson.
 */
function Cell({
  events,
  describe,
  selected,
  onSelect,
}: {
  events: SlotTuple[][];
  describe: (event: SlotTuple[]) => CellFace;
  selected: boolean;
  onSelect: () => void;
}) {
  const base: React.CSSProperties = {
    borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
    height: 22, textAlign: "center", overflow: "hidden", whiteSpace: "nowrap",
    fontSize: 9, fontFamily: "var(--font-mono)", padding: 0, cursor: "pointer",
    /* An outline rather than a border or a background: a border would move the
       cell's neighbours by a pixel and a background would fight §10.5's colour,
       which is the one thing in the cell carrying meaning. `outline-offset`
       pulls it inside so it is not clipped by the cell beside it. */
    ...(selected ? { outline: "2px solid var(--brand-deep)", outlineOffset: -2, position: "relative", zIndex: 1 } : {}),
  };
  // An EMPTY cell is selectable too. A free period is a fact, and the strip is
  // the only place with room to say whose it is.
  if (events.length === 0) {
    return <td onClick={onSelect} style={{ ...base, color: "var(--ink-faint)" }} />;
  }
  if (events.length === 1) {
    const face = describe(events[0]);
    return (
      <td onClick={onSelect} title={face.title} style={{
        ...base,
        // §10.5 — a substitution keeps its cyan whatever colour the lesson
        // would otherwise have had. An existing meaning outranks a new one.
        background: face.substituted ? "var(--accent-bg)" : face.swatch?.bg ?? "var(--paper)",
        color: face.substituted ? "var(--accent)" : face.swatch?.fg ?? "var(--ink)",
        // A pin, in the only width there is for one. The Matrix can afford 🔒;
        // here it would be 40% of the cell.
        borderLeft: face.locked ? "2px solid var(--ink)" : undefined,
        fontWeight: 700,
      }}>
        {face.text}
      </td>
    );
  }
  const all = events.map((e) => describe(e));
  return (
    <td
      onClick={onSelect}
      title={all.map((a) => a.title).join("\n")}
      style={{ ...base, background: "var(--steel-pale)", color: "var(--brand)", fontWeight: 800 }}
    >
      {events.length}
    </td>
  );
}

/**
 * §31.6 — the strip.
 *
 * One row along the bottom of the grid box that never moves and never covers
 * the grid. Clicking a cell fills it; clicking another replaces it.
 *
 * **A strip and not a popover.** A popover over a 27-pixel cell covers the
 * neighbours you are comparing it with, and comparing is almost always why the
 * cell was clicked. A fixed strip keeps the whole grid visible while it
 * explains one piece of it — the same argument §8.5 made for putting a
 * master's form beside its list rather than below it.
 *
 * It is **always rendered**, at a fixed height, even with nothing selected.
 * Appearing on the first click would shorten the grid under the pointer at the
 * exact moment somebody is reading it, and the row they clicked would move.
 */
function Strip({
  groups,
  readiness,
  onShowIssues,
}: {
  groups: StripGroup[] | null;
  readiness: ReadinessPayload | null;
  onShowIssues: () => void;
}) {
  return (
    <div
      style={{
        borderTop: "1px solid var(--line)", background: "var(--offwhite)",
        height: 86, display: "flex", alignItems: "stretch",
        overflowX: "auto", overflowY: "hidden", flex: "0 0 auto",
      }}
    >
      {groups === null || groups.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", padding: "0 16px", color: "var(--ink-faint)", fontSize: 12 }}>
          Click any cell to see what it is — the class, the teacher, the room, and what else that class studies.
          <span style={{ marginLeft: 10, fontFamily: "var(--font-mono)", fontSize: 11 }}>← ↑ ↓ →</span>
        </div>
      ) : (
        groups.map((g, n) => (
          <div
            key={g.label + n}
            style={{
              padding: "9px 14px", minWidth: 0,
              borderLeft: n === 0 ? undefined : "1px solid var(--line)",
              // The last group — the class's whole curriculum — takes what is
              // left and scrolls inside itself, so twenty subjects cannot push
              // the teacher's name off the strip.
              flex: n === groups.length - 1 ? "1 1 auto" : "0 0 auto",
              display: "flex", flexDirection: "column", gap: 3,
            }}
          >
            <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--ink-faint)", fontWeight: 800 }}>
              {g.label}
            </div>
            {g.primary && (
              <div style={{
                fontWeight: 800, fontSize: 13.5, whiteSpace: "nowrap",
                color: g.swatch?.fg ?? "var(--brand-deep)",
                background: g.swatch?.bg, borderRadius: 5,
                padding: g.swatch ? "1px 7px" : undefined, alignSelf: "flex-start",
              }}>
                {g.primary}
              </div>
            )}
            {(g.lines ?? []).map((line, k) => (
              <div key={k} style={{ fontSize: 11, color: "var(--ink-soft, #4F5D70)", whiteSpace: "nowrap" }}>
                {line}
              </div>
            ))}
            {g.chips && (
              <div style={{ display: "flex", gap: 4, flexWrap: "nowrap", overflowX: "auto", paddingBottom: 2 }}>
                {g.chips.map((c, k) => (
                  <span
                    key={k}
                    title={c.title}
                    style={{
                      fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 700,
                      padding: "2px 6px", borderRadius: 5, whiteSpace: "nowrap",
                      background: c.swatch?.bg ?? "var(--steel-pale)",
                      color: c.swatch?.fg ?? "var(--brand)",
                    }}
                  >
                    {c.text}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))
      )}

      {/*
        §31.10 — the same four numbers wherever you are on this screen.

        Pinned to the right and OUTSIDE the group list on purpose: the groups
        change with every click and answer "what is this cell?", while these
        answer "how is the whole timetable?" — a question whose answer must not
        move about or vanish when nothing is selected. `marginLeft: auto` keeps
        them at the end however many groups there are.
      */}
      {readiness && (
        <div style={{
          marginLeft: "auto", flex: "0 0 auto", display: "flex", alignItems: "center",
          gap: 16, padding: "0 16px", borderLeft: "1px solid var(--line)",
          background: "var(--paper)",
        }}>
          <Figure
            label="Readiness"
            value={`${readiness.score}%`}
            tone={readiness.ready ? "ok" : readiness.score >= 80 ? "warn" : "bad"}
          />
          <Figure label="Week holds" value={readiness.stats.totalAvailableSlots.toLocaleString()} />
          <Figure
            label="Allocated"
            value={readiness.stats.totalRequiredSlots.toLocaleString()}
            tone={readiness.stats.totalRequiredSlots > readiness.stats.totalAvailableSlots ? "bad" : "plain"}
          />
          {/*
            The only one that is a control, because it is the only one with
            somewhere to go. A count with no way to see what it counts is a
            number that makes somebody feel worse and no better informed.
          */}
          <button
            onClick={onShowIssues}
            disabled={readiness.blockers.length + readiness.warnings.length === 0}
            // Only for a blocker. A warning is worth knowing and does not stop
            // anybody working, and a screen that pulses at a school with
            // nothing wrong is a screen whose pulses stop meaning anything.
            className={readiness.blockers.length > 0 ? "strip-alert" : undefined}
            title={readiness.blockers.length + readiness.warnings.length === 0
              ? "Nothing to fix"
              : "Show what is wrong, and what to do about it"}
            style={{
              border: "none", background: "none", padding: "3px 8px", textAlign: "left",
              borderRadius: 9,
              cursor: readiness.blockers.length + readiness.warnings.length === 0 ? "default" : "pointer",
              font: "inherit",
            }}
          >
            <Figure
              label={readiness.blockers.length > 0 ? "Errors \u203a" : "Warnings \u203a"}
              value={String(readiness.blockers.length > 0
                ? readiness.blockers.length
                : readiness.warnings.length)}
              tone={readiness.blockers.length > 0 ? "bad"
                : readiness.warnings.length > 0 ? "warn" : "ok"}
            />
          </button>
        </div>
      )}
    </div>
  );
}

/** One figure in the strip's tail: a small label over a large number. */
function Figure({
  label,
  value,
  tone = "plain",
}: {
  label: string;
  value: string;
  tone?: "plain" | "ok" | "warn" | "bad";
}) {
  const colour = tone === "bad" ? "var(--signal)"
    : tone === "warn" ? "var(--amber)"
    : tone === "ok" ? "var(--accent)"
    : "var(--brand-deep)";
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 3, whiteSpace: "nowrap" }}>
      <span style={{
        font: "800 9px/1 Inter, sans-serif", letterSpacing: "0.07em",
        textTransform: "uppercase", color: "var(--ink-faint)",
      }}>
        {label}
      </span>
      <span style={{ font: "800 17px/1 var(--font-mono, monospace)", color: colour }}>{value}</span>
    </span>
  );
}

/**
 * §31.10 — what is wrong, in order, with what to do about it.
 *
 * A drawer down the right, full height, over the page rather than beside it.
 * The strip's figure is a count, and a count alone is a number that makes
 * somebody feel worse and no better informed; this is where it goes.
 *
 * Blockers first and warnings after — the Readiness Dashboard's own order, and
 * the order the school has to work in: a blocker stops Generate and a warning
 * does not. Each carries the engine's own `fix`, because §4's "tell me what to
 * fix" is a core promise: that prose is written where the numbers are in scope,
 * so it names the row and the change rather than restating the rule.
 *
 * Read-only, deliberately. §21's auto-resolve applies remedies behind a consent
 * step, a `WRITABLE` allow-list and a compare-and-set on the value the admin
 * saw, and it lives on the Readiness Dashboard. An Apply button here would be a
 * second writer over the same remedies — the mistake this whole phase has been
 * careful not to make.
 */
function IssueDrawer({
  readiness,
  onClose,
}: {
  readiness: ReadinessPayload;
  onClose: () => void;
}) {
  const rows = [
    ...readiness.blockers.map((i) => ({ ...i, kind: "blocker" as const })),
    ...readiness.warnings.map((i) => ({ ...i, kind: "warning" as const })),
  ];
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(11,31,68,.35)" }}
    >
      <aside
        role="dialog"
        aria-label="What is wrong with this timetable"
        style={{
          position: "absolute", top: 0, right: 0, bottom: 0, width: "min(460px, 92vw)",
          background: "var(--paper)", borderLeft: "1px solid var(--line)",
          boxShadow: "-14px 0 40px rgba(11,31,68,.14)",
          display: "flex", flexDirection: "column",
        }}
      >
        <header style={{
          padding: "14px 18px", borderBottom: "1px solid var(--line)",
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ font: "800 15px/1.2 Inter, sans-serif", color: "var(--brand-deep)" }}>
              {readiness.blockers.length > 0
                ? `${readiness.blockers.length} thing${readiness.blockers.length === 1 ? "" : "s"} to fix`
                : "Nothing is blocking generation"}
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 3 }}>
              Readiness {readiness.score}%
              {readiness.warnings.length > 0
                ? ` \u00b7 ${readiness.warnings.length} warning${readiness.warnings.length === 1 ? "" : "s"}`
                : ""}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{
              border: "1px solid var(--line)", background: "var(--paper)", borderRadius: 8,
              padding: "6px 11px", cursor: "pointer", font: "700 12px/1 Inter, sans-serif",
            }}>
            Close
          </button>
        </header>

        <div style={{ flex: 1, overflowY: "auto", padding: "12px 18px 22px" }}>
          {rows.length === 0 && (
            <p className="screen-sub">Every check passes. This timetable is ready to generate.</p>
          )}
          {rows.map((issue, n) => {
            const bad = issue.kind === "blocker";
            return (
              <div
                key={`${issue.code}:${n}`}
                style={{
                  borderLeft: `3px solid ${bad ? "var(--signal)" : "var(--amber)"}`,
                  background: bad ? "var(--signal-bg)" : "var(--amber-bg)",
                  borderRadius: "0 9px 9px 0", padding: "11px 13px", marginBottom: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
                  {/* Numbered, because "in sequence" is the ask — and because a
                      list of eleven identical cards is one nobody can hold
                      their place in. */}
                  <span style={{
                    font: "800 10px/1 var(--font-mono, monospace)",
                    color: bad ? "var(--signal)" : "var(--amber)",
                  }}>
                    {n + 1}
                  </span>
                  <span style={{
                    font: "800 9px/1 Inter, sans-serif", letterSpacing: "0.07em",
                    textTransform: "uppercase", color: bad ? "var(--signal)" : "var(--amber)",
                  }}>
                    {bad ? "Blocks generation" : "Worth knowing"}
                  </span>
                  {issue.entity && (
                    <span style={{
                      marginLeft: "auto", font: "600 10.5px/1 var(--font-mono, monospace)",
                      color: "var(--ink-faint)", whiteSpace: "nowrap",
                      overflow: "hidden", textOverflow: "ellipsis", maxWidth: 150,
                    }} title={issue.entity.label}>
                      {issue.entity.label}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12.8, lineHeight: 1.55, color: "var(--ink)" }}>
                  {issue.message}
                </div>
                {issue.fix && (
                  <div style={{
                    fontSize: 12.2, lineHeight: 1.5, color: "var(--ink-soft)",
                    marginTop: 7, paddingTop: 7, borderTop: "1px solid rgba(0,0,0,.07)",
                  }}>
                    <strong style={{ color: "var(--ink)" }}>Fix:</strong> {issue.fix}
                  </div>
                )}
              </div>
            );
          })}
          {rows.length > 0 && (
            <p style={{ fontSize: 11.5, color: "var(--ink-faint)", lineHeight: 1.55, marginTop: 14 }}>
              The Readiness Dashboard can apply many of these for you, with a confirmation and an
              undo. This list is read-only so there is only ever one thing writing to your master
              data.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

const cornerTh: React.CSSProperties = {
  position: "sticky", left: 0, top: 0, zIndex: 4, background: "var(--brand)", color: "#fff",
  padding: "5px 8px", fontSize: 9.5, textAlign: "left", whiteSpace: "nowrap", overflow: "hidden",
};

const rowTh: React.CSSProperties = {
  position: "sticky", left: 0, zIndex: 2, background: "var(--offwhite)", fontWeight: 700,
  padding: "3px 8px", fontSize: 9.5, textAlign: "left", whiteSpace: "nowrap",
  overflow: "hidden", textOverflow: "ellipsis",
  borderRight: "2px solid var(--line)", borderBottom: "1px solid var(--line)",
};
