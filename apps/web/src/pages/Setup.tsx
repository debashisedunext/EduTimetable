import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { asMessage, confirmDelete, DataTable, ErrorNote, RowActions } from "../components";
import { useApi, useConfigCtx } from "../hooks";
import { inputStyle } from "./Timetables";
import { StepConfig } from "./SetupAdvanced";
import { StepElectives } from "./Electives";
import { TermsEditor } from "../terms/TermsEditor";
import { CategorySelect, LunchRules, lunchSummary, PrioritySelect } from "../subjects/Placement";
import { ChipPicker } from "../onboarding/steps/ChipPicker";
import { defaultsFor } from "@edutimetable/shared";
import { MasterPane, PaneActions, PaneField } from "../masters/MasterPane";

/**
 * §26.2 — the placement fields the admin has actually set.
 *
 * Layered over `defaultsFor(name)` so the form shows what WOULD be saved: a
 * field nobody touched is `undefined` here and is filled from the name by the
 * server, and one they changed overrides it. Stripping the undefined keys is
 * what makes the spread do that rather than blanking the default.
 */
const clean = (form: any) => {
  const out: Record<string, unknown> = {};
  for (const k of ["category", "priority", "lunchRule", "gapAfterLunch"]) {
    if (form[k] !== undefined) out[k] = form[k];
  }
  return out;
};

/**
 * §8.2 — what is left of the old nine-step wizard: the timetable's own week.
 *
 * The five master steps moved to the Masters screen, where they are a set of
 * things a school edits rather than a sequence it walks. Curriculum and Teacher
 * Mapping moved to the Allocation page, which was already the better answer to
 * both — one grid, class-sections down and subjects across, instead of two
 * lists that had to quote each other's numbers.
 *
 * What could not move is here. A period grid, its breaks, its §28 activities
 * and which class-sections a timetable covers are facts about **one timetable**,
 * not about the school, so they belong beside the timetable and not among the
 * masters. Reached from the Timetables screen, which is where a wing is chosen.
 */
const STEPS = ["The week", "Split electives"];

export function Setup() {
  const [step, setStep] = useState(0);
  const { current } = useConfigCtx();

  return (
    <div>
      {/* §16: the whole thing can still be skipped by uploading one spreadsheet */}
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

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
        {STEPS.map((label, i) => (
          <button key={label} onClick={() => setStep(i)} className="btn"
            style={{
              padding: "5px 13px", fontSize: 12.5,
              background: i === step ? "var(--brand)" : "var(--paper)",
              color: i === step ? "#fff" : "var(--ink)",
              borderColor: i === step ? "var(--brand)" : "var(--line)",
            }}>{label}</button>
        ))}
        <span style={{ flex: 1 }} />
        {/* The masters are no longer steps of this, so say where they went. */}
        <Link to="/masters" style={{ fontSize: 12.5, color: "var(--brand)", fontWeight: 600 }}>
          Subjects, classes, rooms and teachers are on Masters →
        </Link>
      </div>

      {current && <p className="screen-sub">Editing timetable: <b>{current.name}</b></p>}

      {step === 0 && <StepConfig />}
      {step === 1 && <StepElectives />}
    </div>
  );
}

export function StepAcademicYear() {
  const { data, refetch } = useApi<any[]>("/academic-years");
  const [form, setForm] = useState({ name: "", startDate: "", endDate: "" });
  const [editId, setEditId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * §25 — which session's terms are open below the table. A session at a time,
   * because a school runs one at a time and four expanded editors would be four
   * calendars to read at once.
   */
  const [termsFor, setTermsFor] = useState<number | null>(null);

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
    <MasterPane
      title="Academic Years"
      sub="Everything downstream is scoped to a year."
      formTitle={editId ? `Editing ${data?.find((x) => x.id === editId)?.name ?? "session"}` : "Add a session"}
      form={
        <>
          <ErrorNote message={error} />
          <PaneField label="Name (e.g. 2026-27)">
            <input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </PaneField>
          <PaneField label="Start date">
            <input type="date" style={inputStyle} value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
          </PaneField>
          <PaneField label="End date">
            <input type="date" style={inputStyle} value={form.endDate}
              onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </PaneField>
          <PaneActions
            editing={editId !== null}
            disabled={!form.name || !form.startDate || !form.endDate}
            onSave={save} onCancel={reset} />

          {/*
            §25 — the term calendar, in the form column with the session it
            belongs to. It used to open BELOW the table, which put a
            three-term calendar between the list and the form and made the
            scroll this screen was rebuilt to remove.
          */}
          {termsFor !== null && (() => {
            const y = (data ?? []).find((row) => row.id === termsFor);
            if (!y) return null;
            return (
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
                <TermsEditor
                  key={y.id}
                  academicYearId={y.id}
                  session={{ startDate: y.startDate?.slice(0, 10) ?? "", endDate: y.endDate?.slice(0, 10) ?? "" }}
                />
              </div>
            );
          })()}
        </>
      }
      list={
        <DataTable
          headers={["Name", "Start", "End", "Active", ""]}
          rows={(data ?? []).map((y) => [
            y.name, y.startDate?.slice(0, 10), y.endDate?.slice(0, 10),
            y.isActive ? <span key="a" className="badge badge-ok">active</span> : "—",
            <span key="x" style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" }}>
              {/* §25 — a session runs as one year or as terms, and this is where
                  that is decided. Beside Edit rather than inside it: the term
                  calendar is a different question from the session's own dates. */}
              <button
                style={{
                  border: "1px solid var(--line)", padding: "4px 9px", fontSize: 11.5,
                  borderRadius: 7, cursor: "pointer",
                  background: termsFor === y.id ? "var(--brand)" : "var(--paper)",
                  color: termsFor === y.id ? "#fff" : "var(--ink)",
                }}
                onClick={() => setTermsFor(termsFor === y.id ? null : y.id)}
              >
                ⌛ Terms
              </button>
              <RowActions
                onEdit={() => { setEditId(y.id); setForm({ name: y.name, startDate: y.startDate?.slice(0, 10) ?? "", endDate: y.endDate?.slice(0, 10) ?? "" }); }}
                onDelete={() => remove(y)} />
            </span>,
          ])}
        />
      }
    />
  );
}

export function StepClasses() {
  const { data: classes, refetch } = useApi<any[]>("/classes");
  const { data: years } = useApi<any[]>("/academic-years");
  /*
    §30 — deliberately NOT narrowed to the selected timetable's pool, unlike the
    pickers on Electives, Extra Classes and Subject Mapping.

    This is where cohort rows are MANAGED, including ones attached to no
    timetable at all; filtering would make those unreachable from the one screen
    that exists to reach them. It can afford to show every pool because it
    already distinguishes them — the table has a Timetable column, which is the
    qualifier decision §30 asks for wherever several are legitimately in view.
  */
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

  /**
   * §8.5 — one screen, two entities, no scroll.
   *
   * A class and a class-section are different things and used to be two stacked
   * cards, which put the second below the fold on every school with more than a
   * handful of classes — and the class-sections table is the one that matters,
   * because it is where "belongs to no timetable" is visible at all.
   *
   * So class-SECTIONS are the list (they are the scheduling unit, §3.10) and
   * classes live in the form column, where a school touches them once a year.
   * Class-sections keep editing IN the row, as they already did: three fields
   * fit, and it means the row you are changing never moves.
   */
  return (
    <MasterPane
      title="Class-Sections"
      sub="The scheduling units. A class-section belongs to exactly one timetable (§3.10), and until it does, no timetable can see it."
      actions={<span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>{(sections ?? []).length} section(s)</span>}
      formTitle="Classes"
      formSub="A class holds its sections. Add the class first, then its sections."
      form={
        <>
          <ErrorNote message={error} />
          {/*
            The class list, compact. Not a second DataTable: at 14 classes a
            table of two columns is a lot of furniture for a list of names, and
            this column is 340px wide.
          */}
          <div style={{ maxHeight: 210, overflow: "auto", border: "1px solid var(--line)", borderRadius: 8, marginBottom: 11 }}>
            {(classes ?? []).length === 0 && (
              <p style={{ fontSize: 11.5, color: "var(--ink-faint)", padding: "9px 10px", margin: 0 }}>
                No classes yet.
              </p>
            )}
            {(classes ?? []).map((c) => (
              <div key={c.id} style={{
                display: "flex", alignItems: "center", gap: 8, padding: "5px 9px",
                borderBottom: "1px solid var(--line)",
                background: editClassId === c.id ? "var(--steel-pale)" : undefined,
              }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>
                  <b>{c.name}</b>
                  <span style={{ color: "var(--ink-faint)" }}>
                    {" "}{c.sections.map((x: any) => x.name).join(", ") || "no sections"}
                  </span>
                </span>
                <RowActions
                  onEdit={() => { setEditClassId(c.id); setClassName(c.name); }}
                  onDelete={() => removeClass(c)} />
              </div>
            ))}
          </div>

          <PaneField label={editClassId ? "Rename class" : "Class name (e.g. Class 7)"}>
            <input style={inputStyle} value={className} onChange={(e) => setClassName(e.target.value)} />
          </PaneField>
          <PaneActions
            editing={editClassId !== null}
            disabled={!className}
            onSave={saveClass}
            onCancel={() => { setEditClassId(null); setClassName(""); }}
            addLabel="＋ Add class"
          />

          <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
            <PaneField label="Add a section to">
              <select style={inputStyle} value={secForm.classId}
                onChange={(e) => setSecForm({ ...secForm, classId: e.target.value })}>
                <option value="">— choose class —</option>
                {(classes ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </PaneField>
            <PaneField label="Section name (A, B…)">
              <input style={inputStyle} value={secForm.name}
                onChange={(e) => setSecForm({ ...secForm, name: e.target.value })} />
            </PaneField>
            <button className="btn btn-primary" style={{ fontSize: 12.5, width: "100%" }}
              onClick={addSection} disabled={!secForm.classId || !secForm.name}>
              ＋ Add section
            </button>
          </div>
        </>
      }
      list={
        <>
          {/*
            §8.2 — the gap between "I entered everything" and "Readiness says 0%".

            Creating a class-section and giving it to a timetable are separate
            acts, and the second happens on another screen. A school that does
            the first and not the second has every master filled in and a
            dashboard reading 0% with no obvious cause. So it is said once,
            loudly, above the table, and it links to the screen that fixes it.
          */}
          {(sections ?? []).some((cs) => !cs.timetableConfigName) && (
            <div style={{
              display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 10,
              borderLeft: "3px solid var(--amber)", background: "var(--amber-bg)",
              padding: "9px 12px", borderRadius: "0 8px 8px 0", fontSize: 12.5, lineHeight: 1.5,
            }}>
              <span style={{ flex: 1, minWidth: 240, color: "var(--ink-soft)" }}>
                <strong style={{ color: "var(--ink)" }}>
                  {(sections ?? []).filter((cs) => !cs.timetableConfigName).length} class-section(s) belong to no
                  timetable yet.
                </strong>{" "}
                Readiness reports 0% for a timetable with no classes, however complete the rest of the school is.
              </span>
              <Link to="/setup" className="btn btn-primary" style={{ textDecoration: "none", fontSize: 12.5 }}>
                Assign them →
              </Link>
            </div>
          )}
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
        </>
      }
    />
  );
}

export function StepRooms() {
  const { data, refetch } = useApi<any[]>("/rooms");
  const { data: sections, refetch: refetchSections } = useApi<any[]>("/class-sections");
  const { data: subjects } = useApi<any[]>("/subjects");
  const blank = { name: "", roomType: "classroom", capacity: "", homeFor: "", subjectIds: [] as number[] };
  const [form, setForm] = useState(blank);
  const [editId, setEditId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setForm(blank); setEditId(null); };
  const save = async () => {
    try {
      const body = JSON.stringify({
        name: form.name, roomType: form.roomType,
        capacity: form.capacity ? Number(form.capacity) : null,
        // §19: both mappings the solver honours — which class sits here all
        // week, and which subjects this room is set up for.
        homeForIds: form.homeFor ? [Number(form.homeFor)] : [],
        subjectIds: form.subjectIds,
      });
      if (editId) await api(`/rooms/${editId}`, { method: "PUT", body });
      else await api("/rooms", { method: "POST", body });
      reset(); setError(null); refetch(); refetchSections();
    } catch (e) { setError(asMessage(e)); }
  };
  const remove = async (r: any) => {
    if (!confirmDelete(`room "${r.name}"`)) return;
    try { await api(`/rooms/${r.id}`, { method: "DELETE" }); setError(null); refetch(); }
    catch (e) { setError(asMessage(e)); }
  };

  return (
    <MasterPane
      title="Rooms"
      sub="Which class sits here, and which subjects it is set up for — the solver puts lessons in the room you name (§19)."
      actions={<span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>{(data ?? []).length} room(s)</span>}
      formTitle={editId ? `Editing ${data?.find((x) => x.id === editId)?.name ?? "room"}` : "Add a room"}
      form={
        <>
          <ErrorNote message={error} />
          <PaneField label="Name">
            <input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </PaneField>
          <PaneField label="Type">
            <select style={inputStyle} value={form.roomType} onChange={(e) => setForm({ ...form, roomType: e.target.value })}>
              {["classroom", "lab", "sports", "music", "art", "auditorium", "other"].map((t) => <option key={t}>{t}</option>)}
            </select>
          </PaneField>
          <PaneField label="Capacity">
            <input type="number" style={inputStyle} value={form.capacity}
              onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
          </PaneField>
          <PaneField label="Home room for" hint="The class-section that sits here all week.">
            <select style={inputStyle} value={form.homeFor} onChange={(e) => setForm({ ...form, homeFor: e.target.value })}>
              <option value="">— none —</option>
              {(sections ?? []).map((cs) => (
                <option key={cs.id} value={cs.id}>{cs.label ?? `${cs.className}-${cs.sectionName}`}</option>
              ))}
            </select>
          </PaneField>
          <PaneField label="Set up for (labs and special rooms)"
            hint="Leave empty for a general room. A lab listed for Biology will only ever take Biology periods.">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(subjects ?? []).map((sub) => {
                const on = form.subjectIds.includes(sub.id);
                return (
                  <label key={sub.id} className="chip" style={{
                    cursor: "pointer", userSelect: "none",
                    background: on ? "var(--brand)" : undefined, color: on ? "#fff" : undefined,
                  }}>
                    <input type="checkbox" style={{ display: "none" }} checked={on}
                      onChange={() => setForm({
                        ...form,
                        subjectIds: on ? form.subjectIds.filter((x) => x !== sub.id) : [...form.subjectIds, sub.id],
                      })} />
                    {sub.name}
                  </label>
                );
              })}
            </div>
          </PaneField>
          <PaneActions editing={editId !== null} disabled={!form.name} onSave={save} onCancel={reset} />
        </>
      }
      list={
        <DataTable
          headers={["Room", "Type", "Home room for", "Set up for", "Capacity", ""]}
          rows={(data ?? []).map((r) => [
            r.name,
            <span key="t" className="chip mono">{r.roomType}</span>,
            r.homeForLabels?.length ? <b key="h">{r.homeForLabels.join(", ")}</b> : <span key="h" style={{ color: "var(--ink-faint)" }}>—</span>,
            r.subjectNames?.length
              ? r.subjectNames.join(", ")
              : <span key="s" style={{ color: "var(--ink-faint)" }}>{r.roomType === "lab" ? "any lab subject" : "—"}</span>,
            r.capacity ?? "—",
            <RowActions key="x"
              onEdit={() => {
                setEditId(r.id);
                setForm({
                  name: r.name, roomType: r.roomType,
                  capacity: r.capacity == null ? "" : String(r.capacity),
                  homeFor: r.homeForIds?.[0] ? String(r.homeForIds[0]) : "",
                  subjectIds: r.subjectIds ?? [],
                });
              }}
              onDelete={() => remove(r)} />,
          ])}
        />
      }
    />
  );
}

export function StepSubjects() {
  const { data, refetch } = useApi<any[]>("/subjects");
  /**
   * §26.2 — the form carries the four placement fields as well.
   *
   * `undefined` until the admin touches one, so a new subject is classified
   * from its NAME by the server (`defaultsFor`) rather than by whatever this
   * form happened to be showing. The controls below display that same
   * derivation, so what is on screen is what will be saved.
   */
  const [form, setForm] = useState<any>({ name: "", isLab: false, requiresDoublePeriod: false });
  const [editId, setEditId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** §19.1 — the rooms to choose from when a subject has one of its own. */
  const { data: rooms } = useApi<any[]>("/rooms");
  const roomName = (id: number) => (rooms ?? []).find((r) => r.id === id)?.name ?? `room #${id}`;
  /**
   * §27.16 — the classes to choose from, in LADDER order.
   *
   * `sequence`, not name: sorted alphabetically "Class 10" lands between
   * "Class 1" and "Class 2", and a class list in that order is unreadable.
   */
  const { data: classes } = useApi<any[]>("/classes");
  const ladder = [...(classes ?? [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const classId = (name: string) => ladder.find((c) => c.name === name)?.id;
  const chosenClasses = (ids: number[]) =>
    ladder.filter((c) => ids.includes(c.id)).map((c) => c.name);
  /**
   * Toggling in a picker that starts with EVERYTHING ticked.
   *
   * "Not stated" is stored as an empty list and READ as every class (invariant
   * 7), so the cell shows all of them until one is removed — and removing the
   * last one would store `[]`, which means "all", handing the subject straight
   * back to every class. So the last class cannot be removed, exactly as
   * §27.9's teacher scope cannot.
   */
  const toggleClass = (name: string) => {
    const id = classId(name);
    if (id === undefined) return;
    const current = (form.classIds ?? []).length > 0 ? form.classIds : ladder.map((c) => c.id);
    const next = current.includes(id) ? current.filter((x: number) => x !== id) : [...current, id];
    if (next.length === 0) return;
    setForm({ ...form, classIds: next.length === ladder.length ? [] : next });
  };

  const shown = { ...defaultsFor(form.name ?? ""), ...clean(form) };
  const reset = () => { setForm({ name: "", isLab: false, requiresDoublePeriod: false, classIds: [] }); setEditId(null); };
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
    <MasterPane
      title="Subjects"
      sub="Flag lab subjects — they must land in a lab room."
      actions={<span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>{(data ?? []).length} subject(s)</span>}
      formTitle={editId ? `Editing ${data?.find((x) => x.id === editId)?.name ?? "subject"}` : "Add a subject"}
      formSub={editId ? undefined : "Everything except the name has a sensible default worked out from it."}
      form={
        <>
          <ErrorNote message={error} />
          <PaneField label="Subject name">
            <input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </PaneField>
          {/*
            §27.16 — second, as it was when this was a row: it is the field with
            the widest reach, because it decides where the Allocation page even
            offers the subject.
          */}
          <PaneField label="Taught to" hint="Blank means every class.">
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", minHeight: 34 }}>
              <ChipPicker
                all={ladder}
                chosen={(form.classIds ?? []).length === 0 ? ladder.map((c) => c.name) : chosenClasses(form.classIds)}
                noun="class"
                nounPlural="classes"
                keepOrder
                collapseAll
                label={form.name?.trim() || "this subject"}
                onToggle={toggleClass}
              />
            </div>
          </PaneField>
          <PaneField label="Category">
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)" }}>
              <CategorySelect value={shown.category} onChange={(category) => setForm({ ...form, category })} />
            </div>
          </PaneField>
          <PaneField label="Priority — earlier in the day">
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)" }}>
              <PrioritySelect value={shown.priority} onChange={(priority) => setForm({ ...form, priority })} />
            </div>
          </PaneField>
          <PaneField label="Placement around lunch">
            <LunchRules value={shown} onChange={(patch) => setForm({ ...form, ...patch })} />
          </PaneField>

          <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 12.5, marginBottom: 10 }}>
            <input type="checkbox" checked={form.isLab} onChange={(e) => setForm({ ...form, isLab: e.target.checked })} />
            Requires a lab
          </label>
          <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 12.5, marginBottom: 10 }}>
            <input type="checkbox" checked={!!form.requiresDoublePeriod}
              onChange={(e) => setForm({ ...form, requiresDoublePeriod: e.target.checked })} />
            Usually a double period
          </label>

          {/*
            §19.1 — the checkbox and the room it needs, together. Ticking the box
            without naming a room is the half-said state Check 5b has to warn
            about, and the picker sits directly under it so most people do not
            reach that state at all.
          */}
          <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 12.5 }}>
            <input type="checkbox" checked={!!form.taughtInOwnRoom}
              onChange={(e) => setForm({ ...form, taughtInOwnRoom: e.target.checked })} />
            Taught in its own room
          </label>
          <select
            value={(form.roomIds ?? [])[0] ?? ""}
            disabled={!form.taughtInOwnRoom}
            aria-label="The room this subject is taught in"
            onChange={(e) => setForm({ ...form, roomIds: e.target.value ? [Number(e.target.value)] : [] })}
            style={{ ...inputStyle, marginTop: 5, width: "100%", opacity: form.taughtInOwnRoom ? 1 : 0.45 }}
          >
            <option value="">— class's home room —</option>
            {(rooms ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          {(form.roomIds ?? []).length > 1 && (
            <small style={{ display: "block", fontSize: 10.5, color: "var(--ink-faint)", marginTop: 3 }}>
              {form.roomIds.length} rooms set — choosing here replaces them all
            </small>
          )}

          <PaneActions editing={editId !== null} disabled={!form.name} onSave={save} onCancel={reset} />
        </>
      }
      list={
        <DataTable
          headers={["Subject", "Classes", "Category", "Priority", "Placement", "Lab?", "Room", ""]}
          rows={(data ?? []).map((s) => [
            s.name,
            (s.classIds ?? []).length === 0
              ? <span key="k" style={{ color: "var(--ink-faint)" }}>Every class</span>
              : <span key="k">{chosenClasses(s.classIds).join(", ")}</span>,
            s.category === "co_scholastic"
              ? <span key="c" style={{ color: "var(--steel)" }}>Co-scholastic</span>
              : "Scholastic",
            <span key="p" className="mono" style={{ fontVariantNumeric: "tabular-nums" }}>{s.priority}</span>,
            lunchSummary(s) ?? <span key="q" style={{ color: "var(--ink-faint)" }}>—</span>,
            s.isLab ? <span key="l" className="badge badge-ok">lab</span> : "—",
            !s.taughtInOwnRoom
              ? <span key="r" style={{ color: "var(--ink-faint)" }}>Home room</span>
              : (s.roomIds ?? []).length === 0
                ? <span key="r" style={{ color: "var(--signal)" }}>own room — none set</span>
                : <span key="r">{(s.roomIds ?? []).map(roomName).join(", ")}</span>,
            <RowActions key="x"
              onEdit={() => {
                setEditId(s.id);
                setForm({
                  name: s.name, isLab: s.isLab, requiresDoublePeriod: s.requiresDoublePeriod,
                  category: s.category, priority: s.priority,
                  lunchRule: s.lunchRule, gapAfterLunch: s.gapAfterLunch,
                  taughtInOwnRoom: s.taughtInOwnRoom,
                  roomIds: s.roomIds ?? [],
                  classIds: s.classIds ?? [],
                });
              }}
              onDelete={() => remove(s)} />,
          ])}
        />
      }
    />
  );
}
