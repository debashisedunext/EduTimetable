import { useMemo, useState } from "react";
import { useApi, useConfigCtx } from "../hooks";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface SlotsPayload {
  status: string;
  workingDays: number[];
  periods: { periodNumber: number | null; startTime: string; isBreak: boolean; breakName: string | null; isExtra?: boolean }[];
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
  const { data } = useApi<SlotsPayload>(
    current
      ? `/timetable-configs/${current.id}/slots?status=${status}${status === "published" && date ? `&date=${date}` : ""}`
      : null,
  );
  const [dimension, setDimension] = useState<"section" | "teacher">("section");
  const [search, setSearch] = useState("");

  const index = useMemo(() => {
    if (!data) return null;
    const bySection = new Map<string, (typeof data.slots)[number]>();
    const byTeacher = new Map<string, (typeof data.slots)[number]>();
    for (const s of data.slots) {
      bySection.set(`${s[0]}@${s[1]}:${s[2]}`, s);
      if (s[4] !== null) byTeacher.set(`${s[4]}@${s[1]}:${s[2]}`, s);
    }
    return { bySection, byTeacher };
  }, [data]);

  if (!current) return <p className="screen-sub">Select a timetable first.</p>;
  if (!data || !index) return <p className="screen-sub">Loading matrix…</p>;

  // §18: the extra window is teaching, but it is not what the timetable has to
  // fill — counting it would make a full grid look under-allocated.
  const teachingPeriods = data.periods.filter(
    (p) => !p.isBreak && !p.isExtra && p.periodNumber !== 0 && p.periodNumber !== null,
  );
  const capacity = data.sections.length * data.workingDays.length * teachingPeriods.length;
  const filled = data.slots.length;

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
    if (block) {
      return {
        main: abbr(block.name),
        sub: `${block.options.length} options`,
        merged: false,
        elective: true,
        locked: locked === 1,
        substituted: false,
        room: null,
        title: `${block.name}\n${block.options.map((o) => `${o.subject} — ${o.teacher} (${o.room})`).join("\n")}`,
      };
    }
    return {
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
          <span className="chip mono">{data.status}</span>
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
                    background: p.isBreak ? "var(--offwhite)" : p.isExtra ? "var(--amber-bg, #FDF4E3)" : "var(--steel-pale)",
                    color: p.isExtra ? "var(--amber)" : "var(--brand)", padding: "5px 3px", fontSize: 9.5, fontFamily: "var(--font-mono)",
                    minWidth: p.isBreak ? 30 : 62,
                    borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                    borderLeft: p.isExtra ? "2px solid var(--amber)" : undefined,
                  }} title={p.isExtra ? "Extra-class window — after the school day" : undefined}>
                    {p.isBreak ? "Brk" : p.isExtra ? `X${p.periodNumber}` : `P${p.periodNumber}`}
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
                    const cell = cellFor(row.key, d, p.periodNumber as number);
                    return (
                      <td key={`${d}:${i}`} title={cell?.title ?? (cell?.substituted ? `Substitute teacher on ${date}` : (cell?.room ?? undefined))} style={{
                        padding: "5px 7px", minWidth: 62, height: 44, verticalAlign: "middle",
                        borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)",
                        background: cell?.substituted ? "var(--accent-bg)" : cell?.elective ? "var(--brand-pale, var(--steel-pale))" : cell?.merged ? "var(--steel-pale)" : p.isExtra ? "var(--amber-bg, #FDF4E3)" : "var(--paper)",
                        borderLeft: p.isExtra ? "2px solid var(--amber)" : undefined,
                      }}>
                        {cell ? (
                          <>
                            <div style={{ fontWeight: 700, fontSize: 11 }}>
                              {cell.main}{cell.elective ? " ⋔" : ""}{cell.merged ? " 🔗" : ""}{cell.locked ? " 🔒" : ""}{cell.substituted ? " ↺" : ""}
                            </div>
                            <div style={{ fontSize: 9.5, color: cell.substituted ? "var(--accent)" : "var(--ink-faint)", fontWeight: cell.substituted ? 700 : 400 }}>{cell.sub}</div>
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
