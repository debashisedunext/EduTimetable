/**
 * §38 — the guided setup's last step: what this timetable turned out to be.
 *
 * Every other step asks a question. This one answers them: how many lessons the
 * curriculum asked for, how many are on the wall, which classes came out short,
 * and who is teaching it. It appears once the timetable has a live publication
 * and is where the wizard opens from then on.
 *
 * ## Why it exists at all
 *
 * §24.9 made the point about the progress bar and it applies to the whole
 * flow: *finished is a state with something to say, not an absent bar.* A
 * wizard whose last step is "Settings" leaves a school that has just published
 * its year with nowhere to land, and with no screen that says plainly "this
 * worked, and here is what it produced".
 *
 * ## It renders; it does not calculate
 *
 * One payload, `GET /timetable-configs/:id/summary`, composed server-side from
 * the figures that already have owners — Check 1's per-section required,
 * `teacherWeeklyCapacity`, `crossConfigTeacherLoad`. Nothing is derived here
 * beyond a percentage of two numbers that arrived together, because a second
 * arithmetic on the client is how two screens end up quoting different totals
 * for one week.
 */
import type React from "react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";

interface ClassLine {
  id: number;
  label: string;
  required: number;
  placed: number;
  available: number;
}

interface TeacherLine {
  id: number;
  name: string;
  initials: string;
  periods: number;
  totalPeriods: number;
  otherTimetables: string[];
  capacity: number;
  loadPct: number | null;
  over: boolean;
}

export interface TimetableSummary {
  id: number;
  name: string;
  academicYear: string | null;
  where: string;
  published: boolean;
  version: number | null;
  publishedAt: string | null;
  frozenAt: string | null;
  totals: {
    classSections: number;
    teachers: number;
    required: number;
    placed: number;
    pct: number | null;
    capacity: number;
    rooms: number;
  };
  classes: ClassLine[];
  teachers: TeacherLine[];
}

/*
  The table idiom this app already uses (`TeacherRequirement.tsx`), not new
  classes: `.data-table` does not exist in `styles.css`, and adding a stylesheet
  rule for one screen is how two tables end up looking almost the same.
*/
const th: React.CSSProperties = {
  font: "800 9.5px/1 Inter", letterSpacing: "0.11em", textTransform: "uppercase",
  color: "var(--ink-faint)", padding: "9px 11px", borderBottom: "1px solid var(--line)",
  whiteSpace: "nowrap", textAlign: "left",
};
const thR: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = {
  padding: "8px 11px", borderBottom: "1px solid var(--offwhite)", color: "var(--ink-soft)",
};
const tdN: React.CSSProperties = {
  ...td, textAlign: "right", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
};

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—";

/** One headline number. */
function Stat({ n, label, tone }: { n: string; label: string; tone?: string }) {
  return (
    <div style={{
      background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 9,
      padding: "11px 14px", minWidth: 128, flex: "1 1 128px",
    }}>
      <div style={{
        font: "700 22px/1 Inter, sans-serif", color: tone ?? "var(--brand-dark)",
        fontVariantNumeric: "tabular-nums",
      }}>{n}</div>
      <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 4, letterSpacing: ".02em" }}>
        {label}
      </div>
    </div>
  );
}

/**
 * A bar that says how much of a row is done.
 *
 * `pct` is clamped for the WIDTH only — the number beside it is printed as it
 * came. An over-taught class really does read 110%, and a bar quietly stopping
 * at 100 while the figure says otherwise is the screen arguing with itself.
 */
function MiniBar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <div style={{
      height: 5, borderRadius: 3, background: "var(--steel-pale)", overflow: "hidden",
      minWidth: 52, flex: 1,
    }}>
      <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: "100%", background: tone }} />
    </div>
  );
}

export function StepSummary({ configId }: { configId: number | null }) {
  const [data, setData] = useState<TimetableSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (configId === null) { setData(null); return; }
    setError(null);
    api<TimetableSummary>(`/timetable-configs/${configId}/summary`)
      .then((d) => { if (live) setData(d); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [configId]);

  if (configId === null) {
    return <p className="screen-sub">Select a timetable above to see its summary.</p>;
  }
  if (error) {
    return <p className="screen-sub" style={{ color: "var(--signal)" }}>{error}</p>;
  }
  if (!data) return <p className="screen-sub">Working out what this timetable contains…</p>;

  const { totals } = data;
  const complete = totals.pct !== null && totals.pct >= 100;
  /*
    Short of the curriculum, per class — the only thing on this screen worth
    acting on. §31.7's rule in a different frame: a number that is always two
    numbers is a number nobody reads, so the classes that match are stated once
    at the top and only the differing ones are listed.
  */
  const short = data.classes.filter((c) => c.placed < c.required);
  const over = data.classes.filter((c) => c.placed > c.required);

  return (
    <div>
      <h2 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 22, margin: "0 0 4px" }}>
        {complete ? "This timetable is ready." : "Where this timetable stands"}
      </h2>
      <p className="screen-sub" style={{ marginBottom: 16 }}>
        {data.name}
        {data.academicYear ? ` · ${data.academicYear}` : ""}
        {data.published
          ? ` · published v${data.version} on ${fmtDate(data.publishedAt)}`
          : ` · not published yet — this describes ${data.where}`}
        {data.frozenAt ? " · locked" : ""}
      </p>

      {/* The headline four, the numbers somebody came here to read. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 9, marginBottom: 18 }}>
        <Stat n={totals.placed.toLocaleString()} label="Lessons placed" />
        <Stat n={totals.required.toLocaleString()} label="Lessons required" />
        <Stat
          n={totals.pct === null ? "—" : `${totals.pct}%`}
          label="Generated"
          tone={totals.pct === null ? undefined
            : totals.pct >= 100 ? "var(--accent)"
            : totals.pct >= 90 ? "var(--amber)" : "var(--signal)"}
        />
        <Stat n={String(totals.classSections)} label="Class-sections" />
        <Stat n={String(totals.teachers)} label="Teachers involved" />
        <Stat n={String(totals.rooms)} label="Rooms used" />
      </div>

      {/*
        The one sentence this screen exists to be able to say. §24.9's rule:
        a school that finished deserves to be told, rather than shown an
        absence of warnings.
      */}
      {complete && short.length === 0 && (
        <div style={{
          borderLeft: "3px solid var(--accent)", background: "var(--accent-bg)",
          padding: "11px 14px", borderRadius: "0 8px 8px 0", marginBottom: 18,
          fontSize: 12.8, lineHeight: 1.55,
        }}>
          <strong>Every lesson the curriculum asks for is on the timetable.</strong>{" "}
          {totals.placed.toLocaleString()} lessons across {totals.classSections} class-sections,
          taught by {totals.teachers} {totals.teachers === 1 ? "teacher" : "teachers"} in{" "}
          {totals.rooms} {totals.rooms === 1 ? "room" : "rooms"}.
        </div>
      )}

      {short.length > 0 && (
        <div style={{
          borderLeft: "3px solid var(--amber)", background: "var(--amber-bg)",
          padding: "11px 14px", borderRadius: "0 8px 8px 0", marginBottom: 18,
          fontSize: 12.8, lineHeight: 1.55,
        }}>
          <strong>
            {short.length} {short.length === 1 ? "class-section is" : "class-sections are"} short
            of {short.length === 1 ? "its" : "their"} curriculum.
          </strong>{" "}
          They are listed below.{" "}
          <Link to="/readiness">Readiness</Link> says why, and{" "}
          <Link to="/generate">Generate</Link> is where a re-run starts.
        </div>
      )}

      {/* ─────────────────────────────────── class-wise */}
      <h3 style={{ font: "700 13px/1.3 Inter, sans-serif", margin: "0 0 8px", color: "var(--brand-dark)" }}>
        Class-wise allocation
      </h3>
      <p style={{ fontSize: 11.5, color: "var(--ink-faint)", margin: "0 0 9px" }}>
        What the curriculum asks of each class-section, against what the week actually holds.
        {over.length > 0 && (
          <> {over.length} {over.length === 1 ? "row is" : "rows are"} over — usually a subject
            taught both as a curriculum row and inside a split elective (§31.19).</>
        )}
      </p>
      <div className="table-scroll" style={{ marginBottom: 20, maxHeight: 320, overflowY: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
          <thead>
            <tr>
              <th style={th}>Class-section</th>
              <th style={thR}>Required</th>
              <th style={thR}>Placed</th>
              <th style={{ ...th, width: "30%" }}>Of the curriculum</th>
              <th style={thR}>Free periods</th>
            </tr>
          </thead>
          <tbody>
            {data.classes.map((c) => {
              const pct = c.required > 0 ? Math.round((c.placed / c.required) * 100) : null;
              const tone = pct === null ? "var(--steel)"
                : pct >= 100 ? "var(--accent)"
                : pct >= 90 ? "var(--amber)" : "var(--signal)";
              return (
                <tr key={c.id}>
                  <td style={{ ...td, fontWeight: 600, color: "var(--ink)" }}>{c.label}</td>
                  <td style={tdN}>{c.required}</td>
                  <td style={{
                    ...tdN,
                    color: c.placed === c.required ? undefined : tone,
                    fontWeight: c.placed === c.required ? 400 : 700,
                  }}>{c.placed}</td>
                  <td style={td}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <MiniBar pct={pct ?? 0} tone={tone} />
                      <span className="mono" style={{ fontSize: 11, color: tone, minWidth: 34, textAlign: "right" }}>
                        {pct === null ? "—" : `${pct}%`}
                      </span>
                    </div>
                  </td>
                  {/*
                    Cells the week holds that nothing is timetabled in. Net of
                    §4.7b class time off, because `available` comes from Check
                    1 — a class that blocks Friday afternoon is not "free" then.
                  */}
                  <td style={{ ...tdN, color: "var(--ink-faint)" }}>
                    {Math.max(0, c.available - c.placed)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ─────────────────────────────────── teachers */}
      <h3 style={{ font: "700 13px/1.3 Inter, sans-serif", margin: "0 0 8px", color: "var(--brand-dark)" }}>
        Teachers on this timetable
      </h3>
      <p style={{ fontSize: 11.5, color: "var(--ink-faint)", margin: "0 0 9px" }}>
        {/*
          §29.3a — the load is the WHOLE week, and the other timetables are
          named rather than folded in. A percentage drawn round one wing reads
          67% where the truth is 87%, which is the wrong number to reassure
          somebody with.
        */}
        Load is measured against each teacher&rsquo;s whole week, across every timetable they
        appear in — a figure drawn round this one alone would understate it.
      </p>
      <div className="table-scroll" style={{ maxHeight: 340, overflowY: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
          <thead>
            <tr>
              <th style={th}>Teacher</th>
              <th style={thR}>Here</th>
              <th style={thR}>Whole week</th>
              <th style={thR}>Capacity</th>
              <th style={{ ...th, width: "26%" }}>Load</th>
            </tr>
          </thead>
          <tbody>
            {data.teachers.map((t) => {
              const pct = t.loadPct;
              const tone = t.over ? "var(--signal)"
                : pct !== null && pct >= 85 ? "var(--amber)" : "var(--accent)";
              return (
                <tr key={t.id}>
                  <td style={td}>
                    <span style={{ fontWeight: 600, color: "var(--ink)" }}>{t.name}</span>
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-faint)", marginLeft: 6 }}>
                      {t.initials}
                    </span>
                    {t.otherTimetables.length > 0 && (
                      <div style={{ fontSize: 10.5, color: "var(--steel)", marginTop: 1 }}>
                        also in {t.otherTimetables.join(", ")}
                      </div>
                    )}
                  </td>
                  <td style={tdN}>{t.periods}</td>
                  <td style={{ ...tdN, fontWeight: t.totalPeriods > t.periods ? 700 : 400 }}>
                    {t.totalPeriods}
                  </td>
                  <td style={{ ...tdN, color: "var(--ink-faint)" }}>{t.capacity || "—"}</td>
                  <td style={td}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <MiniBar pct={pct ?? 0} tone={tone} />
                      <span className="mono" style={{ fontSize: 11, color: tone, minWidth: 40, textAlign: "right" }}>
                        {pct === null ? "—" : `${pct}%`}
                        {t.over ? " !" : ""}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 12 }}>
        The whole week, class by class, is on the{" "}
        <Link to="/master-grid">Master Grid</Link>; <Link to="/wall">Wall</Link> is the printable
        version, and <Link to="/reports">Reports</Link> exports it.
      </p>
    </div>
  );
}
