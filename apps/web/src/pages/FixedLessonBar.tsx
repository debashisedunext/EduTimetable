/**
 * §36 — the toolbar for the cell being pinned.
 *
 * Three pickers and a remove, over the grid rather than in a popover: the
 * argument §31.15 made for the Lesson grid's cell bar holds here for the same
 * reason — a popup over a 27-pixel cell covers the neighbours you opened it to
 * compare, and somebody pinning a week works across a row.
 *
 * **It offers only what the server would accept.** `options` arrives already
 * filtered (no elective-owned subject, no §4.8 double-period row, no guest
 * teacher), and the subject list here is that list narrowed to the selected
 * section. Nothing is re-derived, so the picker cannot drift from the refusal.
 *
 * The count beside the subject is the one thing the client owns, because it is
 * about unsaved work: "3 of 6 fixed" has to include the pin just placed.
 */
import { useEffect, useState } from "react";
import type { Pin, PinOption } from "./fixed-lessons";

export function FixedLessonBar({
  label, cell, pin, options, rooms, capFor, whyEmpty, days, onRepeat, onChange, onClear,
}: {
  /** "Class 1-A · Monday P2" — what is being edited, said once. */
  label: string;
  cell: { classSectionId: number; dayOfWeek: number; periodNumber: number };
  pin: Pin | null;
  options: PinOption[];
  rooms: Array<{ id: number; name: string }>;
  capFor: (classSectionId: number, subjectId: number) => { used: number; cap: number };
  /** §36 — why there is nothing to offer, when there is nothing. */
  whyEmpty: string | null;
  /** §36.6 — the timetable's working days, for "every day". */
  days: number[];
  /** Fills this period on every working day, and says what it did. */
  onRepeat: () => string;
  onChange: (next: Pin) => void;
  onClear: () => void;
}) {
  /*
    One entry per subject, because the subject picker is a subject picker: a
    section may have two mappings for one subject (two teachers), and listing
    it twice would make the reader choose a teacher in the wrong control.
  */
  const subjects = [...new Map(options.map((o) => [o.subjectId, o])).values()]
    .sort((a, b) => a.subject.localeCompare(b.subject));
  const teachers = pin ? options.filter((o) => o.subjectId === pin.subjectId) : [];

  const box: React.CSSProperties = {
    font: "500 12px/1 Inter, sans-serif", color: "var(--ink)", background: "var(--paper)",
    border: "1px solid var(--line)", borderRadius: 7, padding: "6px 8px", maxWidth: 190,
  };
  const lbl: React.CSSProperties = {
    font: "700 9px/1 var(--font-mono, monospace)", letterSpacing: "0.1em",
    textTransform: "uppercase", color: "var(--steel)", display: "block", marginBottom: 3,
  };

  const pick = (subjectId: number) => {
    // The first mapped teacher for that subject, so one click produces a whole
    // pin. Choosing a subject and then being told to choose a teacher is two
    // decisions for a cell that usually has only one possible answer.
    const first = options.find((o) => o.subjectId === subjectId);
    if (!first) return;
    onChange({
      ...cell,
      subjectId,
      teacherId: pin && pin.subjectId === subjectId ? pin.teacherId : first.teacherId,
      roomId: pin?.roomId ?? null,
    });
  };

  const count = pin ? capFor(cell.classSectionId, pin.subjectId) : null;

  /*
    §36.6 — what "every day" just did, said where the button is.

    Cleared when the selection moves, for the reason §31.15's cell bar clears
    its refusal: a sentence about the last cell, still on screen beside a new
    one, reads as being about the new one.
  */
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setNote(null), [cell.classSectionId, cell.dayOfWeek, cell.periodNumber]);

  /*
    §36 — nothing to offer is a STATE, and it gets said rather than drawn as
    three dead controls.

    A pin attaches to a lesson somebody teaches, so a class with no curriculum
    or no staffing genuinely has nothing pinnable. That is correct — and shown
    as an empty dropdown it reads as a broken screen, which is the failure this
    codebase keeps writing down: a state nobody can tell from a bug is a state
    that was not communicated. The two causes name different screens, so they
    are told apart rather than folded into one vague sentence.
  */
  if (whyEmpty) {
    return (
      <div style={{
        display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
        padding: "9px 12px", borderRadius: 8,
        background: "var(--amber-bg)", border: "1px solid var(--amber)",
      }}>
        <span style={{
          font: "800 11.5px/1.6 Inter, sans-serif", padding: "3px 8px", borderRadius: 6,
          background: "var(--paper)", color: "var(--brand-dark)", whiteSpace: "nowrap",
        }}>{label}</span>
        <span style={{ font: "500 12.3px/1.5 Inter", color: "var(--ink)", maxWidth: "72ch" }}>
          {whyEmpty}
        </span>
      </div>
    );
  }

  return (
    <div style={{
      display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap",
      padding: "5px 9px", borderRadius: 8,
      background: "var(--offwhite)", border: "1px solid var(--line)",
    }}>
      <span style={{
        font: "800 11.5px/1.6 Inter, sans-serif", padding: "3px 8px", borderRadius: 6,
        background: "var(--steel-pale)", color: "var(--brand-dark)", whiteSpace: "nowrap",
        alignSelf: "center",
      }}>{label}</span>

      <label>
        <span style={lbl}>Subject</span>
        <select style={box} value={pin?.subjectId ?? ""}
          onChange={(e) => (e.target.value ? pick(Number(e.target.value)) : onClear())}>
          <option value="">— nothing fixed —</option>
          {subjects.map((o) => {
            const c = capFor(cell.classSectionId, o.subjectId);
            return (
              <option key={o.subjectId} value={o.subjectId}>
                {o.subject} — {c.used} of {c.cap} fixed
              </option>
            );
          })}
        </select>
      </label>

      <label>
        <span style={lbl}>Teacher</span>
        <select style={box} value={pin?.teacherId ?? ""} disabled={!pin}
          onChange={(e) => pin && onChange({ ...pin, teacherId: Number(e.target.value) })}>
          {!pin && <option value="">—</option>}
          {teachers.map((o) => (
            <option key={o.teacherId} value={o.teacherId}>
              {o.teacher}{o.initials ? ` (${o.initials})` : ""}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span style={lbl}>Room</span>
        {/*
          §19 — blank is "not stated", never "anywhere": the solver picks by its
          own ladder, which is what every unpinned lesson gets. Naming one binds.
        */}
        <select style={{ ...box, maxWidth: 150 }} value={pin?.roomId ?? ""} disabled={!pin}
          onChange={(e) => pin && onChange({ ...pin, roomId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Solver chooses</option>
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>

      {pin && count && count.used > count.cap && (
        <span style={{ font: "600 11px/1.4 Inter", color: "var(--signal)", alignSelf: "center", maxWidth: 210 }}>
          {count.used} fixed against {count.cap} taught a week — the save will refuse this.
        </span>
      )}

      {/*
        §36.6 — "this day" is what a click already does, so only the other
        answer needs a control. A segmented This day / Every day would have
        been a mode with a state to remember and a question about whether it
        is still on; a button is an action with a result, and the result is
        printed beside it.
      */}
      {pin && days.length > 1 && (
        <button onClick={() => setNote(onRepeat())} className="btn"
          style={{ alignSelf: "center", padding: "5px 9px", fontSize: 11.5, whiteSpace: "nowrap" }}
          title={`Fix ${subjects.find((o) => o.subjectId === pin.subjectId)?.subject ?? "this lesson"} at period ${cell.periodNumber} on every working day for this class-section. Existing pins are left alone, and it stops at the periods a week this class is taught.`}>
          ⟳ Every day
        </button>
      )}

      {pin && (
        <button onClick={onClear} className="btn"
          style={{ alignSelf: "center", padding: "5px 9px", fontSize: 11.5, color: "var(--signal)" }}
          title="Leave this cell to the solver">
          ✕ Unfix
        </button>
      )}

      {note && (
        <span style={{
          font: "500 11.5px/1.4 Inter", alignSelf: "center", maxWidth: 330,
          color: note.startsWith("Fixed") ? "var(--accent)" : "var(--amber)",
        }}>{note}</span>
      )}
    </div>
  );
}
