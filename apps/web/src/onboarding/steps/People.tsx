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
import { useEffect, useMemo, useState } from "react";
import { defaultsFor, planClasses, proposeInitials, type SubjectAnswer, type TeacherAnswer, type WingAnswer } from "@edutimetable/shared";
import { CategorySelect, LunchRules, PrioritySelect } from "../../subjects/Placement";
import { Note } from "./Structure";
import { ChipPicker } from "./ChipPicker";
import { cell, Heading, LinkButton, pasteColumn, Scroll, td, th } from "./ui";
import { api } from "../../api";

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

/**
 * §26.2 — what a row's placement controls should show.
 *
 * Derived from the name on every render rather than written into the draft when
 * the row was created, and that is the whole behaviour: type "Games" over
 * "Sports" and the rules follow the new name, where a value baked in at
 * creation would keep Sports' and nobody would know why. The moment somebody
 * changes a control, their choice is in `answers` and wins from then on.
 */
function placementOf(s: SubjectAnswer) {
  const d = defaultsFor(s.name);
  return {
    category: s.category ?? d.category,
    priority: s.priority ?? d.priority,
    lunchRule: s.lunchRule ?? d.lunchRule,
    gapAfterLunch: s.gapAfterLunch ?? d.gapAfterLunch,
  };
}

export function StepSubjects({ answers, onChange }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}) {
  const subjects: SubjectAnswer[] = answers.subjects ?? [];
  /**
   * §27.16 — the classes on offer, in ladder order.
   *
   * Read from the wings the previous step defined, so the two statements cannot
   * disagree: a subject cannot be pinned to a class this school is not going to
   * have. Empty until wings exist, and the picker says so.
   */
  const wings: WingAnswer[] = answers.wings ?? [];
  const ladder = useMemo(() => planClasses(wings).classes.map((c) => ({ name: c.className })), [JSON.stringify(wings)]);
  const set = (next: SubjectAnswer[]) => onChange({ subjects: next });

  /**
   * §32 — the tick boxes belong to ONE timetable, so the step has to say which.
   *
   * The same tab strip step 4 uses, and for the same reason: "which subjects
   * does the school teach" is one question, but "which of them does *this*
   * week run" is one question per wing. Without the strip the ticks would be
   * an answer with no subject — and the wizard's own scope switcher narrows
   * pools, not wings, so a grouped pool with three wings could not be
   * expressed at all.
   *
   * Clamped, because the list can shrink under a stored index (§30.9).
   */
  const [activeWing, setActiveWing] = useState(0);
  const wingIdx = wings.length === 0 ? 0 : Math.min(activeWing, wings.length - 1);
  const wingName: string | null = wings[wingIdx]?.name ?? null;

  const byWing: Record<string, string[]> = answers.subjectsByWing ?? {};
  /**
   * Which subjects this wing runs. Absent is **not stated**, which is all of
   * them (invariant 7) — `subjectsForWing` in `packages/shared` is that rule,
   * and the Lesson Grid reads it too so the two cannot disagree.
   */
  const teaches = (name: string) => {
    const stated = wingName ? byWing[wingName] : undefined;
    if (!Array.isArray(stated)) return true;
    return stated.some((n) => n.trim().toLowerCase() === name.trim().toLowerCase());
  };
  /**
   * Ticking writes the WHOLE list, never a delta.
   *
   * The stored value has to be a complete statement, because that is what the
   * commit turns into rows; a delta would need the "not stated" list expanded
   * somewhere else, which is a second place to get invariant 7 wrong.
   */
  const toggleTeaches = (name: string) => {
    if (!wingName) return;
    const named = rows.map((r) => r.name).filter((n) => n.trim());
    const now = named.filter((n) => teaches(n));
    const next = now.some((n) => n.trim().toLowerCase() === name.trim().toLowerCase())
      ? now.filter((n) => n.trim().toLowerCase() !== name.trim().toLowerCase())
      : [...now, name];
    // Unticking the last one would store `[]`, which reads back as "not
    // stated" and therefore as ALL of them — take one away and get everything
    // back is the one behaviour nobody would predict. §27.9 and §27.16 refuse
    // the same move for the same reason.
    if (next.length === 0) return;
    onChange({ subjectsByWing: { ...byWing, [wingName]: next } });
  };

  /**
   * The subjects that are already `subjects` rows, by lowercased name.
   *
   * What decides whether this screen may take one off the list at all. Read
   * from the server rather than derived from the draft, because a resumed or
   * adopted setup has subjects in its answers that were committed long ago and
   * a draft cannot tell you which. Empty on failure: nothing is then
   * removable, which is the safe direction to be wrong in.
   */
  const [committed, setCommitted] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    api<Array<{ name: string }>>("/subjects")
      .then((all) => { if (live) setCommitted(new Set(all.map((x) => x.name.trim().toLowerCase()))); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  const edit = (i: number, patch: Partial<SubjectAnswer>) =>
    set(subjects.map((s, n) => (n === i ? { ...s, ...patch } : s)));

  /** Which classes a row shows — everything until somebody removes one. */
  const chosenClasses = (s: SubjectAnswer) =>
    (s.classes ?? []).length === 0 ? ladder.map((c) => c.name) : (s.classes ?? []).filter((c) => ladder.some((x) => x.name === c));
  /**
   * §27.16 — removing the LAST class is refused, because `[]` is stored as
   * "not stated" and read back as every class (invariant 7). Taking one away
   * and getting all of them back is the one behaviour nobody would predict —
   * §27.9's teacher scope refuses it for exactly this reason.
   */
  const toggleClass = (i: number, name: string) => {
    const chosen = chosenClasses(rows[i]);
    const next = chosen.includes(name) ? chosen.filter((c) => c !== name) : [...chosen, name];
    if (next.length === 0) return;
    edit(i, { classes: next.length === ladder.length ? [] : ladder.filter((c) => next.includes(c.name)).map((c) => c.name) });
  };

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

      {wings.length > 1 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--steel)" }}>
            Teaching
          </span>
          {wings.map((w, i) => (
            <button key={w.name} onClick={() => setActiveWing(i)} className="btn"
              style={{
                padding: "5px 11px", fontSize: 12,
                background: i === wingIdx ? "var(--brand)" : "var(--paper)",
                color: i === wingIdx ? "#fff" : "var(--ink)",
                borderColor: i === wingIdx ? "var(--brand)" : "var(--line)",
              }}>{w.name}</button>
          ))}
        </div>
      )}

      <Scroll max={460}>
        <thead><tr>
          {/* §32 — does THIS timetable teach it. First column, because it is
              the question the row is answering before any of its settings
              matter. */}
          <th style={{ ...th, width: 40, textAlign: "center" }} title={wingName ? `Taught in ${wingName}` : "Taught"}>✓</th>
          <th style={{ ...th, width: "26%" }}>Subject</th>
          <th style={{ ...th, width: 74 }}>Code</th>
          {/* §26.2 — set from the subject's name as it is typed, and shown
              rather than hidden: a default nobody can see is a default nobody
              corrects. */}
          {/* §27.16 — which classes take this subject. Immediately after the
              name because it is the field with the widest reach: it decides
              where the Allocation step even offers the subject. */}
          <th style={{ ...th, width: 128 }} title="Which classes take this subject — blank means every class">Taught to</th>
          <th style={{ ...th, width: 118 }} title="Scholastic subjects are examined; co-scholastic ones are not">Category</th>
          <th style={{ ...th, width: 108 }} title="Higher is placed earlier in the day — a preference, not a rule">Priority</th>
          <th style={{ ...th, width: 150 }} title="Which side of lunch this may be taught">Placement</th>
          <th style={{ ...th, width: 62 }}>Lab</th>
          {/* §19.1 — WHETHER only. WHICH room is a fact about the room, and the
              Rooms step is where a room says which subjects it serves. */}
          <th style={{ ...th, width: 78 }}
            title="Always taught in its own room — a music room, a computer room — rather than the class's own">
            Own room
          </th>
          <th style={{ ...th, width: 74 }}>Double</th>
          <th style={{ ...th, width: 34 }} />
        </tr></thead>
        <tbody>
          {rows.map((s, i) => (
            <tr key={i} style={teaches(s.name) ? undefined : { opacity: 0.5 }}>
              {/*
                §32 — unticking takes the subject out of THIS timetable only.

                Not a deletion: the subject, its settings, its mappings and any
                other timetable that teaches it are untouched. What it removes
                is the demand — the snapshot stops loading this subject's
                curriculum rows for this config, so the Lesson Grid drops the
                column, generation places none of it, and Readiness stops
                counting its periods.

                Disabled with no wing to attach it to, rather than hidden: a
                control that appears only sometimes is one people stop looking
                for.
              */}
              <td style={{ ...td, textAlign: "center" }}>
                <input type="checkbox" checked={teaches(s.name)} disabled={!wingName || !s.name.trim()}
                  aria-label={wingName ? `${s.name || `Subject ${i + 1}`} is taught in ${wingName}` : "Taught"}
                  onChange={() => toggleTeaches(s.name)} />
              </td>
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
              <td style={td}>
                <ChipPicker
                  all={ladder}
                  chosen={chosenClasses(s)}
                  noun="class"
                  nounPlural="classes"
                  keepOrder
                  collapseAll
                  label={s.name?.trim() || `subject ${i + 1}`}
                  onToggle={(name) => toggleClass(i, name)}
                />
              </td>
              <td style={td}>
                <CategorySelect value={placementOf(s).category}
                  onChange={(category) => edit(i, { category })} />
              </td>
              <td style={td}>
                <PrioritySelect value={placementOf(s).priority}
                  onChange={(priority) => edit(i, { priority })} />
              </td>
              <td style={td}>
                <LunchRules value={placementOf(s)} onChange={(patch) => edit(i, patch)} />
              </td>
              <td style={{ ...td, textAlign: "center" }}>
                <input type="checkbox" checked={Boolean(s.isLab)} aria-label={`${s.name} needs a lab`}
                  onChange={(e) => edit(i, { isLab: e.target.checked })} />
              </td>
              <td style={{ ...td, textAlign: "center" }}>
                <input type="checkbox" checked={Boolean(s.taughtInOwnRoom)}
                  aria-label={`${s.name} is taught in its own room`}
                  onChange={(e) => edit(i, { taughtInOwnRoom: e.target.checked })} />
              </td>
              <td style={{ ...td, textAlign: "center" }}>
                <input type="checkbox" checked={Boolean(s.requiresDoublePeriod)}
                  aria-label={`${s.name} needs double periods`}
                  onChange={(e) => edit(i, { requiresDoublePeriod: e.target.checked })} />
              </td>
              <td style={{ ...td, textAlign: "right" }}>
                {/*
                  §32 — no ✕ once the subject is a `subjects` row.

                  It only ever removed the row from the DRAFT: the §16 importer
                  creates subjects and never deletes one, so the subject stayed
                  in the database, kept its mappings and its curriculum, and
                  went on being taught — while this screen stopped listing it.
                  Deselecting is the honest control, and it is the tick in the
                  first column. A row somebody has just typed is still theirs
                  to take back.
                */}
                {rows.length > 1 && !committed.has(s.name.trim().toLowerCase())
                  ? <LinkButton tone="danger" onClick={() => set(rows.filter((_, n) => n !== i))}>✕</LinkButton>
                  : null}
              </td>
            </tr>
          ))}
        </tbody>
      </Scroll>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
        <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={() => set([...rows, blankSubject()])}>+ Add a subject</button>
        <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
          {rows.filter((s) => s.name.trim()).length} subjects
          {wingName && (() => {
            const on = rows.filter((s) => s.name.trim() && teaches(s.name)).length;
            const off = rows.filter((s) => s.name.trim()).length - on;
            return off > 0 ? ` · ${on} taught in ${wingName}` : ` · all taught in ${wingName}`;
          })()}
          {" · Enter on the last row adds another"}
        </span>
      </div>

      <Note>
        The <strong>first column</strong> says whether {wingName ? <strong>{wingName}</strong> : "this timetable"} teaches
        the subject. Unticking removes it from that timetable only — from its Lesson Grid, from
        what gets generated and from what Readiness counts. The subject itself, its settings and
        every other timetable that teaches it are untouched, which is why a subject the school has
        already entered has no ✕: it is deselected here, and deleted on the Subjects master.
      </Note>

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
  /**
   * The classes on offer for one teacher — their wing's, or every class when
   * they are not pinned to one.
   *
   * In ladder order, which `planClasses` already gives: Pre-Nursery through
   * Class 12 sorted alphabetically puts "Class 10" before "Class 2", and a
   * class list in that order is one nobody can use.
   */
  const allClasses = useMemo(() => planClasses(wings).classes, [JSON.stringify(wings)]);
  const classesFor = (wing?: string) =>
    allClasses.filter((c) => !wing || c.wing === wing).map((c) => ({ name: c.className }));

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

  /**
   * §27.9 — every class ticked to begin with; removing is the interaction.
   *
   * A teacher takes their whole wing until somebody says otherwise, so that is
   * what the cell shows: all of them, and you take away the ones that do not
   * apply. Starting empty would have meant the same thing to the importer —
   * blank is "not stated", which falls back to the wing — but it says nothing
   * on screen, and "which classes does she take?" would have had a blank box
   * for an answer.
   *
   * The STORED value stays empty while nothing has been removed. That keeps
   * "not stated" meaning what invariant 7 says it means, keeps a draft from
   * carrying sixteen strings per teacher for no information, and — the part
   * that matters — means a teacher whose wing changes later follows the new
   * wing instead of silently keeping the old one's class list.
   */
  const chosenClasses = (t: TeacherAnswer) => {
    const mine = classesFor(t.wing).map((c) => c.name);
    const stored = (t.classes ?? []).filter((c) => mine.includes(c));
    return stored.length > 0 ? stored : mine;
  };

  const toggleClass = (i: number, name: string) => {
    const mine = classesFor(rows[i].wing).map((c) => c.name);
    const current = chosenClasses(rows[i]);
    const next = current.includes(name)
      ? current.filter((c) => c !== name)
      // Ladder order, not click order — a class list in click order is one
      // nobody can read.
      : mine.filter((c) => c === name || current.includes(c));
    /*
      Removing the last class would store `[]`, which means "all" — so a
      teacher would go from one class to every class by taking one away. Refused
      rather than reinterpreted: a cell that does the opposite of what the click
      said is worse than a click that does nothing.
    */
    if (next.length === 0) return;
    // All of them selected is stored as "not stated", so it keeps tracking the
    // wing rather than freezing today's class list into the draft.
    edit(i, { classes: next.length === mine.length ? [] : next });
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
          <th style={{ ...th, width: "20%" }}>Name</th>
          <th style={{ ...th, width: 74 }}>Code</th>
          <th style={{ ...th, width: 58 }}>Initials</th>
          {/*
            Wide enough for the longest subject name a school actually has.

            It was the flexible column, which sounds right and is not: every
            other column here takes a fixed width, so "flexible" meant "whatever
            is left", and what was left fitted "Computer" but not "Computer
            Science". A minimum, not a fixed width — a school of one-word
            subjects should not be made to look at 190px of white space, and the
            table still gives the column more when the window allows.
          */}
          <th style={{ ...th, width: "16%", minWidth: 190 }}>Teaches</th>
          {/* §27.9 — WHICH classes, not just which wing. The Allocation step
              staffs the curriculum from this, so a blank here is the difference
              between "give them anything in their wing" and "these four".
              Narrower since §27.16 summarised the cell into one chip. */}
          <th style={{ ...th, width: 128 }} title="Which classes they take — blank means any class in their wing">
            Classes
          </th>
          {wings.length > 1 && <th style={{ ...th, width: 110 }}>Wing</th>}
          <th style={{ ...th, width: 52 }} title="Most periods in one day">Max/day</th>
          <th style={{ ...th, width: 56 }} title="Most periods in a week">Max/week</th>
          <th style={{ ...th, width: 56 }} title="Longest run of back-to-back periods">In a row</th>
          <th style={{ ...th, width: 46 }} title="Available for substitutions">Sub</th>
          {/* §26.5 — collected here, checked later. The guided setup has no
              teacher rows yet, and evaluating at commit would be one model call
              per teacher — 122 for a real school, to answer a question nobody
              has asked. It arrives as "not checked yet". */}
          <th style={{ ...th, width: 180 }} title="Anything about when they can teach, in plain English">
            Special instruction
          </th>
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
                <ChipPicker
                  all={subjects}
                  chosen={t.subjects}
                  label={t.name?.trim() || `teacher ${i + 1}`}
                  onToggle={(name) => toggleSubject(i, name)}
                />
              </td>
              {/*
                §27.9 — the classes this teacher takes.

                Starts with all of them and you remove what does not apply.
                Offered from the teacher's OWN wing when they have one, so the
                two statements cannot contradict each other: a teacher pinned to
                Primary cannot be given Class 9 here and then have the commit
                decide which of the two answers it believes.
              */}
              <td style={td}>
                <ChipPicker
                  all={classesFor(t.wing)}
                  chosen={chosenClasses(t)}
                  noun="class"
                  nounPlural="classes"
                  keepOrder
                  collapseAll
                  label={t.name?.trim() || `teacher ${i + 1}`}
                  onToggle={(name) => toggleClass(i, name)}
                />
              </td>
              {wings.length > 1 && (
                <td style={td}>
                  <select style={{ ...cell, fontSize: 11.5 }} value={t.wing ?? ""}
                    aria-label={`Wing for ${t.name}`}
                    onChange={(e) => edit(i, {
                      wing: e.target.value,
                      // §27.9 — a narrowed class list belongs to the wing it was
                      // narrowed within. Carrying "Class 1, Class 2" into Senior
                      // would leave the screen showing every Senior class while
                      // the commit wrote two Primary ones.
                      classes: [],
                    })}>
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
              <td style={td}>
                {/* Collected, not evaluated (§26.5). It reaches the school as
                    "not checked yet"; the Teachers screen turns it into rules,
                    one deliberate press at a time. */}
                <input
                  style={{ ...cell, fontSize: 11.5 }}
                  value={t.specialInstruction ?? ""}
                  maxLength={600}
                  placeholder="e.g. leaves at 1pm on Fridays"
                  aria-label={`Special instruction for ${t.name || `teacher ${i + 1}`}`}
                  onChange={(e) => edit(i, { specialInstruction: e.target.value })}
                />
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
