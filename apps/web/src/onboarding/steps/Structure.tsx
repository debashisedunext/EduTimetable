/**
 * §15.3 Phase 25.3 — steps 3, 4 and 5: wings, classes, and the week.
 *
 * These are the steps that first put real rows in the database, and how they do
 * it is the point:
 *
 *  - **Classes and sections go through the §16 importer** (`POST
 *    /onboarding/commit/4`), the same pipeline an uploaded spreadsheet uses.
 *    That gives identical validation and, more usefully, idempotency: pressing
 *    Next twice or resuming a draft creates nothing extra.
 *  - **Wings and the week go through the endpoints that already own them** —
 *    `POST /timetable-configs` and `PUT /:id/structure`. §16 is masters only;
 *    period and break structure has always lived here.
 *
 * Nothing in this file writes a row itself.
 */
import { useMemo, useState } from "react";
import {
  CLASS_LADDER,
  CLASS_LADDER_SHORT,
  planClasses,
  planSummary,
  weeklyCapacity,
  type WingAnswer,
} from "@edutimetable/shared";
import { api } from "../../api";

const DAYS = [
  { n: 1, label: "Mon" }, { n: 2, label: "Tue" }, { n: 3, label: "Wed" },
  { n: 4, label: "Thu" }, { n: 5, label: "Fri" }, { n: 6, label: "Sat" }, { n: 7, label: "Sun" },
];

const label = {
  display: "block", font: "600 11px/1.4 Inter", textTransform: "uppercase" as const,
  letterSpacing: "0.06em", color: "var(--steel)", marginBottom: 5,
};
const input = {
  width: "100%", padding: "8px 11px", border: "1px solid var(--line)", borderRadius: 8,
  fontSize: 13.5, background: "var(--paper)", color: "var(--ink)",
};

export function Note({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warn" | "ok" }) {
  const c = tone === "warn"
    ? { bg: "var(--amber-bg)", line: "var(--amber)" }
    : tone === "ok" ? { bg: "var(--accent-bg)", line: "var(--accent)" }
    : { bg: "var(--steel-pale)", line: "var(--brand)" };
  return (
    <div style={{
      borderLeft: `3px solid ${c.line}`, background: c.bg, padding: "11px 13px",
      borderRadius: "0 8px 8px 0", fontSize: 12.8, color: "var(--ink-soft)", marginTop: 12,
    }}>{children}</div>
  );
}

// ───────────────────────────────────────────────────────── step 3: wings

export function StepWings({ answers, onChange }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}) {
  const wings: WingAnswer[] = answers.wings ?? [];
  const [name, setName] = useState("");

  const set = (next: WingAnswer[]) => onChange({ wings: next });
  const add = () => {
    const n = name.trim();
    if (!n) return;
    if (wings.some((w) => w.name.toLowerCase() === n.toLowerCase())) return;
    // A sensible default range so the slider opens somewhere useful rather than
    // collapsed on Pre-Nursery.
    set([...wings, { name: n, fromIndex: 4, toIndex: 9, sections: 2 }]);
    setName("");
  };

  return (
    <>
      <h2 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 22, margin: "0 0 4px" }}>
        Which wings does the school timetable separately?
      </h2>
      <p style={{ fontSize: 13.5, color: "var(--ink-soft)", margin: "0 0 16px" }}>
        A wing gets its own week — its own working days, period count and start time. Most schools
        run two or three. One is perfectly normal.
      </p>

      {wings.length > 0 && (
        <div style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
          {wings.map((w, i) => (
            <div key={w.name} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 13px",
              borderBottom: i < wings.length - 1 ? "1px solid var(--line)" : "none",
            }}>
              <strong style={{ fontSize: 13.5 }}>{w.name}</strong>
              <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>
                {CLASS_LADDER[w.fromIndex]} – {CLASS_LADDER[w.toIndex]}
              </span>
              <span style={{ flex: 1 }} />
              <button className="btn" style={{ padding: "4px 9px", fontSize: 11.5, border: "none", background: "none", color: "var(--signal)" }}
                onClick={() => set(wings.filter((x) => x.name !== w.name))}>Remove</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "end" }}>
        <div style={{ flex: 1 }}>
          <label style={label}>Add a wing</label>
          <input style={input} value={name} placeholder="e.g. Primary Wing"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        </div>
        <button className="btn btn-primary" onClick={add} disabled={!name.trim()}>+ Add wing</button>
      </div>

      <Note>
        A wing <em>is</em> a timetable — the same <code>timetable_config</code> the rest of the app
        works with. Wings generate, publish and are edited entirely independently of one another.
      </Note>
    </>
  );
}

/** Create one config per wing, skipping any that already exist. */
export async function commitWings(answers: Record<string, any>): Promise<void> {
  const wings: WingAnswer[] = answers.wings ?? [];
  if (wings.length === 0) throw new Error("Add at least one wing.");

  const years = await api<Array<{ id: number; name: string }>>("/academic-years");
  const year = years.find((y) => y.name === answers.session?.name) ?? years[0];
  if (!year) throw new Error("The session was not created — go back to step 2.");

  // Re-read rather than trusting the draft: the wizard may be resuming, or a
  // colleague may have made one. Creating a duplicate name would 409 anyway;
  // skipping is the honest version of the same rule.
  const existing = await api<Array<{ id: number; name: string }>>("/timetable-configs");
  for (const w of wings) {
    if (existing.some((c) => c.name.toLowerCase() === w.name.toLowerCase())) continue;
    await api("/timetable-configs", {
      method: "POST",
      body: JSON.stringify({ name: w.name, academicYearId: year.id }),
    });
  }
}

// ─────────────────────────────────────────────────────── step 4: classes

function Ladder({ wing, onChange }: { wing: WingAnswer; onChange: (w: WingAnswer) => void }) {
  const span = CLASS_LADDER.length - 1;
  const lo = Math.min(wing.fromIndex, wing.toIndex);
  const hi = Math.max(wing.fromIndex, wing.toIndex);

  return (
    <div style={{ background: "var(--offwhite)", border: "1px solid var(--line)", borderRadius: 10, padding: "16px 18px 8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
        {CLASS_LADDER_SHORT.map((c, i) => (
          <span key={c} style={{
            flex: 1, textAlign: "center", fontSize: 10, fontFamily: "var(--mono, monospace)",
            color: i >= lo && i <= hi ? "var(--brand)" : "var(--ink-faint)",
            fontWeight: i >= lo && i <= hi ? 700 : 400,
          }}>{c}</span>
        ))}
      </div>
      <div style={{ position: "relative", height: 26 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 12, height: 4, borderRadius: 3, background: "var(--steel-light)" }} />
        <div style={{
          position: "absolute", top: 12, height: 4, borderRadius: 3, background: "var(--brand)",
          left: `${(lo / span) * 100}%`, width: `${((hi - lo) / span) * 100}%`,
        }} />
        {/* Two handles, not one. A Senior wing runs 9–12; with a single handle
            that means creating Pre-Nursery through 12 and deleting nine
            classes. The Primary case simply never moves the left one. */}
        {(["fromIndex", "toIndex"] as const).map((k) => (
          <input
            key={k}
            type="range" min={0} max={span} value={wing[k]}
            aria-label={k === "fromIndex" ? "First class" : "Last class"}
            onChange={(e) => onChange({ ...wing, [k]: Number(e.target.value) })}
            style={{
              position: "absolute", left: 0, top: 0, width: "100%", height: 26, margin: 0,
              background: "none", pointerEvents: "none", WebkitAppearance: "none", appearance: "none",
            }}
            className="ladder-range"
          />
        ))}
      </div>
    </div>
  );
}

export function StepClasses({ answers, onChange }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}) {
  const wings: WingAnswer[] = answers.wings ?? [];
  const [active, setActive] = useState(0);
  const wing = wings[active];
  const { classes, issues } = useMemo(() => planClasses(wings), [wings]);
  const summary = useMemo(() => planSummary({ wings }), [wings]);

  if (!wing) return <Note tone="warn">Add a wing on the previous step first.</Note>;

  const update = (w: WingAnswer) => onChange({ wings: wings.map((x, i) => (i === active ? w : x)) });
  const override = (className: string, patch: { sections?: number; removed?: boolean }) =>
    update({ ...wing, overrides: { ...(wing.overrides ?? {}), [className]: { ...(wing.overrides?.[className] ?? {}), ...patch } } });

  return (
    <>
      <h2 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 22, margin: "0 0 4px" }}>
        Which classes does <span style={{ color: "var(--brand)" }}>{wing.name}</span> run?
      </h2>
      <p style={{ fontSize: 13.5, color: "var(--ink-soft)", margin: "0 0 14px" }}>
        Drag both ends of the ladder. Sections are lettered automatically.
      </p>

      {wings.length > 1 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
          {wings.map((w, i) => (
            <button key={w.name} onClick={() => setActive(i)}
              className="btn"
              style={{
                padding: "5px 11px", fontSize: 12,
                background: i === active ? "var(--brand)" : "var(--paper)",
                color: i === active ? "#fff" : "var(--ink)",
                borderColor: i === active ? "var(--brand)" : "var(--line)",
              }}>{w.name}</button>
          ))}
        </div>
      )}

      <label style={label}>Class range</label>
      <Ladder wing={wing} onChange={update} />

      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", marginTop: 14 }}>
        <div>
          <label style={label}>Sections per class</label>
          <input style={input} type="number" min={1} max={26} value={wing.sections}
            onChange={(e) => update({ ...wing, sections: Number(e.target.value) })} />
        </div>
        <div>
          <label style={label}>This wing</label>
          <input style={{ ...input, background: "var(--offwhite)", color: "var(--ink-soft)" }} readOnly
            value={`${summary.perWing.find((p) => p.wing === wing.name)?.classes ?? 0} classes · ${summary.perWing.find((p) => p.wing === wing.name)?.sections ?? 0} sections`} />
        </div>
        <div>
          <label style={label}>All wings</label>
          <input style={{ ...input, background: "var(--offwhite)", color: "var(--ink-soft)" }} readOnly
            value={`${summary.classes} classes · ${summary.sections} sections`} />
        </div>
      </div>

      {issues.length > 0 && (
        <Note tone="warn">
          {issues.map((i, n) => <div key={n}><strong>{i.message}</strong> {i.fix}</div>)}
        </Note>
      )}

      <div style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "auto", maxHeight: 210, marginTop: 14 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead><tr>
            {["Class", "Sections", "Wing", ""].map((h) => (
              <th key={h} style={{
                textAlign: "left", font: "600 10px/1.3 Inter", textTransform: "uppercase",
                letterSpacing: "0.07em", color: "var(--steel)", padding: "8px 11px",
                borderBottom: "1px solid var(--line)", background: "var(--offwhite)",
                position: "sticky", top: 0,
              }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {classes.filter((c) => c.wing === wing.name).map((c) => (
              <tr key={c.className}>
                <td style={{ padding: "7px 11px", borderBottom: "1px solid var(--line)" }}>{c.className}</td>
                <td style={{ padding: "7px 11px", borderBottom: "1px solid var(--line)", color: "var(--ink-faint)", fontFamily: "var(--mono, monospace)", fontSize: 11.5 }}>
                  {c.sections.join(", ")}
                </td>
                <td style={{ padding: "7px 11px", borderBottom: "1px solid var(--line)", color: "var(--ink-faint)" }}>{c.wing}</td>
                <td style={{ padding: "4px 11px", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" }}>
                  <input type="number" min={1} max={26} value={c.sections.length} aria-label={`Sections for ${c.className}`}
                    onChange={(e) => override(c.className, { sections: Number(e.target.value) })}
                    style={{ width: 52, padding: "3px 6px", border: "1px solid var(--line)", borderRadius: 6, fontSize: 12 }} />
                  <button onClick={() => override(c.className, { removed: true })}
                    style={{ marginLeft: 6, border: "none", background: "none", color: "var(--signal)", cursor: "pointer", fontSize: 11.5 }}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11.5, color: "var(--ink-faint)", margin: "8px 0 0" }}>
        A class with 6 sections next to classes with 4 is one edit here, not a reason to avoid the
        slider. These are created when you press Next — and creating them twice is impossible, so
        coming back is safe.
      </p>
    </>
  );
}

// ────────────────────────────────────────────────────────── step 5: week

export interface WeekAnswer {
  workingDays: number[];
  periodsPerDay: number;
  periodDurationMins: number;
  startTime: string;
  hasZeroPeriod: boolean;
  breaks: Array<{ afterPeriod: number; name: string; durationMins: number }>;
}

const defaultWeek = (): WeekAnswer => ({
  workingDays: [1, 2, 3, 4, 5],
  periodsPerDay: 8,
  periodDurationMins: 40,
  startTime: "08:00",
  hasZeroPeriod: false,
  breaks: [
    { afterPeriod: 2, name: "Short Break", durationMins: 15 },
    { afterPeriod: 5, name: "Lunch", durationMins: 30 },
  ],
});

export function StepWeek({ answers, onChange }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}) {
  const wings: WingAnswer[] = answers.wings ?? [];
  const [active, setActive] = useState(0);
  const wing = wings[active];
  if (!wing) return <Note tone="warn">Add a wing on step 3 first.</Note>;

  const weeks: Record<string, WeekAnswer> = answers.weeks ?? {};
  const week = { ...defaultWeek(), ...(weeks[wing.name] ?? {}) };
  const set = (patch: Partial<WeekAnswer>) =>
    onChange({ weeks: { ...weeks, [wing.name]: { ...week, ...patch } } });

  const capacity = weeklyCapacity(week.periodsPerDay, week.workingDays);
  const summary = planSummary({ wings });
  const mine = summary.perWing.find((p) => p.wing === wing.name);

  return (
    <>
      <h2 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 22, margin: "0 0 4px" }}>
        How does <span style={{ color: "var(--brand)" }}>{wing.name}</span>'s week run?
      </h2>
      <p style={{ fontSize: 13.5, color: "var(--ink-soft)", margin: "0 0 14px" }}>
        This is the ceiling for everything after it — a week of {capacity} periods means no subject
        can ask for {capacity + 1}. Filled in with the commonest answer; change what differs.
      </p>

      {wings.length > 1 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
          {wings.map((w, i) => (
            <button key={w.name} onClick={() => setActive(i)} className="btn"
              style={{
                padding: "5px 11px", fontSize: 12,
                background: i === active ? "var(--brand)" : "var(--paper)",
                color: i === active ? "#fff" : "var(--ink)",
                borderColor: i === active ? "var(--brand)" : "var(--line)",
              }}>{w.name}</button>
          ))}
        </div>
      )}

      <label style={label}>Working days</label>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 14 }}>
        {DAYS.map((d) => {
          const on = week.workingDays.includes(d.n);
          return (
            <button key={d.n} className="btn"
              onClick={() => set({
                workingDays: on
                  ? week.workingDays.filter((x) => x !== d.n)
                  : [...week.workingDays, d.n].sort((a, b) => a - b),
              })}
              style={{
                padding: "5px 11px", fontSize: 12,
                background: on ? "var(--brand)" : "var(--paper)",
                color: on ? "#fff" : "var(--ink)",
                borderColor: on ? "var(--brand)" : "var(--line)",
              }}>{d.label}</button>
          );
        })}
      </div>

      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        <div><label style={label}>Periods / day</label>
          <input style={input} type="number" min={1} max={14} value={week.periodsPerDay}
            onChange={(e) => set({ periodsPerDay: Number(e.target.value) })} /></div>
        <div><label style={label}>Start time</label>
          <input style={input} type="time" value={week.startTime}
            onChange={(e) => set({ startTime: e.target.value })} /></div>
        <div><label style={label}>Period duration</label>
          <input style={input} type="number" min={20} max={120} value={week.periodDurationMins}
            onChange={(e) => set({ periodDurationMins: Number(e.target.value) })} /></div>
        <div><label style={label}>Zero period</label>
          <select style={input} value={week.hasZeroPeriod ? "yes" : "no"}
            onChange={(e) => set({ hasZeroPeriod: e.target.value === "yes" })}>
            <option value="no">No</option><option value="yes">Yes</option>
          </select></div>
      </div>

      <label style={{ ...label, marginTop: 14 }}>Breaks</label>
      {week.breaks.map((b, i) => (
        <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
          <input style={{ ...input, flex: 2 }} value={b.name}
            onChange={(e) => set({ breaks: week.breaks.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)) })} />
          <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>after P</span>
          <input style={{ ...input, width: 66 }} type="number" min={1} max={week.periodsPerDay} value={b.afterPeriod}
            onChange={(e) => set({ breaks: week.breaks.map((x, n) => (n === i ? { ...x, afterPeriod: Number(e.target.value) } : x)) })} />
          <input style={{ ...input, width: 76 }} type="number" min={5} max={120} value={b.durationMins}
            onChange={(e) => set({ breaks: week.breaks.map((x, n) => (n === i ? { ...x, durationMins: Number(e.target.value) } : x)) })} />
          <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>min</span>
          <button onClick={() => set({ breaks: week.breaks.filter((_, n) => n !== i) })}
            style={{ border: "none", background: "none", color: "var(--signal)", cursor: "pointer", fontSize: 11.5 }}>Remove</button>
        </div>
      ))}
      <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }}
        onClick={() => set({ breaks: [...week.breaks, { afterPeriod: Math.min(week.periodsPerDay, week.breaks.length + 3), name: "Break", durationMins: 15 }] })}>
        + Add a break
      </button>

      <Note tone="ok">
        <strong>Weekly capacity: {capacity} periods.</strong> {week.periodsPerDay} periods ×{" "}
        {week.workingDays.length} days
        {mine ? ` · ${mine.classes} classes, ${mine.sections} sections in this wing` : ""}. Every
        curriculum and mapping entry from here on is checked against this number.
      </Note>
    </>
  );
}

/** Write each wing's week through the endpoint that already owns it. */
export async function commitWeeks(answers: Record<string, any>): Promise<void> {
  const wings: WingAnswer[] = answers.wings ?? [];
  const weeks: Record<string, WeekAnswer> = answers.weeks ?? {};
  const configs = await api<Array<{ id: number; name: string }>>("/timetable-configs");

  for (const w of wings) {
    const config = configs.find((c) => c.name.toLowerCase() === w.name.toLowerCase());
    if (!config) throw new Error(`${w.name} has no timetable yet — go back to step 3.`);
    const week = { ...defaultWeek(), ...(weeks[w.name] ?? {}) };
    if (week.workingDays.length === 0) throw new Error(`${w.name} needs at least one working day.`);
    // `PUT /:id/structure` rewrites the period rows wholesale, so running it
    // twice is the same as running it once — no bookkeeping needed here either.
    await api(`/timetable-configs/${config.id}/structure`, {
      method: "PUT",
      body: JSON.stringify({
        startTime: week.startTime,
        periodsPerDay: week.periodsPerDay,
        periodDurationMins: week.periodDurationMins,
        workingDays: week.workingDays,
        hasZeroPeriod: week.hasZeroPeriod,
        breaks: week.breaks,
      }),
    });
  }
}
