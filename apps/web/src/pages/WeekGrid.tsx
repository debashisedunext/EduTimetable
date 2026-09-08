/** Shared weekly-grid renderer for §10 reports and the teacher's My views:
 *  Day columns × Period rows, breaks shaded, free periods marked, substitute
 *  cells highlighted. Print-friendly (the Reports screen prints this). */
import { useColors } from "../colors";

export interface GridCell {
  subject: string | null;
  teacher: string | null;
  room: string | null;
  classSection: string | null;
  substituted: boolean;
  duty?: boolean;
  /** §4.9 — a split-elective cell: several lessons running in this one slot,
   *  each with its own subject, teacher and room. Every member section of the
   *  block shows the same list. */
  blockName?: string | null;
  electiveOptions?: Array<{ subject: string | null; teacher: string | null; room: string | null; substituted: boolean }>;
}
export interface GridPayload {
  kind: "class-section" | "teacher";
  label: string;
  date?: string | null;
  workingDays: number[];
  dayNames: string[];
  periods: {
    periodNumber: number | null; startTime: string; endTime: string | null;
    isBreak: boolean; breakName: string | null;
    /** §28.3/28.4 — a staffed band either side of the teaching day. */
    isActivity?: boolean; activityTeacher?: string | null; activityRoom?: string | null;
  }[];
  grid: Record<string, GridCell>;
  classTeacher?: string | null;
  weeklyLoad?: number;
  maxPeriodsPerWeek?: number;
}

export function WeekGrid({ data }: { data: GridPayload }) {
  const rows = data.periods.filter((p) => p.periodNumber !== 0);
  // §10.5 — colour the thing the cell is ABOUT. A class's grid headlines the
  // subject; a teacher's headlines the class they are with. So the fill follows
  // the headline rather than being a second, competing signal.
  const colors = useColors();
  const swatchFor = (cell: GridCell) =>
    data.kind === "teacher" ? colors.classOf(cell.classSection) : colors.subject(cell.subject);
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
      <thead>
        <tr>
          <th style={th}>Period</th>
          {data.dayNames.map((d) => <th key={d} style={th}>{d}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((p, ri) =>
          /*
            §28.3/28.4 — a full-width band like a break, but carrying who is on
            duty and where. That difference is the entire feature: a break is
            unstaffed by definition, and an assembly with nobody named on it is
            a school still deciding rather than a school with nobody there.
          */
          p.isActivity ? (
            <tr key={`a${ri}`}>
              <td colSpan={data.workingDays.length + 1} style={{
                padding: "5px 10px", textAlign: "center", fontSize: 10.5, letterSpacing: "0.06em",
                textTransform: "uppercase", color: "var(--accent)", fontWeight: 700,
                background: "var(--accent-bg)", border: "1px solid var(--line)",
                borderLeft: "3px solid var(--accent)",
              }}>
                {p.breakName ?? "Activity"} · {p.startTime}–{p.endTime}
                {p.activityTeacher ? ` · ${p.activityTeacher}` : ""}
                {p.activityRoom ? ` · ${p.activityRoom}` : ""}
              </td>
            </tr>
          ) : p.isBreak ? (
            <tr key={`b${ri}`}>
              <td colSpan={data.workingDays.length + 1} style={{
                padding: "5px 10px", textAlign: "center", fontSize: 10, letterSpacing: "0.08em",
                textTransform: "uppercase", color: "var(--ink-faint)",
                background: "repeating-linear-gradient(45deg, var(--offwhite), var(--offwhite) 5px, #e9eef7 5px, #e9eef7 10px)",
                border: "1px solid var(--line)",
              }}>
                {p.breakName ?? "Break"} · {p.startTime}–{p.endTime}
              </td>
            </tr>
          ) : (
            <tr key={`p${ri}`}>
              <td style={{ ...td, whiteSpace: "nowrap", fontWeight: 700, color: "var(--steel)" }}>
                P{p.periodNumber}
                <div style={{ fontSize: 9.5, fontWeight: 400, color: "var(--ink-faint)", fontFamily: "var(--font-mono)" }}>
                  {p.startTime}–{p.endTime}
                </div>
              </td>
              {data.workingDays.map((d) => {
                const cell = data.grid[`${d}:${p.periodNumber}`];
                if (!cell) {
                  return (
                    <td key={d} style={{ ...td, background: "var(--offwhite)", color: "var(--ink-faint)", fontStyle: "italic", textAlign: "center" }}>
                      Free
                    </td>
                  );
                }
                // §4.9: one slot, several lessons. The whole point of the cell
                // is that it names every option — a parent reading a printed
                // timetable has to see which language their child is in, and
                // which teacher and room that is.
                const options = cell.electiveOptions ?? [];
                if (options.length > 0) {
                  // §4.9: a block is several subjects at once, so no single
                  // subject colour is truthful. It keeps the steel tint that
                  // has always marked "this cell is shared".
                  return (
                    <td key={d} style={{ ...td, background: cell.substituted ? "var(--accent-bg)" : "var(--steel-pale)" }}>
                      <div style={{ fontWeight: 700 }}>
                        {cell.blockName ?? cell.subject} ⋔
                      </div>
                      {options.map((o, i) => (
                        <div key={i} style={{ fontSize: 10.5, color: o.substituted ? "var(--accent)" : "var(--ink-soft, var(--ink-faint))" }}>
                          <b style={{ fontWeight: 600 }}>{o.subject}</b>
                          {o.teacher ? ` — ${o.teacher}` : ""}
                          {o.room ? ` (${o.room})` : ""}
                          {o.substituted ? " ↺" : ""}
                        </div>
                      ))}
                    </td>
                  );
                }
                // A substituted cell keeps its cyan: on a cover sheet "what
                // changed today" outranks which subject it is, and a colour
                // code that hid that would be actively unhelpful.
                const sw = cell.substituted ? null : swatchFor(cell);
                return (
                  <td key={d} style={{
                    ...td,
                    background: cell.substituted ? "var(--accent-bg)" : sw?.bg ?? "var(--paper)",
                    ...(sw ? { borderColor: sw.border } : {}),
                  }}>
                    <div style={{ fontWeight: 700, color: sw?.fg }}>
                      {data.kind === "teacher" ? cell.classSection : cell.subject}
                      {cell.substituted ? " ↺" : ""}
                    </div>
                    <div style={{ fontSize: 10.5, color: cell.substituted ? "var(--accent)" : sw ? sw.fg : "var(--ink-faint)", opacity: sw ? 0.78 : 1 }}>
                      {data.kind === "teacher" ? cell.subject : cell.teacher}
                      {cell.room ? ` · ${cell.room}` : ""}
                      {cell.duty ? " · covering" : ""}
                    </div>
                  </td>
                );
              })}
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

const th: React.CSSProperties = {
  border: "1px solid var(--line)", background: "var(--steel-pale)", color: "var(--brand)",
  padding: "7px 10px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left",
};
const td: React.CSSProperties = { border: "1px solid var(--line)", padding: "6px 10px", verticalAlign: "top", height: 44 };
