import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { asMessage, Card, confirmDelete, DataTable, ErrorNote, Field, RowActions } from "../components";
import { useApi, useConfigCtx } from "../hooks";
import { inputStyle } from "./Timetables";
import { StepCurriculum, StepTeachers, StepTeacherMapping, StepConfig } from "./SetupAdvanced";

// Capacity-first order: Timetable Config (periods/week capacity) precedes
// Curriculum and Teacher Mapping so their periods/week entries validate
// against an already-defined week.
const STEPS = [
  "Academic Year",
  "Classes & Sections",
  "Rooms",
  "Subjects",
  "Teachers",
  "Timetable Config",
  "Curriculum",
  "Teacher Mapping",
];

/** Setup Wizard (§8.1) — list-first, form-second on every step. */
export function Setup() {
  const [step, setStep] = useState(0);
  const { current } = useConfigCtx();

  return (
    <div>
      {/* §16: the whole wizard can be skipped by uploading one spreadsheet */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", marginBottom: 16,
        background: "var(--steel-pale)", border: "1px solid var(--steel-light)", borderRadius: 10,
      }}>
        <span style={{ fontSize: 16 }}>⬆</span>
        <span style={{ fontSize: 12.5, color: "var(--ink-soft)", flex: 1 }}>
          Already have this data in a spreadsheet? Import every master from one Excel file instead of typing it in.
        </span>
        <Link to="/import" className="btn btn-secondary" style={{ textDecoration: "none", fontSize: 12.5, padding: "6px 12px" }}>
          Import from Excel →
        </Link>
      </div>

      {/* stepper spans the full width: connector lines flex-grow so all steps
          stay visible without horizontal scroll; wraps on narrow screens */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: 10, marginBottom: 22 }}>
        {STEPS.map((label, i) => (
          <div key={label} style={{ display: "flex", alignItems: "center", flex: i > 0 ? "1 1 auto" : "0 0 auto", minWidth: 0 }}>
            {i > 0 && <div style={{ flex: 1, minWidth: 12, height: 1.5, background: "var(--line)", margin: "0 8px" }} />}
            <button
              onClick={() => setStep(i)}
              style={{ display: "flex", alignItems: "center", gap: 7, background: "none", border: "none", padding: 0, flexShrink: 0, cursor: "pointer" }}
            >
              <span style={{
                width: 26, height: 26, borderRadius: "50%", display: "grid", placeItems: "center",
                fontSize: 11.5, fontWeight: 700,
                background: i === step ? "var(--brand)" : i < step ? "var(--accent)" : "var(--steel-pale)",
                color: i <= step ? "#fff" : "var(--steel)",
              }}>{i + 1}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: i === step ? "var(--ink)" : "var(--ink-faint)", whiteSpace: "nowrap" }}>
                {label}
              </span>
            </button>
          </div>
        ))}
      </div>

      {current && step >= 5 && (
        <p className="screen-sub">Editing timetable: <b>{current.name}</b></p>
      )}

      {step === 0 && <StepAcademicYear />}
      {step === 1 && <StepClasses />}
      {step === 2 && <StepRooms />}
      {step === 3 && <StepSubjects />}
      {step === 4 && <StepTeachers onNext={() => setStep(5)} />}
      {step === 5 && <StepConfig />}
      {step === 6 && <StepCurriculum />}
      {step === 7 && <StepTeacherMapping />}

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
  const [editId, setEditId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setForm({ name: "", startDate: "", endDate: "" }); setEditId(null); };
  const save = async () => {
    try {
      if (editId) await api(`/academic-years/${editId}`, { method: "PUT", body: JSON.stringify(form) });
      else await api("/academic-years", { method: "POST", body: JSON.stringify(form) });
      reset(); setError(null); refetch();
    } catch (e) { setError(asMessage(e)); }
  };
  const remove = async (y: any) => {
    if (!confirmDelete(`academic year "${y.name}"`)) return;
    try { await api(`/academic-years/${y.id}`, { method: "DELETE" }); setError(null); refetch(); }
    catch (e) { setError(asMessage(e)); }
  };

  return (
    <Card title="Academic Years" sub="Everything downstream is scoped to a year.">
      <ErrorNote message={error} />
      <DataTable
        headers={["Name", "Start", "End", "Active", ""]}
        rows={(data ?? []).map((y) => [
          y.name, y.startDate?.slice(0, 10), y.endDate?.slice(0, 10),
          y.isActive ? <span key="a" className="badge badge-ok">active</span> : "—",
          <RowActions key="x"
            onEdit={() => { setEditId(y.id); setForm({ name: y.name, startDate: y.startDate?.slice(0, 10) ?? "", endDate: y.endDate?.slice(0, 10) ?? "" }); }}
            onDelete={() => remove(y)} />,
        ])}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto auto", gap: 10, marginTop: 14, alignItems: "end" }}>
        <Field label="Name (e.g. 2026-27)"><input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Start date"><input type="date" style={inputStyle} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
        <Field label="End date"><input type="date" style={inputStyle} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></Field>
        <button className="btn btn-primary" style={{ marginBottom: 18 }} onClick={save} disabled={!form.name || !form.startDate || !form.endDate}>
          {editId ? "✓ Save changes" : "＋ Add"}
        </button>
        {editId && <button className="btn" style={{ marginBottom: 18, border: "1px solid var(--line)" }} onClick={reset}>Cancel</button>}
      </div>
    </Card>
  );
}

function StepClasses() {
  const { data: classes, refetch } = useApi<any[]>("/classes");
  const { data: years } = useApi<any[]>("/academic-years");
  const { data: sections, refetch: refetchSections } = useApi<any[]>("/class-sections");
  const [className, setClassName] = useState("");
  const [editClassId, setEditClassId] = useState<number | null>(null);
  const [secForm, setSecForm] = useState({ classId: "", name: "" });
  const [csEdit, setCsEdit] = useState<{ id: number; sectionName: string; strength: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetchAll = () => { refetch(); refetchSections(); };

  const saveClass = async () => {
    try {
      if (editClassId) await api(`/classes/${editClassId}`, { method: "PUT", body: JSON.stringify({ name: className }) });
      else await api("/classes", { method: "POST", body: JSON.stringify({ name: className, sequence: (classes?.length ?? 0) + 1 }) });
      setClassName(""); setEditClassId(null); setError(null); refetchAll();
    } catch (e) { setError(asMessage(e)); }
  };
  const removeClass = async (c: any) => {
    if (!confirmDelete(`class "${c.name}" (and nothing else — sections must be removed first)`)) return;
    try { await api(`/classes/${c.id}`, { method: "DELETE" }); setError(null); refetchAll(); }
    catch (e) { setError(asMessage(e)); }
  };
  const addSection = async () => {
    try {
      const yearId = years?.find((y) => y.isActive)?.id ?? years?.[0]?.id;
      if (!yearId) { setError("Create an academic year first."); return; }
      await api(`/classes/${secForm.classId}/sections`, { method: "POST", body: JSON.stringify({ name: secForm.name, academicYearId: yearId }) });
      setSecForm({ classId: secForm.classId, name: "" }); setError(null); refetchAll();
    } catch (e) { setError(asMessage(e)); }
  };
  const saveCs = async () => {
    if (!csEdit) return;
    try {
      await api(`/class-sections/${csEdit.id}`, {
        method: "PUT",
        body: JSON.stringify({
          sectionName: csEdit.sectionName,
          strength: csEdit.strength === "" ? null : Number(csEdit.strength),
        }),
      });
      setCsEdit(null); setError(null); refetchAll();
    } catch (e) { setError(asMessage(e)); }
  };
  const removeCs = async (cs: any) => {
    if (!confirmDelete(`class-section "${cs.label}"`)) return;
    try { await api(`/class-sections/${cs.id}`, { method: "DELETE" }); setError(null); refetchAll(); }
    catch (e) { setError(asMessage(e)); }
  };

  const smallInput: React.CSSProperties = { ...inputStyle, padding: "5px 8px", fontSize: 12 };

  return (
    <>
      <Card title="Classes" sub="Grades I–XII, in display order.">
        <ErrorNote message={error} />
        <DataTable
          headers={["Class", "Sections", ""]}
          rows={(classes ?? []).map((c) => [
            c.name, c.sections.map((s: any) => s.name).join(", ") || "—",
            <RowActions key="x"
              onEdit={() => { setEditClassId(c.id); setClassName(c.name); }}
              onDelete={() => removeClass(c)} />,
          ])}
        />
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 10, marginTop: 14, alignItems: "end" }}>
          <Field label={editClassId ? "Rename class" : "Class name (e.g. Class 7)"}>
            <input style={inputStyle} value={className} onChange={(e) => setClassName(e.target.value)} />
          </Field>
          <button className="btn btn-primary" style={{ marginBottom: 18 }} onClick={saveClass} disabled={!className}>
            {editClassId ? "✓ Save" : "＋ Add Class"}
          </button>
          {editClassId && <button className="btn" style={{ marginBottom: 18, border: "1px solid var(--line)" }} onClick={() => { setEditClassId(null); setClassName(""); }}>Cancel</button>}
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
          headers={["Class-Section", "Strength", "Timetable", "Class Teacher", ""]}
          rows={(sections ?? []).map((cs) => {
            const edit = csEdit && csEdit.id === cs.id ? csEdit : null;
            return edit
              ? [
                  <span key="a" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <b>{cs.label.split("-").slice(0, -1).join("-")}-</b>
                    <input style={{ ...smallInput, width: 54 }} value={edit.sectionName}
                      onChange={(e) => setCsEdit({ ...edit, sectionName: e.target.value })} />
                  </span>,
                  <input key="b" type="number" style={{ ...smallInput, width: 70 }} placeholder="—" value={edit.strength}
                    onChange={(e) => setCsEdit({ ...edit, strength: e.target.value })} />,
                  cs.timetableConfigName ?? "—",
                  cs.classTeacherName ?? "—",
                  <span key="x" style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button className="btn btn-primary" style={{ padding: "4px 10px", fontSize: 11.5 }} onClick={saveCs}>✓ Save</button>
                    <button className="btn" style={{ padding: "4px 10px", fontSize: 11.5, border: "1px solid var(--line)" }} onClick={() => setCsEdit(null)}>Cancel</button>
                  </span>,
                ]
              : [
                  <b key="a">{cs.label}</b>, cs.strength ?? "—",
                  cs.timetableConfigName ?? <span key="b" className="badge badge-error">unassigned</span>,
                  cs.classTeacherName ?? <span key="c" style={{ color: "var(--ink-faint)" }}>—</span>,
                  <RowActions key="x"
                    onEdit={() => setCsEdit({ id: cs.id, sectionName: cs.label.split("-").pop() ?? "", strength: cs.strength == null ? "" : String(cs.strength) })}
                    onDelete={() => removeCs(cs)} />,
                ];
          })}
        />
      </Card>
    </>
  );
}

function StepRooms() {
  const { data, refetch } = useApi<any[]>("/rooms");
  const [form, setForm] = useState({ name: "", roomType: "classroom", capacity: "" });
  const [editId, setEditId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setForm({ name: "", roomType: "classroom", capacity: "" }); setEditId(null); };
  const save = async () => {
    try {
      const body = JSON.stringify({ ...form, capacity: form.capacity ? Number(form.capacity) : null });
      if (editId) await api(`/rooms/${editId}`, { method: "PUT", body });
      else await api("/rooms", { method: "POST", body });
      reset(); setError(null); refetch();
    } catch (e) { setError(asMessage(e)); }
  };
  const remove = async (r: any) => {
    if (!confirmDelete(`room "${r.name}"`)) return;
    try { await api(`/rooms/${r.id}`, { method: "DELETE" }); setError(null); refetch(); }
    catch (e) { setError(asMessage(e)); }
  };

  return (
    <Card title="Rooms" sub="Labs and other shared rooms get their own contention check (§4.5).">
      <ErrorNote message={error} />
      <DataTable
        headers={["Room", "Type", "Capacity", "Shared", ""]}
        rows={(data ?? []).map((r) => [
          r.name, <span key="t" className="chip mono">{r.roomType}</span>, r.capacity ?? "—", r.isShared ? "yes" : "—",
          <RowActions key="x"
            onEdit={() => { setEditId(r.id); setForm({ name: r.name, roomType: r.roomType, capacity: r.capacity == null ? "" : String(r.capacity) }); }}
            onDelete={() => remove(r)} />,
        ])}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto auto", gap: 10, marginTop: 14, alignItems: "end" }}>
        <Field label="Name"><input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Type">
          <select style={inputStyle} value={form.roomType} onChange={(e) => setForm({ ...form, roomType: e.target.value })}>
            {["classroom", "lab", "sports", "music", "art", "auditorium", "other"].map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Capacity"><input type="number" style={inputStyle} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} /></Field>
        <button className="btn btn-primary" style={{ marginBottom: 18 }} onClick={save} disabled={!form.name}>
          {editId ? "✓ Save changes" : "＋ Add"}
        </button>
        {editId && <button className="btn" style={{ marginBottom: 18, border: "1px solid var(--line)" }} onClick={reset}>Cancel</button>}
      </div>
    </Card>
  );
}

function StepSubjects() {
  const { data, refetch } = useApi<any[]>("/subjects");
  const [form, setForm] = useState({ name: "", isLab: false });
  const [editId, setEditId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setForm({ name: "", isLab: false }); setEditId(null); };
  const save = async () => {
    try {
      if (editId) await api(`/subjects/${editId}`, { method: "PUT", body: JSON.stringify(form) });
      else await api("/subjects", { method: "POST", body: JSON.stringify(form) });
      reset(); setError(null); refetch();
    } catch (e) { setError(asMessage(e)); }
  };
  const remove = async (s: any) => {
    if (!confirmDelete(`subject "${s.name}"`)) return;
    try { await api(`/subjects/${s.id}`, { method: "DELETE" }); setError(null); refetch(); }
    catch (e) { setError(asMessage(e)); }
  };

  return (
    <Card title="Subjects" sub="Flag lab subjects — they must land in a lab room.">
      <ErrorNote message={error} />
      <DataTable
        headers={["Subject", "Lab?", ""]}
        rows={(data ?? []).map((s) => [
          s.name, s.isLab ? <span key="l" className="badge badge-ok">lab</span> : "—",
          <RowActions key="x"
            onEdit={() => { setEditId(s.id); setForm({ name: s.name, isLab: s.isLab }); }}
            onDelete={() => remove(s)} />,
        ])}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 10, marginTop: 14, alignItems: "end" }}>
        <Field label="Subject name"><input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <label style={{ display: "flex", gap: 7, alignItems: "center", marginBottom: 24, fontSize: 13 }}>
          <input type="checkbox" checked={form.isLab} onChange={(e) => setForm({ ...form, isLab: e.target.checked })} /> Requires lab
        </label>
        <button className="btn btn-primary" style={{ marginBottom: 18 }} onClick={save} disabled={!form.name}>
          {editId ? "✓ Save changes" : "＋ Add"}
        </button>
        {editId && <button className="btn" style={{ marginBottom: 18, border: "1px solid var(--line)" }} onClick={reset}>Cancel</button>}
      </div>
    </Card>
  );
}
