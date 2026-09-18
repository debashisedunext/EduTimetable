/**
 * §4.9 Phase 15 — Split Electives.
 *
 * The screen for the scenario every school has and no other screen can express:
 * a third-language period that several sections take at the same time, with a
 * different subject, teacher and room for each group of students. Class 5-A,
 * 5-B and 5-C all keep Monday P4 free; inside it French, Sanskrit and German
 * run at once under three teachers in three rooms.
 *
 * That is not a mapping (one teacher, one subject) and not a merged group (one
 * teacher across sections) — it is their mirror, and it has had a database
 * model, a solver and six feasibility checks since Phase 10 with no way for an
 * admin to reach any of it except the Excel importer. This is that way in.
 *
 * List-first, form-second, like every other master screen.
 */
import { useMemo, useState } from "react";
import { api } from "../api";
import { useApi, useConfigCtx } from "../hooks";
import { asMessage, Card, confirmDelete, DataTable, ErrorNote, Field } from "../components";
import { inputStyle } from "./Timetables";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type Placement = "solver" | "same_period" | "fixed";

interface Pin {
  day: number;
  period: number;
}

interface Option {
  id?: number;
  subjectId: string;
  teacherId: string;
  roomId: string;
}

interface Block {
  id: number;
  name: string;
  periodsPerWeek: number;
  maxPeriodsPerDay: number;
  placement: Placement;
  fixedSlots: Pin[];
  members: { classSectionId: number; label: string }[];
  options: {
    id: number;
    subjectId: number;
    subjectName: string;
    teacherId: number;
    teacherName: string;
    roomId: number;
    roomName: string;
  }[];
}

const placementChip = (b: Block) => {
  if (b.placement === "same_period") return "same period daily";
  if (b.placement === "fixed") {
    return b.fixedSlots.length
      ? b.fixedSlots.map((p) => `${DAY_NAMES[p.day] ?? p.day} P${p.period}`).join(", ")
      : "fixed — no slots chosen";
  }
  return "solver chooses";
};

export function StepElectives() {
  // §3.12: a block belongs to a session through its member sections. After a
  // clone the school has the same block name in two sessions, so the list is
  // narrowed to the timetable already chosen in the top bar — the same rule the
  // Curriculum screen follows, and deliberately not a second selector.
  const { current } = useConfigCtx();
  const yearId = current?.academicYearId ?? null;
  const { data: blocks, refetch } = useApi<Block[]>(
    yearId ? `/elective-blocks?academicYearId=${yearId}` : "/elective-blocks",
  );
  const { data: sections } = useApi<any[]>(`/class-sections${current ? `?timetableConfigId=${current.id}` : ""}`);
  const { data: subjects } = useApi<any[]>("/subjects");
  const { data: teachers } = useApi<any[]>("/teachers");
  const { data: rooms } = useApi<any[]>("/rooms");
  const [view, setView] = useState<"list" | "form">("list");
  const [editing, setEditing] = useState<Block | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const remove = async (b: Block) => {
    if (!confirmDelete(`elective block "${b.name}"`)) return;
    try {
      await api(`/elective-blocks/${b.id}`, { method: "DELETE" });
      setError(null);
      refetch();
    } catch (e) {
      setError(asMessage(e));
    }
  };

  if (view === "form") {
    return (
      <ElectiveForm
        editing={editing}
        sections={sections ?? []}
        subjects={subjects ?? []}
        teachers={teachers ?? []}
        rooms={rooms ?? []}
        onBack={() => {
          setView("list");
          setError(null);
          refetch();
        }}
        onSaved={(msg) => {
          setNote(msg);
          setError(null);
          setView("list");
          refetch();
        }}
      />
    );
  }

  return (
    <Card
      title="Split Electives"
      sub="One slot, several lessons. Every listed class-section keeps the period free and its students go to whichever option they chose — each option with its own subject, teacher and room."
      actions={
        <button className="btn btn-primary" onClick={() => { setEditing(null); setNote(null); setError(null); setView("form"); }}>
          ＋ Add Elective Block
        </button>
      }
    >
      <ErrorNote message={error} />
      {note && (
        <div style={{ background: "var(--accent-bg)", color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, marginBottom: 12, fontWeight: 600 }}>
          ✓ {note}
        </div>
      )}
      {(blocks ?? []).length === 0 ? (
        <div style={{ padding: "26px 18px", textAlign: "center", color: "var(--ink-faint)", fontSize: 12.5 }}>
          No elective blocks yet. Add one for a third language, an activity choice, or any period where the
          class splits into groups taught different subjects at the same time.
        </div>
      ) : (
        <DataTable
          headers={["Block", "Class-Sections", "Periods/Week", "When", "Options", "", ""]}
          rows={(blocks ?? []).map((b) => [
            <b key="n">{b.name}</b>,
            <span key="m" style={{ fontSize: 12 }}>{b.members.map((m) => m.label).join(", ") || <span className="badge badge-error">none</span>}</span>,
            <span key="p">{b.periodsPerWeek}<span style={{ color: "var(--ink-faint)" }}> · max {b.maxPeriodsPerDay}/day</span></span>,
            <span key="w" className="chip mono" style={{ fontSize: 11 }}>{placementChip(b)}</span>,
            <div key="o" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
              {b.options.map((o) => (
                <div key={o.id}>
                  <b>{o.subjectName}</b> — {o.teacherName} <span style={{ color: "var(--ink-faint)" }}>({o.roomName})</span>
                </div>
              ))}
            </div>,
            <button key="e" className="btn" style={{ border: "1px solid var(--line)", padding: "4px 11px", fontSize: 11.5 }} onClick={() => { setEditing(b); setNote(null); setError(null); setView("form"); }}>Edit</button>,
            <button key="d" className="btn" style={{ border: "1px solid var(--line)", padding: "4px 9px", fontSize: 11, color: "var(--signal)" }} onClick={() => remove(b)}>✕</button>,
          ])}
        />
      )}
    </Card>
  );
}

function ElectiveForm({
  editing, sections, subjects, teachers, rooms, onBack, onSaved,
}: {
  editing: Block | null;
  sections: any[];
  subjects: any[];
  teachers: any[];
  rooms: any[];
  onBack: () => void;
  onSaved: (msg: string) => void;
}) {
  const { current } = useConfigCtx();
  const [name, setName] = useState(editing?.name ?? "");
  const [periodsPerWeek, setPeriodsPerWeek] = useState(String(editing?.periodsPerWeek ?? 5));
  const [maxPerDay, setMaxPerDay] = useState(String(editing?.maxPeriodsPerDay ?? 1));
  const [placement, setPlacement] = useState<Placement>(editing?.placement ?? "solver");
  const [pins, setPins] = useState<Pin[]>(editing?.fixedSlots ?? []);
  const [selected, setSelected] = useState<Set<number>>(new Set(editing?.members.map((m) => m.classSectionId) ?? []));
  const [options, setOptions] = useState<Option[]>(
    editing?.options.map((o) => ({ id: o.id, subjectId: String(o.subjectId), teacherId: String(o.teacherId), roomId: String(o.roomId) })) ?? [
      { subjectId: "", teacherId: "", roomId: "" },
      { subjectId: "", teacherId: "", roomId: "" },
    ],
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * §27.13 — the escape hatch for the teacher filter below.
   *
   * One toggle for the whole block rather than one per row: the rows are the
   * same question asked three times, and three links saying "show all 11" is
   * three controls for one decision.
   */
  const [showAllTeachers, setShowAllTeachers] = useState(false);

  /**
   * §27.13 — who teaches this subject, for one option row.
   *
   * The same rule, and the same two traps, as the Allocation dialog's teacher
   * field: a list of every teacher in the school is a list to find three
   * language teachers in, and at a real school that is 122 names.
   *
   *  - **Never hide the teacher already chosen.** A `<select>` whose `value`
   *    matches no option renders blank, and saving then writes a different
   *    teacher than the one on the row — a silent reassignment caused by a
   *    display filter.
   *  - **Never show an empty list.** If nobody is recorded as teaching the
   *    subject the filter has nothing useful to say, so it shows everybody and
   *    says why, rather than a dropdown holding one dash.
   *
   * Reads `subjects`, which the API serves as the UNION of declared (§27.13)
   * and mapped — the documented reading rule, and what keeps a school with no
   * declarations yet from losing the list.
   *
   * Display only, deliberately. `POST /elective-blocks` checks §18 teaching
   * scope and does NOT check the subject, exactly as `POST /mappings` does not
   * — so this narrows the same way every other door in the app narrows, and
   * refusing here would make electives the one screen that is stricter than
   * the rule it is showing.
   */
  const teachersFor = (o: Option) => {
    const subjectName = subjects.find((s) => String(s.id) === o.subjectId)?.name ?? null;
    if (!subjectName || showAllTeachers) return { list: teachers, filtered: false, subjectName };
    const teach = teachers.filter((t) => (t.subjects ?? []).includes(subjectName));
    if (teach.length === 0) return { list: teachers, filtered: false, subjectName };
    const chosen = teachers.find((t) => String(t.id) === o.teacherId);
    const list = chosen && !teach.some((t) => t.id === chosen.id) ? [...teach, chosen] : teach;
    return { list, filtered: true, subjectName };
  };

  const wanted = Number(periodsPerWeek) || 0;
  const days = current?.workingDays ?? [1, 2, 3, 4, 5];
  const perDay = current?.periodsPerDay ?? 8;

  /**
   * The rules the server will enforce anyway, shown while the admin is still
   * typing. Every option runs at once, so a repeated teacher or room is one
   * person or place asked to be in two lessons at the same moment — the thing
   * `uq_teacher_slot` / `uq_room_slot` would refuse at write time.
   */
  const problems = useMemo(() => {
    const out: string[] = [];
    const filled = options.filter((o) => o.subjectId && o.teacherId && o.roomId);
    if (!name.trim()) out.push("Give the block a name — it is what appears in the timetable cell.");
    if (selected.size === 0) out.push("Choose the class-sections whose students take it.");
    if (filled.length < 2) out.push("A block needs at least 2 options — with one there is nothing to choose between.");
    const dupe = (key: keyof Option, what: string) => {
      const seen = new Set<string>();
      for (const o of filled) {
        if (seen.has(o[key] as string)) {
          out.push(`The same ${what} appears on two options — they run at the same time, so each needs its own.`);
          return;
        }
        seen.add(o[key] as string);
      }
    };
    dupe("teacherId", "teacher");
    dupe("roomId", "room");
    dupe("subjectId", "subject");
    if (placement === "fixed") {
      if (pins.length !== wanted) out.push(`Choose exactly ${wanted} slot(s) — one for each period this block runs.`);
      const perDayCount = new Map<number, number>();
      for (const p of pins) perDayCount.set(p.day, (perDayCount.get(p.day) ?? 0) + 1);
      for (const [d, n] of perDayCount) {
        if (n > (Number(maxPerDay) || 1)) out.push(`${DAY_NAMES[d]} has ${n} slots but the block is capped at ${maxPerDay}/day.`);
      }
    }
    if (placement === "same_period" && wanted > days.length) {
      out.push(`One period number cannot come round ${wanted} times in ${days.length} working day(s).`);
    }
    return out;
  }, [name, selected, options, placement, pins, wanted, maxPerDay, days.length]);

  const togglePin = (day: number, period: number) => {
    setPins((cur) => {
      const at = cur.findIndex((p) => p.day === day && p.period === period);
      if (at >= 0) return cur.filter((_, i) => i !== at);
      return [...cur, { day, period }].sort((a, b) => a.day - b.day || a.period - b.period);
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        periodsPerWeek: wanted,
        maxPeriodsPerDay: Number(maxPerDay) || 1,
        placement,
        fixedSlots: placement === "fixed" ? pins : [],
        classSectionIds: [...selected],
        options: options
          .filter((o) => o.subjectId && o.teacherId && o.roomId)
          .map((o) => ({ subjectId: Number(o.subjectId), teacherId: Number(o.teacherId), roomId: Number(o.roomId) })),
      };
      if (editing) await api(`/elective-blocks/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
      else await api("/elective-blocks", { method: "POST", body: JSON.stringify(body) });
      onSaved(editing ? `${body.name} updated` : `${body.name} created with ${body.options.length} options`);
    } catch (e) {
      setError(asMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={editing ? `Edit Elective Block — ${editing.name}` : "Add Elective Block"}>
      <ErrorNote message={error} />

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 14, marginBottom: 16 }}>
        <Field label="Block name" hint="What the timetable cell says, e.g. Class 5 Third Language">
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Class 5 Third Language" />
        </Field>
        <Field label="Periods / week" hint="For the block as a whole">
          <input type="number" min={1} style={inputStyle} value={periodsPerWeek} onChange={(e) => setPeriodsPerWeek(e.target.value)} />
        </Field>
        <Field label="Max periods / day" hint="1 = one language period a day">
          <input type="number" min={1} style={inputStyle} value={maxPerDay} onChange={(e) => setMaxPerDay(e.target.value)} />
        </Field>
      </div>

      <Field label={`Class-sections attending — select one or more (${selected.size} selected)`}
        hint="Every one of these keeps this period free at the same time, and its students split across the options below.">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 7 }}>
          {sections.map((cs) => {
            const on = selected.has(cs.id);
            return (
              <button key={cs.id} onClick={() => setSelected((s) => {
                const next = new Set(s);
                if (next.has(cs.id)) next.delete(cs.id); else next.add(cs.id);
                return next;
              })} style={{
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

      <div style={{ marginTop: 18, marginBottom: 6, fontSize: 13, fontWeight: 700 }}>
        Options — the parallel lessons inside the slot
      </div>
      <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 0, marginBottom: 10 }}>
        Add one row per choice. They all run at the same moment, so each needs a different teacher and a
        different room. Three languages means three rows; five means five.
      </p>
      <div style={{ display: "grid", gap: 8, marginBottom: 8 }}>
        {options.map((o, i) => {
          const who = teachersFor(o);
          return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8, alignItems: "center" }}>
            <select style={inputStyle} value={o.subjectId} onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, subjectId: e.target.value } : x)))}>
              <option value="">— Subject —</option>
              {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select style={inputStyle} value={o.teacherId} onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, teacherId: e.target.value } : x)))}>
              {/* Says what the list has been narrowed to, in the one place
                  somebody is looking when they wonder where a name went. */}
              <option value="">
                {who.filtered ? `— Teaches ${who.subjectName} —` : "— Teacher —"}
              </option>
              {who.list.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {/* Only ever on the row's existing teacher, kept visible by
                      the rule above — so the reason it is still listed is on
                      the option itself rather than left to be guessed. */}
                  {who.filtered && !(t.subjects ?? []).includes(who.subjectName)
                    ? ` · not listed for ${who.subjectName}` : ""}
                </option>
              ))}
            </select>
            <select style={inputStyle} value={o.roomId} onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, roomId: e.target.value } : x)))}>
              <option value="">— Room —</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <button
              className="btn"
              style={{ border: "1px solid var(--line)", padding: "6px 10px", fontSize: 11, color: "var(--signal)", visibility: options.length > 2 ? "visible" : "hidden" }}
              onClick={() => setOptions(options.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn" style={{ border: "1px solid var(--line)", fontSize: 12 }} onClick={() => setOptions([...options, { subjectId: "", teacherId: "", roomId: "" }])}>
          ＋ Add another option
        </button>
        {/*
          §27.13 — the escape hatch, one click away rather than the default.

          The reason the old list showed everybody was sound: a school staffing
          an elective in a hurry knows something the subject list does not, and
          §18 teaching scope is checked on save either way. It is offered here
          instead of being the thing everybody has to scroll past.
        */}
        <button
          onClick={() => setShowAllTeachers(!showAllTeachers)}
          style={{
            border: "none", background: "none", cursor: "pointer", padding: 0,
            font: "500 11.5px/1 Inter", color: "var(--brand)", textDecoration: "underline",
          }}>
          {showAllTeachers
            ? "Only teachers who take the subject"
            : `Show all ${teachers.length} teachers`}
        </button>
        <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>
          {showAllTeachers
            ? "Every teacher is offered. Teaching scope is still checked when this is saved."
            : "Each row offers the teachers recorded as teaching that option's subject."}
        </span>
      </div>

      <div style={{ marginTop: 22, marginBottom: 6, fontSize: 13, fontWeight: 700 }}>When does it run?</div>
      <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
        <PlacementOption
          selected={placement === "solver"}
          onSelect={() => setPlacement("solver")}
          title="Let the solver choose"
          desc="The block is placed wherever it fits best, like any other lesson."
        />
        <PlacementOption
          selected={placement === "same_period"}
          onSelect={() => setPlacement("same_period")}
          title="Same period every day"
          desc="The solver picks the period number, then holds every occurrence to it — so the block always falls at the same point in the day and a whole grade changes rooms together."
        />
        <PlacementOption
          selected={placement === "fixed"}
          onSelect={() => setPlacement("fixed")}
          title="Fixed slots — I choose the exact day and period"
          desc="Pin each occurrence. These cells are removed from the solver's choices before it starts, so it can never place the block anywhere else — and can never work around a pin that does not fit."
        >
          {placement === "fixed" && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 6 }}>
                {pins.length} of {wanted} slot(s) chosen
              </div>
              <table style={{ borderCollapse: "collapse", fontSize: 11.5 }}>
                <thead>
                  <tr>
                    <th style={pinTh} />
                    {days.map((d) => <th key={d} style={pinTh}>{DAY_NAMES[d]}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: perDay }, (_, i) => i + 1).map((p) => (
                    <tr key={p}>
                      <td style={{ ...pinTh, textAlign: "right" }}>P{p}</td>
                      {days.map((d) => {
                        const on = pins.some((x) => x.day === d && x.period === p);
                        return (
                          <td key={d} style={{ padding: 2 }}>
                            <button
                              onClick={() => togglePin(d, p)}
                              style={{
                                width: 44, height: 26, borderRadius: 6, cursor: "pointer",
                                border: `1px solid ${on ? "var(--brand)" : "var(--line)"}`,
                                background: on ? "var(--brand)" : "var(--paper)",
                                color: on ? "#fff" : "var(--ink-faint)", fontSize: 11, fontWeight: 700,
                              }}
                            >
                              {on ? "✓" : ""}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </PlacementOption>
      </div>

      {problems.length > 0 && (
        <div style={{ background: "var(--amber-bg, #FDF4E3)", border: "1px solid var(--amber)", borderRadius: 8, padding: "10px 13px", fontSize: 12, marginBottom: 14 }}>
          {problems.map((p, i) => (
            <div key={i} style={{ color: "var(--amber)" }}>⚠ {p}</div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <button className="btn" style={{ border: "1px solid var(--line)" }} onClick={onBack}>← Back to Elective List</button>
        <button className="btn btn-primary" disabled={problems.length > 0 || saving} onClick={save}>
          {saving ? "Saving…" : editing ? "Save Block" : "Create Block"}
        </button>
      </div>
    </Card>
  );
}

function PlacementOption({ selected, onSelect, title, desc, children }: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  desc: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        padding: "11px 14px", borderRadius: 9, cursor: "pointer",
        border: `1px solid ${selected ? "var(--brand)" : "var(--line)"}`,
        background: selected ? "var(--steel-pale)" : "var(--paper)",
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <input type="radio" checked={selected} readOnly style={{ marginTop: 3 }} />
        <span>
          <span style={{ fontSize: 13, fontWeight: 700 }}>{title}</span>
          <br />
          <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>{desc}</span>
        </span>
      </div>
      {children}
    </div>
  );
}

const pinTh: React.CSSProperties = {
  padding: "3px 6px",
  fontSize: 10.5,
  color: "var(--steel)",
  fontWeight: 700,
};

/** Standalone route, so the screen is reachable without walking the wizard. */
export function Electives() {
  return (
    <div>
      <h2 className="screen-title">Split Electives</h2>
      <p className="screen-sub">
        Periods where a class divides into groups taught different subjects at the same time — a third
        language, an activity choice, a stream option (§4.9).
      </p>
      <StepElectives />
    </div>
  );
}
