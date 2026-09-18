/**
 * §15.3 Phase 25.2 — the three doors.
 *
 * Opens by itself while the school has no timetable at all — the real
 * definition of "new" — once per sitting, and afterwards lives behind a
 * permanent button. Both halves matter: a school that has not built a timetable
 * should be met at the door every time it signs in, and a modal in front of the
 * app on the three-hundredth sign-in of a school that HAS one is a thing people
 * learn to dismiss without reading, which would waste the one screen that gets
 * to explain the choice.
 *
 * **Each door says what it is best for and roughly how long it takes.** Three
 * equal options is a decision handed back to somebody with no basis to make it;
 * that information is what actually lets them choose. The middle door is
 * recommended because it is right for most schools, and saying so is more
 * useful than pretending they are equivalent.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

export interface OnboardingState {
  isNew: boolean;
  hasConfig: boolean;
  hasClasses: boolean;
  hasPublished: boolean;
  dismissedAt: string | null;
  resumeStep: number | null;
  resumeMode: "wizard" | "ai" | null;
  shouldPrompt: boolean;
  /**
   * §39.1 — the timetables that are genuinely unfinished, and what each wants
   * next. Empty for a school whose every timetable is complete.
   */
  unfinished?: Array<{ id: number; name: string; pct: number; nextLabel: string | null }>;
}

// §8.2 — TWO doors, not three. The manual one led to a nine-step wizard whose
// five master steps are now the Masters screen and whose curriculum and mapping
// steps are the Allocation grid; offering it as a third way to set a school up
// was offering a third writer over the same rows.
const DOORS = [
  {
    key: "guided" as const,
    icon: "⚡",
    title: "Guided setup",
    body:
      "Eleven short steps in this window. Pick your classes on a slider, and the system proposes " +
      "rooms, curriculum and teacher mappings for you to correct rather than type.",
    best: "Best for a standard school · ~15–25 min",
    to: null,
    recommended: true,
  },
  {
    key: "ai" as const,
    icon: "✦",
    title: "Describe it to the assistant",
    body:
      "Answer the same questions in plain English and the assistant fills the form as you talk. " +
      "You review everything on one screen before a single row is saved.",
    best: "Best if you'd rather talk than type · ~10–20 min",
    to: null,
  },
];


/**
 * §39.1 — one sentence about what is left, built rather than ternaried.
 *
 * The first draft of this was a chain of inline conditionals with a
 * `many ? "is" : "is"` in it — both branches identical, which is what a
 * sentence assembled inside JSX tends to become. Written out, each case is
 * readable and the plurals are obviously right.
 */
function resumeLede(rows: Array<{ name: string; nextLabel: string | null }>): string {
  const [first, ...rest] = rows;
  const what = first.nextLabel
    ? ` — ${first.nextLabel.toLowerCase()} is the next thing it needs`
    : "";
  if (rest.length === 0) {
    return `${first.name} is not finished${what}. Everything you have already answered is saved.`;
  }
  const others = rest.length === 1 ? "1 other timetable" : `${rest.length} other timetables`;
  return `${first.name}${what}, and ${others} still unfinished. `
    + "Everything you have already answered is saved.";
}
export function WelcomeModal({
  state,
  userName,
  schoolName,
  onClose,
  onStartGuided,
  onStartChat,
}: {
  state: OnboardingState;
  userName: string;
  schoolName: string;
  onClose: () => void;
  onStartGuided: () => void;
  onStartChat: () => void;
}) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  /*
    §39.1 — resuming is about UNFINISHED WORK, not about a saved cursor.

    It was `resumeStep > 1`: the existence of a draft row whose step number
    happened to be past the first. `completed_at` is only written by pressing
    "Finish setup", so a school that published from the Generate screen kept a
    draft for ever and was met with "Pick up where you left off — step 3" over
    a finished, published timetable. `unfinished` is the §24.9 milestones, which
    can only move when something is really created.

    The `?? []` is for a client that outlives a server without the field. Absent
    reads as "nothing unfinished", so the dialog goes quiet rather than falling
    back to the cursor it is replacing.
  */
  const unfinished = state.unfinished ?? [];
  const resuming = unfinished.length > 0;
  /* The one it will open on — the same ordering the server sent. */
  const next = unfinished[0] ?? null;
  const many = unfinished.length > 1;

  const later = async () => {
    setBusy(true);
    // "Later" means later, not never: it closes this sitting's offer, and the
    // next sign-in asks again while the school still has no timetable (§24.1a).
    // The server call records the decline against this user — a colleague who
    // has never been offered it still is.
    try { await api("/me/onboarding/dismiss", { method: "POST" }); } catch { /* non-fatal */ }
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Set up your timetable"
      style={{
        position: "fixed", inset: 0, zIndex: 200, background: "rgba(11,31,68,.45)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
    >
      <div style={{
        background: "var(--paper)", borderRadius: 14, maxWidth: 840, width: "100%",
        maxHeight: "calc(100vh - 40px)", overflowY: "auto",
        boxShadow: "0 24px 64px rgba(11,31,68,.3)", border: "1px solid var(--line)",
      }}>
        <div style={{ padding: "24px 28px 18px", borderBottom: "1px solid var(--line)" }}>
          <div style={{
            font: "600 11px/1 Inter", textTransform: "uppercase", letterSpacing: "0.11em",
            color: "var(--steel)",
          }}>Welcome, {userName}</div>
          <h2 style={{
            fontFamily: "Fraunces, Georgia, serif", fontSize: 26, margin: "6px 0 0", fontWeight: 600,
          }}>
            {resuming ? "Pick up where you left off" : "Let's build your first timetable"}
          </h2>
          <p style={{ fontSize: 14, color: "var(--ink-soft)", margin: "8px 0 0" }}>
            {/*
              §39.1 — the TIMETABLE that needs work, never a step number.

              "You were on step 3 of 11" answers "where was I?", which nobody is
              asking, and the old sentence went on to claim "nothing has been
              written yet" — false on any school past step 2, since the wizard
              commits on every Next.
            */}
            {resuming
              ? resumeLede(unfinished)
              : `${schoolName} has no timetable yet. Choose how you'd like to put the information in — you can switch between these at any point, and nothing is written until you confirm.`}
          </p>
        </div>

        <div style={{ padding: "22px 28px" }}>
          {resuming && (
            <button
              onClick={onStartGuided}
              style={{
                width: "100%", textAlign: "left", marginBottom: 16, cursor: "pointer", font: "inherit",
                border: "1.5px solid var(--brand)", borderRadius: 12, padding: 18,
                background: "var(--steel-pale)",
              }}
            >
              <div style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 16.5, fontWeight: 600 }}>
                ↻ Carry on with {next?.name}
              </div>
              <div style={{ fontSize: 12.8, color: "var(--ink-soft)", marginTop: 4 }}>
                {next?.nextLabel
                  ? `${next.nextLabel} is the next thing it needs — ${next.pct}% done.`
                  : `${next?.pct}% done.`}
                {many && ` ${unfinished.length - 1} other timetable${unfinished.length > 2 ? "s" : ""} also unfinished.`}
              </div>
            </button>
          )}

          <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit,minmax(228px,1fr))" }}>
            {DOORS.map((d) => (
              <button
                key={d.key}
                disabled={busy}
                onClick={() => (d.to ? nav(d.to) : d.key === "ai" ? onStartChat() : onStartGuided())}
                style={{
                  position: "relative", textAlign: "left", font: "inherit",
                  border: `1.5px solid ${d.recommended && !resuming ? "var(--brand)" : "var(--line)"}`,
                  borderRadius: 12, padding: 18, background: "var(--paper)",
                  cursor: "pointer",
                  display: "flex", flexDirection: "column", gap: 8,
                  boxShadow: d.recommended && !resuming ? "0 0 0 3px var(--steel-pale)" : "none",
                }}
              >
                {d.recommended && !resuming && (
                  <span style={{
                    position: "absolute", top: -9, right: 12, background: "var(--brand)", color: "#fff",
                    font: "600 10px/1 Inter", letterSpacing: "0.05em", textTransform: "uppercase",
                    padding: "4px 8px", borderRadius: 5,
                  }}>Recommended</span>
                )}
                <span style={{ fontSize: 22, lineHeight: 1 }}>{d.icon}</span>
                <h3 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 16.5, margin: 0 }}>
                  {d.title}
                </h3>
                <p style={{ fontSize: 12.8, color: "var(--ink-soft)", margin: 0, lineHeight: 1.5 }}>
                  {d.body}
                </p>
                <span style={{
                  fontSize: 11.5, color: "var(--ink-faint)", marginTop: "auto",
                  paddingTop: 8, borderTop: "1px dashed var(--line)",
                }}>
                  {d.best}
                </span>
              </button>
            ))}
          </div>

          <div style={{
            borderLeft: "3px solid var(--accent)", background: "var(--accent-bg)",
            padding: "11px 13px", borderRadius: "0 8px 8px 0", fontSize: 13, marginTop: 16,
            color: "var(--ink-soft)",
          }}>
            <strong>Already have this in a spreadsheet?</strong> Skip all three and{" "}
            <a href="/import" onClick={(e) => { e.preventDefault(); nav("/import"); }}>
              import every master from one Excel file
            </a>{" "}
            — the same validator checks it either way.
          </div>
        </div>

        <div style={{
          padding: "14px 28px", borderTop: "1px solid var(--line)", background: "var(--offwhite)",
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <button className="btn" onClick={later} disabled={busy}
            style={{ border: "none", background: "none", color: "var(--ink-soft)" }}>
            I'll do this later
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={onStartGuided} disabled={busy}>
            {resuming ? `Carry on with ${next?.name} →` : "Start guided setup →"}
          </button>
        </div>
      </div>
    </div>
  );
}
