import { useState } from "react";
import { api } from "../api";
import { useApi, useConfigCtx } from "../hooks";
import { asMessage, Card, DataTable, ErrorNote, Field } from "../components";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 11px", border: "1px solid var(--line)",
  borderRadius: 8, fontSize: 13, background: "var(--paper)",
};

interface ExtraClass {
  id: number;
  classSectionLabel: string;
  subjectName: string;
  teacherName: string;
  employmentType: string;
  roomName: string | null;
  dayOfWeek: number;
  periodNumber: number;
  reason: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

/**
 * §18 — Extra & Guest Classes.
 *
 * Remedial and revision teaching that sits *outside* the timetable the solver
 * builds. A school whose grid is full has no spare period to give one, so
 * these run in the config's extra window — the periods after the teaching day
 * — and never compete with the curriculum for a slot.
 *
 * They are stored as ordinary timetable slots, so the same unique keys that
 * stop a teacher being double-booked in a normal lesson stop it here, and they
 * appear in the class's grid and the teacher's own timetable without anything
 * being taught to look in a second place.
 */
export function ExtraClasses() {
  const { current } = useConfigCtx();
  const { data, refetch } = useApi<ExtraClass[]>(current ? `/extra-classes?configId=${current.id}` : null);
  const { data: window } = useApi<{ days: number[]; periods: { periodNumber: number; startTime: string; endTime: string }[] }>(
    current ? `/extra-classes/window?configId=${current.id}` : null,
  );
  const { data: sections } = useApi<any[]>("/class-sections");
  const { data: subjects } = useApi<any[]>("/subjects");
  const { data: teachers } = useApi<any[]>("/teachers");
  const { data: rooms } = useApi<any[]>("/rooms");

  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blank = { classSectionId: "", subjectId: "", teacherId: "", roomId: "", dayOfWeek: 1, periodNumber: "", reason: "", effectiveFrom: "", effectiveTo: "" };
  const [form, setForm] = useState<any>(blank);

  const hasWindow = (window?.periods.length ?? 0) > 0;

  const save = async () => {
    try {
      await api("/extra-classes", {
        method: "POST",
        body: JSON.stringify({
          timetableConfigId: current!.id,
          classSectionId: Number(form.classSectionId),
          subjectId: Number(form.subjectId),
          teacherId: Number(form.teacherId),
          roomId: form.roomId ? Number(form.roomId) : null,
          dayOfWeek: Number(form.dayOfWeek),
          periodNumber: Number(form.periodNumber),
          reason: form.reason || null,
          effectiveFrom: form.effectiveFrom || null,
          effectiveTo: form.effectiveTo || null,
        }),
      });
      setError(null); setAdding(false); setForm(blank); refetch();
    } catch (e) { setError(asMessage(e)); }
  };

  const cancel = async (id: number) => {
    try { await api(`/extra-classes/${id}`, { method: "DELETE" }); refetch(); }
    catch (e) { setError(asMessage(e)); }
  };

  if (!current) return <Card title="Extra & Guest Classes"><p>Select a timetable first.</p></Card>;

  return (
    <Card
      title="Extra & Guest Classes"
      sub={
        hasWindow
          ? `Remedial and guest teaching in the extra window — periods ${window!.periods.map((p) => p.periodNumber).join(", ")}, after the school day. They never take a period the curriculum needs.`
          : "This timetable has no extra-class window yet."
      }
      actions={
        hasWindow ? (
          <button className="btn btn-primary" onClick={() => { setError(null); setAdding(true); }}>+ Schedule an extra class</button>
        ) : undefined
      }
    >
      <ErrorNote message={error} />

      {!hasWindow && (
        <div className="note" style={{ padding: 14, background: "var(--offwhite)", borderRadius: 10, fontSize: 13 }}>
          Extra classes run in periods added <b>after</b> the teaching day, so they cannot displace a lesson the
          timetable already depends on. Add them in <b>Setup → Timetable Structure</b> — set
          “Extra periods / day” to 1 or 2 — and they will appear here.
        </div>
      )}

      {adding && hasWindow && (
        <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 18, marginBottom: 18, background: "var(--offwhite)" }}>
          <div className="form-grid">
            <Field label="Class-section">
              <select style={inputStyle} value={form.classSectionId} onChange={(e) => setForm({ ...form, classSectionId: e.target.value })}>
                <option value="">Select…</option>
                {(sections ?? []).map((cs) => <option key={cs.id} value={cs.id}>{cs.label ?? `${cs.className}-${cs.sectionName}`}</option>)}
              </select>
            </Field>
            <Field label="Subject">
              <select style={inputStyle} value={form.subjectId} onChange={(e) => setForm({ ...form, subjectId: e.target.value })}>
                <option value="">Select…</option>
                {(subjects ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Teacher">
              <select style={inputStyle} value={form.teacherId} onChange={(e) => setForm({ ...form, teacherId: e.target.value })}>
                <option value="">Select…</option>
                {(teachers ?? []).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}{t.employmentType === "guest" ? " (guest)" : ""}</option>
                ))}
              </select>
            </Field>
            <Field label="Room (optional)">
              <select style={inputStyle} value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })}>
                <option value="">Home room</option>
                {(rooms ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
            <Field label="Day">
              <select style={inputStyle} value={form.dayOfWeek} onChange={(e) => setForm({ ...form, dayOfWeek: e.target.value })}>
                {(window?.days ?? []).map((d) => <option key={d} value={d}>{DAY_NAMES[d]}</option>)}
              </select>
            </Field>
            <Field label="Period">
              <select style={inputStyle} value={form.periodNumber} onChange={(e) => setForm({ ...form, periodNumber: e.target.value })}>
                <option value="">Select…</option>
                {(window?.periods ?? []).map((p) => (
                  <option key={p.periodNumber} value={p.periodNumber}>P{p.periodNumber} · {p.startTime}–{p.endTime}</option>
                ))}
              </select>
            </Field>
            <Field label="Reason (optional)">
              <input style={inputStyle} placeholder="Board revision" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </Field>
            <Field label="Runs from (optional)">
              <input type="date" style={inputStyle} value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
            </Field>
            <Field label="Runs until (optional)">
              <input type="date" style={inputStyle} value={form.effectiveTo} onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })} />
            </Field>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button className="btn btn-primary" onClick={save}>Schedule</button>
            <button className="btn btn-secondary" onClick={() => { setAdding(false); setError(null); }}>Cancel</button>
          </div>
        </div>
      )}

      <DataTable
        headers={["Class", "Subject", "Teacher", "When", "Room", "Reason", "Runs", ""]}
        rows={(data ?? []).map((x) => [
          <b key="c">{x.classSectionLabel}</b>,
          x.subjectName,
          <span key="t">
            {x.teacherName}
            {x.employmentType === "guest" && <span className="chip" style={{ marginLeft: 6 }}>guest</span>}
          </span>,
          <span key="w" className="mono">{DAY_NAMES[x.dayOfWeek]} P{x.periodNumber}</span>,
          x.roomName ?? "Home room",
          x.reason ?? "—",
          x.effectiveFrom || x.effectiveTo
            ? `${x.effectiveFrom ? String(x.effectiveFrom).slice(0, 10) : "—"} → ${x.effectiveTo ? String(x.effectiveTo).slice(0, 10) : "—"}`
            : "Ongoing",
          <button key="d" className="btn btn-secondary" style={{ padding: "4px 10px", fontSize: 11.5 }}
            onClick={() => cancel(x.id)}>Cancel</button>,
        ])}
      />
      {(data?.length ?? 0) === 0 && hasWindow && !adding && (
        <p style={{ fontSize: 13, color: "var(--ink-faint)", marginTop: 12 }}>
          No extra classes scheduled. They appear in each class's own timetable under the school day, and in the
          teacher's timetable, so nobody has to look in two places.
        </p>
      )}
    </Card>
  );
}
