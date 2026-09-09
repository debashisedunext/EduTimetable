import { useMemo, useState } from "react";
import { useApi, useConfigCtx } from "../hooks";
import { useColors } from "../colors-context";

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
  /** which draft the server actually served — its answer when we sent none */
  draftId: number | null;
  workingDays: number[];
  periods: {
    periodNumber: number | null; startTime: string; endTime?: string;
    isBreak: boolean; breakName: string | null; isExtra?: boolean;
    /** §28.3/28.4 — assembly, dispersal: a staffed band, not a break. */
    isActivity?: boolean; activityTeacher?: string | null; activityRoom?: string | null;
  }[];
  sections: { id: number; label: string }[];
  subjects: Record<string, string>;
  teachers: Record<string, string>;
  rooms: Record<string, string>;
  /** §4.9 split electives, keyed by block id — the parallel lessons in one slot */
  blocks: Record<string, { name: string; options: { subject: string; teacher: string; room: string }[] }>;
  /** [classSectionId, day, period, subjectId, teacherId, roomId, mergedGroupId, locked, substituted, electiveBlockId] */
  slots: Array<Array<number | null>>;
}

const short = (name: string) =>
  name.length <= 5 ? name : name.split(" ").map((w) => w[0] + ".").join("").slice(0, 6);
const abbr = (subject: string) => (subject.length <= 5 ? subject : subject.slice(0, 4));

/** Screen 3 (§8.3): the full slot grid, By Class-Section / By Teacher, sticky
 *  headers. Data is the compact cached endpoint (§14 budget). */
export function Matrix() {
  const { current } = useConfigCtx();
  const [status, setStatus] = useState<"draft" | "published">("draft");
  const [date, setDate] = useState("");
  // §22 — which named draft this matrix is reading. `null` means "the config's
  // current one", which is what the server resolves when the parameter is
  // absent, so a single-draft school sees exactly what it saw before.
  const [draftId, setDraftId] = useState<number | null>(null);
  const { data: drafts } = useApi<DraftRow[]>(
    current ? `/timetable-configs/${current.id}/drafts` : null,
  );
  const { data } = useApi<SlotsPayload>(
    current
      ? `/timetable-configs/${current.id}/slots?status=${status}` +
        `${status === "published" && date ? `&date=${date}` : ""}` +
        // A draft id is meaningless on the published view: there is exactly one
        // published set per config however many drafts it was promoted from
        // (§22.2), so sending it would ask a question with no answer.
        `${status === "draft" && draftId !== null ? `&draftId=${draftId}` : ""}`
      : null,
  );
  const [dimension, setDimension] = useState<"section" | "teacher">("section");
  const colors = useColors();
  const [search, setSearch] = useState("");

  const index = useMemo(() => {
    if (!data) return null;
    const bySection = new Map<string, (typeof data.slots)[number]>();
    const byTeacher = new Map<string, (typeof data.slots)[number]>();
    for (const s of data.slots) {
      // §4.9 invariant 9, applied per dimension. A section grid wants cells:
      // an option row has no section and must not become one. A teacher grid
      // wants lessons: an option row IS this teacher's lesson, and dropping it
      // leaves a language teacher's whole week blank. Member rows carry no
      // teacher, so they fall out of `byTeacher` on their own.
      if (s[0] !== null) bySection.set(`${s[0]}@${s[1]}:${s[2]}`, s);
      if (s[4] !== null) byTeacher.set(`${s[4]}@${s[1]}:${s[2]}`, s);
    }
    return { bySection, byTeacher };
  }, [data]);

  if (!current) return <p className="screen-sub">Select a timetable first.</p>;
  if (!data || !index) return <p className="screen-sub">Loading matrix…</p>;

  const liveDrafts = (drafts ?? []).filter((d) => d.status !== "discarded");
  // Show the draft the SERVER chose until the reader picks one. Guessing
  // "the newest" here would disagree with `DraftsService.currentId`, which
  // prefers the newest draft that actually has rows — and the picker would
  // then name a different draft from the one on screen.
  const shownDraftId = draftId ?? data.draftId ?? null;
  const shownDraft = liveDrafts.find((d) => d.id === shownDraftId) ?? null;

  // §18: the extra window is teaching, but it is not what the timetable has to
  // fill — counting it would make a full grid look under-allocated.
  const teachingPeriods = data.periods.filter(
    // §28.3 — an activity has no period number, so it is already excluded by
    // the last clause. Named anyway: the day it gains one by accident, this
    // reads as the intent rather than as luck.
    (p) => !p.isBreak && !p.isExtra && !p.isActivity && p.periodNumber !== 0 && p.periodNumber !== null,
  );
  const capacity = data.sections.length * data.workingDays.length * teachingPeriods.length;
  // Numerator and denominator must count the same thing. `capacity` is built
  // from `teachingPeriods`, so `filled` counts only slots inside them: option
  // rows occupy no section cell, and §18 extra classes sit in periods this
  // capacity deliberately excludes. Counting either produced a fill rate over
  // 100% — School 2 read "2241 of 2240" from one leftover revision class.
  const teachingPeriodNumbers = new Set(teachingPeriods.map((p) => p.periodNumber));
  const filled = data.slots.filter((s) => s[0] !== null && teachingPeriodNumbers.has(s[2])).length;

  const q = search.trim().toLowerCase();
  const rows: { key: number; label: string }[] =
    dimension === "section"
      ? data.sections.map((s) => ({ key: s.id, label: s.label }))
      : Object.entries(data.teachers).map(([id, name]) => ({ key: Number(id), label: name }));
  const visibleRows = q
    ? rows.filter((r) => r.label.toLowerCase().includes(q))
    : rows;

  const cellFor = (rowKey: number, day: number, period: number) => {
    const s = dimension === "section"
      ? index.bySection.get(`${rowKey}@${day}:${period}`)
      : index.byTeacher.get(`${rowKey}@${day}:${period}`);
    if (!s) return null;
    const [csId, , , subjectId, teacherId, roomId, mergedGroupId, locked, substituted, blockId] = s;
    // A §4.9 elective cell has no subject or teacher of its own: the section's
    // students split across the block's options. Show the block, and list the
    // choices on hover — "blank with a tooltip" would read as a gap in the grid.
    const block = blockId !== null && blockId !== undefined ? data.blocks?.[String(blockId)] : undefined;
    // In a TEACHER's row the question is what this person is doing, and the
    // answer is one option, not all of them: Pranav Banerjee teaches French in
    // Room 41 while two colleagues teach Sanskrit and German in the same slot.
    // Listing the block's whole menu here would credit him with their lessons.
    if (block && csId === null) {
      return {
        // §10.5: this teacher takes ONE option, so the cell is truthfully that
        // subject's colour — unlike the section-row version below, which is the
        // whole menu and belongs to no single subject.
        colorKey: data.subjects[String(subjectId)] ?? null,
        main: abbr(data.subjects[String(subjectId)] ?? block.name),
        sub: `${short(block.name)}${roomId !== null ? ` · ${data.rooms[String(roomId)] ?? ""}` : ""}`,
        merged: false,
        elective: true,
        locked: locked === 1,
        substituted: substituted === 1,
        room: roomId !== null ? (data.rooms[String(roomId)] ?? null) : null,
        title: `${block.name}\nThis teacher takes ${data.subjects[String(subjectId)] ?? "one option"}${
          roomId !== null ? ` in ${data.rooms[String(roomId)] ?? ""}` : ""
        }\n\nRunning at the same time:\n${block.options
          .map((o) => `${o.subject} — ${o.teacher} (${o.room})`)
          .join("\n")}`,
      };
    }
    if (block) {
      return {
        colorKey: null,
        main: abbr(block.name),
        // The subjects themselves, not a count: "Fre / San / Ger" tells a
        // reader scanning the grid what the choice actually is, and a count
        // tells them nothing they could not see. Teachers and rooms stay on
        // the tooltip — this cell is one row of a 50×40 matrix.
        sub: block.options.map((o) => abbr(o.subject)).join(" / "),
        merged: false,
        elective: true,
        locked: locked === 1,
        substituted: false,
        room: null,
        title: `${block.name}\n${block.options.map((o) => `${o.subject} — ${o.teacher} (${o.room})`).join("\n")}`,
      };
    }
    return {
      // §10.5 — the FULL name, because `main` is abbreviated for the 50×40 grid
      // and "Mat" would not match the school's "Mathematics".
      colorKey: dimension === "section"
        ? (data.subjects[String(subjectId)] ?? null)
        : (data.sections.find((x) => x.id === csId)?.label ?? null),
      main: dimension === "section" ? abbr(data.subjects[String(subjectId)] ?? "?") : (data.sections.find((x) => x.id === csId)?.label ?? "?"),
      sub: dimension === "section" ? short(data.teachers[String(teacherId)] ?? "") : abbr(data.subjects[String(subjectId)] ?? "?"),
      merged: mergedGroupId !== null,
      elective: false,
      locked: locked === 1,
      substituted: substituted === 1,
      room: roomId !== null ? data.rooms[String(roomId)] : null,
      title: undefined as string | undefined,
    };
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {/* §22.5 — which draft this matrix is showing. First in the row, and
              only on the draft view, because it scopes everything after it. */}
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
          <select value={dimension} onChange={(e) => setDimension(e.target.value as any)}
            style={{ padding: "8px 11px", border: "1px solid var(--line)", borderRadius: 8, fontWeight: 600, fontSize: 13 }}>
            <option value="section">By Class-Section</option>
            <option value="teacher">By Teacher</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value as "draft" | "published")}
            style={{ padding: "8px 11px", border: "1px solid var(--line)", borderRadius: 8, fontWeight: 600, fontSize: 13 }}>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
          </select>
          {status === "published" && (
            <input type="date" title="Overlay this date's substitutions (§6)" value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{ padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12.5 }} />
          )}
          <input placeholder={`Search ${dimension === "section" ? "class" : "teacher"}…`} value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: "8px 12px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12.5, width: 210 }} />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <span className="chip mono">{filled} / {capacity} slots filled ({capacity ? Math.round((filled / capacity) * 100) : 0}%)</span>
          <span className="badge badge-ok">0 conflicts — DB-enforced</span>
          {/* Which week these numbers describe. "draft" alone stopped being an
              answer the moment a config could hold five of them. */}
          <span className="chip mono">
            {data.status}
            {status === "draft" && shownDraft ? ` #${shownDraft.draftNo}` : ""}
          </span>
        </div>
      </div>

      <div style={{ overflow: "auto", border: "1px solid var(--line)", borderRadius: 12, maxHeight: "70vh", background: "var(--paper)" }}>
        <table style={{ borderCollapse: "separate", borderSpacing: 0, fontSize: 11.5 }}>
          <thead>
            <tr>
              <th style={{ ...cornerTh }}>{dimension === "section" ? "Class-Section" : "Teacher"}</th>
              {data.workingDays.map((d) => (
                <th key={d} colSpan={data.periods.filter((p) => p.periodNumber !== 0).length}
                  style={{ position: "sticky", top: 0, zIndex: 3, background: "var(--brand)", color: "#fff", padding: "7px 4px", fontSize: 10.5, letterSpacing: "0.05em", borderRight: "2px solid var(--brand-dark)" }}>
                  {DAY_NAMES[d]}
                </th>
              ))}
            </tr>
            <tr>
              <th style={{ ...cornerTh, top: 29 }}></th>
              {data.workingDays.map((d) =>
                data.periods.filter((p) => p.periodNumber !== 0).map((p, i) => (
                  <th key={`${d}:${i}`} style={{
                    position: "sticky", top: 29, zIndex: 3,
                    background: p.isActivity ? "var(--accent-bg)" : p.isBreak ? "var(--offwhite)" : p.isExtra ? "var(--amber-bg, #FDF4E3)" : "var(--steel-pale)",
                    color: p.isActivity ? "var(--accent)" : p.isExtra ? "var(--amber)" : "var(--brand)",
                    padding: "5px 3px", fontSize: 9.5, fontFamily: "var(--font-mono)",
                    minWidth: p.isBreak ? 30 : p.isActivity ? 44 : 62,
                    borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                    borderLeft: p.isExtra ? "2px solid var(--amber)" : p.isActivity ? "2px solid var(--accent)" : undefined,
                  }} title={
                    p.isActivity
                      ? `${p.breakName} · ${p.startTime}–${p.endTime ?? ""}` +
                        (p.activityTeacher ? ` · ${p.activityTeacher}` : "") +
                        (p.activityRoom ? ` · ${p.activityRoom}` : "")
                      : p.isExtra ? "Extra-class window — after the school day" : undefined
                  }>
                    {p.isActivity ? (p.breakName ?? "Act").slice(0, 4)
                      : p.isBreak ? "Brk" : p.isExtra ? `X${p.periodNumber}` : `P${p.periodNumber}`}
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={row.key}>
                <td style={{
                  position: "sticky", left: 0, zIndex: 2, background: "var(--offwhite)", fontWeight: 700,
                  padding: "8px 12px", borderRight: "2px solid var(--line)", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap",
                }}>
                  {row.label}
                </td>
                {data.workingDays.map((d) =>
                  data.periods.filter((p) => p.periodNumber !== 0).map((p, i) => {
                    if (p.isBreak) {
                      return <td key={`${d}:${i}`} style={{ background: "repeating-linear-gradient(45deg, var(--offwhite), var(--offwhite) 5px, #E9EEF7 5px, #E9EEF7 10px)", borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)", minWidth: 30 }} />;
                    }
                    /*
                      §28.3/28.4 — the same band for every row, because it is.
                      An assembly is one event the whole wing attends; drawing
                      it per class-section as if each had its own would invite
                      somebody to try to change one of them.
                    */
                    if (p.isActivity) {
                      return (
                        <td key={`${d}:${i}`} style={{
                          background: "var(--accent-bg)", borderLeft: "2px solid var(--accent)",
                          borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                          minWidth: 44, textAlign: "center", fontSize: 9,
                          color: "var(--accent)", fontFamily: "var(--font-mono)",
                        }}>
                          {p.activityTeacher ?? "·"}
                        </td>
                      );
                    }
                    const cell = cellFor(row.key, d, p.periodNumber as number);
                    // Substitution keeps its cyan; a merged group keeps its 🔗
                    // and an elective its ⋔, so neither loses its marker by
                    // gaining a colour.
                    const sw = cell && !cell.substituted
                      ? (dimension === "section" ? colors.subject(cell.colorKey) : colors.classOf(cell.colorKey))
                      : null;
                    return (
                      <td key={`${d}:${i}`} title={cell?.title ?? (cell?.substituted ? `Substitute teacher on ${date}` : (cell?.room ?? undefined))} style={{
                        padding: "5px 7px", minWidth: 62, height: 44, verticalAlign: "middle",
                        borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                        background: cell?.substituted ? "var(--accent-bg)" : sw?.bg ?? (cell?.elective ? "var(--brand-pale, var(--steel-pale))" : cell?.merged ? "var(--steel-pale)" : p.isExtra ? "var(--amber-bg, #FDF4E3)" : "var(--paper)"),
                        borderLeft: p.isExtra ? "2px solid var(--amber)" : undefined,
                      }}>
                        {cell ? (
                          <>
                            <div style={{ fontWeight: 700, fontSize: 11, color: sw?.fg }}>
                              {cell.main}{cell.elective ? " ⋔" : ""}{cell.merged ? " 🔗" : ""}{cell.locked ? " 🔒" : ""}{cell.substituted ? " ↺" : ""}
                            </div>
                            <div style={{ fontSize: 9.5, color: cell.substituted ? "var(--accent)" : sw ? sw.fg : "var(--ink-faint)", opacity: sw ? 0.75 : 1, fontWeight: cell.substituted ? 700 : 400 }}>{cell.sub}</div>
                          </>
                        ) : (
                          <span style={{ color: "var(--ink-faint)", fontSize: 10 }}>—</span>
                        )}
                      </td>
                    );
                  }),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const cornerTh: React.CSSProperties = {
  position: "sticky", left: 0, top: 0, zIndex: 4, background: "var(--brand)", color: "#fff",
  padding: "7px 12px", fontSize: 10.5, textAlign: "left", whiteSpace: "nowrap",
};
