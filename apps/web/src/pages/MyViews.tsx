import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { asMessage, Card, ErrorNote } from "../components";
import { inputStyle } from "./Timetables";
import { WeekGrid, type GridPayload } from "./WeekGrid";

/** Every empty state on these screens says WHY it is empty and what to do —
 *  a blank content area is a bug, not a state. */
function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card title={title}>
      <p className="screen-sub" style={{ marginBottom: 0 }}>{children}</p>
    </Card>
  );
}

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

  if (error) {
    return (
      <>
        <ErrorNote message={error} />
        <EmptyState title="My Timetable">Your timetable could not be loaded. Try again, or ask an administrator to check your access.</EmptyState>
      </>
    );
  }
  if (!data) return <EmptyState title="My Timetable">Loading your timetable…</EmptyState>;

  // an admin/office login that is not a teacher — explain instead of showing a void
  if (data.unlinked) {
    return (
      <EmptyState title="My Timetable">
        This login isn't linked to a teacher record, so there's no personal timetable to show.
        An administrator can link it on the <Link to="/roles">Roles &amp; Access</Link> page — or use{" "}
        <Link to="/reports">Reports</Link> to open any teacher's weekly grid.
      </EmptyState>
    );
  }
  if (data.periods.length === 0) {
    return (
      <EmptyState title={`${data.label} — my week`}>
        Nothing published yet for your classes. Once a timetable is published your week appears here,
        with free periods marked and that day's substitutions overlaid.
      </EmptyState>
    );
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

  if (error) {
    return (
      <>
        <ErrorNote message={error} />
        <EmptyState title="My Classes">Those class grids could not be loaded.</EmptyState>
      </>
    );
  }
  if (sections.length === 0) {
    return (
      <EmptyState title="My Classes">
        No class-sections are linked to this login yet. A teacher appears here once they're mapped to a
        subject in a section or made its class teacher (Setup Wizard → Teacher Mapping). Admins can open
        any class grid from <Link to="/reports">Reports</Link>.
      </EmptyState>
    );
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
      {!data ? (
        <EmptyState title="Loading…">Fetching that class-section's week.</EmptyState>
      ) : data.periods.length === 0 ? (
        <EmptyState title={`${data.label} — weekly timetable`}>
          Nothing published for this class-section yet.
        </EmptyState>
      ) : (
        <Card title={`${data.label} — weekly timetable`} sub={data.classTeacher ? `Class teacher: ${data.classTeacher}` : undefined}>
          <WeekGrid data={data} />
        </Card>
      )}
    </div>
  );
}
