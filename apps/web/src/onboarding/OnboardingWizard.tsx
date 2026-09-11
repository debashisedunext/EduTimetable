/**
 * §15.3 Phase 25.2 — the guided setup's shell.
 *
 * Eleven steps, of which two are built here; 25.3 and 25.4 fill the rest into
 * the same frame. What this file owns is the frame itself, and three properties
 * that are easy to get wrong and expensive to retrofit:
 *
 *  - **Every Next saves to the server.** Not localStorage: a school is set up
 *    from whichever machine is to hand, and losing twenty minutes because
 *    somebody finished on a different one is the same failure as losing it to a
 *    refresh.
 *  - **A step saves only its own answers.** The service merges rather than
 *    replaces, so going Back and forward again cannot blank a later step.
 *  - **Nothing here writes a master row.** Answers accumulate; the actual
 *    classes, rooms and teachers are created at the end through the endpoints
 *    that already exist. That is what lets an abandoned wizard leave no trace.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { asMessage } from "../components";
import { commitWeeks, commitWings, defaultWeek, StepClasses, StepWeek, StepWings } from "./steps/Structure";
import { StepSubjects, StepTeachers } from "./steps/People";
import { defaultSettings, StepRooms, StepSettings } from "./steps/Syllabus";
import {
  GROUPED_SCOPE, planClasses, wingScope,
  type SubjectAnswer, type TeacherAnswer, type WingAnswer,
} from "@edutimetable/shared";
import { celebrate, setSoundEnabled, soundEnabled } from "./celebrate";
import { DraftTerms, termProblems } from "../terms/TermsEditor";

/**
 * §28 — ten steps, not eleven. Curriculum and Mapping merged into Allocation.
 *
 * The server owns the same number and the migration of stored step numbers
 * (`onboarding.service.ts`), because a resumed draft is read there.
 */
export const TOTAL_STEPS = 10;

/**
 * §31.13 — the steps this wizard SHOWS, in order.
 *
 * Step 9 (Allocation) is deliberately absent. Curriculum and mappings moved to
 * the Master Grid's Lesson Grid, which is the one place they are entered now —
 * so Rooms is followed by Settings, and Settings offers the door across.
 *
 * The **numbers do not change**, and that is the point of a list rather than a
 * smaller `TOTAL_STEPS`. `POST /onboarding/commit/:step`, the stored
 * `current_step`, `migrateStep` on the server and `ALLOCATION_STEP` in
 * `commit-allocation.ts` all mean what they have always meant; only which of
 * them the wizard walks through has changed. Renumbering would have been a
 * second migration of everybody's stored step for a change to a menu.
 */
export const WIZARD_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 10] as const;

/** Where a step sits in the visible sequence, or -1 for one that is not shown. */
export const stepIndex = (n: number): number => WIZARD_STEPS.indexOf(n as never);

/**
 * The nearest step this wizard will actually show.
 *
 * A draft saved mid-setup can name step 9, and there is no longer anywhere to
 * put somebody who resumes there — so they land on Settings, which is what
 * came after it. Everything else is returned untouched.
 */
export const visibleStep = (n: number): number => {
  const clamped = Math.min(TOTAL_STEPS, Math.max(1, n));
  return stepIndex(clamped) >= 0 ? clamped : TOTAL_STEPS;
};

/** The next step forward, or the same one at the end. */
export const stepAfter = (n: number): number =>
  WIZARD_STEPS[Math.min(WIZARD_STEPS.length - 1, stepIndex(visibleStep(n)) + 1)];

/** The previous step, or the same one at the start. */
export const stepBefore = (n: number): number =>
  WIZARD_STEPS[Math.max(0, stepIndex(visibleStep(n)) - 1)];

/**
 * What to say after a step lands.
 *
 * Three parts, and each is doing a job:
 *
 *  1. **The cheer.** Chosen by step number rather than at random — a message
 *     that re-renders is a message that would change its adjective mid-read.
 *  2. **What actually happened**, with the real count. "Wow!" on its own is
 *     noise by the third step; "8 subjects on the list" is the thing somebody
 *     would otherwise scroll back to check, and the numbers come from the §16
 *     importer's own tally so they cannot drift from what the database got.
 *  3. **How much is left**, because that is the question anybody eleven steps
 *     into a form is actually asking.
 */
const CHEERS = [
  "Wow!", "Superb!", "Fantastic!", "Brilliant!", "Excellent!",
  "Lovely!", "Terrific!", "Wonderful!", "Great going!", "Marvellous!", "Outstanding!",
];

/** "5 steps to go" — and something better than "0 steps to go" at the end. */
function remaining(step: number): string {
  const left = WIZARD_STEPS.length - 1 - stepIndex(visibleStep(step));
  if (left <= 0) return "that was the last one";
  if (left === 1) return "just one step to go";
  return `only ${left} steps to go`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function wellDone(step: number, created: Record<string, number> | undefined): string {
  const n = (k: string) => created?.[k] ?? 0;

  /**
   * Zero created is not a failure — it is the wizard being idempotent.
   *
   * Every step can be re-run: pressing Next twice, coming back, or resuming a
   * draft commits the same rows and the §16 importer skips the ones already
   * there. So a count of zero means "these already exist", and saying
   * "0 subjects created" about a school that has eight of them would be both
   * wrong and deflating.
   */
  const did = (count: number, made: string, already: string) => (count > 0 ? made : already);

  /**
   * A whole clause per case, not a fragment slotted into a fixed frame.
   *
   * The first version pushed every case through "You have just ___", which fits
   * "created 8 subjects" and produces "You have just your wings are ready" for
   * everything else. Printing all thirty variants — real counts, re-runs, and
   * the singular of each — was what showed it; reading the code did not.
   */
  const clause = (() => {
    switch (step) {
      // No em dash of its own: the tail adds one, and two in a row reads badly.
      case 1: return "Your school has a name";
      case 2: return "Your academic session is set up";
      case 3: return did(n("configs"), `You have just created ${plural(n("configs"), "wing")}`, "Your wings are ready");
      case 4: return did(
        n("classSections"),
        `You have just created ${plural(n("classes"), "class", "classes")} and ${plural(n("classSections"), "section")}`,
        "Your classes and sections are in",
      );
      case 5: return "Your weekly structure is in place";
      case 6: return did(n("subjects"), `You have just created ${plural(n("subjects"), "subject")}`, "Your subjects are in");
      case 7: return did(n("teachers"), `You have just added ${plural(n("teachers"), "teacher")}`, "Your teachers are in");
      case 8: return did(n("rooms"), `You have just created ${plural(n("rooms"), "room")}`, "Your rooms are ready");
      // §31.13 — no case 9. The wizard does not commit the allocation any
      // more, so there is nothing here to cheer; the Master Grid's Lesson Grid
      // is where that happens and it reports its own save.
      default: return "Your school is set up";
    }
  })();

  return `${CHEERS[(step - 1) % CHEERS.length]} ${clause} — ${remaining(step)}.`;
}

export const STEP_TITLES = [
  "School", "Session", "Wings", "Classes", "Timetable", "Subjects",
  "Teachers", "Rooms", "Allocation", "Settings",
];

/**
 * The steps whose content is a table or a grid, and so uses the full width of
 * the pane (§24.5d).
 *
 * Classes (the per-class section grid), Subjects, Teachers and Rooms are the
 * widest things left here now that §31.13 has moved Allocation out; the other
 * five are ordinary forms, which a measure makes easier to read rather than
 * harder. A set of step numbers rather than a guess inside each screen, so the
 * two kinds are visible side by side and a new step has to choose.
 *
 * **Subjects (6) belongs here and was missing.** Its table is ten columns wide
 * — name, code, the classes chip, category, priority, placement, three flags
 * and the row control — and an 880px measure squeezed every one of them: the
 * category read "Schola", the code "CHEM" was clipped to "CHEN", and the page
 * carried several hundred pixels of empty gutter on each side while doing it.
 * A measure is for prose. This is a spreadsheet.
 */
const WIDE_STEPS = new Set([4, 6, 7, 8]);

/**
 * The steps that want the pane's HEIGHT, not only its width (§28).
 *
 * Empty since §31.13 took Allocation out — it was the only one, because it is a
 * grid that scrolls inside itself with its load line and footer pinned, and
 * that only works when the step is handed a fixed height rather than growing
 * the dialog's own scroller. The mechanism stays because the requirement is
 * about a KIND of step rather than about that one, and the next grid to arrive
 * here would otherwise rediscover the second-scrollbar bug from scratch.
 */
const TALL_STEPS = new Set<number>();

/** What a §16 commit reports back. */
interface Committed { created?: Record<string, number> }

export interface Draft {
  id?: number;
  mode?: string;
  currentStep: number;
  answers: Record<string, any>;
}

export interface SchoolIdentity {
  id: number;
  name: string;
  shortName: string | null;
  code: string;
  origin: "erp" | "self_serve";
  erpNameSyncedAt: string | null;
  trustName: string | null;
  timezone: string;
}

// ─────────────────────────────────────────────────────────────── chrome

/**
 * How far through, as a number and as a bar.
 *
 * Counted on steps COMPLETED — `step - 1` — not on the step being looked at.
 * Showing 9% for having opened the first question is the kind of progress bar
 * people stop believing, and the eleventh step reading 100% before it has been
 * pressed would be worse.
 */
function Progress({ step }: { step: number }) {
  // Counted over the steps actually shown, so the bar reaches 100% on the
  // last one somebody can be standing on rather than stopping short of it.
  const pct = Math.round((stepIndex(visibleStep(step)) / WIZARD_STEPS.length) * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
      <div style={{
        flex: 1, height: 6, borderRadius: 3, background: "var(--steel-pale)", overflow: "hidden",
      }}>
        <div style={{
          width: `${pct}%`, height: "100%", borderRadius: 3,
          background: "linear-gradient(90deg,var(--brand),var(--accent))",
          // Eases with the step rather than snapping, so the movement itself
          // reads as "that worked".
          transition: "width 520ms cubic-bezier(.22,.68,.36,1)",
        }} />
      </div>
      <span style={{
        font: "700 12px/1 var(--mono, monospace)", color: "var(--brand-dark)", minWidth: 34,
        textAlign: "right",
      }}>{pct}%</span>
    </div>
  );
}

/**
 * §31.13 — every step is reachable, always.
 *
 * The rail used to open a step only when every step before it was complete,
 * with "Finish Rooms first" on the ones it refused. That is defensible for a
 * wizard somebody is walking through once; it is wrong for a screen people come
 * back to for years, where "I need to add a room" should not require finishing
 * the session dates first. Nothing is lost by opening them: a forward jump
 * still commits every step it passes that is ready, and skips the ones that are
 * not — see `jumpTo`, which now reports what it skipped rather than refusing to
 * move. `problemAt` still guards **Next**, which is the deliberate "I have
 * finished this step" action.
 *
 * `unfinished` is therefore a marker, not a gate: the dot says a step still
 * wants something, and you may go and look at it.
 */
function Rail({ step, unfinished, onJump, disabled }: {
  step: number;
  /** Steps still missing something — drawn with a ring, never locked. */
  unfinished: (n: number) => boolean;
  onJump: (n: number) => void;
  disabled: boolean;
}) {
  return (
    /*
      The strip spans the dialog (§24.5d). It used to be eleven dots bunched at
      the left with 10px connectors between them — packed tight while most of
      the bar was empty, which reads as a cluster rather than a route. The
      CONNECTORS are the flexible part now, so the dots space themselves to
      whatever width the pane has, and every step is named rather than only the
      current one: with the room to show them, "which step is Rooms?" should not
      need clicking to find out.
    */
    <div style={{ display: "flex", alignItems: "flex-start", marginBottom: 14 }}>
      {WIZARD_STEPS.map((n, i) => {
        const label = STEP_TITLES[n - 1];
        // "Done" is about position, not about the numbers: the sequence skips
        // step 9, so `n < step` would call Settings undone while standing on it.
        const state = i < stepIndex(step) ? "done" : n === step ? "now" : "todo";
        const wants = unfinished(n);
        return (
          <div key={label} style={{
            display: "flex", alignItems: "flex-start", minWidth: 0,
            // Every segment after the first may grow, and it is the CONNECTOR
            // inside it that takes the space — which is what spreads the dots
            // across the whole strip instead of bunching them at the left.
            flex: i === 0 ? "0 0 auto" : "1 1 auto",
          }}>
            {i > 0 && (
              <span style={{
                flex: "1 1 auto", minWidth: 6, height: 2, margin: "12px 6px 0", borderRadius: 2,
                // The line fills in behind you, so the rail reads as a route
                // travelled rather than eleven dots.
                background: n <= step ? "var(--accent)" : "var(--line)",
                transition: "background 400ms ease",
              }} />
            )}
            <button
              type="button"
              onClick={() => onJump(n)}
              disabled={disabled || n === step}
              aria-current={state === "now" ? "step" : undefined}
              title={
                n === step ? `${label} — you are here`
                  : wants ? `Go to ${label} — it still wants something`
                  : `Go to ${label}`
              }
              style={{
                display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
                flex: "0 1 auto", minWidth: 0, maxWidth: 104,
                background: "none", border: "none", padding: 0, font: "inherit",
                cursor: n === step || disabled ? "default" : "pointer",
              }}>
              <span
                // The current step is lifted, ringed and gently pulsing — at a
                // glance, from across a desk, "you are here".
                className={state === "now" ? "step-now" : undefined}
                style={{
                  width: state === "now" ? 26 : 20, height: state === "now" ? 26 : 20,
                  flexShrink: 0,
                  borderRadius: "50%", display: "grid", placeItems: "center",
                  font: `600 ${state === "now" ? 11 : 10}px/1 var(--mono, monospace)`,
                  background: state === "done" ? "var(--accent)" : state === "now" ? "var(--brand)" : "var(--paper)",
                  color: state === "todo" ? "var(--ink-faint)" : "#fff",
                  // Amber ring = "this one still wants something", which is the
                  // whole of what used to be a locked dot. It informs where the
                  // lock only refused.
                  border: `1.5px solid ${
                    wants && state !== "now" ? "var(--amber)"
                      : state === "todo" ? "var(--line)" : "transparent"
                  }`,
                  transition: "width 220ms ease, height 220ms ease, background 300ms ease",
                }}>{state === "done" && !wants ? "✓" : i + 1}</span>
              {/*
                Named under its dot rather than beside it: eleven labels in a row
                pushed the dots apart unevenly, since "Curriculum" is three times
                "Wings". Under the dot they cost the strip no width, and truncate
                rather than collide when the pane is narrow.
              */}
              <span style={{
                fontSize: 10.5, lineHeight: 1.2, maxWidth: "100%",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                color: state === "now" ? "var(--brand)" : "var(--ink-faint)",
                fontWeight: state === "now" ? 700 : 400,
              }}>{label}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function Field({ label, hint, ...rest }: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{
        display: "block", font: "600 11px/1.4 Inter", textTransform: "uppercase",
        letterSpacing: "0.06em", color: "var(--steel)", marginBottom: 5,
      }}>{label}</label>
      <input {...rest} style={{
        width: "100%", padding: "8px 11px", border: "1px solid var(--line)", borderRadius: 8,
        fontSize: 13.5, background: rest.readOnly ? "var(--offwhite)" : "var(--paper)",
        color: rest.readOnly ? "var(--ink-soft)" : "var(--ink)",
      }} />
      {hint && <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

// ───────────────────────────────────────────────────────── step 1: school

/**
 * One step, two faces, decided by ONE column.
 *
 * An ERP school's name is overwritten from the token on every login, so an
 * editable field here would store a change that silently reverts and produce a
 * bug nobody who did not sign in again can reproduce. A self-serve school's
 * name was typed by the person in front of us, because nobody else knows it.
 *
 * Keyed on `erpNameSyncedAt` rather than `origin`, matching the server: a Phase
 * 9.2 placeholder ("School 1") has ERP origin but no ERP-supplied name, and
 * locking those would strand them under a placeholder forever.
 */
function StepSchool({ school, answers, onChange }: {
  school: SchoolIdentity;
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}) {
  const erpNamed = school.erpNameSyncedAt !== null;
  const value = answers.school?.name ?? school.name;

  return (
    <>
      <h2 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 22, margin: "0 0 4px" }}>
        {erpNamed ? "Confirm your school" : "Name your school"}
      </h2>
      <p style={{ fontSize: 13.5, color: "var(--ink-soft)", margin: "0 0 18px" }}>
        {erpNamed
          ? "These came from your ERP sign-in."
          : "This is the name that appears on every printed timetable."}
      </p>

      <Field
        label="School name"
        value={value}
        readOnly={erpNamed}
        onChange={(e) => onChange({ school: { ...answers.school, name: e.target.value } })}
        hint={erpNamed
          ? "🔒 Managed by your ERP — change it there and it updates here on your next sign-in."
          : "You can change this later on the School Profile screen."}
      />
      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
        <Field label="School code" value={school.code} readOnly hint="Stable identifier — never changes" />
        <Field label="Timezone" value={school.timezone} readOnly />
      </div>
      {school.trustName && <Field label="Trust" value={school.trustName} readOnly />}
    </>
  );
}

// ──────────────────────────────────────────────────────── step 2: session

/** The Indian school year, offered as the default rather than assumed. */
function defaultSession(): { name: string; startDate: string; endDate: string } {
  const now = new Date();
  // April–March. Before April the current session began the previous year.
  const startYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    name: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    startDate: `${startYear}-04-01`,
    endDate: `${startYear + 1}-03-31`,
  };
}

function StepSession({ answers, onChange }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}) {
  const s = { ...defaultSession(), ...(answers.session ?? {}) };
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ session: { ...s, [k]: e.target.value } });

  return (
    <>
      <h2 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 22, margin: "0 0 4px" }}>
        Which session is this timetable for?
      </h2>
      <p style={{ fontSize: 13.5, color: "var(--ink-soft)", margin: "0 0 18px" }}>
        Every class, curriculum row and timetable belongs to one session, so this is what keeps next
        year's planning out of this year's timetable.
      </p>
      <Field label="Session name" value={s.name} onChange={set("name")}
        hint="However your school writes it — 2026-27, 2026/2027, Academic Year 2026." />
      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
        <Field label="Starts" type="date" value={s.startDate} onChange={set("startDate")} />
        <Field label="Ends" type="date" value={s.endDate} onChange={set("endDate")} />
      </div>

      {/* §25 — terms belong to the session, so they are asked for here and
          nowhere else. Collected into the draft like every other answer; the
          rows are written when this step commits, right after the importer
          creates the year they hang off. */}
      {s.startDate && s.endDate && s.endDate > s.startDate && (
        <DraftTerms
          session={{ startDate: s.startDate, endDate: s.endDate }}
          value={answers.terms ?? []}
          onChange={(terms) => onChange({ terms })}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────── the shell

export function OnboardingWizard({ school, startAt = null, startWing = null, inline = false, onClose }: {
  school: SchoolIdentity;
  /**
   * §8.3 — render as an ordinary page instead of a dialog over one.
   *
   * The routed way in (`/guided-setup`, `/allocation`) passes this; the
   * welcome flow does not, because arriving there IS a hand-over from
   * something else and closing must give that back.
   */
  inline?: boolean;
  /**
   * Open here instead of at the saved step — the §24.6 handover's destination.
   *
   * Null for every other way in, which keeps the resume behaviour below as the
   * default: a wizard that quietly restarted at step 1 would be worse than one
   * that never saved.
   */
  startAt?: number | null;
  /**
   * Which wing step 4 opens on — §3.10a's destination.
   *
   * A URL parameter rather than an answer in the draft, and the distinction is
   * the point: this is where somebody is being *sent*, not something they have
   * said. Stored in the draft it would keep forcing that tab on every later
   * visit; in the URL it is spent the moment they navigate.
   */
  startWing?: string | null;
  /**
   * How the wizard was left.
   *
   * §31.13 adds `allocation`: the Settings step's door to the Master Grid's
   * Lesson Grid, which is neither finishing nor abandoning — the draft is saved
   * and stays resumable, and the caller decides where "the allocation" is.
   */
  onClose: (reason: "saved" | "discarded" | "allocation") => void;
}) {
  const [step, setStep] = useState(1);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  /**
   * §30.10 — the error banner remembers WHICH pool it is about.
   *
   * A plain string was not enough, and the failure was on screen: a school
   * setting up its individual timetable was shown "Class 1 is in both Main
   * Timetable 2026-27 and New" — a real clash between two grouped wings,
   * raised while the main school was selected and still sitting there after the
   * switch. `changeScope` clears it, but that is one of nine places this state
   * is written from, and "every writer remembers to clear it" is not a property
   * anybody can keep true. React Fast Refresh preserves state across a hot
   * reload too, so an error could even outlive the code that raised it.
   *
   * Stamping the scope makes the wrong banner impossible rather than unlikely:
   * it is rendered only where it was raised. The setter keeps its old signature,
   * so all nine writers are untouched — the one that matters is the read.
   */
  const [errorAt, setErrorAt] = useState<{ scope: string; message: string } | null>(null);
  /** The line shown after a step lands; cleared when the next one starts. */
  const [praise, setPraise] = useState<string | null>(null);
  const [sound, setSound] = useState(soundEnabled());
  /**
   * §28 — the step rail folded away, so a grid gets the whole pane.
   *
   * Remembered per browser, not per school: it is a preference about how
   * somebody likes to work, and asking for it again every session would make
   * it not worth using.
   */
  const [focus, setFocus] = useState(() => {
    try { return localStorage.getItem("setup.focus") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("setup.focus", focus ? "1" : "0"); } catch { /* private mode */ }
  }, [focus]);
  const tall = TALL_STEPS.has(step);
  /**
   * The answer keys edited since the last successful save.
   *
   * A ref rather than state: it must not cause a render, and it must be read
   * at save time rather than at the render that scheduled the save — a `useState`
   * here would send yesterday's set on a fast Next.
   */
  const touched = useRef<Set<string>>(new Set());
  /** Where the burst comes from — the button that was pressed. */
  const burstFrom = useRef<{ x: number; y: number } | null>(null);

  // Resume whatever was saved. A wizard that quietly restarted at step 1 would
  // be worse than one that never saved at all — the work is gone AND you cannot
  // tell.
  useEffect(() => {
    api<Draft & { empty?: boolean; prefilled?: boolean }>("/onboarding/session")
      .then((d) => {
        if (!d.empty) {
          setAnswers(d.answers ?? {});
          // Loading is not editing. Everything here is already saved, so
          // nothing is owed to the server until somebody changes it.
          touched.current.clear();
          // §31.13 — a draft saved on the old step 9 resumes on Settings, since
          // there is no longer an Allocation step to put anybody on.
          setStep(visibleStep(startAt ?? d.currentStep));
        } else if (d.prefilled && d.answers) {
          /**
           * §27.12 — the school's own masters, rebuilt but NOT saved.
           *
           * Every key is marked touched, so the first Next writes them. That is
           * not bookkeeping for its own sake: `sheetsFor` commits from the
           * STORED draft, so a step whose answers were only ever in the browser
           * would commit nothing and report "There is nothing to create yet" —
           * the §28.6 failure, one level up.
           */
          setAnswers(d.answers);
          for (const k of Object.keys(d.answers)) touched.current.add(k);
          setStep(visibleStep(startAt ?? d.currentStep ?? 1));
        } else if (startAt) {
          setStep(visibleStep(startAt));
        }
      })
      .catch(() => { /* an unreadable draft is not a reason to block a new one */ })
      .finally(() => setLoading(false));
  }, []);

  /**
   * §30.9 — which §30 resource pool this setup is working on.
   *
   * A school's ordinary wings share one pool and are set up together; an
   * individual timetable is a pool of its own and shares **nothing** — not a
   * class, not a room, not a teacher's capacity. Mixing them in one wing list
   * was the bug: the Classes step reported Class 1 as claimed by both the main
   * timetable and an individual one, and offered two fixes the school must not
   * make.
   *
   * Held here rather than in step 4 because it is not a fact about that step:
   * the week (5), the teachers pinned to a wing (7) and the rooms (8) are all
   * per-wing too, and a scope that changed between steps would be worse than
   * none.
   */
  const [scope, setScope] = useState<string>(GROUPED_SCOPE);

  /**
   * Change scope, and drop what was said about the last one.
   *
   * The error banner and the praise line are both about the pool that produced
   * them — "Class 1 is in both Main Timetable and New" is true of the main
   * school and means nothing while an individual timetable is on screen, but it
   * is state, so it sat there after the switch looking like a fresh refusal.
   * Wrapped rather than left to a `useEffect` on `scope`, because clearing an
   * error is a consequence of the click and not of the render that follows it.
   */
  /*
    A ref, because `setError` is called from async work that captured an older
    render. Reading the scope through it stamps the error with the pool the
    person is looking at NOW, not the one they were in when the request left.
  */
  const scopeNow = useRef(scope);
  scopeNow.current = scope;
  const setError = (message: string | null) =>
    setErrorAt(message === null ? null : { scope: scopeNow.current, message });
  /** Shown only in the pool that raised it. */
  const error = errorAt && errorAt.scope === scope ? errorAt.message : null;

  const changeScope = (next: string) => {
    if (next === scope) return;
    setScope(next);
    setError(null);
    setPraise(null);
  };

  const allWings: WingAnswer[] = Array.isArray(answers.wings) ? answers.wings : [];
  /**
   * The scopes this school actually has, in the order the wings are stored.
   *
   * `grouped` is always offered even when no wing is in it yet — it is where
   * "+ Add wing" puts one, so a school with nothing but an individual
   * timetable must still be able to reach it.
   */
  const scopes = (() => {
    const out: Array<{ key: string; label: string; count: number }> = [];
    const grouped = allWings.filter((w) => wingScope(w) === GROUPED_SCOPE);
    out.push({
      key: GROUPED_SCOPE,
      label: grouped.length === 1 ? grouped[0].name : "Main school",
      count: grouped.length,
    });
    for (const w of allWings) {
      if (wingScope(w) === GROUPED_SCOPE) continue;
      out.push({ key: wingScope(w), label: w.name, count: 1 });
    }
    return out;
  })();

  /*
    The wings this scope owns — and therefore every wing any step can see.

    Filtering ONCE, here, rather than teaching twenty-five call sites about
    pools: `answers.wings` is read by the ladder, the week, the room
    suggestion, the teacher pinning, `planClasses` and the summary boxes, and a
    filter at each of them is twenty-five chances to forget one.
  */
  const wingsInScope = allWings.filter((w) => wingScope(w) === scope);

  /**
   * What a step is handed: the draft, with `wings` narrowed to this scope.
   *
   * The stored draft keeps every wing — losing the others on a save would be a
   * far worse bug than the one being fixed — so the narrowing happens on the
   * way IN and `patch` widens again on the way out.
   */
  const answersInScope: Record<string, any> = { ...answers, wings: wingsInScope };

  /**
   * Put a step's edited wing list back into the full one, in place.
   *
   * Walked in order rather than concatenated, so a wing does not jump to the
   * end of the tab strip for having been edited. A shorter list means a wing
   * was removed; a longer one means a wing was added, and it is appended.
   */
  const mergeWings = (next: WingAnswer[]): WingAnswer[] => {
    const incoming = [...next];
    const out: WingAnswer[] = [];
    for (const w of allWings) {
      if (wingScope(w) !== scope) { out.push(w); continue; }
      const take = incoming.shift();
      if (take) out.push(take);
    }
    out.push(...incoming);
    return out;
  };

  /*
    §3.10a + §30.9 — arriving from "New Timetable" names the wing in the URL,
    and that wing may be an individual timetable.

    Without this the setup opens on the main school's scope, where the wing
    just created does not appear at all — the exact "I made it and it is not
    there" the flow exists to avoid. Once, guarded by a ref: after that the
    switcher is the person's, and a later edit to the wings must not drag them
    back to where they arrived.
  */
  const scopedToStart = useRef(false);
  useEffect(() => {
    if (scopedToStart.current || !startWing) return;
    const want = startWing.trim().toLowerCase();
    const found = allWings.find((w) => w.name.trim().toLowerCase() === want);
    if (!found) return;
    scopedToStart.current = true;
    setScope(wingScope(found));
  }, [startWing, answers.wings]);

  const patch = (p: Record<string, any>) => {
    let payload = p;
    if (Array.isArray(p.wings)) {
      /*
        A step only ever saw this scope's wings, so what comes back replaces
        exactly those. Everything a step creates belongs to the scope it was
        created in — an individual pool holds one timetable and the wizard
        never makes one, so anything added here is grouped.
      */
      const stamped = (p.wings as WingAnswer[]).map((w) =>
        scope === GROUPED_SCOPE
          ? (w.individual ? { ...w, individual: false } : w)
          : { ...w, individual: true },
      );
      payload = { ...p, wings: mergeWings(stamped) };
      /*
        Renaming the wing you are scoped to changes its scope key — the key is
        the name, as everything else in this wizard is (`answers.weeks` is
        keyed by wing name too). Re-key here, or the next render finds no wing
        in scope and the screen empties under somebody's cursor.
      */
      if (scope !== GROUPED_SCOPE && stamped.length === 1) {
        const moved = wingScope(stamped[0]);
        if (moved !== scope) setScope(moved);
      }
    }
    for (const k of Object.keys(payload)) touched.current.add(k);
    setAnswers((a) => ({ ...a, ...payload }));
  };

  /**
   * Only this step's keys go up; the server merges.
   *
   * That comment was here from the start and the code did not honour it — it
   * sent the whole `answers` object every time. Nobody noticed while drafts
   * were small; §27 put the curriculum and every mapping into the draft, and
   * Second Branch (64 sections, 122 teachers, 957 mappings) reached **145kb**
   * against Express's 100kb default. Pressing Next on the Subjects step failed
   * with a raw `request entity too large` — on a school that had done nothing
   * unusual, at a step that had changed three kilobytes.
   *
   * So the wizard now tracks which keys were actually edited and sends those.
   * The server has always merged rather than replaced, so a partial payload is
   * what it is built for; sending everything also meant a step could overwrite
   * a key it never showed, which is the bug that comment was written to
   * prevent.
   *
   * The touched set is cleared only after a SUCCESSFUL save. Clearing it on
   * the way in would lose somebody's typing to one failed request.
   */
  const persist = (nextStep: number) => persistWith({}, nextStep);

  /**
   * @param extra keys to send whose value this caller knows and `answers` does
   *   not yet — a `setState` scheduled in the same tick is not readable here.
   */
  const persistWith = async (extra: Record<string, any>, nextStep: number) => {
    setBusy(true); setError(null);
    const keys = [...new Set([...touched.current, ...Object.keys(extra)])];
    const delta: Record<string, any> = {};
    for (const k of keys) delta[k] = k in extra ? extra[k] : answers[k];
    try {
      await api("/onboarding/session", {
        method: "PUT",
        body: JSON.stringify({ currentStep: nextStep, answers: delta, mode: "wizard" }),
      });
      for (const k of keys) touched.current.delete(k);
      return true;
    } catch (e) {
      setError(asMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  /**
   * What is stopping step `at` from being complete, or null.
   *
   * Takes the step rather than reading the one on screen, because the rail now
   * asks the same question about steps nobody is looking at: "may I jump to
   * 7?" is "is every step before 7 filled in?", and that is this function
   * eleven times rather than a second set of rules that would drift from it.
   */
  const problemAt = (at: number): string | null => {
    const step = at;
    if (step === 1) {
      const name = (answers.school?.name ?? school.name ?? "").trim();
      if (name.length < 2) return "Enter the school's name.";
    }
    if (step === 2) {
      const s = { ...defaultSession(), ...(answers.session ?? {}) };
      if (!s.name?.trim()) return "Give the session a name.";
      if (!s.startDate || !s.endDate) return "A session needs a start and an end date.";
      if (s.endDate <= s.startDate) return "The session must end after it starts.";
      // §25 — a half-built term calendar must not reach the commit. The server
      // would refuse it, but on the step AFTER the one holding the mistake.
      const bad = termProblems(answers.terms ?? [], { startDate: s.startDate, endDate: s.endDate })[0];
      if (bad) return `${bad.message} ${bad.fix}`;
    }
    if (step === 3) {
      if (wingsInScope.length === 0) return "Add at least one wing — most schools have one to three.";
    }
    if (step === 4) {
      // §30.9 — this scope's wings. `planClasses` is pool-aware too, so this
      // is belt and braces rather than the only guard; the filter is what stops
      // another pool's wing being NAMED in a message about this one.
      const { classes, issues } = planClasses(wingsInScope);
      // Refused rather than merged: `classes.name` is unique per school, so
      // which wing teaches a shared class is a decision, not a guess.
      if (issues.length > 0) return `${issues[0].message} ${issues[0].fix}`;
      if (classes.length === 0) return "Choose a class range — every wing is currently empty.";
    }
    if (step === 5) {
      const weeks = answers.weeks ?? {};
      for (const w of wingsInScope) {
        const days = weeks[w.name]?.workingDays ?? [1, 2, 3, 4, 5];
        if (days.length === 0) return `${w.name} needs at least one working day.`;
      }
    }
    if (step === 6) {
      const named = (answers.subjects ?? []).filter((s: SubjectAnswer) => s.name?.trim());
      if (named.length === 0) return "Add at least one subject — the curriculum and every mapping are built from this list.";
      const seen = new Set<string>();
      for (const s of named) {
        const key = s.name.trim().toLowerCase();
        // Caught here rather than at the importer, which would refuse the whole
        // sheet and name a row number in a spreadsheet nobody is looking at.
        if (seen.has(key)) return `${s.name.trim()} is listed twice — subject names are unique.`;
        seen.add(key);
      }
    }
    if (step === 7) {
      const named = (answers.teachers ?? []).filter((t: TeacherAnswer) => t.name?.trim());
      if (named.length === 0) return "Add at least one teacher — nobody can be given a class otherwise.";
      const codes = new Set<string>();
      for (const t of named) {
        const code = t.employeeCode?.trim().toLowerCase();
        if (!code) continue;
        if (codes.has(code)) return `Employee code ${t.employeeCode} is used twice — it is the identifier, so it has to be unique.`;
        codes.add(code);
      }
    }
    /*
      §31.13 — there was a step 9 check here: no class may be given more
      periods than its wing's week holds. It is deliberately not carried over
      as dead code, because the rule did not move with the step — the Master
      Grid's Lesson Grid enforces it on the cell being typed into
      (`computeLoads` / `assertWithinWeek`, §27), which is both earlier and
      more precise than a banner on a step somebody is trying to leave.
    */
    return null;
  };

  /**
   * What this step has to WRITE before the next one can mean anything.
   *
   * Steps 1–2 hold answers only. From step 3 the wizard puts real rows in the
   * database, because everything after depends on them existing: a class-section
   * cannot attach to a wing that is not there, and the week cannot be written
   * against a config that does not exist.
   *
   * Every one of these is idempotent, so a second press, a resumed draft or a
   * Back-then-Next creates nothing extra:
   *  - step 2 and 4 go through the §16 importer, which skips existing rows;
   *  - step 3 reads the configs first and creates only what is missing;
   *  - step 5's `PUT /:id/structure` rewrites the period rows wholesale.
   */
  const commitStep = async (n: number): Promise<Record<string, number> | undefined> => {
    /*
      §30.9 — the pool being set up travels with the commit.

      The server commits from the STORED draft, which holds every wing, so
      without this it validates and creates rows for pools nobody is looking
      at. Concretely: `commit(4)` runs `planClasses` over what it is given and
      throws on the first issue, so a school setting up an individual timetable
      was refused with "Class 1 is in both Main Timetable 2026-27 and New" — a
      real conflict between two GROUPED wings, unrelated to the timetable on
      screen and unfixable from it.
    */
    const q = `?scope=${encodeURIComponent(scope)}`;
    if (n === 2) return (await api<Committed>(`/onboarding/commit/2${q}`, { method: "POST" })).created;
    if (n === 3) return { configs: await commitWings(answers) };
    if (n === 4) return (await api<Committed>("/onboarding/commit/4", { method: "POST" })).created;
    if (n === 5) { await commitWeeks(answers); return undefined; }
    /*
      §31.13 — step 9 is not in `WIZARD_STEPS`, so it never reaches here.
      Committing the allocation is the Master Grid Lesson Grid's Save, which
      calls the same `commitAllocation` module. There is one commit path; the
      wizard simply no longer walks it.
    */
    // Steps 6–10 all go through the §16 importer, which is what makes them
    // idempotent — pressing Next twice, or coming back, creates nothing extra.
    if (n >= 6 && n <= 10) {
      return (await api<Committed>(`/onboarding/commit/${n}${q}`, { method: "POST" })).created;
    }
    return undefined;
  };

  /**
   * §31.13 — which steps still want something.
   *
   * This used to be `furthest`: the first incomplete step, and the point past
   * which the rail refused to go. Every step is open now, so the same question
   * has a better answer — mark the steps that are not finished and let somebody
   * go and look at any of them. Derived from the answers rather than remembered
   * as a high-water mark, so it survives a refresh, a different machine, and
   * going back to empty something out.
   */
  const unfinished = (n: number) => problemAt(n) !== null;

  /**
   * Jump to a step from the rail.
   *
   * Backwards is free — those steps are already committed, and going back to
   * look at something must never be a write. Forwards COMMITS each step it
   * passes over, in order, because steps 2-10 create real rows and skipping
   * one would land somebody on a screen whose data does not exist yet. Every
   * commit is idempotent, so re-crossing ground already covered costs a round
   * trip and changes nothing.
   */
  const jumpTo = async (target: number) => {
    if (busy || target === step) return;
    setPraise(null);
    setError(null);
    if (stepIndex(target) < stepIndex(step)) {
      if (await persist(target)) setStep(target);
      return;
    }
    /*
      §31.13 — a forward jump commits what it can and ALWAYS lands.

      It used to refuse: the first incomplete step it passed became an error
      and the destination was never reached. That is the behaviour "let me go
      to any tab" is about — somebody who wants to add a room should not have
      to finish the session dates to get there.

      So each step in between is committed only if it is ready, and the ones
      that are not are named afterwards rather than blocking. Nothing is lost
      by skipping one: every commit is idempotent, so pressing Next through it
      later writes exactly the rows this pass did not.
    */
    setBusy(true);
    const skipped: string[] = [];
    try {
      for (const n of WIZARD_STEPS) {
        if (stepIndex(n) < stepIndex(step) || stepIndex(n) >= stepIndex(target)) continue;
        if (problemAt(n)) { skipped.push(STEP_TITLES[n - 1]); continue; }
        await commitStep(n);
      }
    } catch (e) {
      // A server refusal is different from an unfinished step, and is still
      // worth stopping for: it means a commit that looked ready was not.
      setError(asMessage(e));
      setBusy(false);
      return;
    }
    setBusy(false);
    if (await persist(target)) {
      setStep(target);
      if (skipped.length > 0) {
        setError(
          `Saved what was ready. ${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} `
          + "still unfinished — the rail marks them, and nothing is lost.",
        );
      }
    }
  };

  /**
   * The last step is a different action, not a Next with nothing after it.
   *
   * `finish` writes the settings, marks the draft complete so it stops offering
   * to resume, and hands over to Readiness — which is the screen that actually
   * answers "can this school generate?".
   */
  const finish = async () => {
    /**
     * Saved directly, not through `patch`.
     *
     * `patch` schedules a state update; `persist` on the very next line reads
     * `answers` from THIS render and cannot see it. So a school that pressed
     * Finish without opening the Settings step stored no settings at all, and
     * `/onboarding/finish` applied none of them — the first-period rule, the
     * §20 floor and (since §28.1) the load-alert line all quietly kept their
     * database defaults instead of the wizard's.
     *
     * Sent explicitly so the value that goes up is the one this function
     * decided, rather than whatever React has got round to yet.
     */
    const settings = answers.settings ?? defaultSettings();
    if (!answers.settings) patch({ settings });
    if (!(await persistWith({ settings }, TOTAL_STEPS))) return;
    setBusy(true); setError(null);
    try {
      await api("/onboarding/finish", { method: "POST" });
    } catch (e) {
      setError(asMessage(e));
      setBusy(false);
      return;
    }
    setBusy(false);
    // The eleventh step earns more than the other ten.
    celebrate(burstFrom.current ?? undefined);
    window.setTimeout(() => celebrate(), 260);
    onClose("saved");
  };

  const next = async () => {
    setPraise(null);
    // §30.10 — cleared FIRST. It used to be cleared only after the step
    // validated and the draft saved, so a persist that failed left the previous
    // attempt's message standing over a fresh one.
    setError(null);
    const bad = problemAt(step);
    if (bad) { setError(bad); return; }
    /**
     * The defaults a step SHOWED but nobody typed into.
     *
     * Steps 1 and 2 render a filled-in answer and only write it to the draft
     * when a field is edited — so somebody who agrees with all three session
     * defaults leaves `answers.session` undefined. These two lines existed to
     * catch that, and could not: `patch` schedules a state update and the
     * `persist` on the next line reads `answers` from THIS render.
     *
     * The result was "There is nothing to create yet" on pressing Next — the
     * draft had no session, so `sheetsFor(2)` had nothing to commit. Accepting
     * the defaults, which is the commonest thing anybody does on this step, was
     * the one path that failed.
     *
     * Passed explicitly instead, so what goes up is what this function decided
     * rather than whatever React has got round to.
     */
    const shown: Record<string, any> = {};
    if (step === 1 && !answers.school) shown.school = { name: school.name };
    if (step === 2 && !answers.session) shown.session = defaultSession();
    // Step 5 is the same shape one level down: the week is shown per wing and
    // written only on edit. `commitWeeks` merges the defaults itself, so the
    // timetable config is correct either way — but the DRAFT ends up with no
    // week, and a resumed setup then reports the wing's week as still missing.
    if (step === 5) {
      const weeks = { ...(answers.weeks ?? {}) };
      let filled = false;
      for (const w of wingsInScope) {
        if (!weeks[w.name]) { weeks[w.name] = defaultWeek(); filled = true; }
      }
      if (filled) shown.weeks = weeks;
    }
    if (Object.keys(shown).length > 0) patch(shown);

    // Save the answers FIRST. The server commits from the stored draft, so an
    // unsaved answer is one the commit would not see — and if the commit then
    // fails, the typing is still safe.
    if (!(await persistWith(shown, step))) return;

    setBusy(true); setError(null);
    let created: Record<string, number> | undefined;
    try {
      created = await commitStep(step);
    } catch (e) {
      setError(asMessage(e));
      setBusy(false);
      return;
    }
    setBusy(false);
    if (await persist(stepAfter(step))) {
      // Celebrated only after the advance is real — the commit landed AND the
      // new position saved. A flourish for something that then failed to save
      // is worse than no flourish at all.
      setPraise(wellDone(step, created));
      celebrate(burstFrom.current ?? undefined);
      setStep((s) => stepAfter(s));
    }
  };

  const back = async () => {
    setPraise(null);
    if (step === WIZARD_STEPS[0]) return;
    await persist(stepBefore(step));
    setStep((s) => stepBefore(s));
  };

  const saveAndClose = async () => {
    if (await persist(step)) onClose("saved");
  };

  /**
   * §31.13 — save, then hand over to the Master Grid's Lesson Grid.
   *
   * `persist` and not `finish`: the setup is not over, and marking the draft
   * complete here would stop it offering to resume — somebody who goes to
   * allocate and comes back would find the wizard with nothing to carry on.
   */
  const openAllocation = async () => {
    if (await persist(step)) onClose("allocation");
  };

  const discard = async () => {
    if (!window.confirm("Throw away what you have entered so far? The school itself is not affected.")) return;
    setBusy(true);
    try { await api("/onboarding/session", { method: "DELETE" }); } catch { /* already gone */ }
    onClose("discarded");
  };

  /*
    §8.3 — a page, or a dialog over the page.

    It was only ever a dialog, and by §24.5d it had already grown to the exact
    size and position of the pane beside the nav — a "modal" filling the whole
    content area, dimming a strip of nav nobody was looking at. At that point
    the overlay is costing something and buying nothing: it traps focus, it
    cannot be linked to, the browser's Back button does not close it, and two
    of them (setup and the Allocation grid) are screens somebody works in for
    an hour rather than a question they answer and dismiss.

    So `inline` renders the same wizard as an ordinary routed page, and the
    dialog wrapper stays for the one case that is genuinely modal: the welcome
    flow's own hand-over, which opens over whatever you were looking at.
  */
  const shell = (
    <div className={inline ? "pane-page" : "pane-dialog"}>
        <div style={{
          // §8.4 — a tall step in focus mode is down to one line of chrome, and
          // that line is 24px rather than 28. It is the difference between the
          // header being a band and being a caption.
          padding: focus ? (tall ? "5px 10px 4px" : "10px 28px 8px") : "22px 28px 14px",
          borderBottom: "1px solid var(--line)",
        }}>
          {/*
            Focus mode (§28). The progress bar and the ten-step rail matter when
            you arrive and when you leave; they do not matter while you work,
            and on the Allocation grid they were costing four rows of school.
            Collapsed rather than removed, and remembered — so somebody who
            wants the route back gets it in one click.
          */}
          <div style={{
            overflow: "hidden", maxHeight: focus ? 0 : 120, opacity: focus ? 0 : 1,
            transition: "max-height 240ms ease, opacity 180ms ease",
          }}>
            <Progress step={step} />
            <Rail step={step} unfinished={unfinished} onJump={(n) => void jumpTo(n)} disabled={busy} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, color: "var(--ink-faint)" }}>
            <span>Step {stepIndex(visibleStep(step)) + 1} of {WIZARD_STEPS.length} · {STEP_TITLES[step - 1]} · {school.name}</span>
            {/*
              §30.9 — which §30 pool this setup is working on.

              Shown ONLY when the school has more than one, which for almost
              every school is never: an individual timetable is a deliberate,
              unusual thing to create, and a selector offering one choice is a
              control that teaches nothing and costs a glance on every step.

              Beside the step line rather than above the tab strip on step 4,
              because it governs every step — the week, the teachers pinned to a
              wing and the rooms are all per-wing too, and a scope that changed
              between steps would be worse than none.
            */}
            {scopes.length > 1 && (
              <>
                <span style={{ color: "var(--line)" }}>|</span>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{
                    font: "800 9px/1 Inter, sans-serif", letterSpacing: "0.07em",
                    textTransform: "uppercase", color: "var(--ink-faint)",
                  }}>
                    Setting up
                  </span>
                  <select
                    value={scope}
                    onChange={(e) => changeScope(e.target.value)}
                    disabled={busy}
                    title="An individual timetable stands on its own — it shares no class, room or teacher with the rest of the school, so it is set up on its own too."
                    style={{
                      font: "700 11.5px/1 Inter, sans-serif", color: "var(--brand)",
                      border: "1px solid var(--steel-pale)", background: "var(--steel-pale)",
                      borderRadius: 7, padding: "4px 8px",
                    }}
                  >
                    {scopes.map((sc) => (
                      <option key={sc.key} value={sc.key}>
                        {sc.key === GROUPED_SCOPE
                          ? `${sc.label} · ${sc.count} timetable${sc.count === 1 ? "" : "s"}`
                          : `${sc.label} · individual`}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <span style={{ flex: 1 }} />
            <button
              onClick={() => setFocus(!focus)}
              title={focus ? "Show the step rail again" : "Fold the step rail away and give the room to this screen"}
              style={{
                border: "none", background: "none", cursor: "pointer", fontSize: 12, padding: 0,
                color: focus ? "var(--brand)" : "var(--ink-faint)",
              }}>
              {focus ? "⇲ Show steps" : "⇱ Focus"}
            </button>
            {/* Opt-in, and remembered. A school office is a shared room, and a
                browser blocks autoplay for good reasons. */}
            <button
              onClick={() => { setSoundEnabled(!sound); setSound(!sound); }}
              title={sound ? "Turn the completion sound off" : "Play a short sound when a step completes"}
              style={{
                border: "none", background: "none", cursor: "pointer", fontSize: 12,
                color: sound ? "var(--brand)" : "var(--ink-faint)", padding: 0,
              }}>
              {sound ? "🔊 Sound on" : "🔇 Sound off"}
            </button>
          </div>
        </div>

        <div style={{
          // §8.4 — a tall step gets the frame's padding down to almost nothing.
          // 12px of inset around a 50×22 grid is 12px that could have been a
          // row; the form steps keep their breathing room, which is what makes
          // them readable.
          padding: tall ? "6px 8px 8px" : "20px 28px",
          // A tall step owns its own scrolling; everything else scrolls here.
          overflowY: tall ? "hidden" : "auto",
          flex: 1, minHeight: 0, display: tall ? "flex" : undefined, flexDirection: "column",
          // The floating praise above is positioned against this.
          position: "relative",
        }}>
          {/*
            The dialog is as wide as the pane; the CONTENT is not always.
            A class × subject matrix wants every pixel; "what is your school
            called?" does not, and a 1600px-wide text box is not more usable
            than a 700px one, it is just harder to read across. So the wide
            steps fill and the form steps hold a measure — declared here, beside
            the step list it refers to, rather than guessed per screen.
          */}
          <div style={{
            ...(WIDE_STEPS.has(step) ? {} : { maxWidth: 880, marginLeft: "auto", marginRight: "auto" }),
            ...(tall ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" as const } : {}),
          }}>
          {/*
            §8.4 — on a TALL step it floats; everywhere else it is a banner.

            "Wonderful! Your rooms are ready" is worth saying and is worth
            nothing after it has been read. On the Allocation grid it was taking
            a permanent 60px band at the top of the one screen in the app that
            is short of vertical room, to hold a sentence about the step before.
            Floating it over the top-right corner keeps the encouragement and
            gives the height back; on the ordinary form steps there is room to
            spare and a banner in the flow reads better than something hovering.
          */}
          {praise && (
            <div
              key={praise}
              className="praise"
              style={{
                display: "flex", alignItems: "center", gap: 9,
                borderLeft: "3px solid var(--accent)", background: "var(--accent-bg)",
                padding: "11px 14px",
                fontSize: 13, color: "var(--ink-soft)",
                ...(tall
                  ? {
                      position: "absolute" as const, top: 8, right: 14, zIndex: 3,
                      maxWidth: "min(520px, 60%)",
                      boxShadow: "0 8px 22px rgba(11,31,68,.18)",
                      // Rounded on all four corners when it floats: the flat
                      // left edge only reads as a banner against a page edge.
                      borderRadius: 9,
                    }
                  : { marginBottom: 16, borderRadius: "0 9px 9px 0" }),
              }}>
              <span style={{ fontSize: 15 }} aria-hidden>✨</span>
              {/* Announced, so the encouragement is not only visual. */}
              <span role="status">{praise}</span>
            </div>
          )}
          {loading ? (
            <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>Loading what you saved…</p>
          ) : (
            /*
              §30.9 — every step is handed `answersInScope`, not `answers`.

              The only difference is `wings`, narrowed to the pool being set
              up. Steps 1 and 2 do not read it and are given the same object for
              one reason: a step that starts reading wings later must not have
              to remember to ask for the narrowed copy.
            */
            step === 1 ? <StepSchool school={school} answers={answersInScope} onChange={patch} />
            : step === 2 ? <StepSession answers={answersInScope} onChange={patch} />
            : step === 3 ? <StepWings answers={answersInScope} onChange={patch} />
            : step === 4 ? <StepClasses answers={answersInScope} onChange={patch} startWing={startWing} />
            : step === 5 ? <StepWeek answers={answersInScope} onChange={patch} />
            : step === 6 ? <StepSubjects answers={answersInScope} onChange={patch} />
            : step === 7 ? <StepTeachers answers={answersInScope} onChange={patch} />
            : step === 8 ? <StepRooms answers={answersInScope} onChange={patch} />
            : (
              <StepSettings
                answers={answersInScope}
                onChange={patch}
                onOpenAllocation={() => { void openAllocation(); }}
              />
            )
          )}
          {error && (
            <div style={{
              borderLeft: "3px solid var(--signal)", background: "var(--signal-bg)",
              padding: "11px 13px", borderRadius: "0 8px 8px 0", fontSize: 12.5,
              color: "var(--ink-soft)", marginTop: 14,
            }}>{error}</div>
          )}
          </div>
        </div>

        <div style={{
          // §8.4 — the same buttons, in a thinner band, on the steps that are
          // short of height. Back / Discard / Next do not get easier to press
          // for having 14px above and below them rather than 8.
          padding: tall ? "8px 12px" : "14px 28px",
          borderTop: "1px solid var(--line)", background: "var(--offwhite)",
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        }}>
          <button className="btn" onClick={back} disabled={busy || step === WIZARD_STEPS[0]}>← Back</button>
          <button className="btn" onClick={discard} disabled={busy}
            style={{ border: "none", background: "none", color: "var(--ink-faint)", fontSize: 12 }}>
            Discard
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={saveAndClose} disabled={busy}>Save &amp; close</button>
          {/* The last step SHOWN, which is what decides Finish-vs-Next — the
              same list `stepAfter` walks, rather than `TOTAL_STEPS`, which only
              happens to be the same number today. */}
          {step === WIZARD_STEPS[WIZARD_STEPS.length - 1] ? (
            <button className="btn btn-primary"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                burstFrom.current = { x: r.left + r.width / 2, y: r.top };
                void finish();
              }}
              disabled={busy}>
              {busy ? "Finishing…" : "Finish setup →"}
            </button>
          ) : (
            <button className="btn btn-primary"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                burstFrom.current = { x: r.left + r.width / 2, y: r.top };
                void next();
              }}
              disabled={busy}>
              {/*
                §31.13 — the step this button GOES TO, not the next number.

                `STEP_TITLES[step]` read the title one index along, which was
                the same thing while the sequence was 1..10 and stopped being
                it the moment 9 was taken out: Rooms offered "Next: Allocation"
                and landed on Settings. `stepAfter` is the same function the
                press itself uses, so the label and the destination cannot
                disagree again.
              */}
              {busy ? "Saving…" : `Next: ${STEP_TITLES[stepAfter(step) - 1]} →`}
            </button>
          )}
        </div>
    </div>
  );

  if (inline) return shell;
  return (
    // Sized to the pane beside the nav rather than to a centred card (§24.5d):
    // the curriculum matrix and the mapping table are the widest things in the
    // app, and at 840px they scrolled sideways inside a dialog with half the
    // screen dimmed and empty beside them.
    <div role="dialog" aria-modal="true" aria-label="Guided setup" className="pane-overlay">
      {shell}
    </div>
  );
}
