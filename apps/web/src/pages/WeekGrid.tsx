/** Shared weekly-grid renderer for §10 reports and the teacher's My views:
 *  Day columns × Period rows, breaks shaded, free periods marked, substitute
 *  cells highlighted. Print-friendly (the Reports screen prints this). */
import { useColors } from "../colors-context";

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
  /** §10.6 — the slots behind this cell, so a wall can highlight one lesson
   *  everywhere it appears. Strings: slot ids are BigInt. */
  slotIds?: string[];
  /** §10.6 — a subject card's cell is a count, not a lesson (see the service). */
  count?: number;
  sections?: string[];
}

/**
 * §10.6 — one row, identified by `key` rather than by its period number.
 *
 * A period number stopped being an identity the moment a card could span two
 * wings (§3.10): Primary's P3 and Senior's P3 are different rows at different
 * times, and `grid` is a flat map. The key is built once, on the server.
 */
export interface GridRow {
  key: string;
  configId: number;
  wing: string;
  periodNumber: number | null;
  startTime: string;
  endTime: string | null;
  isBreak: boolean;
  breakName: string | null;
  /** §28.3/28.4 — a staffed band either side of the teaching day. */
  isActivity?: boolean;
  activityTeacher?: string | null;
  activityRoom?: string | null;
}

export interface GridPayload {
  kind: "class-section" | "teacher" | "room" | "subject";
  label: string;
  date?: string | null;
  workingDays: number[];
  dayNames: string[];
  periods: GridRow[];
  /** The wings this card spans. More than one means the rows interleave by clock.
   *  §30.5 — each carries its own validity window, because two wings on one card
   *  may apply over different dates. */
  wings?: Array<{ id: number; name: string; effectiveFrom?: string | null; effectiveTo?: string | null }>;
  /**
   * §34.6 — how far each day reaches, where that is not the whole row axis.
   *
   * A school running a short Saturday keeps ONE row axis and hatches the
   * periods Saturday does not have, rather than splitting the card or growing
   * a second header. Present only for days that differ, so a uniform week is
   * exactly what it was.
   */
  dayReach?: Record<number, number>;
  /** That day's own clock, where its period length differs from the axis. */
  dayClock?: Record<number, Record<number, [string, string]>>;
  grid: Record<string, GridCell>;
  classTeacher?: string | null;
  weeklyLoad?: number;
  maxPeriodsPerWeek?: number;
  roomType?: string | null;
  /** Subject cards: the busiest cell, so the heat scale is the server's, not the renderer's guess. */
  busiest?: number;
  weeklyLessons?: number;
}

export function WeekGrid({ data }: { data: GridPayload }) {
  const rows = data.periods.filter((p) => p.periodNumber !== 0);
  // §10.5 — colour the thing the cell is ABOUT. A class's grid headlines the
  // subject; a teacher's and a room's headline the class they are with. So the
  // fill follows the headline rather than being a second, competing signal.
  const colors = useColors();
  const headlinesClass = data.kind === "teacher" || data.kind === "room";
  const swatchFor = (cell: GridCell) =>
    headlinesClass ? colors.classOf(cell.classSection) : colors.subject(cell.subject);
  /*
    §10.6 — a card that spans two wings has two wings' period numbers in it, so
    "P3" alone stops being an answer. The wing rides in the period column, and
    only then: on the single-wing card that every school had before this, the
    column is exactly what it was.
  */
  const manyWings = (data.wings?.length ?? 0) > 1;
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
                {manyWings && (
                  <div style={{ fontSize: 9, fontWeight: 600, color: "var(--brand)" }}>{p.wing}</div>
                )}
              </td>
              {data.workingDays.map((d) => {
                /*
                  §34.6 — a period this day does not have.

                  Hatched and unlabelled rather than left blank: "Free" would
                  say the class is in school with nothing timetabled, which is
                  a different and wronger statement than "school has finished".
                  Checked BEFORE the cell lookup, because a stale slot at a
                  period a day has since lost must not print as a lesson.
                */
                const reach = data.dayReach?.[d];
                if (reach !== undefined && p.periodNumber !== null && p.periodNumber > reach) {
                  return (
                    <td key={d} aria-label="not a teaching period on this day" style={{
                      ...td, textAlign: "center", color: "var(--ink-faint)", fontSize: 10,
                      background:
                        "repeating-linear-gradient(135deg, var(--offwhite), var(--offwhite) 6px, var(--line) 6px, var(--line) 7px)",
                    }} />
                  );
                }
                /*
                  §34.6 — and where this day's clock differs from the axis, the
                  cell carries its own time.

                  The row header can only show one clock, and it shows the
                  week's. Printing a Saturday lesson against Monday's minutes
                  would be a false statement on the one document a parent
                  actually reads, so the day that differs says so in the cell.
                */
                const own = p.periodNumber !== null ? data.dayClock?.[d]?.[p.periodNumber] : undefined;
                const ownTime = own && (own[0] !== p.startTime || own[1] !== p.endTime)
                  ? <div style={{ fontSize: 8.5, color: "var(--ink-faint)", fontFamily: "var(--font-mono)" }}>{own[0]}–{own[1]}</div>
                  : null;
                const cell = data.grid[`${d}:${p.key}`];
                if (!cell) {
                  return (
                    <td key={d} style={{ ...td, background: "var(--offwhite)", color: "var(--ink-faint)", fontStyle: "italic", textAlign: "center" }}>
                      Free
                      {ownTime}
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
                      {ownTime}
                    </td>
                  );
                }
                /*
                  §10.6 — a subject cell is a COUNT.

                  Headlining `cell.subject` here would print the same word in
                  every filled cell, which tells the reader nothing they did not
                  know from the card's title. What they came for is *how much*
                  and *who*, so the number leads and the sections follow. The
                  tint is the count against the card's own busiest cell, sent by
                  the server — a renderer that computed its own scale would make
                  two subject cards incomparable.
                */
                if (cell.count !== undefined) {
                  const heat = Math.min(1, cell.count / Math.max(1, data.busiest ?? 1));
                  return (
                    <td key={d} title={(cell.sections ?? []).join(", ")} style={{
                      ...td,
                      background: `color-mix(in srgb, var(--brand) ${Math.round(14 + heat * 46)}%, var(--paper))`,
                    }}>
                      <div style={{
                        fontWeight: 700, fontFamily: "var(--font-mono)", fontSize: 13,
                        color: heat > 0.55 ? "#fff" : "var(--brand-dark)",
                      }}>
                        {cell.count}
                      </div>
                      <div style={{
                        fontSize: 10, lineHeight: 1.3,
                        color: heat > 0.55 ? "rgba(255,255,255,.85)" : "var(--ink-soft)",
                      }}>
                        {(cell.sections ?? []).slice(0, 3).join(", ")}
                        {(cell.sections?.length ?? 0) > 3 ? ` +${(cell.sections!.length - 3)}` : ""}
                      </div>
                      {ownTime}
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
                      {headlinesClass ? cell.classSection : cell.subject}
                      {cell.substituted ? " ↺" : ""}
                    </div>
                    <div style={{ fontSize: 10.5, color: cell.substituted ? "var(--accent)" : sw ? sw.fg : "var(--ink-faint)", opacity: sw ? 0.78 : 1 }}>
                      {/* A room's card wants both — which class, and who is
                          taking them. A teacher's already knows who. */}
                      {data.kind === "room"
                        ? [cell.subject, cell.teacher].filter(Boolean).join(" · ")
                        : data.kind === "teacher" ? cell.subject : cell.teacher}
                      {cell.room ? ` · ${cell.room}` : ""}
                      {cell.duty ? " · covering" : ""}
                    </div>
                    {ownTime}
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
