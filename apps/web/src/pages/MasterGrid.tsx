import { useMemo, useState } from "react";
import { cellEvents, initialsOf, pivotCellKey, pivotSlots, SLOT, type GridPivot, type SlotTuple } from "@edutimetable/shared";
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

/** §31 — the Lesson grid tab's own payload: the curriculum, not the slots. */
interface LessonsPayload {
  sections: { id: number; classId: number; label: string }[];
  subjects: { id: number; name: string }[];
  /** [classId, subjectId, periodsPerWeek] */
  cells: Array<[number, number, number]>;
  weekCapacity: number;
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

export function MasterGrid() {
  const { current } = useConfigCtx();
  const colors = useColors();
  const [tab, setTab] = useState<Tab>("section");
  const [status, setStatus] = useState<"draft" | "published">("draft");
  const [draftId, setDraftId] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const { data: drafts } = useApi<DraftRow[]>(
    current ? `/timetable-configs/${current.id}/drafts` : null,
  );
  const { data } = useApi<SlotsPayload>(
    current
      ? `/timetable-configs/${current.id}/slots?status=${status}` +
        `${status === "draft" && draftId !== null ? `&draftId=${draftId}` : ""}`
      : null,
  );
  // Fetched only for the tab that needs it — four of the five tabs are pivots
  // of the payload above and asking for the curriculum to render them would be
  // a request nobody reads (§14).
  const { data: lessons } = useApi<LessonsPayload>(
    current && tab === "lesson" ? `/timetable-configs/${current.id}/lessons` : null,
  );

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
    : (lessons?.sections ?? []).map((s) => ({ key: s.id, label: s.label }));
  const visibleRows = q ? rows.filter((r) => r.label.toLowerCase().includes(q)) : rows;

  const teachingPeriodNumbers = new Set(
    columns.filter((p) => !p.isBreak && !p.isExtra && !p.isActivity && p.periodNumber !== null)
      .map((p) => p.periodNumber),
  );
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
              curriculum · a week of {lessons?.weekCapacity ?? "—"} periods
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

        <div style={{ flex: "1 1 auto", minWidth: 0, overflow: "auto", maxHeight: "74vh" }}>
          {tab === "lesson" ? (
            <LessonGrid lessons={lessons} visibleRows={visibleRows} colors={colors} />
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
                          <Cell key={`${d}:${i}`} events={cellEvents(here, tab)} describe={describe} />
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
 * "Event", not "lesson": §4.10 collapsing already happened in `eventsOf`, so
 * this component never has to know that a teacher's four rows can be one
 * lesson.
 */
function Cell({
  events,
  describe,
}: {
  events: SlotTuple[][];
  describe: (event: SlotTuple[]) => CellFace;
}) {
  const base: React.CSSProperties = {
    borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
    height: 22, textAlign: "center", overflow: "hidden", whiteSpace: "nowrap",
    fontSize: 9, fontFamily: "var(--font-mono)", padding: 0,
  };
  if (events.length === 0) {
    return <td style={{ ...base, color: "var(--ink-faint)" }} />;
  }
  if (events.length === 1) {
    const face = describe(events[0]);
    return (
      <td title={face.title} style={{
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
      title={all.map((a) => a.title).join("\n")}
      style={{ ...base, background: "var(--steel-pale)", color: "var(--brand)", fontWeight: 800 }}
    >
      {events.length}
    </td>
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
  lessons,
  visibleRows,
  colors,
}: {
  lessons: LessonsPayload | null;
  visibleRows: Array<{ key: number; label: string }>;
  colors: ReturnType<typeof useColors>;
}) {
  const byClass = useMemo(() => {
    const m = new Map<string, number>();
    for (const [classId, subjectId, periods] of lessons?.cells ?? []) {
      m.set(`${classId}:${subjectId}`, periods);
    }
    return m;
  }, [lessons]);

  if (!lessons) return <p className="screen-sub" style={{ padding: 20 }}>Loading the curriculum…</p>;
  const classOfSection = new Map(lessons.sections.map((s) => [s.id, s.classId]));
  const subjects = lessons.subjects;
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
          // Over the week this timetable actually offers. Not a blocker and not
          // a score — Readiness owns that verdict (§4); this only says out loud
          // that the arithmetic on this row does not fit, at the moment
          // somebody is looking at the row.
          const over = lessons.weekCapacity > 0 && total > lessons.weekCapacity;
          return (
            <tr key={row.key}>
              <th title={row.label} style={rowTh}>{row.label}</th>
              {subjects.map((s, i) => {
                const n = cells[i];
                const sw = n > 0 ? colors.subject(s.name) : null;
                return (
                  <td key={s.id} title={n > 0 ? `${row.label} · ${s.name} · ${n} periods a week` : `${row.label} does not take ${s.name}`} style={{
                    borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                    height: 22, textAlign: "center", fontSize: 9.5, fontFamily: "var(--font-mono)",
                    fontWeight: n > 0 ? 700 : 400, padding: 0,
                    background: sw?.bg ?? "var(--paper)", color: sw?.fg ?? "var(--ink-faint)",
                  }}>
                    {/* A blank, not a zero. Zero periods and "this class does
                        not take this subject" are the same fact here (§27.15
                        made not-taken a real deletion), and a grid of zeros
                        would hide the numbers that matter. */}
                    {n > 0 ? n : ""}
                  </td>
                );
              })}
              <td title={`${total} of ${lessons.weekCapacity} periods a week`} style={{
                borderBottom: "1px solid var(--line)", height: 22, textAlign: "center",
                fontSize: 9.5, fontFamily: "var(--font-mono)", fontWeight: 800, padding: 0,
                background: over ? "var(--signal-bg, #FBE9E7)" : "var(--offwhite)",
                color: over ? "var(--signal)" : "var(--brand-deep)",
              }}>
                {total}{over ? "!" : ""}
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
