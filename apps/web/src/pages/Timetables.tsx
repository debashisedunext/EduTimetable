import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, switchSchool } from "../api";
import { Card, ErrorNote, Field } from "../components";
import { useConfigCtx } from "../hooks";
import type { MeResponse } from "@edutimetable/shared";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Screen 0 (§8.1): every wing's timetable, built and published independently. */
export function Timetables({ me }: { me: MeResponse }) {
  const { configs, setCurrentId, refetch } = useConfigCtx();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A trust admin may run timetables for several schools, so the school is part
  // of creating one. Defaults to the school the session is already in, which is
  // the only option for a single-school user (§17.4).
  const [schoolId, setSchoolId] = useState(me.school.id);
  const manySchools = me.schools.length > 1;

  const create = async () => {
    try {
      // Creating "for another school" means being in that school: the server
      // takes the school from the session, never from the request body, so
      // there is no way to create a timetable somewhere you are not (§17).
      if (schoolId !== me.school.id) {
        await switchSchool(schoolId);
        const moved = await api<{ id: number }[]>("/academic-years");
        if (moved.length === 0) {
          setError("That school has no academic year yet — its Setup Wizard starts there.");
          window.location.href = "/setup";
          return;
        }
      }
      const years = await api<{ id: number }[]>("/academic-years");
      if (years.length === 0) {
        setError("Create an academic year first (Setup Wizard → Academic Year).");
        return;
      }
      const created = await api<{ id: number }>("/timetable-configs", {
        method: "POST",
        body: JSON.stringify({ name, academicYearId: years[0].id }),
      });
      setCreating(false);
      setName("");
      if (schoolId !== me.school.id) {
        // The whole page belongs to the previous school; reload into the new one.
        setCurrentId(created.id);
        window.location.href = "/setup";
        return;
      }
      refetch();
      setCurrentId(created.id);
      navigate("/setup");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div style={{ maxWidth: 880 }}>
      <ErrorNote message={error} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <p className="screen-sub" style={{ margin: 0 }}>
          Every wing runs its own timetable — different timings, periods, and breaks — built and published independently (§3.10).
        </p>
        <div style={{ display: "flex", gap: 10 }}>
          {/* §16: skip the hand-entry route entirely and load the masters from a spreadsheet */}
          <Link to="/import" className="btn btn-secondary" style={{ textDecoration: "none" }}>⬆ Import from Excel</Link>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>＋ New Timetable</button>
        </div>
      </div>

      {creating && (
        <Card title="New Timetable">
          {manySchools ? (
            <Field label="School">
              <select value={schoolId} onChange={(e) => setSchoolId(Number(e.target.value))} style={inputStyle}>
                {me.schools.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </Field>
          ) : (
            <p style={{ fontSize: 12.5, color: "var(--ink-soft)", margin: "0 0 12px" }}>
              For <strong>{me.school.name}</strong>
            </p>
          )}
          <Field label="Name (e.g. Senior Wing)">
            <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
          </Field>
          <button className="btn btn-primary" onClick={create} disabled={!name.trim()}>Create & open wizard</button>{" "}
          <button className="btn" style={{ border: "1px solid var(--line)" }} onClick={() => setCreating(false)}>Cancel</button>
        </Card>
      )}

      {configs.length === 0 && !creating && (
        <Card><p style={{ color: "var(--ink-faint)", fontSize: 13 }}>No timetables yet — create one to start the Setup Wizard.</p></Card>
      )}

      {configs.map((c) => (
        <Card key={c.id}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 17 }}>{c.name}</h2>
              <p style={{ fontSize: 12.5, color: "var(--ink-soft)", margin: "4px 0 8px" }}>
                {c.description ?? "—"} · {c.academicYear}
              </p>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span className="chip mono">{c.workingDays.map((d) => DAY_NAMES[d]).join(" ")}</span>
                <span className="chip mono">{c.periodsPerDay} periods/day</span>
                <span className="chip mono">{c.startTime}–{c.endTime ?? "?"}</span>
                {c.classSections.length > 0 ? (
                  <span className="chip">{c.classSections.length} class-sections</span>
                ) : (
                  <span className="badge badge-error">no classes assigned</span>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className={`badge ${c.status === "active" ? "badge-ok" : "badge-error"}`} style={c.status === "draft" ? { background: "var(--amber-bg)", color: "var(--amber)" } : {}}>
                {c.status}
              </span>
              <button className="btn btn-primary" onClick={() => { setCurrentId(c.id); navigate("/setup"); }}>Edit</button>
              <button className="btn" style={{ border: "1px solid var(--line)" }} onClick={() => { setCurrentId(c.id); navigate("/readiness"); }}>
                Readiness
              </button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

export const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 8,
  fontSize: 13, fontFamily: "inherit", background: "var(--paper)",
};
