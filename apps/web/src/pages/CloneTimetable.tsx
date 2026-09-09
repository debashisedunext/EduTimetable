/**
 * §3.12 — clone a timetable into a new academic session.
 *
 * Always previews before it writes. The preview is the point of the screen:
 * a clone touches six tables at once, and "630 rows will be created, 4 lessons
 * belong to teachers who have left" is a sentence somebody can act on, where
 * "Clone?" is not.
 */
import { useEffect, useState } from "react";
import { api } from "../api";
import { asMessage, Card, ErrorNote, Field } from "../components";
import type { TimetableConfigSummary } from "../hooks";
import { inputStyle } from "./Timetables";

interface CloneNote {
  code: string;
  message: string;
  fix: string;
  rows: string[];
}
interface ClonePlan {
  source: { id: number; name: string; academicYear: string };
  target: { academicYearId: number; academicYear: string; name: string };
  counts: {
    periods: number;
    classSectionsNew: number;
    classSectionsReused: number;
    classTeachers: number;
    curriculum: number;
    mappings: number;
    mergedGroups: number;
    electiveBlocks: number;
    electiveOptions: number;
  };
  skipped: { curriculum: number; mappings: number };
  blockers: CloneNote[];
  warnings: CloneNote[];
  sourceReadiness: number | null;
}
interface Year {
  id: number;
  name: string;
}

/** "2026-27" → "2027-28", so the commonest case is already typed in. */
function nextSessionName(current: string): string {
  const m = current.match(/^(\d{4})\s*-\s*(\d{2,4})$/);
  if (!m) return "";
  const start = Number(m[1]) + 1;
  const endDigits = m[2].length;
  const end = endDigits === 4 ? String(start + 1) : String((start + 1) % 100).padStart(2, "0");
  return `${start}-${end}`;
}

export function CloneTimetable({
  config,
  years,
  onDone,
  onCancel,
}: {
  config: TimetableConfigSummary;
  years: Year[];
  onDone: (newConfigId: number) => void;
  onCancel: () => void;
}) {
  // A session other than the one being cloned: the same session cannot hold two
  // copies of a class-section, so offering it would only produce a refusal.
  const others = years.filter((y) => y.id !== config.academicYearId);
  const suggested = nextSessionName(config.academicYear);

  const [mode, setMode] = useState<"existing" | "new">(others.length > 0 ? "existing" : "new");
  const [yearId, setYearId] = useState<string>(others[0] ? String(others[0].id) : "");
  const [yearName, setYearName] = useState(suggested);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [name, setName] = useState(
    suggested && config.name.includes(config.academicYear)
      ? config.name.replace(config.academicYear, suggested)
      : `${config.name} (copy)`,
  );
  const [plan, setPlan] = useState<ClonePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default the new session's dates to the year after the one being cloned,
  // guessing April–March only when the source says so.
  useEffect(() => {
    if (!suggested) return;
    const start = Number(suggested.slice(0, 4));
    setStartDate(`${start}-04-01`);
    setEndDate(`${start + 1}-03-31`);
  }, [suggested]);

  const body = () => ({
    name,
    ...(mode === "existing"
      ? { academicYearId: Number(yearId) }
      : { newYear: { name: yearName, startDate, endDate } }),
  });

  const ready =
    name.trim().length > 0 &&
    (mode === "existing" ? yearId !== "" : yearName.trim() !== "" && startDate !== "" && endDate !== "");

  const preview = async () => {
    setBusy(true);
    setError(null);
    try {
      setPlan(await api<ClonePlan>(`/timetable-configs/${config.id}/clone/preview`, {
        method: "POST",
        body: JSON.stringify(body()),
      }));
    } catch (e) {
      setPlan(null);
      setError(asMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await api<{ id: number }>(`/timetable-configs/${config.id}/clone`, {
        method: "POST",
        body: JSON.stringify(body()),
      });
      onDone(made.id);
    } catch (e) {
      setError(asMessage(e));
      setBusy(false);
    }
  };

  // Any change to the target invalidates the preview — a plan that describes a
  // different session than the form now shows is worse than no plan.
  const invalidate = <T,>(set: (v: T) => void) => (v: T) => { setPlan(null); set(v); };

  const total = plan
    ? plan.counts.periods + plan.counts.classSectionsNew + plan.counts.classSectionsReused +
      plan.counts.curriculum + plan.counts.mappings + plan.counts.mergedGroups +
      plan.counts.electiveBlocks + plan.counts.electiveOptions
    : 0;

  return (
    <Card title={`Clone “${config.name}”`} sub={`From ${config.academicYear} into another session. Classes, syllabus, staffing and rooms are copied — the generated timetable is not, so you adjust and press Generate.`}>
      <ErrorNote message={error} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="New timetable name">
          <input value={name} onChange={(e) => invalidate(setName)(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Clone into session">
          <select
            value={mode}
            onChange={(e) => invalidate(setMode)(e.target.value as "existing" | "new")}
            style={inputStyle}
          >
            {others.length > 0 && <option value="existing">An existing session</option>}
            <option value="new">Create a new session</option>
          </select>
        </Field>
      </div>

      {mode === "existing" ? (
        <Field label="Session">
          <select value={yearId} onChange={(e) => invalidate(setYearId)(e.target.value)} style={inputStyle}>
            {others.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}
          </select>
        </Field>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Field label="Session name">
            <input value={yearName} onChange={(e) => invalidate(setYearName)(e.target.value)} style={inputStyle} placeholder="2027-28" />
          </Field>
          <Field label="Starts">
            <input type="date" value={startDate} onChange={(e) => invalidate(setStartDate)(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Ends">
            <input type="date" value={endDate} onChange={(e) => invalidate(setEndDate)(e.target.value)} style={inputStyle} />
          </Field>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button className="btn btn-secondary" onClick={preview} disabled={!ready || busy}>
          {busy && !plan ? "Checking…" : "Preview what will be copied"}
        </button>
        <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>

      {plan && (
        <div style={{ marginTop: 18, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
          <p style={{ fontSize: 13, margin: "0 0 12px" }}>
            <strong>{total}</strong> row{total === 1 ? "" : "s"} will be created in{" "}
            <strong>{plan.target.academicYear}</strong>
            {plan.sourceReadiness !== null && (
              <> · {plan.source.name} currently reads <strong>{plan.sourceReadiness}%</strong> readiness</>
            )}
          </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8, marginBottom: 14 }}>
            <Count n={plan.counts.periods} label="periods & breaks" />
            <Count n={plan.counts.classSectionsNew} label="class-sections" note={plan.counts.classSectionsReused > 0 ? `${plan.counts.classSectionsReused} reused` : undefined} />
            <Count n={plan.counts.classTeachers} label="class teachers" />
            <Count n={plan.counts.curriculum} label="curriculum rows" note={plan.skipped.curriculum > 0 ? `${plan.skipped.curriculum} already there` : undefined} />
            <Count n={plan.counts.mappings} label="subject mappings" note={plan.skipped.mappings > 0 ? `${plan.skipped.mappings} already there` : undefined} />
            <Count n={plan.counts.mergedGroups} label="merged groups" />
            <Count n={plan.counts.electiveBlocks} label="elective blocks" note={plan.counts.electiveOptions > 0 ? `${plan.counts.electiveOptions} options` : undefined} />
          </div>

          {plan.blockers.map((b) => <Note key={b.code} note={b} kind="blocker" />)}
          {plan.warnings.map((w) => <Note key={w.code} note={w} kind="warning" />)}

          <p style={{ fontSize: 12, color: "var(--ink-faint)", margin: "12px 0" }}>
            Not copied: the generated timetable itself, its drafts and publications, extra classes
            (they run on dates), holidays, and absence records. Generate the new session when you have
            made your changes.
          </p>

          <button
            className="btn btn-primary"
            onClick={commit}
            disabled={busy || plan.blockers.length > 0}
          >
            {busy ? "Cloning…" : `Clone into ${plan.target.academicYear}`}
          </button>
        </div>
      )}
    </Card>
  );
}

function Count({ n, label, note }: { n: number; label: string; note?: string }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "8px 10px", background: "var(--offwhite)" }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 19, fontWeight: 600, color: n > 0 ? "var(--brand)" : "var(--ink-faint)" }}>{n}</div>
      <div style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>{label}</div>
      {note && <div style={{ fontSize: 10.5, color: "var(--ink-faint)" }}>{note}</div>}
    </div>
  );
}

function Note({ note, kind }: { note: CloneNote; kind: "blocker" | "warning" }) {
  const blocker = kind === "blocker";
  return (
    <div
      style={{
        border: `1px solid ${blocker ? "var(--signal)" : "var(--amber)"}`,
        background: blocker ? "var(--signal-bg, #FDF2F1)" : "var(--amber-bg, #FDF6EA)",
        borderRadius: 8, padding: "10px 12px", marginBottom: 8, fontSize: 12.5,
      }}
    >
      <div style={{ fontWeight: 600, color: blocker ? "var(--signal)" : "var(--amber)" }}>{note.message}</div>
      <div style={{ color: "var(--ink-soft)", margin: "3px 0 5px" }}>{note.fix}</div>
      {/* The exact rows, never a vague count — this is the "name the row and the
          fix" contract the Feasibility Engine holds itself to (§4). */}
      <ul className="mono" style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, color: "var(--ink-soft)" }}>
        {note.rows.slice(0, 8).map((r) => <li key={r}>{r}</li>)}
        {note.rows.length > 8 && <li style={{ listStyle: "none", marginLeft: -18 }}>…and {note.rows.length - 8} more</li>}
      </ul>
    </div>
  );
}
