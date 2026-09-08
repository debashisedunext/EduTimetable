/**
 * §28.3/28.4 — the things a school does either side of the teaching day.
 *
 * Assembly, attendance, bus dispersal. One editor, two doors: the guided
 * setup's week step edits them inside the draft, the manual Timetable
 * Configuration screen edits them against the API. The controls are shared so
 * the two cannot drift into meaning different things by the same words.
 *
 * The distinction worth keeping in mind while reading this: an activity is
 * **not a break**. A break is unstaffed by definition; the entire point of an
 * activity is that somebody is on duty and the timetable should say who. It is
 * also **not a lesson** — it has no period number, so the solver cannot reach
 * it, which is what lets this whole feature exist without teaching the solver a
 * new kind of constraint.
 */
import { useEffect, useState } from "react";
import { api } from "../api";
import { asMessage } from "../components";

export interface ActivityRow {
  id?: number;
  name: string;
  placement: "before_first" | "after_last";
  durationMins: number;
  days: number[];
  teacherId?: number | null;
  roomId?: number | null;
  sortOrder?: number;
}

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The two shapes a school reaches for first, so nobody starts from an empty box. */
export const ACTIVITY_SUGGESTIONS: ActivityRow[] = [
  { name: "Assembly", placement: "before_first", durationMins: 20, days: [1] },
  { name: "Attendance", placement: "before_first", durationMins: 10, days: [1, 2, 3, 4, 5] },
  { name: "Bus Dispersal", placement: "after_last", durationMins: 15, days: [1, 2, 3, 4, 5] },
];

/**
 * What is wrong with this set, in the words the server would use.
 *
 * Same shape as `termProblems` (§25) and for the same reason: Next must not be
 * enabled for something the commit is about to refuse, and the two must not
 * disagree about why.
 */
export function activityProblems(rows: ActivityRow[]): string | null {
  const seen = new Set<string>();
  for (const [i, a] of rows.entries()) {
    const name = a.name?.trim() ?? "";
    if (name.length < 2) return `Activity ${i + 1} needs a name.`;
    if (name.length > 60) return `"${name}" is longer than 60 characters.`;
    if (seen.has(name.toLowerCase())) return `"${name}" is listed twice.`;
    seen.add(name.toLowerCase());
    if (!(a.durationMins >= 1 && a.durationMins <= 120)) {
      return `"${name}" must be between 1 and 120 minutes.`;
    }
    if (!a.days || a.days.length === 0) return `"${name}" needs at least one day.`;
  }
  return null;
}

function Fields({ row, onChange, onRemove, staff, rooms, workingDays }: {
  row: ActivityRow;
  onChange: (patch: Partial<ActivityRow>) => void;
  onRemove: () => void;
  staff: Array<{ id: number; name: string }>;
  rooms: Array<{ id: number; name: string }>;
  workingDays: number[];
}) {
  const toggleDay = (d: number) =>
    onChange({ days: row.days.includes(d) ? row.days.filter((x) => x !== d) : [...row.days, d].sort() });

  return (
    <div style={{
      border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px",
      background: "var(--paper)", display: "flex", flexDirection: "column", gap: 9,
    }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          value={row.name} maxLength={60} aria-label="Activity name"
          placeholder="Assembly"
          onChange={(e) => onChange({ name: e.target.value })}
          style={{
            flex: "1 1 150px", minWidth: 120, padding: "6px 9px", border: "1px solid var(--line)",
            borderRadius: 8, fontSize: 13, fontWeight: 600, background: "var(--paper)", color: "var(--ink)",
          }} />
        <select value={row.placement} aria-label="When it happens"
          onChange={(e) => onChange({ placement: e.target.value as ActivityRow["placement"] })}
          style={{
            padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12.5,
            background: "var(--paper)", color: "var(--ink)",
          }}>
          <option value="before_first">before the first period</option>
          <option value="after_last">after the last period</option>
        </select>
        <input type="number" min={1} max={120} value={row.durationMins} aria-label="Minutes"
          onChange={(e) => onChange({ durationMins: Number(e.target.value) })}
          style={{
            width: 64, padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 8,
            fontSize: 12.5, textAlign: "center", fontFamily: "var(--font-mono, monospace)",
            background: "var(--paper)", color: "var(--ink)",
          }} />
        <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>mins</span>
        <span style={{ flex: 1 }} />
        <button onClick={onRemove} aria-label={`Remove ${row.name}`}
          style={{
            border: "1px solid var(--line)", borderRadius: 6, width: 26, height: 26,
            background: "var(--paper)", color: "var(--signal)", cursor: "pointer",
          }}>✕</button>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {/* Days, because assembly on Monday only is the ordinary case. */}
        <div style={{ display: "flex", gap: 4 }}>
          {workingDays.map((d) => (
            <button key={d} onClick={() => toggleDay(d)} title={DAY_NAMES[d]}
              style={{
                width: 38, height: 26, borderRadius: 7, fontWeight: 700, fontSize: 11,
                cursor: "pointer", border: "1px solid var(--line)",
                background: row.days.includes(d) ? "var(--brand)" : "var(--paper)",
                color: row.days.includes(d) ? "#fff" : "var(--ink-faint)",
              }}>{DAY_NAMES[d]}</button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {/*
          Rendered only when there is somebody to pick.

          In the guided setup this step runs BEFORE teachers are entered, so
          the list is genuinely empty — and a dropdown whose only option is
          "nobody named" is a control that cannot do anything. Better to leave
          it out and say when it becomes available than to show a dead one.
        */}
        {staff.length === 0 && rooms.length === 0 ? (
          <span style={{ fontSize: 11.2, color: "var(--ink-faint)" }}>
            Who is on duty is set once the staff list exists.
          </span>
        ) : null}
        {staff.length > 0 && (
        <select value={row.teacherId ?? ""} aria-label="Teacher on duty"
          onChange={(e) => onChange({ teacherId: e.target.value ? Number(e.target.value) : null })}
          style={{
            padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12,
            maxWidth: 190, background: "var(--paper)", color: "var(--ink)",
          }}>
          {/* Blank means "not stated", never "nobody" — the reading §18 gives
              an empty scope. A school that has not decided who takes assembly
              still wants the band on the timetable. */}
          <option value="">— nobody named —</option>
          {staff.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        )}
        {rooms.length > 0 && (
        <select value={row.roomId ?? ""} aria-label="Where"
          onChange={(e) => onChange({ roomId: e.target.value ? Number(e.target.value) : null })}
          style={{
            padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12,
            maxWidth: 160, background: "var(--paper)", color: "var(--ink)",
          }}>
          <option value="">— nowhere named —</option>
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        )}
      </div>
    </div>
  );
}

function List({ rows, setRows, staff, rooms, workingDays }: {
  rows: ActivityRow[];
  setRows: (next: ActivityRow[]) => void;
  staff: Array<{ id: number; name: string }>;
  rooms: Array<{ id: number; name: string }>;
  workingDays: number[];
}) {
  const add = (seed?: ActivityRow) =>
    setRows([...rows, seed
      ? { ...seed, days: seed.days.filter((d) => workingDays.includes(d)) }
      : { name: "", placement: "before_first", durationMins: 15, days: [...workingDays] }]);

  const unused = ACTIVITY_SUGGESTIONS.filter(
    (s) => !rows.some((r) => r.name.trim().toLowerCase() === s.name.toLowerCase()),
  );

  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r, i) => (
          <Fields key={i} row={r} staff={staff} rooms={rooms} workingDays={workingDays}
            onChange={(patch) => setRows(rows.map((x, n) => (n === i ? { ...x, ...patch } : x)))}
            onRemove={() => setRows(rows.filter((_, n) => n !== i))} />
        ))}
      </div>

      <div style={{ display: "flex", gap: 7, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn" style={{ padding: "5px 11px", fontSize: 12 }} onClick={() => add()}>
          ＋ Add an activity
        </button>
        {/*
          Named suggestions rather than an empty row, for the same reason the
          wing step offers three: "what counts as an activity?" is a question
          about our vocabulary, not the school's, and recognition is faster
          than invention.
        */}
        {unused.map((s) => (
          <button key={s.name} onClick={() => add(s)}
            style={{
              border: "1px dashed var(--line)", background: "var(--paper)", borderRadius: 20,
              padding: "4px 11px", fontSize: 11.5, cursor: "pointer", color: "var(--brand)",
            }}>＋ {s.name}</button>
        ))}
      </div>
    </>
  );
}

/** The guided setup's copy: edits the draft, writes nothing. */
export function DraftActivities({ rows, onChange, staff, rooms, workingDays }: {
  rows: ActivityRow[];
  onChange: (next: ActivityRow[]) => void;
  staff: Array<{ id: number; name: string }>;
  rooms: Array<{ id: number; name: string }>;
  workingDays: number[];
}) {
  return <List rows={rows} setRows={onChange} staff={staff} rooms={rooms} workingDays={workingDays} />;
}

/** The saved copy: reads and writes `/timetable-configs/:id/activities`. */
export function ActivitiesEditor({ configId, workingDays }: {
  configId: number;
  workingDays: number[];
}) {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [staff, setStaff] = useState<Array<{ id: number; name: string }>>([]);
  const [rooms, setRooms] = useState<Array<{ id: number; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [a, t, r] = await Promise.all([
          api<ActivityRow[]>(`/timetable-configs/${configId}/activities`),
          api<Array<{ id: number; name: string }>>("/teachers"),
          api<Array<{ id: number; name: string }>>("/rooms"),
        ]);
        if (!live) return;
        setRows(a);
        setStaff(t.map((x) => ({ id: x.id, name: x.name })));
        setRooms(r.map((x) => ({ id: x.id, name: x.name })));
      } catch (e) {
        if (live) setError(asMessage(e));
      }
    })();
    return () => { live = false; };
  }, [configId]);

  if (error) return <div style={{ fontSize: 12.5, color: "var(--signal)" }}>{error}</div>;
  if (!rows) return <p className="screen-sub">Loading activities…</p>;

  const problem = activityProblems(rows);

  const save = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const res = await api<{ endTime: string }>(`/timetable-configs/${configId}/activities`, {
        method: "PUT",
        body: JSON.stringify({ activities: rows.map((r, i) => ({ ...r, sortOrder: i })) }),
      });
      // The end of day is the visible proof that the period rows were rebuilt —
      // an activity saved without that would exist in the database and appear
      // on no timetable, which reads as the save having failed.
      setNote(`Saved. The day now ends at ${res.endTime}.`);
    } catch (e) {
      setError(asMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <List rows={rows} setRows={setRows} staff={staff} rooms={rooms} workingDays={workingDays} />
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
        <button className="btn btn-primary" disabled={busy || !!problem} onClick={() => void save()}>
          {busy ? "Saving…" : "Save activities"}
        </button>
        {problem && <span style={{ fontSize: 12, color: "var(--signal)" }}>{problem}</span>}
        {note && !problem && <span style={{ fontSize: 12, color: "var(--accent)" }}>{note}</span>}
      </div>
    </>
  );
}
