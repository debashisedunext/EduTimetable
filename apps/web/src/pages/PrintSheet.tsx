/**
 * §10 — one printable page: a masthead, the facts a reader needs, and the week.
 *
 * A printed timetable leaves the app. It goes on a staffroom wall, into a
 * parent's hand, into a file. So it has to say on its own face which school it
 * belongs to, which class or teacher it describes, which timetable it came
 * from and when it was produced — none of which the screen has to say, because
 * on screen all of that is in the chrome around it.
 */
import type { MeResponse } from "@edutimetable/shared";
import { WeekGrid, type GridPayload } from "./WeekGrid";

const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export interface PrintContext {
  me: MeResponse | null;
  /** the timetable config these grids belong to */
  timetableName?: string | null;
  /**
   * §30.5 — the dates that timetable applies over, already formatted, or null
   * for one that runs the whole session. On paper this matters more than
   * anywhere else: a printed sheet outlives the screen it came from, and two
   * terms' timetables for one class are indistinguishable without it.
   */
  timetableWindow?: string | null;
  /** when the batch was produced — one stamp for every sheet of a run */
  printedAt: Date;
}

function Masthead({ ctx, title }: { ctx: PrintContext; title: string }) {
  const school = ctx.me?.school;
  return (
    <div className="print-head">
      {school?.logoUrl ? (
        // A school that has uploaded a logo gets it; one that has not gets its
        // initials rather than a broken image or an apologetic gap.
        <img src={school.logoUrl} alt="" />
      ) : (
        <div
          aria-hidden
          style={{
            height: 46, width: 46, borderRadius: 9, background: "var(--brand-deep)", color: "#fff",
            display: "grid", placeItems: "center", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 17,
          }}
        >
          {(school?.shortName || school?.name || "TT").slice(0, 2).toUpperCase()}
        </div>
      )}
      <div>
        <div className="school">{school?.name ?? "Timetable"}</div>
        <div className="sub">
          {ctx.timetableName ? `${ctx.timetableName}${ctx.timetableWindow ? ` (${ctx.timetableWindow})` : ""} · ` : ""}
          {title}
        </div>
      </div>
      <div className="right">
        Generated
        <br />
        {ctx.printedAt.toLocaleString(undefined, {
          day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
        })}
      </div>
    </div>
  );
}

const TITLES: Record<string, string> = {
  teacher: "Teacher Weekly Timetable",
  "class-section": "Class Weekly Timetable",
  room: "Room Weekly Timetable",
  subject: "Subject Across the Week",
};

/**
 * One sheet. `grid` is the same payload the screen renders, so a printed week
 * can never disagree with the one on screen — including §4.9 electives, which
 * print every option with its teacher and room.
 */
export function PrintSheet({ ctx, grid }: { ctx: PrintContext; grid: GridPayload }) {
  const isTeacher = grid.kind === "teacher";
  const title = TITLES[grid.kind] ?? "Weekly Timetable";
  // §28.3 — an activity has no period number, so "Periods/day" already
  // excludes it. Named rather than relied on: an assembly is not a period, and
  // the day it acquires a number by accident this should still be true.
  const periods = grid.periods.filter(
    (p) => !p.isBreak && !p.isActivity && p.periodNumber !== null && p.periodNumber !== 0);
  const filled = Object.keys(grid.grid).length;
  /*
    §10.6 — "periods/day" is only a number on a single-wing sheet. A card
    spanning two wings has both wings' rows, so dividing by it would print a
    denominator nobody can check. Those sheets say how many rows there are and
    which wings they came from instead.
  */
  const manyWings = (grid.wings?.length ?? 0) > 1;

  return (
    <section className="print-sheet">
      <Masthead ctx={ctx} title={title} />

      <div className="print-title">{grid.label}</div>
      <div className="print-meta">
        {isTeacher ? (
          <>
            <span>
              <b>Weekly load:</b> {grid.weeklyLoad ?? 0}
              {grid.maxPeriodsPerWeek ? ` of ${grid.maxPeriodsPerWeek}` : ""} periods
            </span>
            <span><b>Free periods:</b> {Math.max(0, grid.workingDays.length * periods.length - filled)}</span>
          </>
        ) : grid.kind === "room" ? (
          <>
            <span><b>Type:</b> {grid.roomType ?? "room"}</span>
            <span><b>Periods occupied:</b> {filled}</span>
          </>
        ) : grid.kind === "subject" ? (
          <>
            <span><b>Lessons a week:</b> {grid.weeklyLessons ?? 0}</span>
            <span><b>Busiest period:</b> {grid.busiest ?? 0} sections at once</span>
          </>
        ) : (
          <>
            <span><b>Class teacher:</b> {grid.classTeacher ?? "not assigned"}</span>
            <span><b>Periods scheduled:</b> {filled} of {grid.workingDays.length * periods.length}</span>
          </>
        )}
        <span><b>Days:</b> {grid.workingDays.map((d) => DAY_NAMES[d]).join(", ")}</span>
        {manyWings
          ? <span><b>Wings:</b> {grid.wings!.map((w) => w.name).join(", ")}</span>
          : <span><b>Periods/day:</b> {periods.length}</span>}
        {grid.date && (
          // Not decoration: a dated sheet shows that day's cover, so a reader
          // must be able to tell it apart from the standing timetable.
          <span><b>Substitutions overlaid for:</b> {grid.date}</span>
        )}
      </div>

      <WeekGrid data={grid} />

      <div className="print-foot">
        <span>
          {grid.date
            ? "Includes substitutions for the date shown — not the standing timetable."
            : "Standing timetable. Day-specific substitutions are not shown."}
        </span>
        <span>{ctx.me?.school?.name ?? ""}</span>
      </div>
    </section>
  );
}
