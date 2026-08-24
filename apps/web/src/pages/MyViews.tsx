import { useEffect, useState } from "react";
import { api } from "../api";
import { asMessage, Card, ErrorNote } from "../components";
import { inputStyle } from "./Timetables";
import { WeekGrid, type GridPayload } from "./WeekGrid";

/** §15.3 — My Timetable: the teacher's own weekly grid, free periods marked,
 *  today's substitutions overlaid by default. Scope enforced server-side. */
export function MyTimetable() {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [data, setData] = useState<(GridPayload & { unlinked?: boolean }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<GridPayload & { unlinked?: boolean }>(`/my/timetable${date ? `?date=${date}` : ""}`)
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(asMessage(e)));
  }, [date]);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <p className="screen-sub">Loading your timetable…</p>;
  if (data.unlinked) {
    return <Card title="My Timetable"><p className="screen-sub">Your login isn't linked to a teacher record yet — ask an administrator to link it on the Roles & Access page.</p></Card>;
  }

  return (
    <Card
      title={`${data.label} — my week`}
      sub={`${data.weeklyLoad}/${data.maxPeriodsPerWeek} periods · free periods marked · substitutions overlaid for the picked date`}
      actions={<input type="date" style={{ ...inputStyle, width: 160 }} value={date} onChange={(e) => setDate(e.target.value)} />}
    >
      <WeekGrid data={data} />
    </Card>
  );
}

/** §15.3 — My Classes: weekly grids of the class-sections this teacher is
 *  linked to (teaches, merged-teaches, or is class teacher of). */
export function MyClasses() {
  const [sections, setSections] = useState<{ id: number; label: string }[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [data, setData] = useState<GridPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ sections: { id: number; label: string }[] }>("/my/classes")
      .then((r) => {
        setSections(r.sections);
        if (r.sections[0]) setActive(r.sections[0].id);
      })
      .catch((e) => setError(asMessage(e)));
  }, []);

  useEffect(() => {
    if (active === null) return;
    setData(null);
    api<GridPayload>(`/reports/class-section/${active}`)
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(asMessage(e)));
  }, [active]);

  if (error) return <ErrorNote message={error} />;
  if (sections.length === 0) {
    return <Card title="My Classes"><p className="screen-sub">No linked class-sections — you appear here once you're mapped to subjects or made a class teacher.</p></Card>;
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {sections.map((s) => (
          <button key={s.id} onClick={() => setActive(s.id)} className="btn"
            style={{
              border: "1px solid var(--line)", fontWeight: 700, fontSize: 12.5,
              background: active === s.id ? "var(--brand)" : "var(--paper)",
              color: active === s.id ? "#fff" : "var(--ink)",
            }}>
            {s.label}
          </button>
        ))}
      </div>
      {data ? (
        <Card title={`${data.label} — weekly timetable`} sub={data.classTeacher ? `Class teacher: ${data.classTeacher}` : undefined}>
          <WeekGrid data={data} />
        </Card>
      ) : (
        <p className="screen-sub">Loading…</p>
      )}
    </div>
  );
}
