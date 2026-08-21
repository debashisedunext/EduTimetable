import { useEffect, useState } from "react";
import { api } from "../api";
import { Card, DataTable, ErrorNote, Field } from "../components";
import { useApi, useConfigCtx } from "../hooks";
import { inputStyle } from "./Timetables";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Step 5 — Curriculum mapping (class_subjects, §4.8 block fields). */
export function StepCurriculum() {
  const { data, refetch } = useApi<any[]>("/class-subjects");
  const { data: classes } = useApi<any[]>("/classes");
  const { data: subjects } = useApi<any[]>("/subjects");
  const [form, setForm] = useState({ classId: "", subjectId: "", periodsPerWeek: "5", maxPeriodsPerDay: "1", consecutiveBlockSize: "1", consecutiveBlocksPerWeek: "", samePeriodAcrossWeek: false });
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    try {
      await api("/class-subjects", {
        method: "POST",
        body: JSON.stringify({
          classId: Number(form.classId), subjectId: Number(form.subjectId),
          periodsPerWeek: Number(form.periodsPerWeek), maxPeriodsPerDay: Number(form.maxPeriodsPerDay),
          consecutiveBlockSize: Number(form.consecutiveBlockSize),
          consecutiveBlocksPerWeek: form.consecutiveBlocksPerWeek ? Number(form.consecutiveBlocksPerWeek) : null,
          samePeriodAcrossWeek: form.samePeriodAcrossWeek,
        }),
      });
      setError(null); refetch();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const remove = async (id: number) => {
    await api(`/class-subjects/${id}`, { method: "DELETE" });
    refetch();
  };

  return (
    <Card title="Curriculum Mapping" sub="Which subjects each class takes, how often, and any double-period rules (§4.8).">
      <ErrorNote message={error} />
      <DataTable
        headers={["Class", "Subject", "Periods/wk", "Max/day", "Blocks", "Same period", ""]}
        rows={(data ?? []).map((r) => [
          r.className, r.subjectName, r.periodsPerWeek, r.maxPeriodsPerDay,
          r.consecutiveBlockSize > 1 ? <span key="b" className="chip mono">{r.consecutiveBlocksPerWeek ?? "auto"}×{r.consecutiveBlockSize}</span> : "—",
          r.samePeriodAcrossWeek ? "yes" : "—",
          <button key="d" className="btn" style={{ border: "1px solid var(--line)", padding: "4px 9px", fontSize: 11 }} onClick={() => remove(r.id)}>✕</button>,
        ])}
      />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr) auto", gap: 8, marginTop: 14, alignItems: "end" }}>
        <Field label="Class">
          <select style={inputStyle} value={form.classId} onChange={(e) => setForm({ ...form, classId: e.target.value })}>
            <option value="">—</option>
            {(classes ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Subject">
          <select style={inputStyle} value={form.subjectId} onChange={(e) => setForm({ ...form, subjectId: e.target.value })}>
            <option value="">—</option>
            {(subjects ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Periods/wk"><input type="number" style={inputStyle} value={form.periodsPerWeek} onChange={(e) => setForm({ ...form, periodsPerWeek: e.target.value })} /></Field>
        <Field label="Max/day"><input type="number" style={inputStyle} value={form.maxPeriodsPerDay} onChange={(e) => setForm({ ...form, maxPeriodsPerDay: e.target.value })} /></Field>
        <Field label="Block size"><input type="number" style={inputStyle} value={form.consecutiveBlockSize} onChange={(e) => setForm({ ...form, consecutiveBlockSize: e.target.value })} /></Field>
        <Field label="Blocks/wk"><input type="number" style={inputStyle} placeholder="auto" value={form.consecutiveBlocksPerWeek} onChange={(e) => setForm({ ...form, consecutiveBlocksPerWeek: e.target.value })} /></Field>
        <button className="btn btn-primary" style={{ marginBottom: 18 }} onClick={add} disabled={!form.classId || !form.subjectId}>＋ Add</button>
      </div>
    </Card>
  );
}

/** Step 6 — Teacher Directory (§8.1a): list first, form second, §4.7 rules. */
export function StepTeachers() {
  const { data, refetch } = useApi<any[]>("/teachers");
  const [editing, setEditing] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (form: any) => {
    try {
      const body = {
        name: form.name, employeeCode: form.employeeCode,
        maxPeriodsPerDay: Number(form.maxPeriodsPerDay), maxPeriodsPerWeek: Number(form.maxPeriodsPerWeek),
        classTeacherPeriodRule: form.classTeacherPeriodRule, periodPattern: form.periodPattern,
        alternateDaySet: form.periodPattern === "alternate_day" && form.alternateDaySet.length > 0 ? form.alternateDaySet : null,
      };
      if (form.id) await api(`/teachers/${form.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await api("/teachers", { method: "POST", body: JSON.stringify(body) });
      setEditing(null); setError(null); refetch();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  if (editing) return <TeacherForm initial={editing} onSave={save} onCancel={() => setEditing(null)} error={error} />;

  return (
    <Card
      title="Teachers"
      sub="Placement rules here are HARD constraints — the solver can never override them (§4.7)."
      actions={<button className="btn btn-primary" onClick={() => setEditing({ name: "", employeeCode: "", maxPeriodsPerDay: 6, maxPeriodsPerWeek: 30, classTeacherPeriodRule: "none", periodPattern: "every_period", alternateDaySet: [] })}>＋ Add Teacher</button>}
    >
      <ErrorNote message={error} />
      <DataTable
        headers={["Teacher", "Subjects", "Sections", "Load", "P1 Rule", "Pattern", ""]}
        rows={(data ?? []).map((t) => [
          <span key="n"><b>{t.name}</b><br /><span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{t.employeeCode}</span></span>,
          t.subjects.join(", ") || "—",
          t.sectionsMapped,
          <span key="l" style={{ color: t.weeklyLoad > t.maxPeriodsPerWeek ? "var(--signal)" : undefined, fontWeight: t.weeklyLoad > t.maxPeriodsPerWeek ? 700 : 400 }}>
            {t.weeklyLoad} / {t.maxPeriodsPerWeek}
          </span>,
          <span key="r" className="chip mono">{t.classTeacherPeriodRule}</span>,
          <span key="p" className="chip mono">{t.periodPattern}</span>,
          <button key="e" className="btn" style={{ border: "1px solid var(--line)", padding: "4px 10px", fontSize: 11.5 }} onClick={() => setEditing({ ...t, alternateDaySet: t.alternateDaySet ?? [] })}>Edit</button>,
        ])}
      />
    </Card>
  );
}

function TeacherForm({ initial, onSave, onCancel, error }: { initial: any; onSave: (f: any) => void; onCancel: () => void; error: string | null }) {
  const [form, setForm] = useState(initial);
  const toggleDay = (d: number) => {
    const set = new Set<number>(form.alternateDaySet);
    if (set.has(d)) set.delete(d); else set.add(d);
    setForm({ ...form, alternateDaySet: [...set].sort() });
  };
  return (
    <Card title={form.id ? `Edit Teacher — ${initial.name}` : "Add New Teacher"}>
      <ErrorNote message={error} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Field label="Full name"><input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Employee code"><input style={inputStyle} value={form.employeeCode} onChange={(e) => setForm({ ...form, employeeCode: e.target.value })} /></Field>
        <Field label="Max periods / day"><input type="number" style={inputStyle} value={form.maxPeriodsPerDay} onChange={(e) => setForm({ ...form, maxPeriodsPerDay: e.target.value })} /></Field>
        <Field label="Max periods / week"><input type="number" style={inputStyle} value={form.maxPeriodsPerWeek} onChange={(e) => setForm({ ...form, maxPeriodsPerWeek: e.target.value })} /></Field>
        <Field label="Class-teacher Period-1 rule" hint="Applies only where they ARE class teacher (Teacher Mapping step).">
          <select style={inputStyle} value={form.classTeacherPeriodRule} onChange={(e) => setForm({ ...form, classTeacherPeriodRule: e.target.value })}>
            <option value="none">none</option>
            <option value="always_first_period">always first period (hard)</option>
            <option value="random">random</option>
          </select>
        </Field>
        <Field label="Period pattern" hint="alternate = hard gaps, never bypassed by the solver.">
          <select style={inputStyle} value={form.periodPattern} onChange={(e) => setForm({ ...form, periodPattern: e.target.value })}>
            <option value="every_period">every period</option>
            <option value="alternate_period">alternate periods (no adjacent)</option>
            <option value="alternate_day">alternate days</option>
          </select>
        </Field>
      </div>
      {form.periodPattern === "alternate_day" && (
        <Field label="Alternate day-set (leave empty to auto-pick, confirmed at generation)">
          <div style={{ display: "flex", gap: 7 }}>
            {[1, 2, 3, 4, 5, 6].map((d) => (
              <button key={d} onClick={() => toggleDay(d)} style={{
                width: 44, height: 34, borderRadius: 8, fontWeight: 700, fontSize: 12,
                border: "1px solid var(--line)",
                background: form.alternateDaySet.includes(d) ? "var(--brand)" : "var(--paper)",
                color: form.alternateDaySet.includes(d) ? "#fff" : "var(--ink-faint)",
              }}>{DAY_NAMES[d]}</button>
            ))}
          </div>
        </Field>
      )}
      <div style={{ display: "flex", gap: 10 }}>
        <button className="btn btn-primary" onClick={() => onSave(form)} disabled={!form.name || !form.employeeCode}>Save Teacher</button>
        <button className="btn" style={{ border: "1px solid var(--line)" }} onClick={onCancel}>← Back to directory</button>
      </div>
    </Card>
  );
}

/** Step 7 — Teacher Mapping (§8.1b): class-teacher assignments + subject mappings. */
export function StepTeacherMapping() {
  const { data: sections, refetch: refetchSections } = useApi<any[]>("/class-sections");
  const { data: teachers } = useApi<any[]>("/teachers");
  const { data: mappings, refetch: refetchMappings } = useApi<any[]>("/mappings");
  const { data: subjects } = useApi<any[]>("/subjects");
  const [form, setForm] = useState({ teacherId: "", subjectId: "", periodsPerWeek: "5" });
  const [selectedSections, setSelectedSections] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const assignCT = async (csId: number, teacherId: string) => {
    try {
      await api(`/class-sections/${csId}/class-teacher`, { method: "PUT", body: JSON.stringify({ teacherId: teacherId ? Number(teacherId) : null }) });
      setError(null); refetchSections();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const toggleSection = (id: number) => {
    setSelectedSections((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });
  };
  // Bulk add (task 1.8): one teacher + subject across every selected section in one go.
  const addMapping = async () => {
    try {
      const res = await api<{ created: number; skipped: string[] }>("/mappings", {
        method: "POST",
        body: JSON.stringify({
          teacherId: Number(form.teacherId), subjectId: Number(form.subjectId),
          classSectionIds: [...selectedSections], periodsPerWeek: Number(form.periodsPerWeek),
        }),
      });
      setError(null);
      setNote(
        `Added ${res.created} mapping${res.created === 1 ? "" : "s"}` +
          (res.skipped.length > 0 ? ` · skipped: ${res.skipped.join(", ")}` : ""),
      );
      setSelectedSections(new Set());
      refetchMappings();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setNote(null); }
  };
  const removeMapping = async (id: number) => {
    await api(`/mappings/${id}`, { method: "DELETE" });
    refetchMappings();
  };

  const teacherRule = (id: number | null) => (teachers ?? []).find((t) => t.id === id)?.classTeacherPeriodRule ?? null;

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

      <Card title="Subject Mapping" sub="Who teaches what, where — the rows the solver builds variables from.">
        <DataTable
          headers={["Teacher", "Subject", "Class-Section", "Periods/wk", ""]}
          rows={(mappings ?? []).map((m) => [
            m.teacherName, m.subjectName, m.classSectionLabel, m.periodsPerWeek,
            <button key="d" className="btn" style={{ border: "1px solid var(--line)", padding: "4px 9px", fontSize: 11 }} onClick={() => removeMapping(m.id)}>✕</button>,
          ])}
        />
        {note && (
          <div style={{ background: "var(--accent-bg)", color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, marginTop: 12, fontWeight: 600 }}>
            ✓ {note}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 14 }}>
          <Field label="Teacher">
            <select style={inputStyle} value={form.teacherId} onChange={(e) => setForm({ ...form, teacherId: e.target.value })}>
              <option value="">—</option>
              {(teachers ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Subject">
            <select style={inputStyle} value={form.subjectId} onChange={(e) => setForm({ ...form, subjectId: e.target.value })}>
              <option value="">—</option>
              {(subjects ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Periods/wk (each section)"><input type="number" style={inputStyle} value={form.periodsPerWeek} onChange={(e) => setForm({ ...form, periodsPerWeek: e.target.value })} /></Field>
        </div>
        <Field label={`Class-Sections — pick every section this teacher takes for this subject (${selectedSections.size} selected)`}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 7 }}>
            {(sections ?? []).map((cs) => {
              const on = selectedSections.has(cs.id);
              return (
                <button key={cs.id} onClick={() => toggleSection(cs.id)} style={{
                  padding: "8px 10px", borderRadius: 8, fontSize: 12.5, fontWeight: 600,
                  border: `1px solid ${on ? "var(--brand)" : "var(--line)"}`,
                  background: on ? "var(--steel-pale)" : "var(--paper)",
                  color: on ? "var(--brand)" : "var(--ink)",
                }}>
                  {on ? "☑" : "☐"} {cs.label}
                </button>
              );
            })}
          </div>
        </Field>
        <button
          className="btn btn-primary"
          onClick={addMapping}
          disabled={!form.teacherId || !form.subjectId || selectedSections.size === 0}
        >
          ＋ Add {selectedSections.size > 0 ? `${selectedSections.size} mapping${selectedSections.size === 1 ? "" : "s"}` : "mappings"}
        </button>
      </Card>
    </>
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
