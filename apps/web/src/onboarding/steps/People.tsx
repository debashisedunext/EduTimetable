/**
 * §15.3 Phase 25.4c — steps 6 and 7: the subject list and the staff list.
 *
 * These are the two steps with real volume behind them — a secondary school has
 * a dozen subjects and can have two hundred teachers — so they are grids rather
 * than forms, and three things follow from that:
 *
 *  - **Paste a column.** Every school already has this list in a spreadsheet.
 *    Retyping it is the reason people abandon a setup wizard halfway.
 *  - **Defaults are shown, not hidden.** A blank max-periods box that silently
 *    becomes 6 is a field that lies; the number is in the box, in italics, and
 *    typing over it is the whole interaction.
 *  - **Initials are proposed WITH their collisions visible.** A school with an
 *    Anil Yadav and an Ajay Yadav is not unusual, and `teachers.initials` is
 *    unique — so AY and AY2 are shown as such rather than discovered by the
 *    database refusing the import.
 *
 * Nothing here writes a row. Both steps commit through `POST
 * /onboarding/commit/:step`, which builds the §16 importer's own sheets.
 */
import { useMemo } from "react";
import { proposeInitials, type SubjectAnswer, type TeacherAnswer, type WingAnswer } from "@edutimetable/shared";
import { Note } from "./Structure";
import { SubjectPicker } from "./SubjectPicker";
import { cell, Heading, LinkButton, pasteColumn, Scroll, td, th } from "./ui";

// ────────────────────────────────────────────────────────── step 6: subjects

/**
 * The list nearly every Indian school starts from.
 *
 * Offered, never assumed: a school that teaches something else deletes rows,
 * and one that starts from nothing presses the button. What it must not do is
 * appear pre-filled — a subject nobody chose becomes a curriculum row, a
 * teacher mapping and a timetable slot before anybody notices it.
 */
const USUAL: SubjectAnswer[] = [
  { name: "English" }, { name: "Hindi" }, { name: "Mathematics" },
  { name: "Science", isLab: true }, { name: "Social Science" },
  { name: "Computer Science", isLab: true }, { name: "Art & Craft" },
  { name: "Physical Education" },
];

const blankSubject = (): SubjectAnswer => ({ name: "", code: "", isLab: false, requiresDoublePeriod: false });

export function StepSubjects({ answers, onChange }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}) {
  const subjects: SubjectAnswer[] = answers.subjects ?? [];
  const set = (next: SubjectAnswer[]) => onChange({ subjects: next });
  const edit = (i: number, patch: Partial<SubjectAnswer>) =>
    set(subjects.map((s, n) => (n === i ? { ...s, ...patch } : s)));

  const rows = subjects.length > 0 ? subjects : [blankSubject()];
  const duplicate = (name: string, at: number) =>
    name.trim() !== "" && rows.some((s, i) => i !== at && s.name.trim().toLowerCase() === name.trim().toLowerCase());

  /** A pasted column extends the list rather than overwriting what follows it. */
  const paste = (values: string[], start: number) => {
    const next = [...rows];
    values.forEach((v, k) => {
      const i = start + k;
      if (i < next.length) next[i] = { ...next[i], name: v };
      else next.push({ ...blankSubject(), name: v });
    });
    set(next);
  };

  return (
    <>
      <Heading title="What does the school teach?">
        Subject names as they should appear on a printed timetable. Mark the ones that need a lab —
        it decides which rooms the next step proposes.
      </Heading>

      {subjects.length === 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <button className="btn btn-primary" style={{ fontSize: 12.5 }} onClick={() => set(USUAL)}>
            Start from the usual eight
          </button>
          <span style={{ fontSize: 12, color: "var(--ink-faint)", alignSelf: "center" }}>
            …or type your own below. You can paste a column straight from a spreadsheet.
          </span>
        </div>
      )}

      <Scroll>
        <thead><tr>
          <th style={{ ...th, width: "40%" }}>Subject</th>
          <th style={{ ...th, width: 90 }}>Code</th>
          <th style={{ ...th, width: 80 }}>Needs a lab</th>
          <th style={{ ...th, width: 110 }}>Double period</th>
          <th style={{ ...th, width: 34 }} />
        </tr></thead>
        <tbody>
          {rows.map((s, i) => (
            <tr key={i}>
              <td style={td}>
                <input style={{ ...cell, borderColor: duplicate(s.name, i) ? "var(--signal)" : "transparent" }}
                  value={s.name} placeholder="e.g. Mathematics" aria-label={`Subject ${i + 1}`}
                  onPaste={(e) => pasteColumn(e, i, paste)}
                  onChange={(e) => edit(i, { name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && i === rows.length - 1) set([...rows, blankSubject()]);
                  }} />
              </td>
              <td style={td}>
                <input style={{ ...cell, fontFamily: "var(--mono, monospace)", fontSize: 11.5 }}
                  value={s.code ?? ""} placeholder="MAT" aria-label={`Code for ${s.name || `subject ${i + 1}`}`}
                  onChange={(e) => edit(i, { code: e.target.value })} />
              </td>
              <td style={{ ...td, textAlign: "center" }}>
                <input type="checkbox" checked={Boolean(s.isLab)} aria-label={`${s.name} needs a lab`}
                  onChange={(e) => edit(i, { isLab: e.target.checked })} />
              </td>
              <td style={{ ...td, textAlign: "center" }}>
                <input type="checkbox" checked={Boolean(s.requiresDoublePeriod)}
                  aria-label={`${s.name} needs double periods`}
                  onChange={(e) => edit(i, { requiresDoublePeriod: e.target.checked })} />
              </td>
              <td style={{ ...td, textAlign: "right" }}>
                {rows.length > 1 && <LinkButton tone="danger" onClick={() => set(rows.filter((_, n) => n !== i))}>✕</LinkButton>}
              </td>
            </tr>
          ))}
        </tbody>
      </Scroll>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
        <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={() => set([...rows, blankSubject()])}>+ Add a subject</button>
        <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
          {rows.filter((s) => s.name.trim()).length} subjects · Enter on the last row adds another
        </span>
      </div>

      <Note>
        A <strong>lab</strong> subject is one that has to be taught in a particular room. The room
        step proposes as many labs as the timetable actually needs and maps this subject to them —
        a lab with no subjects listed is a general room that serves everything (§19).
      </Note>
    </>
  );
}

// ────────────────────────────────────────────────────────── step 7: teachers

const blankTeacher = (): TeacherAnswer => ({
  name: "", employeeCode: "", subjects: [], wing: "", gender: "",
  maxPeriodsPerDay: undefined, maxPeriodsPerWeek: undefined,
  maxConsecutivePeriodsPerDay: undefined, canSubstitute: true, employmentType: "permanent",
});

/** The numbers the wizard uses when nobody says otherwise — shown, never implied. */
const DEFAULTS = { perDay: 6, perWeek: 30, run: 3 };

export function StepTeachers({ answers, onChange }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}) {
  const teachers: TeacherAnswer[] = answers.teachers ?? [];
  const subjects: SubjectAnswer[] = (answers.subjects ?? []).filter((s: SubjectAnswer) => s.name?.trim());
  const wings: WingAnswer[] = answers.wings ?? [];

  const set = (next: TeacherAnswer[]) => onChange({ teachers: next });
  const rows = teachers.length > 0 ? teachers : [blankTeacher()];
  const edit = (i: number, patch: Partial<TeacherAnswer>) =>
    set(rows.map((t, n) => (n === i ? { ...t, ...patch } : t)));

  /**
   * Initials for the whole list at once, so a collision is a fact about the
   * SET rather than about one row — which is what `proposeInitials` needs to
   * see in order to hand out AY and AY2 rather than AY twice.
   */
  const initials = useMemo(() => {
    const taken = new Set<string>();
    return rows.map((t) => {
      const v = proposeInitials(t.name ?? "", taken);
      taken.add(v);
      return v;
    });
  }, [rows.map((t) => t.name).join("|")]);
  // A proposal that had to disambiguate ends in a digit — that is the signal
  // worth surfacing. There are no duplicates by construction, which is the
  // point: the collision is resolved in the cell, in front of somebody who can
  // pick something better, rather than by a unique index refusing the import.
  const collides = useMemo(() => initials.map((v) => /\d$/.test(v)), [initials.join("|")]);

  const paste = (values: string[], start: number) => {
    const next = [...rows];
    values.forEach((v, k) => {
      const i = start + k;
      if (i < next.length) next[i] = { ...next[i], name: v };
      else next.push({ ...blankTeacher(), name: v });
    });
    set(next);
  };

  const toggleSubject = (i: number, name: string) => {
    const has = rows[i].subjects.includes(name);
    edit(i, { subjects: has ? rows[i].subjects.filter((s) => s !== name) : [...rows[i].subjects, name] });
  };

  const named = rows.filter((t) => t.name?.trim()).length;
  const unassigned = rows.filter((t) => t.name?.trim() && t.subjects.length === 0).length;

  return (
    <>
      <Heading title="Who teaches?">
        Name and subjects are what the next steps need; everything else has a sensible default you
        can type over. Paste a column of names to fill the list in one go.
      </Heading>

      {subjects.length === 0 && <Note tone="warn">Add some subjects on the previous step first — a teacher with no subject cannot be given any classes.</Note>}

      <Scroll max={340}>
        <thead><tr>
          <th style={{ ...th, width: "24%" }}>Name</th>
          <th style={{ ...th, width: 74 }}>Code</th>
          <th style={{ ...th, width: 58 }}>Initials</th>
          <th style={{ ...th }}>Teaches</th>
          {wings.length > 1 && <th style={{ ...th, width: 110 }}>Wing</th>}
          <th style={{ ...th, width: 52 }} title="Most periods in one day">Max/day</th>
          <th style={{ ...th, width: 56 }} title="Most periods in a week">Max/week</th>
          <th style={{ ...th, width: 56 }} title="Longest run of back-to-back periods">In a row</th>
          <th style={{ ...th, width: 46 }} title="Available for substitutions">Sub</th>
          <th style={{ ...th, width: 30 }} />
        </tr></thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={i}>
              <td style={td}>
                <input style={cell} value={t.name} placeholder="e.g. Anil Yadav" aria-label={`Teacher ${i + 1}`}
                  onPaste={(e) => pasteColumn(e, i, paste)}
                  onChange={(e) => edit(i, { name: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter" && i === rows.length - 1) set([...rows, blankTeacher()]); }} />
              </td>
              <td style={td}>
                <input style={{ ...cell, fontFamily: "var(--mono, monospace)", fontSize: 11.5 }}
                  value={t.employeeCode ?? ""} placeholder="auto" aria-label={`Employee code for ${t.name}`}
                  onChange={(e) => edit(i, { employeeCode: e.target.value })} />
              </td>
              <td style={td}>
                <input
                  title={collides[i] && !t.initials
                    ? "Another teacher has the same initials — this one was numbered to keep them unique"
                    : undefined}
                  aria-label={`Initials for ${t.name}`}
                  value={t.initials ?? (t.name?.trim() ? initials[i] : "")}
                  placeholder="—"
                  onChange={(e) => edit(i, { initials: e.target.value })}
                  style={{
                    ...cell, textAlign: "center", font: "600 11.5px/1.5 var(--mono, monospace)",
                    fontStyle: t.initials === undefined ? "italic" : "normal",
                    color: t.initials !== undefined ? "var(--ink)"
                      : collides[i] ? "var(--amber)" : "var(--ink-faint)",
                  }} />
              </td>
              <td style={td}>
                {/*
                  §26.1 — what this teacher teaches, not what the school does.
                  Every subject used to be a chip in every row: 22 × 122 at the
                  reference school, and the one fact the cell exists to show
                  buried in the middle of it.
                */}
                <SubjectPicker
                  all={subjects}
                  chosen={t.subjects}
                  label={t.name?.trim() || `teacher ${i + 1}`}
                  onToggle={(name) => toggleSubject(i, name)}
                />
              </td>
              {wings.length > 1 && (
                <td style={td}>
                  <select style={{ ...cell, fontSize: 11.5 }} value={t.wing ?? ""}
                    aria-label={`Wing for ${t.name}`}
                    onChange={(e) => edit(i, { wing: e.target.value })}>
                    <option value="">Any wing</option>
                    {wings.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
                  </select>
                </td>
              )}
              {([
                ["maxPeriodsPerDay", DEFAULTS.perDay, 1, 14],
                ["maxPeriodsPerWeek", DEFAULTS.perWeek, 1, 60],
                ["maxConsecutivePeriodsPerDay", DEFAULTS.run, 1, 12],
              ] as const).map(([key, fallback, min, max]) => (
                <td style={td} key={key}>
                  {/* The default is IN the box, in italics, and typing replaces
                      it. A blank that silently becomes 6 is a field that lies. */}
                  <input type="number" min={min} max={max} style={{
                    ...cell, textAlign: "center", fontSize: 12,
                    fontStyle: t[key] === undefined ? "italic" : "normal",
                    color: t[key] === undefined ? "var(--ink-faint)" : "var(--ink)",
                  }}
                    value={t[key] ?? fallback} aria-label={`${key} for ${t.name}`}
                    onChange={(e) => edit(i, { [key]: e.target.value === "" ? undefined : Number(e.target.value) } as Partial<TeacherAnswer>)} />
                </td>
              ))}
              <td style={{ ...td, textAlign: "center" }}>
                {/* Not a preference: a teacher marked No is REMOVED from the
                    substitute candidate list, never merely ranked lower. */}
                <input type="checkbox" checked={t.canSubstitute !== false}
                  aria-label={`${t.name} can cover substitutions`}
                  onChange={(e) => edit(i, { canSubstitute: e.target.checked })} />
              </td>
              <td style={{ ...td, textAlign: "right" }}>
                {rows.length > 1 && <LinkButton tone="danger" onClick={() => set(rows.filter((_, n) => n !== i))}>✕</LinkButton>}
              </td>
            </tr>
          ))}
        </tbody>
      </Scroll>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
        <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={() => set([...rows, blankTeacher()])}>+ Add a teacher</button>
        <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={() => set([...rows, ...Array.from({ length: 10 }, blankTeacher)])}>+ 10 rows</button>
        <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>{named} teachers</span>
      </div>

      {unassigned > 0 && (
        <Note tone="warn">
          {unassigned} {unassigned === 1 ? "teacher has" : "teachers have"} no subject yet. They will be
          created, but the mapping step can give them nothing to teach.
        </Note>
      )}
    </>
  );
}
