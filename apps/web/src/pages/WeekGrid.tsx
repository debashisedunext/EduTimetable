/** Shared weekly-grid renderer for §10 reports and the teacher's My views:
 *  Day columns × Period rows, breaks shaded, free periods marked, substitute
 *  cells highlighted. Print-friendly (the Reports screen prints this). */

export interface GridCell {
  subject: string | null;
  teacher: string | null;
  room: string | null;
  classSection: string | null;
  substituted: boolean;
  duty?: boolean;
}
export interface GridPayload {
  kind: "class-section" | "teacher";
  label: string;
  date?: string | null;
  workingDays: number[];
  dayNames: string[];
  periods: { periodNumber: number | null; startTime: string; endTime: string | null; isBreak: boolean; breakName: string | null }[];
  grid: Record<string, GridCell>;
  classTeacher?: string | null;
  weeklyLoad?: number;
  maxPeriodsPerWeek?: number;
}

export function WeekGrid({ data }: { data: GridPayload }) {
  const rows = data.periods.filter((p) => p.periodNumber !== 0);
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
          p.isBreak ? (
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
                return (
                  <td key={d} style={{ ...td, background: cell.substituted ? "var(--accent-bg)" : "var(--paper)" }}>
                    <div style={{ fontWeight: 700 }}>
                      {data.kind === "teacher" ? cell.classSection : cell.subject}
                      {cell.substituted ? " ↺" : ""}
                    </div>
                    <div style={{ fontSize: 10.5, color: cell.substituted ? "var(--accent)" : "var(--ink-faint)" }}>
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
