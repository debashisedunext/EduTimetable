import { useEffect, useMemo, useRef, useState } from "react";
import {
  blockSections, buildCoverage, cellEvents, initialsOf, pivotCellKey, pivotSlots, SLOT,
  type Coverage, type GridPivot, type SlotTuple,
} from "@edutimetable/shared";
import { useApi, useConfigCtx } from "../hooks";
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
  | { kind: "lesson"; sectionId: number; subjectId: number };

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

const TABS: Array<{ key: Tab; label: string; hint: string }> = [
  { key: "section", label: "Whole", hint: "Every class-section's week — the complete timetable" },
  { key: "teacher", label: "Teachers", hint: "Every teacher's week, one row each" },
  { key: "room", label: "Classrooms", hint: "Which class is in each room, period by period" },
  { key: "subject", label: "Subjects", hint: "When each subject is taught, and by whom" },
  { key: "lesson", label: "Lesson grid", hint: "Class-sections × subjects — periods per week" },
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
  const gridRef = useRef<HTMLDivElement | null>(null);

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
  const { data: context } = useApi<ContextPayload>(
    current ? `/timetable-configs/${current.id}/context` : null,
  );

  /*
    A selection names a row of the tab it was made on, so it cannot survive a
    change of tab: cell 44 on Teachers is a different person from cell 44 on
    Classrooms, and the strip would go on describing something no longer on
    screen. Same for a change of draft or status — the week underneath it is a
    different week.
  */
  useEffect(() => setSelected(null), [tab, status, draftId]);

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

    if (selected.kind === "lesson") {
      const rowAt = visibleRows.findIndex((r) => r.key === selected.sectionId);
      const colAt = (context?.subjects ?? []).findIndex((x) => x.id === selected.subjectId);
      const nextRow = clamp(rowAt + dRow, visibleRows.length);
      const nextCol = clamp(colAt + dCol, context?.subjects.length ?? 0);
      if (nextRow === null || nextCol === null) return;
      setSelected({
        kind: "lesson",
        sectionId: visibleRows[nextRow].key,
        subjectId: context!.subjects[nextCol].id,
      });
      return;
    }

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
   * The Lesson grid's vocabulary, which is a different question (§31.4).
   *
   * A lesson-grid cell has no time in it, so there is no clock and no free
   * period. What it has instead is **who shares the lesson** — and that list is
   * not decoration: several sections on one lesson is a §4.9 block or a §4.10
   * merged group, and this is the only place on the screen where that is
   * visible.
   */
  const stripForLesson = (sel: Extract<Selection, { kind: "lesson" }>): StripGroup[] | null => {
    if (!context) return null;
    const section = context.sections.find((x) => x.id === sel.sectionId);
    const subject = context.subjects.find((x) => x.id === sel.subjectId);
    if (!section || !subject) return null;
    const periods = context.cells.find(([c, sid]) => c === section.classId && sid === sel.subjectId)?.[2] ?? 0;

    // Read off the placements: which cells this section's lessons of this
    // subject sit in, and then everyone else in those cells.
    const mine = data.slots.filter(
      (x) => x[SLOT.subjectId] === sel.subjectId && x[SLOT.classSectionId] === sel.sectionId,
    );
    const cells = new Set(mine.map((x) => `${x[SLOT.day]}:${x[SLOT.period]}`));
    const together = data.slots.filter(
      (x) => x[SLOT.subjectId] === sel.subjectId && cells.has(`${x[SLOT.day]}:${x[SLOT.period]}`),
    );
    const sharing = [...new Set(together.map((x) => sectionLabel(x[SLOT.classSectionId])).filter(Boolean))] as string[];
    const teachers = [...new Set(together.map((x) => x[SLOT.teacherId]).filter((x) => x !== null))] as number[];
    const rooms = [...new Set(together.map((x) => x[SLOT.roomId]).filter((x) => x !== null))] as number[];

    // §31.7 — the same arithmetic the cells use, so the strip and the grid
    // cannot disagree about whether this row is short.
    const got = coverage.placedAt(section.id, sel.subjectId);
    const short = periods > 0 && coverage.comparable(section.id, sel.subjectId) && got !== periods;
    const groups: StripGroup[] = [
      {
        label: "The lesson",
        primary: subject.name,
        swatch: colors.subject(subject.name),
        lines: [
          short
            ? `${got} placed of ${periods} a week — ${got < periods ? `${periods - got} missing` : `${got - periods} too many`}`
            : `${periods} period${periods === 1 ? "" : "s"} a week`,
          // Periods are a CLASS fact (§27), and the strip says so rather than
          // letting a per-section grid imply otherwise.
          `for every section of ${section.label.replace(/-[^-]*$/, "")}`,
          coverage.electiveSubjects.has(sel.subjectId)
            // §4.9 — the children are in the block doing this subject, but the
            // option row belongs to no section, so no honest per-section count
            // exists. Saying so beats a confident 0.
            ? "Also runs as a split elective — placements are not counted per section"
            : "",
        ].filter(Boolean),
      },
      {
        label: "The class",
        primary: section.label,
        swatch: colors.classOf(section.label),
        lines: [
          section.homeRoom ? `Home room ${section.homeRoom}` : "",
          section.classTeacher ? `Class teacher ${section.classTeacher}` : "",
        ].filter(Boolean),
      },
    ];

    if (mine.length === 0) {
      // Not "no teacher" — the curriculum says the lesson exists and nothing
      // has been placed yet. Saying so is the difference between a gap and a
      // timetable that has not been generated.
      groups.push({ label: "Placed", primary: "Not yet", lines: ["Generate to see who takes it and where"] });
      return groups;
    }
    groups.push({
      label: sharing.length > 1 ? "Sharing the lesson" : "Placed",
      primary: `${got} placed`,
      chips: sharing.map((label) => ({ text: shortSection(label), swatch: colors.classOf(label), title: label })),
    });
    groups.push({
      label: teachers.length > 1 ? "Teachers" : "Teacher",
      chips: teachers.map((t) => ({ text: teacherShort(t) ?? "?", title: teacherName(t) ?? "" })),
    });
    if (rooms.length > 0) {
      groups.push({
        label: rooms.length > 1 ? "Rooms" : "Room",
        chips: rooms.map((r) => ({ text: data.rooms[String(r)] ?? "?", title: data.rooms[String(r)] ?? "" })),
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
  const capacity = data.sections.length * days.length * teachingPeriodNumbers.size;
  const filled = data.slots.filter(
    (s) => s[SLOT.classSectionId] !== null && teachingPeriodNumbers.has(s[SLOT.period]),
  ).length;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
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
          <input placeholder={`Filter ${TABS.find((t) => t.key === tab)!.label.toLowerCase()}…`} value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: "8px 12px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12.5, width: 200 }} />
          {q && (
            <span className="chip mono">{visibleRows.length} of {rows.length}</span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {tab === "lesson" ? (
            <span className="chip mono" title="What the school says these classes are taught — the curriculum, not where the lessons ended up">
              curriculum · a week of {context?.weekCapacity ?? "—"} periods
            </span>
          ) : (
            <span className="chip mono">{filled} / {capacity} placed ({capacity ? Math.round((filled / capacity) * 100) : 0}%)</span>
          )}
          <span className="chip mono">
            {data.status}
            {status === "draft" && shownDraft ? ` #${shownDraft.draftNo}` : ""}
          </span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "stretch", gap: 0, border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden", background: "var(--paper)" }}>
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
          <div
            ref={gridRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
          /* §31.6 — the strip is meant to be read ACROSS a row, and reaching
             for the mouse 55 times to do it is not reading. `tabIndex` makes
             the pane focusable so the arrow keys have somewhere to land; the
             outline is suppressed because the selected CELL is the visible
             focus, and a second ring round the whole pane would be noise. */
          style={{ flex: "1 1 auto", minWidth: 0, overflow: "auto", maxHeight: "74vh", outline: "none" }}
        >
          {tab === "lesson" ? (
            <LessonGrid
              coverage={coverage}
              context={context}
              visibleRows={visibleRows}
              colors={colors}
              selected={selected}
              onSelect={(sectionId, subjectId) => setSelected({ kind: "lesson", sectionId, subjectId })}
            />
          ) : (
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
                {visibleRows.map((row) => (
                  <tr key={row.key}>
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
              </tbody>
            </table>
          )}
          {visibleRows.length === 0 && (
            <p className="screen-sub" style={{ padding: 20 }}>
              {q ? `Nothing matches “${search}”.` : "Nothing to show for this timetable yet."}
            </p>
          )}
          </div>
          <Strip
            groups={
              selected === null ? null
              : selected.kind === "cell" ? stripForCell(selected)
              : stripForLesson(selected)
            }
          />
        </div>
      </div>
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
function Strip({ groups }: { groups: StripGroup[] | null }) {
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
    </div>
  );
}

/**
 * §31 — the Lesson grid tab: class-sections down, **subjects** across, periods
 * per week in the cell.
 *
 * The odd tab out, and the reason it is worth naming: the other four are an
 * entity against time and this is the same shape as §27's Allocation grid —
 * "class-sections down, subjects across" — read-only and at grid density. Its
 * numbers are the **curriculum**, so a cell reading 6 means Class 1-A is
 * *meant* to have six periods of English, whether or not a timetable exists.
 *
 * Periods are a **class** fact (§27): `class_subjects` is keyed by class, so
 * 5-A and 5-B show one curriculum in two rows. The payload keys its cells by
 * class for exactly that reason.
 */
function LessonGrid({
  coverage,
  context,
  visibleRows,
  colors,
  selected,
  onSelect,
}: {
  coverage: Coverage;
  context: ContextPayload | null;
  visibleRows: Array<{ key: number; label: string }>;
  colors: ReturnType<typeof useColors>;
  selected: Selection | null;
  onSelect: (sectionId: number, subjectId: number) => void;
}) {
  const byClass = useMemo(() => {
    const m = new Map<string, number>();
    for (const [classId, subjectId, periods] of context?.cells ?? []) {
      m.set(`${classId}:${subjectId}`, periods);
    }
    return m;
  }, [context]);

  if (!context) return <p className="screen-sub" style={{ padding: 20 }}>Loading the curriculum…</p>;
  const classOfSection = new Map(context.sections.map((s) => [s.id, s.classId]));
  const subjects = context.subjects;
  const HEADER_PCT = 14;
  const TOTAL_PCT = 7;
  const colPct = subjects.length ? (100 - HEADER_PCT - TOTAL_PCT) / subjects.length : 1;

  return (
    <table style={{ borderCollapse: "separate", borderSpacing: 0, tableLayout: "fixed", width: "100%", minWidth: 140 + subjects.length * 42 + 60, fontSize: 10 }}>
      <colgroup>
        <col style={{ width: `${HEADER_PCT}%` }} />
        {subjects.map((s) => <col key={s.id} style={{ width: `${colPct}%` }} />)}
        <col style={{ width: `${TOTAL_PCT}%` }} />
      </colgroup>
      <thead>
        <tr>
          <th style={cornerTh}>Class-Section</th>
          {subjects.map((s) => {
            const sw = colors.subject(s.name);
            return (
              <th key={s.id} title={s.name} style={{
                position: "sticky", top: 0, zIndex: 3,
                background: sw?.bg ?? "var(--steel-pale)", color: sw?.fg ?? "var(--brand)",
                padding: "5px 2px", fontSize: 9, fontWeight: 800,
                borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                overflow: "hidden", whiteSpace: "nowrap",
              }}>
                {abbr(s.name)}
              </th>
            );
          })}
          <th style={{
            position: "sticky", top: 0, zIndex: 3, background: "var(--brand)", color: "#fff",
            padding: "5px 2px", fontSize: 9, fontWeight: 800, borderBottom: "1px solid var(--line)",
          }}>
            Total
          </th>
        </tr>
      </thead>
      <tbody>
        {visibleRows.map((row) => {
          const classId = classOfSection.get(row.key);
          const cells = subjects.map((s) => byClass.get(`${classId}:${s.id}`) ?? 0);
          const total = cells.reduce((a, b) => a + b, 0);
          /*
            §31.7 — the row's own shortfall, over the subjects that CAN be
            compared. Deliberately not `placedIn`, which counts every teaching
            lesson the section has: a §4.9 block's periods are real lessons and
            are not curriculum rows, so on any school with an elective the two
            would differ by the block's length and the row would always look
            over-taught.
          */
          const counted = subjects
            .map((s, i) => ({ s, required: cells[i] }))
            .filter((x) => x.required > 0 && coverage.comparable(row.key, x.s.id));
          const requiredCounted = counted.reduce((a, x) => a + x.required, 0);
          const placedCounted = counted.reduce((a, x) => a + coverage.placedAt(row.key, x.s.id), 0);
          const short = counted.length > 0 && placedCounted !== requiredCounted;
          // Over the week this timetable actually offers. Not a blocker and not
          // a score — Readiness owns that verdict (§4); this only says out loud
          // that the arithmetic on this row does not fit, at the moment
          // somebody is looking at the row.
          const over = context.weekCapacity > 0 && total > context.weekCapacity;
          return (
            <tr key={row.key}>
              <th title={row.label} style={rowTh}>{row.label}</th>
              {subjects.map((s, i) => {
                const n = cells[i];
                const placed = coverage.placedAt(row.key, s.id);
                /*
                  §31.7 — two numbers ONLY when they differ. A cell that always
                  read `6/6` would be a number nobody reads, and within a week
                  nobody would be reading `5/6` either.

                  `comparable` is what stops it crying wolf: an ungenerated
                  section and a subject that also runs as a §4.9 option both
                  produce a difference that is not one.
                */
                const differs = n > 0 && coverage.comparable(row.key, s.id) && placed !== n;
                // The subject's colour is given up for this one cell. §10.5's
                // own rule — an existing meaning outranks a new one — cuts this
                // way here: "this row is short" is the more urgent fact, and
                // the column header is still carrying the subject's colour.
                const sw = differs || n === 0 ? null : colors.subject(s.name);
                return (
                  <td
                    key={s.id}
                    onClick={() => onSelect(row.key, s.id)}
                    title={
                      n === 0 ? `${row.label} does not take ${s.name}`
                      : differs ? `${row.label} · ${s.name} · ${placed} placed of ${n} a week`
                      : `${row.label} · ${s.name} · ${n} periods a week`
                    }
                    style={{
                    borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                    height: 22, textAlign: "center", fontSize: differs ? 8.5 : 9.5, fontFamily: "var(--font-mono)",
                    fontWeight: n > 0 ? 700 : 400, padding: 0, cursor: "pointer",
                    background: differs ? "var(--signal-bg)" : sw?.bg ?? "var(--paper)",
                    color: differs ? "var(--signal)" : sw?.fg ?? "var(--ink-faint)",
                    ...(selected?.kind === "lesson" && selected.sectionId === row.key && selected.subjectId === s.id
                      ? { outline: "2px solid var(--brand-deep)", outlineOffset: -2, position: "relative", zIndex: 1 }
                      : {}),
                  }}>
                    {/* A blank, not a zero. Zero periods and "this class does
                        not take this subject" are the same fact here (§27.15
                        made not-taken a real deletion), and a grid of zeros
                        would hide the numbers that matter. */}
                    {n === 0 ? "" : differs ? `${placed}/${n}` : n}
                  </td>
                );
              })}
              <td title={
                short
                  ? `${placedCounted} placed of the ${requiredCounted} this section is owed · ${total} of ${context.weekCapacity} periods a week`
                  : `${total} of ${context.weekCapacity} periods a week`
              } style={{
                borderBottom: "1px solid var(--line)", height: 22, textAlign: "center",
                fontSize: short ? 8.5 : 9.5, fontFamily: "var(--font-mono)", fontWeight: 800, padding: 0,
                background: over || short ? "var(--signal-bg, #FBE9E7)" : "var(--offwhite)",
                color: over || short ? "var(--signal)" : "var(--brand-deep)",
              }}>
                {short ? `${placedCounted}/${requiredCounted}` : total}{over ? "!" : ""}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
