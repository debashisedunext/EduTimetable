/**
 * §26.5 — a teacher's instruction in plain English, and what became of it.
 *
 * One control, used by the manual teacher form and the guided Teachers grid,
 * because those are two doors onto the same column.
 *
 * What it shows is the point. Not "saved" — **what the sentence compiled to**,
 * read back in words, or why it could not be applied. A green tick that meant
 * "the AI understood" would be worth nothing; this one means *this became
 * constraint X, and constraint X is enforced whether the assistant is switched
 * on or not*, and the read-back is how somebody checks that rather than
 * believing it.
 *
 * It renders nothing at all when the school has no AI provider configured. A
 * box that silently never evaluates is worse than no box: it invites a school
 * to write rules that will never be applied.
 */
import { useEffect, useState } from "react";
import { api } from "../api";
import { asMessage } from "../components";

export interface InstructionState {
  specialInstruction?: string | null;
  instructionStatus?: "pending" | "accepted" | "denied" | null;
  instructionNote?: string | null;
}

/** Asked once per screen: does this school have an assistant at all? */
export function useInstructionsAvailable(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    api<{ available: boolean }>("/teachers/instruction/available")
      .then((r) => { if (live) setOn(Boolean(r.available)); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  return on;
}

export function statusChip(status: InstructionState["instructionStatus"]) {
  if (status === "accepted") return { text: "✓ applied", color: "var(--accent)", bg: "var(--accent-bg)" };
  if (status === "denied") return { text: "✕ not applied", color: "var(--signal)", bg: "var(--signal-bg)" };
  if (status === "pending") return { text: "… not checked", color: "var(--amber)", bg: "var(--amber-bg)" };
  return null;
}

export function TeacherInstruction({
  teacherId,
  value,
  onSaved,
  compact = false,
}: {
  /** Null while a teacher is being created — the box says so rather than lying. */
  teacherId: number | null;
  value: InstructionState;
  onSaved: (next: InstructionState) => void;
  /** Grid mode: a narrow cell that expands, rather than a block in a form. */
  compact?: boolean;
}) {
  const [text, setText] = useState(value.specialInstruction ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(!compact);

  useEffect(() => { setText(value.specialInstruction ?? ""); }, [value.specialInstruction]);

  const chip = statusChip(value.instructionStatus);
  // Edited since it was checked: the verdict on screen belongs to different
  // words, and showing it against these would be a tick for a sentence nobody
  // evaluated.
  const stale = text.trim() !== (value.specialInstruction ?? "").trim();

  const check = async () => {
    if (teacherId === null) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api<InstructionState>(`/teachers/${teacherId}/instruction`, {
        method: "PUT",
        body: JSON.stringify({ text }),
      });
      onSaved(next);
    } catch (e) {
      setError(asMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (compact && !open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title={value.instructionNote ?? value.specialInstruction ?? "Add a special instruction"}
        style={{
          font: "500 10.5px/1 Inter", padding: "4px 8px", borderRadius: 20, cursor: "pointer",
          border: `1px ${chip ? "solid" : "dashed"} ${chip?.color ?? "var(--line)"}`,
          background: chip?.bg ?? "var(--paper)", color: chip?.color ?? "var(--ink-faint)",
          maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}
      >
        {chip ? chip.text : "＋ instruction"}
      </button>
    );
  }

  return (
    <div style={compact ? { minWidth: 250 } : { marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
      <label style={{
        display: "block", font: "600 11px/1.4 Inter", textTransform: "uppercase",
        letterSpacing: "0.06em", color: "var(--steel)", marginBottom: 5,
      }}>
        Special instruction
      </label>
      <p style={{ fontSize: 11.5, color: "var(--ink-faint)", margin: "0 0 7px", lineHeight: 1.5 }}>
        Anything about <em>when</em> they can teach, or <em>which classes</em> — in your own words.
        It is turned into the same rules the availability screen sets, or refused with a reason.
      </p>
      <textarea
        value={text}
        rows={compact ? 3 : 2}
        maxLength={600}
        placeholder="e.g. Leaves at 1pm on Fridays. Never two practicals back to back."
        onChange={(e) => setText(e.target.value)}
        style={{
          width: "100%", padding: "8px 11px", border: "1px solid var(--line)", borderRadius: 8,
          fontSize: 13, fontFamily: "inherit", background: "var(--paper)", color: "var(--ink)",
          resize: "vertical",
        }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 8, flexWrap: "wrap" }}>
        <button
          className="btn btn-primary"
          style={{ padding: "5px 12px", fontSize: 12.5 }}
          disabled={busy || teacherId === null || (!stale && value.instructionStatus === "accepted")}
          onClick={() => void check()}
        >
          {busy ? "Checking…" : stale || !chip ? "Check & apply" : "Re-check"}
        </button>
        {teacherId === null && (
          <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
            Save the teacher first — an instruction is about somebody who exists.
          </span>
        )}
        {chip && !stale && (
          <span className="badge" style={{ background: chip.bg, color: chip.color }}>{chip.text}</span>
        )}
        {stale && chip && (
          <span style={{ fontSize: 11.5, color: "var(--amber)" }}>
            edited — the note below is about the previous wording
          </span>
        )}
        {compact && (
          <button className="btn btn-secondary" style={{ padding: "5px 10px", fontSize: 12 }}
            onClick={() => setOpen(false)}>Close</button>
        )}
      </div>

      {error && (
        <div style={{ fontSize: 12, color: "var(--signal)", marginTop: 7 }}>{error}</div>
      )}

      {/*
        The read-back. This is what makes the tick checkable: an accepted
        instruction says exactly which rules it became, in the same words the
        availability screen would use, so a school can see that "leaves at 1pm"
        was read as the right two periods rather than the wrong ones.
      */}
      {value.instructionNote && (
        <div style={{
          marginTop: 8, padding: "8px 11px", borderRadius: 8, fontSize: 12.3, lineHeight: 1.5,
          borderLeft: `3px solid ${chip?.color ?? "var(--line)"}`,
          background: chip?.bg ?? "var(--offwhite)",
          color: "var(--ink-soft)",
        }}>
          <strong style={{ color: chip?.color }}>
            {value.instructionStatus === "accepted" ? "Applied as: " : "Not applied. "}
          </strong>
          {value.instructionNote}
        </div>
      )}
    </div>
  );
}
