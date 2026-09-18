/**
 * §37 — Teacher Requirement.
 *
 * *"How many teachers does this timetable need, and why?"* — answered subject
 * by subject, with the arithmetic on screen rather than behind it.
 *
 * ## The design rule this screen is built on
 *
 * A staffing number is a number somebody takes to a governing body, so every
 * figure has to be defensible in the room. Nothing here is a bare total: each
 * subject can be opened to the class-by-class multiplication that produced its
 * demand, the named teachers who could take it, and the sentence that turns
 * periods into people. A report that says "hire 7.6" and cannot say where the
 * 7.6 came from is a report nobody will act on.
 *
 * ## Three things it deliberately does NOT do
 *
 *  - **It does not place anybody.** Whether a legal timetable can be built is
 *    the Feasibility Engine's question and a harder one. A school can be fully
 *    staffed by this report and still fail Readiness.
 *  - **It does not write.** No hire, no mapping, no suggestion that commits.
 *  - **It does not rank people.** Load is drawn against each teacher's own cap,
 *    never against each other, and a teacher below half is shown as *available*
 *    rather than as underused.
 *
 * The arithmetic is `analyseRequirement` in `packages/shared`, unit-tested
 * there; this file renders and nothing more.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, ErrorNote } from "../components";
import { useApi, useConfigCtx } from "../hooks";

interface DemandLine {
  kind: "curriculum" | "merged" | "elective";
  label: string;
  per?: number;
  sections?: number;
  periods: number;
}
interface SubjectRow {
  id: number; name: string; category: string;
  demand: number; assigned: number; gap: number; over: number;
  qualified: number[]; covered: number; short: number;
  breakdown: DemandLine[];
}
interface Report {
  targetLoad: number;
  defaultTargetLoad: number;
  school: string; config: string;
  workingDays: number; periodsPerDay: number; classes: number; sections: number;
  subjects: SubjectRow[];
  teachers: Array<{ id: number; name: string; cap: number; load: number; subjects: string[] }>;
  totals: {
    demand: number; assigned: number; gap: number; covered: number; short: number;
    over: number; spare: number; overCap: number; unassigned: number; teachersNeeded: number;
  };
}

const n = (x: number) => Math.round(x).toLocaleString();

export function TeacherRequirement() {
  const { current } = useConfigCtx();
  /*
    `null` until somebody moves it, and then the server's number is left alone.

    The default divisor is the mean of the school's own teacher caps, computed
    server-side — a school of part-timers should not be handed a full-timer's
    assumption. Seeding local state from it would freeze whichever school was
    loaded first.
  */
  const [target, setTarget] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const url = current
    ? `/timetable-configs/${current.id}/teacher-requirement${target ? `?targetLoad=${target}` : ""}`
    : null;
  const { data, error } = useApi<Report>(url);

  const byId = useMemo(
    () => new Map((data?.teachers ?? []).map((t) => [t.id, t])),
    [data?.teachers],
  );

  if (!current) {
    return <Card><p style={muted}>Choose a timetable in the top bar to see what it needs.</p></Card>;
  }
  if (error) return <ErrorNote message={error} />;
  if (!data) return <p style={muted}>Working it out…</p>;

  const t = data.totals;
  const picked = data.subjects.find((s) => s.id === open) ?? data.subjects[0] ?? null;
  const load = target ?? data.targetLoad;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* ── the four numbers, before any of the detail ───────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
        <Stat k="Periods to teach each week" v={n(t.demand)} tone="plain"
          s={`${data.classes} classes · ${data.sections} sections · ${data.workingDays} days × ${data.periodsPerDay} periods`} />
        <Stat k="Covered by the staff you have" v={n(t.assigned + t.covered)} tone="ok"
          s={`${n(t.assigned)} assigned, ${n(t.covered)} within existing spare`} />
        <Stat
          k="Teachers still needed"
          v={t.teachersNeeded < 0.05 ? "none" : t.teachersNeeded.toFixed(1)}
          tone={t.teachersNeeded >= 1 ? "bad" : "ok"}
          s={t.teachersNeeded < 0.05
            ? "Every subject can be covered by the staff on the list"
            : `${n(t.short)} periods a week nobody qualified is free for`}
        />
        <Stat k="Teachers over their own cap" v={n(t.overCap)} tone={t.overCap ? "warn" : "ok"}
          s={t.overCap ? "Already past their weekly limit, before any of this" : "Nobody is past their weekly limit"} />
      </div>

      {/*
        The divisor, as a control rather than a constant.

        Periods ÷ load-per-teacher is the one judgement in the report, and it
        belongs to a head teacher rather than to this code. Saying what the
        answer would be at a light and a heavy load is what stops the headline
        being read as a fact.
      */}
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <label htmlFor="tr-load" style={label}>Teaching load per teacher</label>
          <input
            id="tr-load" type="range" min={18} max={40} step={1} value={load}
            onChange={(e) => setTarget(Number(e.target.value))}
            style={{ width: 210, accentColor: "var(--brand)" }}
          />
          <span style={{ font: "700 15px/1 var(--font-mono)", color: "var(--brand)", minWidth: 84 }}>
            {load} / week
          </span>
          <span style={{ fontSize: 12.5, color: "var(--ink-soft)", flex: 1, minWidth: 220 }}>
            The only judgement here. {n(t.short)} uncovered periods is{" "}
            <strong>{t.teachersNeeded.toFixed(1)}</strong> teachers at {load} —{" "}
            {(t.short / 22).toFixed(1)} at a light 22, {(t.short / 36).toFixed(1)} at a heavy 36.
            {target !== null && data.defaultTargetLoad !== load && (
              <>{" "}<button onClick={() => setTarget(null)} style={linkBtn}>
                reset to {data.defaultTargetLoad}, this school&rsquo;s own average
              </button></>
            )}
          </span>
        </div>
      </Card>

      {/* ── where the gap is ─────────────────────────────────────────── */}
      <Card title="Where the gap is" sub="Every subject's weekly demand and what covers it, worst first. Press a row for the arithmetic.">
        <Bars subjects={data.subjects} open={picked?.id ?? null} onOpen={setOpen} />
        <Legend />
        {picked && <Detail s={picked} load={load} byId={byId} config={data.config} />}
      </Card>

      {/* ── what the current staff carry ─────────────────────────────── */}
      <Card title="What the current staff are carrying"
        sub="Each teacher against their own weekly cap. A shortage and a room full of people at 60% are the same school; this is how you tell them apart.">
        <Hist teachers={data.teachers} />
        <Legend
          items={[["var(--steel)", "Under half"], ["var(--brand)", "Working"],
            ["var(--amber)", "At the alert line"], ["var(--signal)", "Over their cap"]]}
        />
        <div style={{
          marginTop: 14, borderLeft: `3px solid ${t.overCap ? "var(--amber)" : "var(--brand)"}`,
          background: t.overCap ? "var(--amber-bg)" : "var(--steel-pale)",
          borderRadius: "0 9px 9px 0", padding: "12px 15px", fontSize: 13, color: "var(--ink-soft)",
        }}>
          <strong style={{ color: "var(--ink)" }}>{n(t.spare)} free periods a week exist</strong> across the
          staff, and <strong style={{ color: "var(--ink)" }}>{n(t.short)}</strong> of the {n(t.gap)}{" "}
          unassigned periods still cannot be covered — free capacity sits with people who are not qualified
          for the subjects that are short. That distance between <em>spare exists</em> and{" "}
          <em>spare is reachable</em> is why this is an allocation and not a subtraction.
          {t.overCap > 0 && (
            <><br /><br /><strong style={{ color: "var(--signal)" }}>
              {n(t.overCap)} teachers are already past their own weekly cap
            </strong>{" "}— before any unassigned period is given to anyone. Those are a re-balance, not a hire:{" "}
            <Link to="/staffing" style={{ color: "var(--brand)" }}>Staffing Changes</Link> is the screen for it.</>
          )}
          {t.over > 0 && (
            <><br /><br /><strong style={{ color: "var(--amber)" }}>
              {n(t.over)} periods a week are assigned beyond what the curriculum asks
            </strong>{" "}— mappings claiming more than the lesson plan. They inflate every teacher's load and
            no hire fixes them; the{" "}
            <Link to="/master-grid?tab=lesson" style={{ color: "var(--brand)" }}>Lesson grid</Link> is where
            they are.</>
          )}
        </div>
      </Card>

      {/* ── the plan ─────────────────────────────────────────────────── */}
      <Card title="The hiring plan" sub="One line per subject that needs somebody, in the order a school would act on them.">
        <Plan subjects={data.subjects} load={load} byId={byId} />
      </Card>

      {/* ── everything, as a table ───────────────────────────────────── */}
      <Card title="Every subject" sub="The ones that are fine as well as the ones that are not.">
        <div style={{ overflowX: "auto" }} className="table-scroll">
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
            <thead><tr>
              {["Subject", "Demand", "Assigned", "Gap", "Qualified", "Their spare", "Still short", ""]
                .map((h, i) => (
                  <th key={h || i} style={{ ...th, textAlign: i === 0 || i === 7 ? "left" : "right" }}>{h}</th>
                ))}
            </tr></thead>
            <tbody>
              {data.subjects.map((s) => {
                const people = s.qualified.map((id) => byId.get(id)).filter(Boolean) as Report["teachers"];
                const spare = people.reduce((a, p) => a + Math.max(0, p.cap - p.load), 0);
                return (
                  <tr key={s.id} onClick={() => setOpen(s.id)} style={{ cursor: "pointer" }}>
                    <td style={td}><strong style={{ color: "var(--ink)" }}>{s.name}</strong></td>
                    <td style={tdN}>{n(s.demand)}</td>
                    <td style={tdN}>{n(s.assigned)}</td>
                    <td style={tdN}>{s.gap ? n(s.gap) : "—"}</td>
                    <td style={tdN}>{people.length}</td>
                    <td style={tdN}>{n(spare)}</td>
                    <td style={{ ...tdN, color: s.short ? "var(--signal)" : undefined, fontWeight: s.short ? 700 : 400 }}>
                      {s.short ? n(s.short) : "—"}
                    </td>
                    <td style={td}>
                      {s.short > 0 ? <Pill tone="bad">short</Pill>
                        : s.over > 0 ? <Pill tone="warn">over-assigned</Pill>
                        : <Pill tone="ok">covered</Pill>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <p style={{ ...muted, fontSize: 11.5 }}>
        Read-only. A requirement is arithmetic over demand and capacity — whether a timetable can actually
        be built from it is <Link to="/readiness" style={{ color: "var(--brand)" }}>Readiness</Link>, which
        asks a harder question.
      </p>
    </div>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────── */

const muted: React.CSSProperties = { color: "var(--ink-faint)", fontSize: 13 };
const label: React.CSSProperties = {
  font: "700 10.5px/1 Inter", letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--ink-faint)",
};
const linkBtn: React.CSSProperties = {
  border: "none", background: "none", padding: 0, color: "var(--brand)",
  font: "inherit", fontSize: 12.5, textDecoration: "underline", cursor: "pointer",
};
const th: React.CSSProperties = {
  font: "800 9.5px/1 Inter", letterSpacing: "0.11em", textTransform: "uppercase",
  color: "var(--ink-faint)", padding: "10px 12px", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap",
};
const td: React.CSSProperties = { padding: "9px 12px", borderBottom: "1px solid var(--offwhite)", color: "var(--ink-soft)" };
const tdN: React.CSSProperties = { ...td, textAlign: "right", fontFamily: "var(--font-mono)" };

const TONE = {
  plain: "var(--steel)", ok: "var(--accent)", warn: "var(--amber)", bad: "var(--signal)",
} as const;

function Stat({ k, v, s, tone }: { k: string; v: string; s: string; tone: keyof typeof TONE }) {
  return (
    <div style={{
      background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 12,
      padding: "14px 16px", position: "relative", overflow: "hidden",
    }}>
      {/* A stripe rather than a coloured number alone: severity should survive
          being read at a glance and in greyscale on a printed page. */}
      <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: TONE[tone] }} />
      <div style={label}>{k}</div>
      <div style={{
        font: "700 28px/1.05 var(--font-mono)", margin: "8px 0 3px", letterSpacing: "-0.02em",
        color: tone === "plain" ? "var(--ink)" : TONE[tone],
      }}>{v}</div>
      <div style={{ fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.4 }}>{s}</div>
    </div>
  );
}

function Pill({ tone, children }: { tone: "ok" | "warn" | "bad"; children: React.ReactNode }) {
  const bg = { ok: "var(--accent-bg)", warn: "var(--amber-bg)", bad: "var(--signal-bg)" }[tone];
  return (
    <span style={{
      display: "inline-flex", font: "700 10.5px/1 Inter", padding: "4px 9px",
      borderRadius: 20, background: bg, color: TONE[tone],
    }}>{children}</span>
  );
}

function Legend({ items }: { items?: Array<[string, string]> }) {
  const rows = items ?? [
    ["var(--accent)", "Already assigned"],
    ["var(--brand)", "Coverable from existing spare"],
    ["var(--signal)", "Nobody can cover it"],
    ["repeating-linear-gradient(45deg,var(--amber) 0 4px,transparent 4px 8px)", "Assigned beyond the curriculum"],
  ];
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11.5, color: "var(--ink-soft)", marginTop: 12 }}>
      {rows.map(([bg, text]) => (
        <span key={text}>
          <i style={{ width: 11, height: 11, borderRadius: 3, display: "inline-block", marginRight: 6, verticalAlign: -1, background: bg }} />
          {text}
        </span>
      ))}
    </div>
  );
}

function Bars({ subjects, open, onOpen }: {
  subjects: SubjectRow[]; open: number | null; onOpen: (id: number) => void;
}) {
  const max = Math.max(1, ...subjects.map((s) => Math.max(s.demand, s.assigned)));
  const pc = (x: number) => `${(x / max) * 100}%`;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {subjects.map((s) => (
        <div
          key={s.id}
          role="button"
          tabIndex={0}
          onClick={() => onOpen(s.id)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(s.id); } }}
          style={{
            display: "grid", gridTemplateColumns: "minmax(88px, 132px) minmax(0, 1fr) 76px",
            gap: 11, alignItems: "center", padding: "3px 5px", margin: "0 -5px", borderRadius: 8,
            cursor: "pointer", background: open === s.id ? "var(--steel-pale)" : undefined,
          }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
            title={s.name}>{s.name}</span>
          <span style={{ height: 18, borderRadius: 5, background: "var(--offwhite)", display: "flex", overflow: "hidden" }}>
            <span style={{ width: pc(Math.min(s.assigned, s.demand)), background: "var(--accent)" }} />
            <span style={{ width: pc(s.covered), background: "var(--brand)" }} />
            <span style={{ width: pc(s.short), background: "var(--signal)" }} />
            <span style={{
              width: pc(s.over), opacity: 0.75,
              background: "repeating-linear-gradient(45deg,var(--amber) 0 5px,transparent 5px 10px)",
            }} />
          </span>
          <span style={{
            font: "700 12px/1 var(--font-mono)", textAlign: "right",
            color: s.short ? "var(--signal)" : "var(--ink-faint)",
          }}>{s.short ? `−${n(s.short)}` : n(s.demand)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The justification, which is the point of the whole screen.
 *
 * Numbered steps rather than a paragraph: somebody defending a hire reads them
 * out in order, and each one has to stand on its own.
 */
function Detail({ s, load, byId, config }: {
  s: SubjectRow; load: number; byId: Map<number, Report["teachers"][number]>; config: string;
}) {
  const people = s.qualified.map((id) => byId.get(id)).filter(Boolean)
    .sort((a, b) => (b!.cap - b!.load) - (a!.cap - a!.load)) as Report["teachers"];
  const spare = people.reduce((a, p) => a + Math.max(0, p.cap - p.load), 0);
  const curric = s.breakdown.filter((b) => b.kind === "curriculum");
  const other = s.breakdown.filter((b) => b.kind !== "curriculum");
  const fte = s.short / load;

  const steps: React.ReactNode[] = [];
  steps.push(<>
    <strong>{n(s.demand)} periods a week</strong> are taught across {curric.length}{" "}
    {curric.length === 1 ? "class" : "classes"}
    {other.length > 0 && <> and {other.length} elective {other.length === 1 ? "block" : "blocks"}</>}.
  </>);
  steps.push(<>
    <strong>{n(s.assigned)}</strong> are assigned
    {s.over > 0 && <> — <strong style={{ color: "var(--amber)" }}>{n(s.over)} more than the curriculum asks</strong>,
      which is a mapping to check rather than a teacher to hire</>}.
  </>);
  if (s.gap > 0) {
    steps.push(<>That leaves <strong>{n(s.gap)} periods</strong> unassigned.</>);
    if (people.length === 0) {
      steps.push(<>
        <strong style={{ color: "var(--signal)" }}>Nobody on the staff list is recorded as able to teach it.</strong>{" "}
        Every one of those {n(s.gap)} periods needs a new person — or somebody&rsquo;s subject list updating on{" "}
        <Link to="/masters" style={{ color: "var(--brand)" }}>Teachers</Link>, which costs nothing and may be all this is.
      </>);
    } else {
      steps.push(<>
        <strong>{people.length}</strong> {people.length === 1 ? "teacher" : "teachers"} can teach it, holding{" "}
        <strong>{n(spare)}</strong> free periods between them — but that capacity is shared with every other
        subject they are qualified for, so <strong>{n(s.covered)}</strong> of it reaches here.
      </>);
      steps.push(
        s.short > 0
          ? <><strong style={{ color: "var(--signal)" }}>{n(s.short)} periods a week are left</strong> — at{" "}
            {load} periods a teacher, <strong>{fte.toFixed(1)}</strong> teachers.</>
          : <><strong style={{ color: "var(--accent)" }}>Nothing is left uncovered.</strong></>,
      );
    }
  } else {
    steps.push(<><strong style={{ color: "var(--accent)" }}>Fully assigned.</strong> No hire is implied by this subject.</>);
  }

  return (
    <div style={{ borderTop: "1px solid var(--line)", marginTop: 16, paddingTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h3 style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 600 }}>{s.name}</h3>
        {s.short > 0 ? <Pill tone="bad">{fte.toFixed(1)} needed</Pill>
          : s.over > 0 ? <Pill tone="warn">over-assigned</Pill> : <Pill tone="ok">covered</Pill>}
        <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>{s.category} · {config}</span>
      </div>

      <ol style={{ display: "grid", gap: 8, margin: "12px 0 0", padding: 0, listStyle: "none" }}>
        {steps.map((el, i) => (
          <li key={i} style={{ display: "grid", gridTemplateColumns: "22px 1fr", gap: 10, fontSize: 13.5, color: "var(--ink-soft)" }}>
            <span style={{ font: "700 11px/1.7 var(--font-mono)", color: "var(--brand)", textAlign: "center" }}>{i + 1}</span>
            <span>{el}</span>
          </li>
        ))}
      </ol>

      <div style={{ marginTop: 14, border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <tbody>
            {curric.map((b, i) => (
              <tr key={`c${i}`}>
                <td style={td}>{b.label}</td>
                <td style={tdN}>{b.per} / week</td>
                <td style={tdN}>× {b.sections} {b.sections === 1 ? "section" : "sections"}</td>
                <td style={{ ...tdN, color: "var(--ink)", fontWeight: 700 }}>{n(b.periods)}</td>
              </tr>
            ))}
            {other.map((b, i) => (
              <tr key={`o${i}`}>
                <td style={td}>{b.kind === "merged" ? "Merged teaching group" : "Split elective"} — {b.label}</td>
                <td style={tdN}>{b.per ? `${b.per} / week` : ""}</td>
                <td style={tdN}>{b.kind === "merged" ? "taught once" : ""}</td>
                <td style={{ ...tdN, fontWeight: 700, color: b.periods < 0 ? "var(--accent)" : "var(--ink)" }}>
                  {b.periods > 0 ? "+" : ""}{n(b.periods)}
                </td>
              </tr>
            ))}
            <tr style={{ background: "var(--steel-pale)" }}>
              <td style={{ ...td, fontWeight: 700, color: "var(--ink)" }}>Demand</td>
              <td style={tdN} /><td style={tdN} />
              <td style={{ ...tdN, fontWeight: 700, color: "var(--ink)" }}>{n(s.demand)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {people.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={label}>Who can teach it, and what they have left</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {people.map((p) => {
              const free = p.cap - p.load;
              const tone = free <= 0 ? "var(--signal)" : free >= 6 ? "var(--accent)" : "var(--line)";
              return (
                <span key={p.id} title={p.subjects.join(" · ") || "nothing assigned"} style={{
                  font: "600 11.5px/1 Inter", border: `1px solid ${tone}`, borderRadius: 20,
                  padding: "5px 10px", whiteSpace: "nowrap",
                  color: free <= 0 ? "var(--signal)" : free >= 6 ? "var(--accent)" : "var(--ink-soft)",
                }}>
                  {p.name} <b style={{ fontFamily: "var(--font-mono)" }}>{p.load}/{p.cap}</b>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Load as a distribution, not as 123 bars.
 *
 * The question is "what shape is this staff room in?", and a bar per teacher
 * answers a different one — it invites comparing people, which this screen has
 * no business doing. Buckets keep the shape and lose the ranking.
 */
function Hist({ teachers }: { teachers: Report["teachers"] }) {
  const buckets: Array<[number, number, string, string]> = [
    [0, 0.0001, "none", "var(--steel)"],
    [0.0001, 0.5, "1–49%", "var(--steel)"],
    [0.5, 0.75, "50–74%", "var(--brand)"],
    [0.75, 0.9, "75–89%", "var(--amber)"],
    [0.9, 1.0001, "90–100%", "var(--amber)"],
    [1.0001, Infinity, "over cap", "var(--signal)"],
  ];
  const counts = buckets.map(([lo, hi]) =>
    teachers.filter((t) => {
      const r = t.cap > 0 ? t.load / t.cap : 0;
      return r >= lo && r < hi;
    }).length);
  const max = Math.max(1, ...counts);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 140, paddingTop: 6 }}>
      {buckets.map(([, , name, colour], i) => (
        <div key={name} style={{
          flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end",
          alignItems: "center", gap: 4, minWidth: 0,
        }}>
          <span style={{ font: "700 10px/1 var(--font-mono)", color: "var(--ink-soft)" }}>{counts[i]}</span>
          <span style={{ width: "100%", height: (counts[i] / max) * 96 || 2, background: colour, borderRadius: "3px 3px 0 0" }} />
          <span style={{ font: "600 9.5px/1.2 Inter", color: "var(--ink-faint)", textAlign: "center", whiteSpace: "nowrap" }}>
            {name}
          </span>
        </div>
      ))}
    </div>
  );
}

function Plan({ subjects, load, byId }: {
  subjects: SubjectRow[]; load: number; byId: Map<number, Report["teachers"][number]>;
}) {
  const need = subjects.filter((s) => s.short > 0);
  if (need.length === 0) {
    return (
      <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>
        <strong style={{ color: "var(--accent)" }}>No hire is implied.</strong> Every subject&rsquo;s demand
        can be met by the teachers already on the list, at {load} periods each.
      </p>
    );
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {need.map((s) => {
        const people = s.qualified.map((id) => byId.get(id)).filter(Boolean) as Report["teachers"];
        const fte = s.short / load;
        return (
          <div key={s.id} style={{
            display: "grid", gridTemplateColumns: "70px 1fr", gap: 14, alignItems: "start",
            borderLeft: "3px solid var(--signal)", background: "var(--paper)",
            border: "1px solid var(--line)", borderLeftWidth: 3, borderLeftColor: "var(--signal)",
            borderRadius: "0 10px 10px 0", padding: "13px 15px",
          }}>
            <div>
              <div style={{ font: "700 26px/1 var(--font-mono)", color: "var(--signal)" }}>{fte.toFixed(1)}</div>
              <div style={{ ...label, marginTop: 4 }}>teachers</div>
            </div>
            <div>
              <h4 style={{ fontSize: 14.5, fontWeight: 700 }}>
                {s.name}{people.length === 0 && " — no qualified staff"}
              </h4>
              <p style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 3 }}>
                {people.length === 0
                  ? `Nobody on the staff list is recorded as able to teach ${s.name}. All ${n(s.demand)} periods a week are unstaffed.`
                  : `${n(s.demand)} periods a week are needed and ${n(s.assigned)} are assigned. The ${people.length} qualified `
                    + `${people.length === 1 ? "teacher" : "teachers"} can absorb ${n(s.covered)} more before hitting their own caps `
                    + `(${people.slice(0, 4).map((p) => `${p.name.split(" ")[0]} ${p.load}/${p.cap}`).join(", ")}`
                    + `${people.length > 4 ? "…" : ""}), which leaves ${n(s.short)}.`}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
