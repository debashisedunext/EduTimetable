/**
 * §24.6 Phase 25.5a — the third door: the same questions, in conversation.
 *
 * Two panels, and the split is the point. On the left, a conversation. On the
 * right, **what has actually been recorded** — because the failure mode of any
 * chat that fills a form is the user believing something was captured when it
 * was not. The panel is read from the server's own answer to every turn, not
 * from the assistant's prose, so it cannot agree with a claim the draft does not
 * support.
 *
 * It writes into the same `onboarding_sessions` row the wizard uses, so
 * "switch to the step-by-step wizard" is a button rather than a migration, and
 * pressing it loses nothing. At step 8 the conversation stops and hands over:
 * the curriculum is a matrix, the mapping a table and the settings three
 * toggles — things read at a glance and painful to hear dictated one cell at a
 * time.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { asMessage } from "../components";
import { CLASS_LADDER, type WingAnswer } from "@edutimetable/shared";

interface TurnResult {
  reply: string;
  nextQuestion: string;
  options?: string[];
  answers: Record<string, any>;
  step: number;
  done: boolean;
  rejected: string[];
}

interface Line {
  who: "you" | "assistant";
  text: string;
}

const HANDOVER_STEP = 8;

const OPENER =
  "Hello — I'll set your timetable up by asking a few questions, and you can answer in your own words. " +
  "Nothing is saved to the school until you review it at the end.\n\nWhat is the school called?";

export function OnboardingChat({ onSwitchToWizard, onClose }: {
  onSwitchToWizard: (step: number) => void;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<Line[]>([{ who: "assistant", text: OPENER }]);
  const [draft, setDraft] = useState("");
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Ready-made answers to the question on screen — tap instead of type.
   *
   * Cleared the moment anything is sent, so the chips can never belong to a
   * question that has already been answered. That is the failure worth
   * designing against: chips left over from "which working days?" under a
   * question about periods a day would look answerable and send nonsense.
   */
  const [options, setOptions] = useState<string[]>([]);
  const [typing, setTyping] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // Resume whatever is already there, whichever door filled it in — the two
  // paths share one draft, so arriving here after five wizard steps must show
  // those five, not an empty panel.
  useEffect(() => {
    api<{ answers?: Record<string, any>; currentStep?: number; empty?: boolean }>("/onboarding/session")
      .then((d) => {
        if (d.empty) return;
        setAnswers(d.answers ?? {});
        setStep(Math.max(1, d.currentStep ?? 1));
      })
      .catch(() => { /* an unreadable draft is not a reason to block a new one */ });
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [lines, busy]);

  /**
   * One turn. `text` comes either from the box or from a tapped option — and
   * they are deliberately the same path: a tapped option IS the answer, sent
   * as if typed, so it is recorded, confirmed and moved past exactly like one.
   * Anything else would be a second way for an answer to reach the draft.
   */
  const send = async (text?: string) => {
    const message = (text ?? draft).trim();
    if (!message || busy) return;
    setDraft("");
    setOptions([]);
    setTyping(false);
    setLines((l) => [...l, { who: "you", text: message }]);
    setBusy(true);
    setError(null);
    try {
      const r = await api<TurnResult>("/onboarding/interview", {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      setAnswers(r.answers ?? {});
      setStep(r.step);
      // The reply, then the question — a turn that recorded something but asked
      // nothing would otherwise leave the conversation with no way forward.
      const said = [r.reply?.trim(), r.nextQuestion?.trim()].filter(Boolean).join("\n\n");
      setLines((l) => [...l, { who: "assistant", text: said || "Recorded." }]);
      setOptions(r.options ?? []);
    } catch (e) {
      setError(asMessage(e));
      // Put the message back rather than swallowing it: retyping a paragraph
      // because a request failed is the fastest way to lose somebody.
      setDraft(message);
      setLines((l) => l.slice(0, -1));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Set up by conversation"
      style={{
        position: "fixed", inset: 0, zIndex: 200, background: "var(--offwhite)",
        display: "flex", flexDirection: "column",
      }}>
      <header style={{
        padding: "14px 22px", borderBottom: "1px solid var(--line)", background: "var(--paper)",
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      }}>
        <span style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 18 }}>
          ✦ Setting up by conversation
        </span>
        <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>
          Step {Math.min(step, HANDOVER_STEP)} of {HANDOVER_STEP} · nothing is written yet
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn" style={{ fontSize: 12 }} onClick={() => onSwitchToWizard(step)}>
          Switch to the step-by-step wizard
        </button>
        <button className="btn" style={{ fontSize: 12 }} onClick={onClose}>Save &amp; close</button>
      </header>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* ── the conversation */}
        <div style={{ flex: "1 1 60%", display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px" }}>
            <div style={{ maxWidth: 680, margin: "0 auto", display: "grid", gap: 14 }}>
              {lines.map((l, i) => (
                <div key={i} style={{
                  justifySelf: l.who === "you" ? "end" : "start", maxWidth: "84%",
                  background: l.who === "you" ? "var(--brand)" : "var(--paper)",
                  color: l.who === "you" ? "#fff" : "var(--ink)",
                  border: l.who === "you" ? "none" : "1px solid var(--line)",
                  borderRadius: 12, padding: "11px 14px", fontSize: 13.5, lineHeight: 1.55,
                  whiteSpace: "pre-wrap",
                }}>{l.text}</div>
              ))}
              {busy && (
                <div style={{ fontSize: 12.5, color: "var(--ink-faint)", fontStyle: "italic" }}>
                  thinking…
                </div>
              )}
              {!busy && options.length > 0 && (
                <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 2 }}>
                  {options.map((o) => (
                    <button key={o} onClick={() => void send(o)} style={{
                      font: "500 12.8px/1.3 Inter", padding: "8px 13px", borderRadius: 20,
                      border: "1px solid var(--brand)", background: "var(--paper)",
                      color: "var(--brand)", cursor: "pointer",
                    }}>{o}</button>
                  ))}
                  {/* Always last, and always present. A list of options a school
                      does not fit is a dead end, and the questions where that
                      happens are the ones the model is told not to guess at. */}
                  <button onClick={() => { setTyping(true); boxRef.current?.focus(); }}
                    style={{
                      font: "500 12.8px/1.3 Inter", padding: "8px 13px", borderRadius: 20,
                      border: "1px dashed var(--line)", background: "var(--paper)",
                      color: "var(--ink-faint)", cursor: "pointer",
                    }}>
                    Something else…
                  </button>
                </div>
              )}
              {error && (
                <div style={{
                  borderLeft: "3px solid var(--signal)", background: "var(--signal-bg)",
                  padding: "11px 13px", borderRadius: "0 8px 8px 0", fontSize: 12.5, color: "var(--ink-soft)",
                }}>{error}</div>
              )}
              <div ref={endRef} />
            </div>
          </div>

          <div style={{ borderTop: "1px solid var(--line)", background: "var(--paper)", padding: "12px 22px" }}>
            <div style={{ maxWidth: 680, margin: "0 auto", display: "flex", gap: 9, alignItems: "flex-end" }}>
              <textarea
                ref={boxRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends, Shift+Enter breaks the line — a school's answer
                  // is usually one line, and a list of teachers is not.
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
                }}
                rows={2}
                placeholder={options.length > 0 && !typing
                  ? "…or type your own answer"
                  : "Answer in your own words…"}
                aria-label="Your answer"
                style={{
                  flex: 1, resize: "none", padding: "10px 12px", border: "1px solid var(--line)",
                  borderRadius: 10, fontSize: 13.5, fontFamily: "inherit", background: "var(--paper)",
                }} />
              <button className="btn btn-primary" onClick={() => void send()} disabled={busy || !draft.trim()}>
                {busy ? "…" : "Send"}
              </button>
            </div>
          </div>
        </div>

        {/* ── what has actually been recorded */}
        <aside style={{
          flex: "0 0 320px", borderLeft: "1px solid var(--line)", background: "var(--paper)",
          overflowY: "auto", padding: "18px 20px",
        }}>
          <h3 style={{
            font: "600 11px/1 Inter", textTransform: "uppercase", letterSpacing: "0.09em",
            color: "var(--steel)", margin: "0 0 12px",
          }}>Collected so far</h3>
          <Collected answers={answers} />

          {step >= HANDOVER_STEP && (
            <div style={{
              marginTop: 18, borderLeft: "3px solid var(--accent)", background: "var(--accent-bg)",
              padding: "12px 13px", borderRadius: "0 9px 9px 0",
            }}>
              <strong style={{ fontSize: 13, display: "block", marginBottom: 4 }}>
                That's everything I need to ask.
              </strong>
              <span style={{ fontSize: 12.3, color: "var(--ink-soft)" }}>
                Rooms, the curriculum and who teaches what are worked out from this — you review and
                correct them on the next screens rather than dictating them.
              </span>
              <button className="btn btn-primary" style={{ marginTop: 11, width: "100%", fontSize: 12.5 }}
                onClick={() => onSwitchToWizard(HANDOVER_STEP)}>
                Review the rest →
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/** The draft, rendered as facts rather than JSON — it is read by an administrator. */
function Collected({ answers }: { answers: Record<string, any> }) {
  const wings: WingAnswer[] = answers.wings ?? [];
  const weeks: Record<string, any> = answers.weeks ?? {};
  const subjects: Array<{ name: string; isLab?: boolean }> = answers.subjects ?? [];
  const teachers: Array<{ name: string; wing?: string }> = answers.teachers ?? [];

  const rows: Array<[string, React.ReactNode]> = [];
  if (answers.school?.name) rows.push(["School", answers.school.name]);
  if (answers.session?.name) {
    rows.push(["Session", `${answers.session.name} · ${answers.session.startDate} → ${answers.session.endDate}`]);
  }
  for (const w of wings) {
    const week = weeks[w.name];
    rows.push([
      w.name,
      <>
        {CLASS_LADDER[w.fromIndex]} – {CLASS_LADDER[w.toIndex]}, {w.sections} section
        {w.sections === 1 ? "" : "s"} each
        {week && (
          <div style={{ color: "var(--ink-faint)", marginTop: 2 }}>
            {week.workingDays.length} days × {week.periodsPerDay} periods ={" "}
            <strong>{week.workingDays.length * week.periodsPerDay} a week</strong>
          </div>
        )}
      </>,
    ]);
  }
  if (subjects.length > 0) {
    rows.push([
      `Subjects (${subjects.length})`,
      subjects.map((s) => s.name + (s.isLab ? " (lab)" : "")).join(", "),
    ]);
  }
  if (teachers.length > 0) {
    rows.push([`Teachers (${teachers.length})`, teachers.slice(0, 12).map((t) => t.name).join(", ") + (teachers.length > 12 ? ", …" : "")]);
  }

  if (rows.length === 0) {
    return (
      <p style={{ fontSize: 12.5, color: "var(--ink-faint)", margin: 0 }}>
        Nothing yet. Everything you confirm appears here, so you can see exactly what has been taken
        down — and what has not.
      </p>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {rows.map(([label, value], i) => (
        <div key={i}>
          <div style={{
            font: "600 10px/1.3 Inter", textTransform: "uppercase", letterSpacing: "0.07em",
            color: "var(--steel)", marginBottom: 3,
          }}>{label}</div>
          <div style={{ fontSize: 12.6, color: "var(--ink)", lineHeight: 1.5 }}>{value}</div>
        </div>
      ))}
    </div>
  );
}
