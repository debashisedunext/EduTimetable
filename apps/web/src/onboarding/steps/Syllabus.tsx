/**
 * §15.3 Phase 25.4d–g — steps 8 to 11: rooms, curriculum, mapping, settings.
 *
 * These three are the *suggested* steps, and the shape of all three is the same:
 * the suggester proposes, the screen shows the proposal as ordinary editable
 * rows, and anything edited is stored in the draft under its own key. The server
 * reads that key if it is there and re-proposes if it is not — so going back to
 * step 7 to add a teacher and forward again changes the proposal, while an edit
 * made here survives.
 *
 * Two things are deliberately NOT re-implemented in the browser:
 *
 *  - **Load and capacity limits.** The §16 importer runs `assertWithinWeek` on
 *    every row it writes. A second opinion here that the server then contradicts
 *    would be worse than no opinion at all.
 *  - **Coverage.** `coverageGaps` is the same function the commit uses to build
 *    its issue list, so what the screen says in green and what Next says in red
 *    cannot drift apart.
 *
 * The per-class curriculum total against the wing's real weekly capacity IS
 * computed here, because it is arithmetic on numbers already on screen and the
 * whole point of a matrix is seeing the row total move as you type.
 */
import { useMemo, useState } from "react";
import {
  coverageGaps, planClasses, suggestCurriculum, suggestMappings, suggestRooms,
  weeklyCapacity, withCurriculumPeriods,
  type CurriculumCell, type MappingSuggestion, type SubjectAnswer, type SuggestedRoom,
  type TeacherAnswer, type WingAnswer,
} from "@edutimetable/shared";
import { Note, type WeekAnswer } from "./Structure";
import { cell, Heading, label, LinkButton, Scroll, td, th, input } from "./ui";

/** The week each wing actually got on step 5 — the ceiling for everything here. */
function weeksOf(answers: Record<string, any>) {
  const wings: WingAnswer[] = answers.wings ?? [];
  const weeks: Record<string, WeekAnswer> = answers.weeks ?? {};
  const capacity: Record<string, number> = {};
  const days: Record<string, number> = {};
  for (const w of wings) {
    const week = weeks[w.name];
    const workingDays = week?.workingDays ?? [1, 2, 3, 4, 5];
    capacity[w.name] = weeklyCapacity(week?.periodsPerDay ?? 8, workingDays);
    days[w.name] = workingDays.length;
  }
  return { wings, capacity, days };
}

// ───────────────────────────────────────────────────────────── step 8: rooms

export function StepRooms({ answers, onChange }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}) {
  const { wings, capacity, days } = weeksOf(answers);
  const subjects: SubjectAnswer[] = answers.subjects ?? [];

  const proposed = useMemo(() => {
    const curriculum = suggestCurriculum(wings, subjects, capacity, days);
    return suggestRooms(wings, subjects, { curriculum, capacityByWing: capacity });
  }, [JSON.stringify([wings, subjects, capacity, days])]);

  const rooms: SuggestedRoom[] = answers.rooms ?? proposed;
  const edited = Array.isArray(answers.rooms);
  const set = (next: SuggestedRoom[]) => onChange({ rooms: next });
  const edit = (i: number, patch: Partial<SuggestedRoom>) =>
    set(rooms.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const byType = (t: string) => rooms.filter((r) => r.type === t).length;

  return (
    <>
      <Heading title="Where do the lessons happen?">
        Worked out from the classes and subjects you entered: a home room for every section, enough
        labs for the lab periods the week actually needs, and a room for each activity subject.
      </Heading>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {[["classroom", "home rooms"], ["lab", "labs"], ["activity", "activity rooms"], ["hall", "halls"]]
          .filter(([t]) => byType(t) > 0)
          .map(([t, name]) => (
            <span key={t} style={{
              font: "600 11.5px/1 Inter", padding: "6px 10px", borderRadius: 20,
              background: "var(--steel-pale)", color: "var(--brand-dark)",
            }}>{byType(t)} {name}</span>
          ))}
        {edited && (
          <LinkButton onClick={() => onChange({ rooms: undefined })}>Start again from the suggestion</LinkButton>
        )}
      </div>

      <Scroll max={300}>
        <thead><tr>
          <th style={{ ...th, width: "34%" }}>Room</th>
          <th style={{ ...th, width: 104 }}>Type</th>
          <th style={{ ...th, width: 74 }}>Seats</th>
          <th style={{ ...th }}>Used for</th>
          <th style={{ ...th, width: 30 }} />
        </tr></thead>
        <tbody>
          {rooms.map((r, i) => (
            <tr key={`${r.name}-${i}`}>
              <td style={td}>
                <input style={cell} value={r.name} aria-label={`Room ${i + 1}`}
                  onChange={(e) => edit(i, { name: e.target.value })} />
              </td>
              <td style={td}>
                <select style={{ ...cell, fontSize: 11.5 }} value={r.type} aria-label={`Type of ${r.name}`}
                  onChange={(e) => edit(i, { type: e.target.value as SuggestedRoom["type"] })}>
                  {["classroom", "lab", "activity", "hall"].map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </td>
              <td style={td}>
                <input type="number" min={1} max={200} style={{ ...cell, textAlign: "center" }}
                  value={r.capacity ?? ""} placeholder="—" aria-label={`Seats in ${r.name}`}
                  onChange={(e) => edit(i, { capacity: e.target.value === "" ? null : Number(e.target.value) })} />
              </td>
              <td style={{ ...td, fontSize: 11.5, color: "var(--ink-faint)", padding: "6px 9px" }}>
                {/* Two different facts, and the difference matters (§19): a home
                    room belongs to a section; a lab's subject list is what stops
                    it being a general room that serves everything. */}
                {r.homeRoomFor
                  ? <>Home room for <strong style={{ color: "var(--ink-soft)" }}>{r.homeRoomFor}</strong></>
                  : r.subjects.length > 0
                    ? r.subjects.join(", ")
                    : <em>anything — no subject listed</em>}
              </td>
              <td style={{ ...td, textAlign: "right" }}>
                <LinkButton tone="danger" onClick={() => set(rooms.filter((_, n) => n !== i))}>✕</LinkButton>
              </td>
            </tr>
          ))}
        </tbody>
      </Scroll>

      <button className="btn" style={{ padding: "4px 10px", fontSize: 12, marginTop: 10 }}
        onClick={() => set([...rooms, { name: "", type: "classroom", isShared: false, capacity: null, subjects: [], because: "added by hand" }])}>
        + Add a room
      </button>

      <Note>
        A lab with <em>no subject listed</em> is a general-purpose room that serves everything (§19).
        The labs above are mapped to their subjects, which is what makes the solver put Science in the
        Science Lab and nothing else there.
      </Note>
    </>
  );
}

// ──────────────────────────────────────────────────────── step 9: curriculum

export function StepCurriculum({ answers, onChange }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}) {
  const { wings, capacity, days } = weeksOf(answers);
  const subjects: SubjectAnswer[] = (answers.subjects ?? []).filter((s: SubjectAnswer) => s.name?.trim());
  const [active, setActive] = useState(0);

  const proposal = useMemo(
    () => suggestCurriculum(wings, subjects, capacity, days),
    [JSON.stringify([wings, subjects, capacity, days])],
  );
  const cells: CurriculumCell[] = answers.curriculum ?? proposal.cells;
  const edited = Array.isArray(answers.curriculum);

  const classes = useMemo(() => planClasses(wings).classes, [JSON.stringify(wings)]);
  const wing = wings[active];
  const mine = classes.filter((c) => c.wing === wing?.name);

  if (!wing) return <Note tone="warn">Add a wing on step 3 first.</Note>;

  const at = (className: string, subjectName: string) =>
    cells.find((c) => c.className === className && c.subjectName === subjectName);

  const setCell = (className: string, subjectName: string, periods: number) => {
    const others = cells.filter((c) => !(c.className === className && c.subjectName === subjectName));
    if (periods <= 0) { onChange({ curriculum: others }); return; }
    const existing = at(className, subjectName);
    const maxPerDay = Math.max(
      // Never below what the week arithmetically requires: 6 periods at 1 a day
      // needs 6 days, and Check 3 refuses that in a 5-day week however it is
      // staffed. Raising the floor with the number is the only honest default.
      Math.ceil(periods / (days[wing.name] ?? 5)),
      existing?.maxPerDay ?? 1,
    );
    onChange({ curriculum: [...others, { className, subjectName, periodsPerWeek: periods, maxPerDay }] });
  };

  const totalOf = (className: string) =>
    cells.filter((c) => c.className === className).reduce((n, c) => n + c.periodsPerWeek, 0);

  const cap = capacity[wing.name] ?? 40;

  return (
    <>
      <Heading title="How many periods does each subject get?">
        One row per class. The total on the right is checked against this wing's{" "}
        <strong>{cap}-period week</strong> — a class asking for more than that cannot be timetabled,
        and one asking for less leaves free periods nobody has decided about.
      </Heading>

      {wings.length > 1 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          {wings.map((w, i) => (
            <button key={w.name} onClick={() => setActive(i)} className="btn"
              style={{
                padding: "5px 11px", fontSize: 12,
                background: i === active ? "var(--brand)" : "var(--paper)",
                color: i === active ? "#fff" : "var(--ink)",
                borderColor: i === active ? "var(--brand)" : "var(--line)",
              }}>{w.name}</button>
          ))}
        </div>
      )}

      <Scroll max={320}>
        <thead><tr>
          <th style={{ ...th, left: 0, position: "sticky", zIndex: 2, minWidth: 92 }}>Class</th>
          {subjects.map((s) => <th key={s.name} style={{ ...th, textAlign: "center", width: 62 }}>{s.name}</th>)}
          <th style={{ ...th, textAlign: "center", width: 74 }}>Total</th>
        </tr></thead>
        <tbody>
          {mine.map((c) => {
            const total = totalOf(c.className);
            const state = total > cap ? "over" : total < cap ? "under" : "exact";
            return (
              <tr key={c.className}>
                <td style={{ ...td, padding: "6px 9px", position: "sticky", left: 0, background: "var(--paper)", fontWeight: 600 }}>
                  {c.className}
                </td>
                {subjects.map((s) => (
                  <td style={td} key={s.name}>
                    <input type="number" min={0} max={20}
                      aria-label={`${s.name} periods for ${c.className}`}
                      value={at(c.className, s.name)?.periodsPerWeek ?? 0}
                      onChange={(e) => setCell(c.className, s.name, Number(e.target.value))}
                      style={{
                        ...cell, textAlign: "center",
                        color: (at(c.className, s.name)?.periodsPerWeek ?? 0) === 0 ? "var(--ink-faint)" : "var(--ink)",
                      }} />
                  </td>
                ))}
                <td style={{
                  ...td, textAlign: "center", font: "600 12px/1 var(--mono, monospace)",
                  color: state === "over" ? "var(--signal)" : state === "under" ? "var(--amber)" : "var(--accent)",
                }} title={
                  state === "over" ? `${total - cap} more than the week holds`
                    : state === "under" ? `${cap - total} free periods a week`
                      : "fills the week exactly"
                }>
                  {total}/{cap}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Scroll>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
        {edited && <LinkButton onClick={() => onChange({ curriculum: undefined })}>Start again from the suggestion</LinkButton>}
        <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
          {cells.length} curriculum rows across every wing
        </span>
      </div>

      {mine.some((c) => totalOf(c.className) > cap) && (
        <Note tone="warn">
          A class asking for more periods than its week holds can never be timetabled. Reduce a
          subject, or give this wing a longer week on step 5.
        </Note>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────── step 10: mapping

export function StepMapping({ answers, onChange }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}) {
  const { wings, capacity, days } = weeksOf(answers);
  const subjects: SubjectAnswer[] = answers.subjects ?? [];
  const teachers: TeacherAnswer[] = answers.teachers ?? [];
  const [filter, setFilter] = useState("");

  const curriculum = useMemo(() => {
    const cells: CurriculumCell[] | undefined = answers.curriculum;
    return cells && cells.length > 0
      ? { cells, totals: [], dropped: [] }
      : suggestCurriculum(wings, subjects, capacity, days);
  }, [JSON.stringify([answers.curriculum, wings, subjects, capacity, days])]);

  const proposal = useMemo(
    () => suggestMappings(wings, curriculum, teachers, days),
    [JSON.stringify([wings, curriculum, teachers, days])],
  );

  // Same rule the commit applies: the teacher is this screen's decision, the
  // periods/week is step 9's and is only being quoted here.
  const mappings: MappingSuggestion[] = useMemo(
    () => withCurriculumPeriods(curriculum, answers.mappings ?? proposal.mappings),
    [JSON.stringify([curriculum, answers.mappings, proposal.mappings])],
  );
  const classTeachers: Array<{ classSection: string; employeeCode: string }> =
    answers.classTeachers ?? proposal.classTeachers;
  const edited = Array.isArray(answers.mappings);

  /** Employee code → the person, for the picker. Codes are minted the same way the sheet mints them. */
  const staff = useMemo(
    () => teachers.map((t, i) => ({
      code: t.employeeCode?.trim() || `T-${String(i + 1).padStart(3, "0")}`,
      name: t.name,
      subjects: t.subjects ?? [],
    })).filter((t) => t.name?.trim()),
    [JSON.stringify(teachers)],
  );
  const nameOf = (code: string) => staff.find((s) => s.code === code)?.name ?? code;

  // The same function the commit uses to build its issue list — so the screen
  // and Next can never disagree about whether this school is covered.
  const gaps = useMemo(
    () => coverageGaps(wings, curriculum, mappings),
    [JSON.stringify([wings, curriculum, mappings])],
  );

  const setMapping = (i: number, code: string) =>
    onChange({ mappings: mappings.map((m, n) => (n === i ? { ...m, employeeCode: code } : m)) });
  const setClassTeacher = (classSection: string, code: string) =>
    onChange({
      classTeachers: [
        ...classTeachers.filter((c) => c.classSection !== classSection),
        ...(code ? [{ classSection, employeeCode: code }] : []),
      ],
    });

  const shown = mappings
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => {
      if (!filter.trim()) return true;
      const q = filter.trim().toLowerCase();
      return m.subjectName.toLowerCase().includes(q)
        || m.classSections.join(" ").toLowerCase().includes(q)
        || nameOf(m.employeeCode).toLowerCase().includes(q);
    });

  const sections = useMemo(
    () => planClasses(wings).classes.flatMap((c) => c.sections.map((s) => `${c.className}-${s}`)),
    [JSON.stringify(wings)],
  );

  return (
    <>
      <Heading title="Who teaches what?">
        Filled in from the subjects each teacher listed, spreading the work across whoever can take
        it. Change any row; the coverage line below updates as you go.
      </Heading>

      {gaps.length === 0 ? (
        <Note tone="ok">
          <strong>Every curriculum row has a teacher.</strong> {mappings.length} assignments across{" "}
          {sections.length} sections.
        </Note>
      ) : (
        <Note tone="warn">
          <strong>{gaps.length} {gaps.length === 1 ? "row has" : "rows have"} nobody teaching them.</strong>{" "}
          {gaps.slice(0, 3).map((g) => `${g.className} ${g.subjectName}`).join(", ")}
          {gaps.length > 3 ? `, and ${gaps.length - 3} more` : ""}. Add a teacher for it on step 7, or
          raise somebody's weekly limit — Readiness will refuse to generate until it is covered.
        </Note>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0 8px" }}>
        <input style={{ ...input, maxWidth: 240, padding: "6px 10px", fontSize: 12.5 }}
          placeholder="Filter by subject, class or teacher" value={filter}
          aria-label="Filter assignments"
          onChange={(e) => setFilter(e.target.value)} />
        {edited && <LinkButton onClick={() => onChange({ mappings: undefined })}>Start again from the suggestion</LinkButton>}
      </div>

      <Scroll max={260}>
        <thead><tr>
          <th style={{ ...th }}>Subject</th>
          <th style={{ ...th, width: 110 }}>Class-section</th>
          <th style={{ ...th, width: 58 }}>P/wk</th>
          <th style={{ ...th, width: "34%" }}>Teacher</th>
          <th style={{ ...th, width: 30 }} />
        </tr></thead>
        <tbody>
          {shown.map(({ m, i }) => (
            <tr key={`${m.subjectName}-${m.classSections.join()}-${i}`}>
              <td style={{ ...td, padding: "6px 9px" }}>{m.subjectName}</td>
              <td style={{ ...td, padding: "6px 9px", fontFamily: "var(--mono, monospace)", fontSize: 11.5 }}>
                {m.classSections.join(", ")}
              </td>
              <td style={{ ...td, padding: "6px 9px", textAlign: "center", fontFamily: "var(--mono, monospace)", fontSize: 11.5 }}>
                {m.periodsPerWeek}
              </td>
              <td style={td}>
                <select style={{ ...cell, fontSize: 12 }} value={m.employeeCode}
                  aria-label={`Teacher for ${m.subjectName} in ${m.classSections.join(", ")}`}
                  onChange={(e) => setMapping(i, e.target.value)}>
                  {/* Everybody, not only those who listed the subject: a school
                      reassigning a class in a hurry knows something the subject
                      list does not, and the importer checks §18 scope anyway. */}
                  {staff.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name}{s.subjects.includes(m.subjectName) ? "" : " (not listed for this subject)"}
                    </option>
                  ))}
                </select>
              </td>
              <td style={{ ...td, textAlign: "right" }}>
                <LinkButton tone="danger"
                  onClick={() => onChange({ mappings: mappings.filter((_, n) => n !== i) })}>✕</LinkButton>
              </td>
            </tr>
          ))}
        </tbody>
      </Scroll>

      <label style={{ ...label, marginTop: 16 }}>Class teachers</label>
      <p style={{ fontSize: 12, color: "var(--ink-faint)", margin: "0 0 8px" }}>
        One per section — the person the first-period rule attaches to, if you turn it on next step.
      </p>
      <Scroll max={190}>
        <thead><tr>
          <th style={{ ...th, width: 120 }}>Class-section</th>
          <th style={{ ...th }}>Class teacher</th>
        </tr></thead>
        <tbody>
          {sections.map((label) => (
            <tr key={label}>
              <td style={{ ...td, padding: "6px 9px", fontWeight: 600 }}>{label}</td>
              <td style={td}>
                <select style={{ ...cell, fontSize: 12 }}
                  aria-label={`Class teacher for ${label}`}
                  value={classTeachers.find((c) => c.classSection === label)?.employeeCode ?? ""}
                  onChange={(e) => setClassTeacher(label, e.target.value)}>
                  <option value="">— none —</option>
                  {staff.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </Scroll>
    </>
  );
}

// ────────────────────────────────────────────────────────── step 11: settings

export interface SettingsAnswer {
  classTeacherFirstPeriod: boolean;
  allowConsecutive: boolean;
  interWingTeaching: boolean;
  minPeriodsPerDay: number;
}

export const defaultSettings = (): SettingsAnswer => ({
  classTeacherFirstPeriod: false,
  allowConsecutive: true,
  interWingTeaching: false,
  // ZERO, not the application's own default of 3 (§20). "At least three periods
  // or none" is a reasonable rule a school can choose; imposed silently on a
  // staff list nobody has looked at yet, it makes a part-time teacher's week
  // arithmetically impossible and Readiness refuses the school for a rule
  // nobody asked for.
  minPeriodsPerDay: 0,
});

function Toggle({ on, onChange, title, children }: {
  on: boolean; onChange: (v: boolean) => void; title: string; children: React.ReactNode;
}) {
  return (
    <label style={{
      display: "flex", gap: 11, alignItems: "flex-start", padding: "12px 14px",
      border: `1px solid ${on ? "var(--brand)" : "var(--line)"}`, borderRadius: 10,
      background: on ? "var(--steel-pale)" : "var(--paper)", cursor: "pointer",
    }}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2 }} />
      <span>
        <strong style={{ fontSize: 13, display: "block", marginBottom: 2 }}>{title}</strong>
        <span style={{ fontSize: 12.3, color: "var(--ink-soft)" }}>{children}</span>
      </span>
    </label>
  );
}

export function StepSettings({ answers, onChange }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}) {
  const s: SettingsAnswer = { ...defaultSettings(), ...(answers.settings ?? {}) };
  const set = (patch: Partial<SettingsAnswer>) => onChange({ settings: { ...s, ...patch } });
  const wings: WingAnswer[] = answers.wings ?? [];

  return (
    <>
      <Heading title="A few rules, then we're done">
        Every one of these is a hard constraint the solver honours — not a preference it scores.
        All of them can be changed later without regenerating from scratch.
      </Heading>

      <div style={{ display: "grid", gap: 10 }}>
        <Toggle on={s.classTeacherFirstPeriod} onChange={(v) => set({ classTeacherFirstPeriod: v })}
          title="The class teacher takes the first period">
          Every section starts its day with its own class teacher. Needs a class teacher on every
          section — you set those on the previous step.
        </Toggle>

        <Toggle on={s.allowConsecutive} onChange={(v) => set({ allowConsecutive: v })}
          title="A subject may run two periods back to back">
          Off means no subject is ever timetabled twice in a row for the same class. Leave it on
          unless the school has a rule against it — it is the constraint that most often makes a
          tight week unsolvable.
        </Toggle>

        {wings.length > 1 && (
          <Toggle on={s.interWingTeaching} onChange={(v) => set({ interWingTeaching: v })}
            title="Teachers may work across wings">
            Off — the default — keeps each teacher to the wing you put them in. Turning it on clears
            those limits, so anybody can be given any class.
          </Toggle>
        )}
      </div>

      <div style={{ marginTop: 16, maxWidth: 320 }}>
        <label style={label}>Minimum periods in a working day</label>
        <input style={input} type="number" min={0} max={8} value={s.minPeriodsPerDay}
          onChange={(e) => set({ minPeriodsPerDay: Number(e.target.value) })} />
        <p style={{ fontSize: 11.8, color: "var(--ink-faint)", marginTop: 6 }}>
          Read as <strong>“zero periods, or at least this many”</strong> — never “at least this many
          every day”, which no part-time teacher could satisfy. Zero means no rule, and is the right
          answer until the school has a reason.
        </p>
      </div>

      <Note tone="ok">
        Pressing <strong>Finish</strong> writes these and takes you to the Readiness dashboard, which
        checks the whole school and names anything still missing before you generate.
      </Note>
    </>
  );
}
