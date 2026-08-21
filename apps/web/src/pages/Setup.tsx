import { useState } from "react";
import { api } from "../api";
import { Card, DataTable, ErrorNote, Field } from "../components";
import { useApi, useConfigCtx } from "../hooks";
import { inputStyle } from "./Timetables";
import { StepCurriculum, StepTeachers, StepTeacherMapping, StepConfig } from "./SetupAdvanced";

const STEPS = [
  "Academic Year",
  "Classes & Sections",
  "Rooms",
  "Subjects",
  "Curriculum",
  "Teachers",
  "Teacher Mapping",
  "Timetable Config",
];

/** Setup Wizard (§8.1) — list-first, form-second on every step. */
export function Setup() {
  const [step, setStep] = useState(0);
  const { current } = useConfigCtx();

  return (
    <div style={{ maxWidth: 980 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 22, overflowX: "auto", paddingBottom: 4 }}>
        {STEPS.map((label, i) => (
          <div key={label} style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            {i > 0 && <div style={{ width: 26, height: 1.5, background: "var(--line)", margin: "0 6px" }} />}
            <button
              onClick={() => setStep(i)}
              style={{ display: "flex", alignItems: "center", gap: 7, background: "none", border: "none", padding: 0 }}
            >
              <span style={{
                width: 26, height: 26, borderRadius: "50%", display: "grid", placeItems: "center",
                fontSize: 11.5, fontWeight: 700,
                background: i === step ? "var(--forest)" : i < step ? "var(--mint)" : "var(--sage-pale)",
                color: i <= step ? "#fff" : "var(--sage)",
              }}>{i + 1}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: i === step ? "var(--ink)" : "var(--ink-faint)", whiteSpace: "nowrap" }}>
                {label}
              </span>
            </button>
          </div>
        ))}
      </div>

      {current && step >= 4 && (
        <p className="screen-sub">Editing timetable: <b>{current.name}</b></p>
      )}

      {step === 0 && <StepAcademicYear />}
      {step === 1 && <StepClasses />}
      {step === 2 && <StepRooms />}
      {step === 3 && <StepSubjects />}
      {step === 4 && <StepCurriculum />}
      {step === 5 && <StepTeachers />}
      {step === 6 && <StepTeacherMapping />}
      {step === 7 && <StepConfig />}

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
        <button className="btn" style={{ border: "1px solid var(--line)" }} disabled={step === 0} onClick={() => setStep(step - 1)}>← Back</button>
        <button className="btn btn-primary" disabled={step === STEPS.length - 1} onClick={() => setStep(step + 1)}>Next →</button>
      </div>
    </div>
  );
}

function StepAcademicYear() {
  const { data, refetch } = useApi<any[]>("/academic-years");
  const [form, setForm] = useState({ name: "", startDate: "", endDate: "" });
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    try {
      await api("/academic-years", { method: "POST", body: JSON.stringify(form) });
      setForm({ name: "", startDate: "", endDate: "" });
      setError(null);
      refetch();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <Card title="Academic Years" sub="Everything downstream is scoped to a year.">
      <ErrorNote message={error} />
      <DataTable
        headers={["Name", "Start", "End", "Active"]}
        rows={(data ?? []).map((y) => [
          y.name, y.startDate?.slice(0, 10), y.endDate?.slice(0, 10),
          y.isActive ? <span key="a" className="badge badge-ok">active</span> : "—",
        ])}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 10, marginTop: 14, alignItems: "end" }}>
        <Field label="Name (e.g. 2026-27)"><input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Start date"><input type="date" style={inputStyle} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
        <Field label="End date"><input type="date" style={inputStyle} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></Field>
        <button className="btn btn-primary" style={{ marginBottom: 18 }} onClick={add} disabled={!form.name || !form.startDate || !form.endDate}>＋ Add</button>
      </div>
    </Card>
  );
}

function StepClasses() {
  const { data: classes, refetch } = useApi<any[]>("/classes");
  const { data: years } = useApi<any[]>("/academic-years");
  const { data: sections, refetch: refetchSections } = useApi<any[]>("/class-sections");
  const [className, setClassName] = useState("");
  const [secForm, setSecForm] = useState({ classId: "", name: "" });
  const [error, setError] = useState<string | null>(null);

  const addClass = async () => {
    try {
      await api("/classes", { method: "POST", body: JSON.stringify({ name: className, sequence: (classes?.length ?? 0) + 1 }) });
      setClassName(""); setError(null); refetch();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const addSection = async () => {
    try {
      const yearId = years?.find((y) => y.isActive)?.id ?? years?.[0]?.id;
      if (!yearId) { setError("Create an academic year first."); return; }
      await api(`/classes/${secForm.classId}/sections`, { method: "POST", body: JSON.stringify({ name: secForm.name, academicYearId: yearId }) });
      setSecForm({ classId: secForm.classId, name: "" }); setError(null); refetch(); refetchSections();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <>
      <Card title="Classes" sub="Grades I–XII, in display order.">
        <ErrorNote message={error} />
        <DataTable
          headers={["Class", "Sections"]}
          rows={(classes ?? []).map((c) => [c.name, c.sections.map((s: any) => s.name).join(", ") || "—"])}
        />
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, marginTop: 14, alignItems: "end" }}>
          <Field label="Class name (e.g. Class 7)"><input style={inputStyle} value={className} onChange={(e) => setClassName(e.target.value)} /></Field>
          <button className="btn btn-primary" style={{ marginBottom: 18 }} onClick={addClass} disabled={!className}>＋ Add Class</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, alignItems: "end" }}>
          <Field label="Add section to">
            <select style={inputStyle} value={secForm.classId} onChange={(e) => setSecForm({ ...secForm, classId: e.target.value })}>
              <option value="">— choose class —</option>
              {(classes ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Section name (A, B…)"><input style={inputStyle} value={secForm.name} onChange={(e) => setSecForm({ ...secForm, name: e.target.value })} /></Field>
          <button className="btn btn-primary" style={{ marginBottom: 18 }} onClick={addSection} disabled={!secForm.classId || !secForm.name}>＋ Add Section</button>
        </div>
      </Card>
      <Card title="Class-Sections" sub="The scheduling units. Assign them to a timetable in the last step.">
        <DataTable
          headers={["Class-Section", "Strength", "Timetable", "Class Teacher"]}
          rows={(sections ?? []).map((cs) => [
            <b key="a">{cs.label}</b>, cs.strength ?? "—",
            cs.timetableConfigName ?? <span key="b" className="badge badge-error">unassigned</span>,
            cs.classTeacherName ?? <span key="c" style={{ color: "var(--ink-faint)" }}>—</span>,
          ])}
        />
      </Card>
    </>
  );
}

function StepRooms() {
  const { data, refetch } = useApi<any[]>("/rooms");
  const [form, setForm] = useState({ name: "", roomType: "classroom", capacity: "" });
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    try {
      await api("/rooms", { method: "POST", body: JSON.stringify({ ...form, capacity: form.capacity ? Number(form.capacity) : null }) });
      setForm({ name: "", roomType: "classroom", capacity: "" }); setError(null); refetch();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <Card title="Rooms" sub="Labs and other shared rooms get their own contention check (§4.5).">
      <ErrorNote message={error} />
      <DataTable
        headers={["Room", "Type", "Capacity", "Shared"]}
        rows={(data ?? []).map((r) => [r.name, <span key="t" className="chip mono">{r.roomType}</span>, r.capacity ?? "—", r.isShared ? "yes" : "—"])}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 10, marginTop: 14, alignItems: "end" }}>
        <Field label="Name"><input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Type">
          <select style={inputStyle} value={form.roomType} onChange={(e) => setForm({ ...form, roomType: e.target.value })}>
            {["classroom", "lab", "sports", "music", "art", "auditorium", "other"].map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Capacity"><input type="number" style={inputStyle} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} /></Field>
        <button className="btn btn-primary" style={{ marginBottom: 18 }} onClick={add} disabled={!form.name}>＋ Add</button>
      </div>
    </Card>
  );
}

function StepSubjects() {
  const { data, refetch } = useApi<any[]>("/subjects");
  const [form, setForm] = useState({ name: "", isLab: false });
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    try {
      await api("/subjects", { method: "POST", body: JSON.stringify(form) });
      setForm({ name: "", isLab: false }); setError(null); refetch();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <Card title="Subjects" sub="Flag lab subjects — they must land in a lab room.">
      <ErrorNote message={error} />
      <DataTable
        headers={["Subject", "Lab?"]}
        rows={(data ?? []).map((s) => [s.name, s.isLab ? <span key="l" className="badge badge-ok">lab</span> : "—"])}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 10, marginTop: 14, alignItems: "end" }}>
        <Field label="Subject name"><input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <label style={{ display: "flex", gap: 7, alignItems: "center", marginBottom: 24, fontSize: 13 }}>
          <input type="checkbox" checked={form.isLab} onChange={(e) => setForm({ ...form, isLab: e.target.checked })} /> Requires lab
        </label>
        <button className="btn btn-primary" style={{ marginBottom: 18 }} onClick={add} disabled={!form.name}>＋ Add</button>
      </div>
    </Card>
  );
}
