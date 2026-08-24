import { useEffect, useState } from "react";
import { api } from "../api";
import { asMessage, Card, confirmDelete, DataTable, ErrorNote, Field, RowActions } from "../components";
import { useApi, useConfigCtx } from "../hooks";
import { inputStyle } from "./Timetables";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Tightest weekly capacity (periods/day × working days) across the configs
 *  the given class-sections belong to — mirrors the server's capacity guard. */
function weekCapFor(
  sectionRows: any[],
  ids: number[],
  configs: { id: number; name: string; periodsPerDay: number; workingDays: number[] }[],
): { cap: number; name: string } | null {
  let min: { cap: number; name: string } | null = null;
  for (const id of ids) {
    const cs = sectionRows.find((s) => s.id === id);
    const cfg = cs && configs.find((c) => c.id === cs.timetableConfigId);
    if (!cfg) continue;
    const cap = cfg.periodsPerDay * cfg.workingDays.length;
    if (!min || cap < min.cap) min = { cap, name: cfg.name };
  }
  return min;
}

/** Step 5 — Curriculum mapping (class_subjects, §4.8 block fields). */
export function StepCurriculum() {
  const { data, refetch } = useApi<any[]>("/class-subjects");
  const { data: classes } = useApi<any[]>("/classes");
  const { data: subjects } = useApi<any[]>("/subjects");
  const { data: sectionRows } = useApi<any[]>("/class-sections");
  const { configs } = useConfigCtx();
  const blank = { classId: "", subjectId: "", periodsPerWeek: "5", maxPeriodsPerDay: "1", consecutiveBlockSize: "1", consecutiveBlocksPerWeek: "", samePeriodAcrossWeek: false };
  const [form, setForm] = useState(blank);
  const [editId, setEditId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setForm(blank); setEditId(null); };
  const save = async () => {
    try {
      const body = JSON.stringify({
        classId: Number(form.classId), subjectId: Number(form.subjectId),
        periodsPerWeek: Number(form.periodsPerWeek), maxPeriodsPerDay: Number(form.maxPeriodsPerDay),
        consecutiveBlockSize: Number(form.consecutiveBlockSize),
        consecutiveBlocksPerWeek: form.consecutiveBlocksPerWeek ? Number(form.consecutiveBlocksPerWeek) : null,
        samePeriodAcrossWeek: form.samePeriodAcrossWeek,
      });
      if (editId) await api(`/class-subjects/${editId}`, { method: "PUT", body });
      else await api("/class-subjects", { method: "POST", body });
      reset(); setError(null); refetch();
    } catch (e) { setError(asMessage(e)); }
  };
  const startEdit = (r: any) => {
    setEditId(r.id);
    setForm({
      classId: String(r.classId), subjectId: String(r.subjectId),
      periodsPerWeek: String(r.periodsPerWeek), maxPeriodsPerDay: String(r.maxPeriodsPerDay),
      consecutiveBlockSize: String(r.consecutiveBlockSize),
      consecutiveBlocksPerWeek: r.consecutiveBlocksPerWeek == null ? "" : String(r.consecutiveBlocksPerWeek),
      samePeriodAcrossWeek: r.samePeriodAcrossWeek,
    });
  };
  const remove = async (r: any) => {
    if (!confirmDelete(`the ${r.className} · ${r.subjectName} curriculum row`)) return;
    try { await api(`/class-subjects/${r.id}`, { method: "DELETE" }); setError(null); refetch(); }
    catch (e) { setError(asMessage(e)); }
  };

  // weekly capacity of the selected class's timetable (mirrors the server guard)
  const classId = form.classId ? Number(form.classId) : null;
  const capInfo = classId !== null
    ? weekCapFor(sectionRows ?? [], (sectionRows ?? []).filter((s) => s.classId === classId).map((s) => s.id), configs)
    : null;
  const usedByClass = classId !== null
    ? (data ?? []).filter((r) => r.classId === classId && r.id !== editId).reduce((n, r) => n + r.periodsPerWeek, 0)
    : 0;

  return (
    <Card title="Curriculum Mapping" sub="Which subjects each class takes, how often, and any double-period rules (§4.8).">
      <ErrorNote message={error} />
      <DataTable
        headers={["Class", "Subject", "Periods/wk", "Max/day", "Blocks", "Same period", ""]}
        rows={(data ?? []).map((r) => [
          r.className, r.subjectName, r.periodsPerWeek, r.maxPeriodsPerDay,
          r.consecutiveBlockSize > 1 ? <span key="b" className="chip mono">{r.consecutiveBlocksPerWeek ?? "auto"}×{r.consecutiveBlockSize}</span> : "—",
          r.samePeriodAcrossWeek ? "yes" : "—",
          <RowActions key="d" onEdit={() => startEdit(r)} onDelete={() => remove(r)} />,
        ])}
      />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr) auto auto", gap: 8, marginTop: 14, alignItems: "end" }}>
        <Field label="Class">
          <select style={inputStyle} disabled={editId !== null} value={form.classId} onChange={(e) => setForm({ ...form, classId: e.target.value })}>
            <option value="">—</option>
            {(classes ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Subject">
          <select style={inputStyle} disabled={editId !== null} value={form.subjectId} onChange={(e) => setForm({ ...form, subjectId: e.target.value })}>
            <option value="">—</option>
            {(subjects ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Periods/wk"
          hint={capInfo ? `${capInfo.name} week = ${capInfo.cap} · class uses ${usedByClass + (Number(form.periodsPerWeek) || 0)}/${capInfo.cap}` : undefined}>
          <input type="number" min={1} max={capInfo?.cap} style={inputStyle} value={form.periodsPerWeek} onChange={(e) => setForm({ ...form, periodsPerWeek: e.target.value })} />
        </Field>
        <Field label="Max/day"><input type="number" style={inputStyle} value={form.maxPeriodsPerDay} onChange={(e) => setForm({ ...form, maxPeriodsPerDay: e.target.value })} /></Field>
        <Field label="Block size"><input type="number" style={inputStyle} value={form.consecutiveBlockSize} onChange={(e) => setForm({ ...form, consecutiveBlockSize: e.target.value })} /></Field>
        <Field label="Blocks/wk"><input type="number" style={inputStyle} placeholder="auto" value={form.consecutiveBlocksPerWeek} onChange={(e) => setForm({ ...form, consecutiveBlocksPerWeek: e.target.value })} /></Field>
        <button className="btn btn-primary" style={{ marginBottom: 18 }} onClick={save} disabled={!form.classId || !form.subjectId}>
          {editId ? "✓ Save" : "＋ Add"}
        </button>
        {editId && <button className="btn" style={{ marginBottom: 18, border: "1px solid var(--line)" }} onClick={reset}>Cancel</button>}
      </div>
    </Card>
  );
}

/** Step 6 — Teacher Directory (§8.1a): list first, form second, §4.7 rules.
 *  Layout mirrors mockup step 5a/5b exactly. */
export function StepTeachers({ onNext }: { onNext?: () => void }) {
  const { data, refetch } = useApi<any[]>("/teachers");
  const [editing, setEditing] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  const blankTeacher = () => ({ name: "", employeeCode: "", maxPeriodsPerDay: 6, maxPeriodsPerWeek: 30, classTeacherPeriodRule: "none", periodPattern: "every_period", alternateDaySet: [] });

  /** returns true when the save landed, so the form can chain add-another/next */
  const save = async (form: any): Promise<boolean> => {
    try {
      const body = {
        name: form.name, employeeCode: form.employeeCode,
        maxPeriodsPerDay: Number(form.maxPeriodsPerDay), maxPeriodsPerWeek: Number(form.maxPeriodsPerWeek),
        classTeacherPeriodRule: form.classTeacherPeriodRule, periodPattern: form.periodPattern,
        alternateDaySet: form.periodPattern === "alternate_day" && form.alternateDaySet.length > 0 ? form.alternateDaySet : null,
      };
      if (form.id) await api(`/teachers/${form.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await api("/teachers", { method: "POST", body: JSON.stringify(body) });
      setError(null); refetch();
      return true;
    } catch (e) { setError(asMessage(e)); return false; }
  };
  const openEdit = (t: any) => { setError(null); setEditing({ ...t, alternateDaySet: t.alternateDaySet ?? [] }); };

  if (editing) {
    return (
      <TeacherForm
        initial={editing}
        error={error}
        onBack={() => { setEditing(null); setError(null); }}
        onSaveAnother={async (f) => { if (await save(f)) setEditing(blankTeacher()); }}
        onSaveNext={async (f) => {
          if (await save(f)) { setEditing(null); onNext?.(); }
        }}
      />
    );
  }

  return (
    <Card
      title="Teachers"
      sub={`${data?.length ?? 0} teacher(s) added so far — click any row to view or edit. Placement rules are HARD constraints (§4.7).`}
      actions={<button className="btn btn-primary" onClick={() => { setError(null); setEditing(blankTeacher()); }}>+ Add New Teacher</button>}
    >
      <ErrorNote message={error} />
      <DataTable
        headers={["Teacher", "Subjects", "Sections", "Load", "Class-Teacher Rule", "Period Pattern", ""]}
        onRowClick={(i) => { const t = (data ?? [])[i]; if (t) openEdit(t); }}
        rows={(data ?? []).map((t) => [
          <span key="n"><b>{t.name}</b><br /><span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{t.employeeCode}</span></span>,
          t.subjects.join(", ") || "—",
          t.sectionsMapped,
          <span key="l" className={`badge ${t.weeklyLoad > t.maxPeriodsPerWeek ? "badge-error" : "badge-ok"}`}>
            {t.weeklyLoad} / {t.maxPeriodsPerWeek}
          </span>,
          <span key="r" className="chip">{t.classTeacherPeriodRule}</span>,
          <span key="p" className="chip">{t.periodPattern}</span>,
          <button key="e" className="btn btn-secondary" style={{ padding: "4px 10px", fontSize: 11.5 }}
            onClick={(e) => { e.stopPropagation(); openEdit(t); }}>Edit</button>,
        ])}
      />
    </Card>
  );
}

/** Radio-card option (mockup .radio-opt): title + explanatory description. */
function RadioOpt({ group, selected, title, desc, onSelect, children }: {
  group: string; selected: boolean; title: string; desc: string;
  onSelect: () => void; children?: React.ReactNode;
}) {
  return (
    <label className={`radio-opt${selected ? " selected" : ""}`}>
      <input type="radio" name={group} checked={selected} onChange={onSelect} />
      <div>
        <div className="radio-opt-title">{title}</div>
        <div className="radio-opt-desc">{desc}</div>
        {children}
      </div>
    </label>
  );
}

/** Step 5b of the mockup — Add / Edit Teacher, replicated 1:1. */
function TeacherForm({ initial, error, onBack, onSaveAnother, onSaveNext }: {
  initial: any; error: string | null;
  onBack: () => void; onSaveAnother: (f: any) => void; onSaveNext: (f: any) => void;
}) {
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial), [initial]);
  const first = (form.name || "This teacher").split(" ")[0];
  const toggleDay = (d: number) => {
    const set = new Set<number>(form.alternateDaySet);
    if (set.has(d)) set.delete(d); else set.add(d);
    setForm({ ...form, periodPattern: "alternate_day", alternateDaySet: [...set].sort() });
  };
  const valid = form.name && form.employeeCode;

  return (
    <div className="card" style={{ padding: 26, marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
        <div>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 600, marginBottom: 0 }}>Add / Edit Teacher</h2>
          <div className="screen-sub" style={{ marginBottom: 0 }}>
            {form.id ? `${form.name} · Employee code ${form.employeeCode}` : "New teacher for this school"}
          </div>
        </div>
        {form.id != null && <span className="badge badge-neutral">{form.sectionsMapped ?? 0} sections mapped</span>}
      </div>

      <ErrorNote message={error} />

      <div className="form-grid">
        <Field label="Full name"><input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Employee code"><input style={inputStyle} value={form.employeeCode} onChange={(e) => setForm({ ...form, employeeCode: e.target.value })} /></Field>
        <Field label="Max periods / day"><input type="number" style={inputStyle} value={form.maxPeriodsPerDay} onChange={(e) => setForm({ ...form, maxPeriodsPerDay: e.target.value })} /></Field>
        <Field label="Max periods / week"><input type="number" style={inputStyle} value={form.maxPeriodsPerWeek} onChange={(e) => setForm({ ...form, maxPeriodsPerWeek: e.target.value })} /></Field>
      </div>

      <div style={{ height: 1, background: "var(--line)", margin: "6px 0 22px" }} />
      <div className="section-label" style={{ display: "block", marginBottom: 18 }}>
        Placement configuration — never bypassed by the solver
      </div>

      <div className="grid2">
        <div className="field">
          <label>Class-teacher period rule</label>
          <div className="radio-row">
            <RadioOpt group="ctpr" selected={form.classTeacherPeriodRule === "always_first_period"}
              title="Always first period"
              desc={`${first} teaches Period 1 of their own class-section every day, and is never placed in Period 1 of any other section.`}
              onSelect={() => setForm({ ...form, classTeacherPeriodRule: "always_first_period" })} />
            <RadioOpt group="ctpr" selected={form.classTeacherPeriodRule === "random"}
              title="Random"
              desc="Their own class's Period 1 is unrestricted — solver places normally."
              onSelect={() => setForm({ ...form, classTeacherPeriodRule: "random" })} />
            <RadioOpt group="ctpr" selected={form.classTeacherPeriodRule === "none"}
              title="None"
              desc="Class-teacher status has no bearing on period placement."
              onSelect={() => setForm({ ...form, classTeacherPeriodRule: "none" })} />
          </div>
        </div>

        <div className="field">
          <label>Period pattern</label>
          <div className="radio-row">
            <RadioOpt group="pp" selected={form.periodPattern === "every_period"}
              title="Every period" desc="No gap restriction (default)."
              onSelect={() => setForm({ ...form, periodPattern: "every_period" })} />
            <RadioOpt group="pp" selected={form.periodPattern === "alternate_period"}
              title="Alternate period" desc="Never two adjacent periods on the same day — hard constraint."
              onSelect={() => setForm({ ...form, periodPattern: "alternate_period" })} />
            <RadioOpt group="pp" selected={form.periodPattern === "alternate_day"}
              title="Alternate day" desc="Restrict to specific days:"
              onSelect={() => setForm({ ...form, periodPattern: "alternate_day" })}>
              <div className="day-picker">
                {[1, 2, 3, 4, 5].map((d) => (
                  <button key={d} type="button"
                    className={`day-toggle${form.periodPattern === "alternate_day" && form.alternateDaySet.includes(d) ? " on" : ""}`}
                    onClick={(e) => { e.preventDefault(); toggleDay(d); }}>
                    {DAY_NAMES[d]}
                  </button>
                ))}
              </div>
            </RadioOpt>
          </div>
        </div>
      </div>

      <div className="wizard-foot">
        <button className="btn btn-secondary" onClick={onBack}>← Back to Teacher List</button>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-secondary" disabled={!valid} onClick={() => onSaveAnother(form)}>Save &amp; Add Another</button>
          <button className="btn btn-primary" disabled={!valid} onClick={() => onSaveNext(form)}>Save &amp; Next: Timetable Config →</button>
        </div>
      </div>
    </div>
  );
}

/** Step 7 — Teacher Mapping (§8.1b): class-teacher assignments + subject mappings. */
export function StepTeacherMapping() {
  const { data: sections, refetch: refetchSections } = useApi<any[]>("/class-sections");
  const { data: teachers } = useApi<any[]>("/teachers");
  const { data: mappings, refetch: refetchMappings } = useApi<any[]>("/mappings");
  const { data: subjects } = useApi<any[]>("/subjects");
  const { data: rooms } = useApi<any[]>("/rooms");
  const [view, setView] = useState<"list" | "form">("list");
  const [editing, setEditing] = useState<any | null>(null); // a mappings row when editing
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const assignCT = async (csId: number, teacherId: string) => {
    try {
      await api(`/class-sections/${csId}/class-teacher`, { method: "PUT", body: JSON.stringify({ teacherId: teacherId ? Number(teacherId) : null }) });
      setError(null); refetchSections();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const removeMapping = async (row: any) => {
    await api(row.type === "merged" ? `/merged-groups/${row.id}` : `/mappings/${row.id}`, { method: "DELETE" });
    refetchMappings();
  };
  const teacherRule = (id: number | null) => (teachers ?? []).find((t) => t.id === id)?.classTeacherPeriodRule ?? null;

  const openAdd = () => { setEditing(null); setNote(null); setError(null); setView("form"); };
  const openEdit = (row: any) => { setEditing(row); setNote(null); setError(null); setView("form"); };

  if (view === "form") {
    return (
      <MappingForm
        editing={editing}
        teachers={teachers ?? []}
        subjects={subjects ?? []}
        sections={sections ?? []}
        rooms={rooms ?? []}
        note={note}
        error={error}
        onBack={() => { setView("list"); setNote(null); setError(null); refetchMappings(); }}
        onSaved={(msg, stay) => {
          setNote(msg); setError(null); refetchMappings();
          if (!stay) setView("list");
          else setEditing(null);
        }}
        onError={(msg) => { setError(msg); }}
      />
    );
  }

  return (
    <>
      <Card title="Class Teacher Assignments" sub="This pointer is what activates a teacher's Period-1 rule for a section (§8.1b).">
        <ErrorNote message={error} />
        <DataTable
          headers={["Class-Section", "Class Teacher", "Their P1 Rule", "Status"]}
          rows={(sections ?? []).map((cs) => [
            <b key="a">{cs.label}</b>,
            <select key="b" value={cs.classTeacherId ?? ""} style={{ padding: "6px 9px", border: "1px solid var(--line)", borderRadius: 7 }} onChange={(e) => assignCT(cs.id, e.target.value)}>
              <option value="">— Unassigned —</option>
              {(teachers ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>,
            cs.classTeacherId ? <span key="c" className="chip mono">{teacherRule(cs.classTeacherId)}</span> : "—",
            cs.classTeacherId
              ? <span key="d" className="badge badge-ok">✓ Assigned</span>
              : <span key="d" className="badge" style={{ background: "var(--amber-bg)", color: "var(--amber)" }}>⚠ Unassigned</span>,
          ])}
        />
      </Card>

      <Card
        title="Subject Mapping"
        sub="Who teaches what, where — the core mapping the solver builds variables from."
        actions={<button className="btn btn-primary" onClick={openAdd}>＋ Add Mapping</button>}
      >
        {note && (
          <div style={{ background: "var(--accent-bg)", color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, marginBottom: 12, fontWeight: 600 }}>
            ✓ {note}
          </div>
        )}
        <DataTable
          headers={["Teacher", "Subject", "Class-Section", "Periods/Week", "Room", "", ""]}
          rows={(mappings ?? []).map((m) => [
            m.teacherName,
            m.subjectName,
            <span key="cs">
              {m.classSectionLabel}{" "}
              {m.type === "merged" && <span className="chip mono" style={{ marginLeft: 4 }}>merged</span>}
            </span>,
            m.periodsPerWeek,
            m.roomLabel,
            <button key="e" className="btn" style={{ border: "1px solid var(--line)", padding: "4px 11px", fontSize: 11.5 }} onClick={() => openEdit(m)}>Edit</button>,
            <button key="d" className="btn" style={{ border: "1px solid var(--line)", padding: "4px 9px", fontSize: 11, color: "var(--signal)" }} onClick={() => removeMapping(m)}>✕</button>,
          ])}
        />
      </Card>
    </>
  );
}

/** Add/Edit Mapping form (§8.1b, mockup pattern): multi-select sections; the
 *  merged checkbox turns the selection into ONE merged group (§4.9) instead of
 *  N independent mappings. */
function MappingForm({
  editing, teachers, subjects, sections, rooms, note, error, onBack, onSaved, onError,
}: {
  editing: any | null;
  teachers: any[]; subjects: any[]; sections: any[]; rooms: any[];
  note: string | null; error: string | null;
  onBack: () => void;
  onSaved: (msg: string, stayOnForm: boolean) => void;
  onError: (msg: string) => void;
}) {
  const [form, setForm] = useState({
    teacherId: editing ? String(editing.teacherId) : "",
    subjectId: editing ? String(editing.subjectId) : "",
    periodsPerWeek: editing ? String(editing.periodsPerWeek) : "5",
    roomId: editing?.roomId ? String(editing.roomId) : "",
    merged: editing?.type === "merged",
  });
  const [selected, setSelected] = useState<Set<number>>(new Set(editing?.classSectionIds ?? []));
  const { configs } = useConfigCtx();
  const mapCap = weekCapFor(sections, [...selected], configs);

  const isEdit = editing !== null;
  const sectionLocked = isEdit && editing.type === "single"; // a plain mapping's section is its identity
  const toggleSection = (id: number) => {
    if (sectionLocked) return;
    setSelected((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });
  };

  const save = async (stayOnForm: boolean) => {
    try {
      if (!form.teacherId || !form.subjectId) throw new Error("Pick a teacher and a subject");
      if (selected.size === 0) throw new Error("Select at least one class-section");
      const roomId = form.roomId ? Number(form.roomId) : null;
      const base = {
        teacherId: Number(form.teacherId),
        subjectId: Number(form.subjectId),
        periodsPerWeek: Number(form.periodsPerWeek),
      };
      let msg: string;
      if (isEdit && editing.type === "merged") {
        await api(`/merged-groups/${editing.id}`, {
          method: "PUT",
          body: JSON.stringify({ ...base, roomId, classSectionIds: [...selected] }),
        });
        msg = "Merged group updated";
      } else if (isEdit) {
        await api(`/mappings/${editing.id}`, {
          method: "PUT",
          body: JSON.stringify({ teacherId: base.teacherId, periodsPerWeek: base.periodsPerWeek, preferredRoomId: roomId }),
        });
        msg = "Mapping updated";
      } else if (form.merged) {
        if (selected.size < 2) throw new Error("A merged group needs at least 2 class-sections");
        await api("/merged-groups", {
          method: "POST",
          body: JSON.stringify({ ...base, roomId, classSectionIds: [...selected] }),
        });
        msg = `Merged group created for ${selected.size} sections`;
      } else {
        const res = await api<{ created: number; skipped: string[] }>("/mappings", {
          method: "POST",
          body: JSON.stringify({ ...base, preferredRoomId: roomId, classSectionIds: [...selected] }),
        });
        msg =
          `Added ${res.created} mapping${res.created === 1 ? "" : "s"}` +
          (res.skipped.length > 0 ? ` · skipped: ${res.skipped.join(", ")}` : "");
      }
      if (stayOnForm) setSelected(new Set());
      onSaved(msg, stayOnForm);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Card
      title={isEdit ? `Edit ${editing.type === "merged" ? "Merged " : ""}Mapping — ${editing.teacherName} · ${editing.subjectName}` : "Add Subject Mapping"}
      sub="Assign one teacher to teach one subject in one or more class-sections."
    >
      <ErrorNote message={error} />
      {note && (
        <div style={{ background: "var(--accent-bg)", color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, marginBottom: 12, fontWeight: 600 }}>
          ✓ {note}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Field label="Teacher">
          <select style={inputStyle} value={form.teacherId} onChange={(e) => setForm({ ...form, teacherId: e.target.value })}>
            <option value="">—</option>
            {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="Subject">
          <select style={inputStyle} value={form.subjectId} disabled={isEdit} onChange={(e) => setForm({ ...form, subjectId: e.target.value })}>
            <option value="">—</option>
            {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label={sectionLocked ? "Class-Section (fixed for this mapping)" : `Class-Section — select one or more (${selected.size} selected)`}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 7 }}>
            {sections.map((cs) => {
              const on = selected.has(cs.id);
              return (
                <button key={cs.id} onClick={() => toggleSection(cs.id)} disabled={sectionLocked && !on} style={{
                  padding: "8px 10px", borderRadius: 8, fontSize: 12.5, fontWeight: 600,
                  border: `1px solid ${on ? "var(--brand)" : "var(--line)"}`,
                  background: on ? "var(--steel-pale)" : "var(--paper)",
                  color: on ? "var(--brand)" : sectionLocked ? "var(--ink-faint)" : "var(--ink)",
                  opacity: sectionLocked && !on ? 0.45 : 1,
                }}>
                  {on ? "☑" : "☐"} {cs.label}
                </button>
              );
            })}
          </div>
        </Field>
        <Field label="Periods / Week (each section)"
          hint={mapCap ? `${mapCap.name} week = ${mapCap.cap} periods — entries above that are refused` : undefined}>
          <input type="number" min={1} max={mapCap?.cap} style={inputStyle} value={form.periodsPerWeek} onChange={(e) => setForm({ ...form, periodsPerWeek: e.target.value })} />
        </Field>
      </div>
      <Field label="Room">
        <select style={inputStyle} value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })}>
          <option value="">Use class-section's home room</option>
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Field>

      <label style={{
        display: "flex", gap: 10, alignItems: "flex-start", padding: "11px 14px",
        border: `1px solid ${form.merged ? "var(--brand)" : "var(--line)"}`, borderRadius: 9,
        background: form.merged ? "var(--steel-pale)" : "var(--paper)", cursor: isEdit ? "not-allowed" : "pointer",
        marginBottom: 18, opacity: isEdit ? 0.6 : 1,
      }}>
        <input type="checkbox" checked={form.merged} disabled={isEdit} style={{ marginTop: 3 }} onChange={(e) => setForm({ ...form, merged: e.target.checked })} />
        <span>
          <span style={{ fontSize: 13, fontWeight: 700 }}>Merged teaching — same teacher, same slot, all selected class-sections</span>
          <br />
          <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
            E.g. one Biology period taught to 10-A and 10-B at once. Every selected section's timetable shows the period; the teacher is counted as occupied only once (§4.9).
            Unchecked, each selected section gets its own independent mapping.
          </span>
        </span>
      </label>

      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <button className="btn" style={{ border: "1px solid var(--line)" }} onClick={onBack}>← Back to Mapping List</button>
        <div style={{ display: "flex", gap: 10 }}>
          {!isEdit && (
            <button className="btn" style={{ border: "1px solid var(--line)" }} onClick={() => save(true)}>Save &amp; Add Another</button>
          )}
          <button className="btn btn-primary" onClick={() => save(false)}>Save Mapping</button>
        </div>
      </div>
    </Card>
  );
}

/** Step 8 — Timetable Configuration (§3.10): grid structure + class scoping. */
export function StepConfig() {
  const { current, refetch: refetchConfigs } = useConfigCtx();
  const { data: sections, refetch: refetchSections } = useApi<any[]>("/class-sections");
  const [error, setError] = useState<string | null>(null);
  const [computedEnd, setComputedEnd] = useState<string | null>(current?.endTime ?? null);
  const [form, setForm] = useState<any>(null);

  useEffect(() => {
    if (current && !form) {
      setForm({
        workingDays: current.workingDays,
        periodsPerDay: current.periodsPerDay,
        periodDurationMins: current.periodDurationMins,
        startTime: current.startTime,
        hasZeroPeriod: current.hasZeroPeriod,
        zeroPeriodDurationMins: current.zeroPeriodDurationMins ?? 30,
        breaks: current.breaks.map((b, i) => ({ afterPeriod: i + 3, name: b.name ?? "Break", durationMins: 20 })),
        selected: new Set<number>(),
      });
      setComputedEnd(current.endTime);
    }
  }, [current, form]);

  useEffect(() => {
    if (form && sections && form.selected.size === 0) {
      const mine = sections.filter((s) => s.timetableConfigId === current?.id).map((s) => s.id);
      if (mine.length > 0) setForm((f: any) => ({ ...f, selected: new Set(mine) }));
    }
  }, [sections, form, current]);

  if (!current) return <Card title="Timetable Configuration"><p className="screen-sub">Create or pick a timetable on the Timetables screen first.</p></Card>;
  if (!form) return null;

  const toggleDay = (d: number) => {
    const days = form.workingDays.includes(d) ? form.workingDays.filter((x: number) => x !== d) : [...form.workingDays, d].sort();
    setForm({ ...form, workingDays: days });
  };
  const toggleSection = (id: number, claimedBy: string | null) => {
    if (claimedBy) return;
    const s = new Set<number>(form.selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setForm({ ...form, selected: s });
  };

  const save = async () => {
    try {
      const res = await api<{ endTime: string }>(`/timetable-configs/${current.id}/structure`, {
        method: "PUT",
        body: JSON.stringify({
          startTime: form.startTime, periodsPerDay: Number(form.periodsPerDay),
          periodDurationMins: Number(form.periodDurationMins), workingDays: form.workingDays,
          hasZeroPeriod: form.hasZeroPeriod, zeroPeriodDurationMins: Number(form.zeroPeriodDurationMins),
          breaks: form.breaks,
        }),
      });
      await api(`/timetable-configs/${current.id}/class-sections`, {
        method: "PUT",
        body: JSON.stringify({ classSectionIds: [...form.selected] }),
      });
      setComputedEnd(res.endTime); setError(null); refetchConfigs(); refetchSections();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <>
      <Card title={`Timetable Configuration — ${current.name}`} sub="Server computes every period's time and the end of day (§3.10).">
        <ErrorNote message={error} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
          <Field label="Start time"><input type="time" style={inputStyle} value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} /></Field>
          <Field label="Periods / day"><input type="number" style={inputStyle} value={form.periodsPerDay} onChange={(e) => setForm({ ...form, periodsPerDay: e.target.value })} /></Field>
          <Field label="Period duration (mins)"><input type="number" style={inputStyle} value={form.periodDurationMins} onChange={(e) => setForm({ ...form, periodDurationMins: e.target.value })} /></Field>
        </div>
        <Field label="Working days">
          <div style={{ display: "flex", gap: 7 }}>
            {[1, 2, 3, 4, 5, 6].map((d) => (
              <button key={d} onClick={() => toggleDay(d)} style={{
                width: 44, height: 34, borderRadius: 8, fontWeight: 700, fontSize: 12, border: "1px solid var(--line)",
                background: form.workingDays.includes(d) ? "var(--brand)" : "var(--paper)",
                color: form.workingDays.includes(d) ? "#fff" : "var(--ink-faint)",
              }}>{DAY_NAMES[d]}</button>
            ))}
          </div>
        </Field>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginBottom: 14 }}>
          <input type="checkbox" checked={form.hasZeroPeriod} onChange={(e) => setForm({ ...form, hasZeroPeriod: e.target.checked })} />
          Zero period{form.hasZeroPeriod && <> of <input type="number" style={{ ...inputStyle, width: 70 }} value={form.zeroPeriodDurationMins} onChange={(e) => setForm({ ...form, zeroPeriodDurationMins: e.target.value })} /> mins</>}
        </label>

        <Field label="Breaks">
          {form.breaks.map((b: any, i: number) => (
            <div key={i} style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 12.5 }}>After period</span>
              <input type="number" style={{ ...inputStyle, width: 64 }} value={b.afterPeriod} onChange={(e) => { const br = [...form.breaks]; br[i] = { ...b, afterPeriod: Number(e.target.value) }; setForm({ ...form, breaks: br }); }} />
              <input style={{ ...inputStyle, width: 150 }} value={b.name} onChange={(e) => { const br = [...form.breaks]; br[i] = { ...b, name: e.target.value }; setForm({ ...form, breaks: br }); }} />
              <input type="number" style={{ ...inputStyle, width: 64 }} value={b.durationMins} onChange={(e) => { const br = [...form.breaks]; br[i] = { ...b, durationMins: Number(e.target.value) }; setForm({ ...form, breaks: br }); }} />
              <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>mins</span>
              <button style={{ border: "1px solid var(--line)", borderRadius: 6, width: 26, height: 26, background: "var(--paper)", color: "var(--signal)" }} onClick={() => setForm({ ...form, breaks: form.breaks.filter((_: any, j: number) => j !== i) })}>✕</button>
            </div>
          ))}
          <button className="btn" style={{ border: "1px solid var(--line)", fontSize: 12 }} onClick={() => setForm({ ...form, breaks: [...form.breaks, { afterPeriod: 3, name: "Break", durationMins: 20 }] })}>＋ Add break</button>
        </Field>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--brand-deep)", borderRadius: 10, padding: "14px 20px", marginTop: 6 }}>
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700, color: "var(--steel-light)" }}>Computed end of day</span>
          <span style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 700, color: "#fff" }}>{computedEnd ?? "—"}</span>
        </div>
      </Card>

      <Card title="Classes covered by this timetable" sub="A class-section belongs to exactly one timetable — sections claimed by another are locked (§3.10).">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          {(sections ?? []).map((cs) => {
            const claimedByOther = cs.timetableConfigId !== null && cs.timetableConfigId !== current.id ? cs.timetableConfigName : null;
            const on = form.selected.has(cs.id);
            return (
              <button key={cs.id} disabled={!!claimedByOther} onClick={() => toggleSection(cs.id, claimedByOther)} style={{
                padding: "9px 11px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, textAlign: "left",
                border: `1px solid ${on ? "var(--brand)" : "var(--line)"}`,
                background: claimedByOther ? "var(--offwhite)" : on ? "var(--steel-pale)" : "var(--paper)",
                color: claimedByOther ? "var(--ink-faint)" : on ? "var(--brand)" : "var(--ink)",
              }}>
                {on ? "☑" : "☐"} {cs.label}
                {claimedByOther && <div style={{ fontSize: 10, fontWeight: 400 }}>in {claimedByOther}</div>}
              </button>
            );
          })}
        </div>
        <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={save}>Save Configuration</button>
      </Card>
    </>
  );
}
