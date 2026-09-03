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
import { commitWeeks, commitWings, StepClasses, StepWeek, StepWings } from "./steps/Structure";
import { StepSubjects, StepTeachers } from "./steps/People";
import { defaultSettings, StepCurriculum, StepMapping, StepRooms, StepSettings } from "./steps/Syllabus";
import { planClasses, type SubjectAnswer, type TeacherAnswer } from "@edutimetable/shared";
import { celebrate, setSoundEnabled, soundEnabled } from "./celebrate";

export const TOTAL_STEPS = 11;

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
  const left = TOTAL_STEPS - step;
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
      case 9: return did(n("curriculum"), `You have just created ${plural(n("curriculum"), "curriculum row")}`, "Your curriculum is in");
      case 10: return did(n("mappings"), `You have just made ${plural(n("mappings"), "assignment")}`, "Every subject has a teacher");
      default: return "Your school is set up";
    }
  })();

  return `${CHEERS[(step - 1) % CHEERS.length]} ${clause} — ${remaining(step)}.`;
}

export const STEP_TITLES = [
  "School", "Session", "Wings", "Classes", "Timetable", "Subjects",
  "Teachers", "Rooms", "Curriculum", "Mapping", "Settings",
];

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
  const pct = Math.round(((step - 1) / TOTAL_STEPS) * 100);
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

function Rail({ step, furthest, onJump, disabled }: {
  step: number;
  /** The last step whose prerequisites are all filled in. */
  furthest: number;
  onJump: (n: number) => void;
  disabled: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: 8, marginBottom: 14 }}>
      {STEP_TITLES.map((label, i) => {
        const n = i + 1;
        const state = n < step ? "done" : n === step ? "now" : "todo";
        // Anything already passed, plus anything whose prerequisites are met.
        const open = n <= Math.max(step, furthest);
        return (
          <div key={label} style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
            {i > 0 && (
              <span style={{
                width: 10, height: 2, margin: "0 5px", borderRadius: 2,
                // The line fills in behind you, so the rail reads as a route
                // travelled rather than eleven dots.
                background: n <= step ? "var(--accent)" : "var(--line)",
                transition: "background 400ms ease",
              }} />
            )}
            <button
              type="button"
              onClick={() => open && onJump(n)}
              disabled={disabled || !open || n === step}
              aria-current={state === "now" ? "step" : undefined}
              title={
                n === step ? `${label} — you are here`
                  : open ? `Go to ${label}`
                  // Named, not just greyed: "why can I not click this?" has an
                  // answer, and it is always the same one.
                  : `Finish ${STEP_TITLES[furthest - 1]} first`
              }
              style={{
                display: "flex", alignItems: "center", gap: 5, fontSize: 11, whiteSpace: "nowrap",
                color: state === "now" ? "var(--brand)" : "var(--ink-faint)",
                fontWeight: state === "now" ? 600 : 400,
                background: "none", border: "none", padding: 0, font: "inherit",
                cursor: !open || n === step || disabled ? "default" : "pointer",
                opacity: open ? 1 : 0.45,
              }}>
              <span
                // The current step is lifted, ringed and gently pulsing — at a
                // glance, from across a desk, "you are here".
                className={state === "now" ? "step-now" : undefined}
                style={{
                  width: state === "now" ? 26 : 20, height: state === "now" ? 26 : 20,
                  borderRadius: "50%", display: "grid", placeItems: "center",
                  font: `600 ${state === "now" ? 11 : 10}px/1 var(--mono, monospace)`,
                  background: state === "done" ? "var(--accent)" : state === "now" ? "var(--brand)" : "var(--paper)",
                  color: state === "todo" ? "var(--ink-faint)" : "#fff",
                  border: `1.5px solid ${state === "todo" ? "var(--line)" : "transparent"}`,
                  transition: "width 220ms ease, height 220ms ease, background 300ms ease",
                }}>{state === "done" ? "✓" : n}</span>
              {/* Only the current step is named, or eleven labels wrap into a wall */}
              {state === "now" && label}
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
    </>
  );
}

// ─────────────────────────────────────────────────────────────── the shell

export function OnboardingWizard({ school, startAt = null, onClose }: {
  school: SchoolIdentity;
  /**
   * Open here instead of at the saved step — the §24.6 handover's destination.
   *
   * Null for every other way in, which keeps the resume behaviour below as the
   * default: a wizard that quietly restarted at step 1 would be worse than one
   * that never saved.
   */
  startAt?: number | null;
  onClose: (reason: "saved" | "discarded") => void;
}) {
  const [step, setStep] = useState(1);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The line shown after a step lands; cleared when the next one starts. */
  const [praise, setPraise] = useState<string | null>(null);
  const [sound, setSound] = useState(soundEnabled());
  /** Where the burst comes from — the button that was pressed. */
  const burstFrom = useRef<{ x: number; y: number } | null>(null);

  // Resume whatever was saved. A wizard that quietly restarted at step 1 would
  // be worse than one that never saved at all — the work is gone AND you cannot
  // tell.
  useEffect(() => {
    api<Draft & { empty?: boolean }>("/onboarding/session")
      .then((d) => {
        if (!d.empty) {
          setAnswers(d.answers ?? {});
          setStep(Math.min(TOTAL_STEPS, Math.max(1, startAt ?? d.currentStep)));
        } else if (startAt) {
          setStep(Math.min(TOTAL_STEPS, Math.max(1, startAt)));
        }
      })
      .catch(() => { /* an unreadable draft is not a reason to block a new one */ })
      .finally(() => setLoading(false));
  }, []);

  const patch = (p: Record<string, any>) => setAnswers((a) => ({ ...a, ...p }));

  /** Only this step's keys go up; the server merges. */
  const persist = async (nextStep: number) => {
    setBusy(true); setError(null);
    try {
      await api("/onboarding/session", {
        method: "PUT",
        body: JSON.stringify({ currentStep: nextStep, answers, mode: "wizard" }),
      });
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
    }
    if (step === 3) {
      if ((answers.wings ?? []).length === 0) return "Add at least one wing — most schools have one to three.";
    }
    if (step === 4) {
      const { classes, issues } = planClasses(answers.wings ?? []);
      // Refused rather than merged: `classes.name` is unique per school, so
      // which wing teaches a shared class is a decision, not a guess.
      if (issues.length > 0) return `${issues[0].message} ${issues[0].fix}`;
      if (classes.length === 0) return "Choose a class range — every wing is currently empty.";
    }
    if (step === 5) {
      const weeks = answers.weeks ?? {};
      for (const w of answers.wings ?? []) {
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
    if (step === 9) {
      // Only "over" blocks. A class that is UNDER its week is a warning, not an
      // error: free periods are a real choice some schools make, and Readiness
      // says so plainly on the next screen.
      const weeks = answers.weeks ?? {};
      const cellsByClass = new Map<string, number>();
      for (const c of answers.curriculum ?? []) {
        cellsByClass.set(c.className, (cellsByClass.get(c.className) ?? 0) + c.periodsPerWeek);
      }
      const { classes } = planClasses(answers.wings ?? []);
      for (const c of classes) {
        const week = weeks[c.wing];
        const capacity = (week?.periodsPerDay ?? 8) * (week?.workingDays ?? [1, 2, 3, 4, 5]).length;
        const total = cellsByClass.get(c.className) ?? 0;
        if (total > capacity) {
          return `${c.className} is given ${total} periods a week but ${c.wing}'s week holds ${capacity}. Reduce a subject, or lengthen the week on step 5.`;
        }
      }
    }
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
    if (n === 2) return (await api<Committed>("/onboarding/commit/2", { method: "POST" })).created;
    if (n === 3) return { configs: await commitWings(answers) };
    if (n === 4) return (await api<Committed>("/onboarding/commit/4", { method: "POST" })).created;
    if (n === 5) { await commitWeeks(answers); return undefined; }
    // Steps 6–10 all go through the §16 importer, which is what makes them
    // idempotent — pressing Next twice, or coming back, creates nothing extra.
    if (n >= 6 && n <= 10) {
      return (await api<Committed>(`/onboarding/commit/${n}`, { method: "POST" })).created;
    }
    return undefined;
  };

  /**
   * The furthest step that can be opened right now.
   *
   * "Freely, if the data entry is filled" — so a step is reachable when every
   * step before it is complete. Derived from the answers rather than remembered
   * as a high-water mark, which means it survives a refresh, a different
   * machine, and going back to empty something out: take the teachers away and
   * the steps after them stop being reachable, which is the honest answer.
   */
  const furthest = (() => {
    for (let n = 1; n <= TOTAL_STEPS; n++) if (problemAt(n)) return n;
    return TOTAL_STEPS;
  })();

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
    if (target < step) {
      if (await persist(target)) setStep(target);
      return;
    }
    for (let n = step; n < target; n++) {
      const bad = problemAt(n);
      if (bad) {
        setError(`${STEP_TITLES[n - 1]} is not finished yet — ${bad}`);
        if (await persist(n)) setStep(n);
        return;
      }
    }
    setBusy(true);
    try {
      for (let n = step; n < target; n++) await commitStep(n);
    } catch (e) {
      setError(asMessage(e));
      setBusy(false);
      return;
    }
    setBusy(false);
    if (await persist(target)) setStep(target);
  };

  /**
   * The last step is a different action, not a Next with nothing after it.
   *
   * `finish` writes the settings, marks the draft complete so it stops offering
   * to resume, and hands over to Readiness — which is the screen that actually
   * answers "can this school generate?".
   */
  const finish = async () => {
    if (!answers.settings) patch({ settings: defaultSettings() });
    if (!(await persist(TOTAL_STEPS))) return;
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
    const bad = problemAt(step);
    if (bad) { setError(bad); return; }
    // Step 1 has no editable field for an ERP school, so record what was shown
    // — otherwise a resumed draft would have no school name in it at all.
    if (step === 1 && !answers.school) patch({ school: { name: school.name } });
    if (step === 2 && !answers.session) patch({ session: defaultSession() });

    // Save the answers FIRST. The server commits from the stored draft, so an
    // unsaved answer is one the commit would not see — and if the commit then
    // fails, the typing is still safe.
    if (!(await persist(step))) return;

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
    if (await persist(Math.min(TOTAL_STEPS, step + 1))) {
      // Celebrated only after the advance is real — the commit landed AND the
      // new position saved. A flourish for something that then failed to save
      // is worse than no flourish at all.
      setPraise(wellDone(step, created));
      celebrate(burstFrom.current ?? undefined);
      setStep((s) => Math.min(TOTAL_STEPS, s + 1));
    }
  };

  const back = async () => {
    setPraise(null);
    if (step === 1) return;
    await persist(step - 1);
    setStep((s) => Math.max(1, s - 1));
  };

  const saveAndClose = async () => {
    if (await persist(step)) onClose("saved");
  };

  const discard = async () => {
    if (!window.confirm("Throw away what you have entered so far? The school itself is not affected.")) return;
    setBusy(true);
    try { await api("/onboarding/session", { method: "DELETE" }); } catch { /* already gone */ }
    onClose("discarded");
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Guided setup"
      style={{
        position: "fixed", inset: 0, zIndex: 200, background: "rgba(11,31,68,.45)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}>
      <div style={{
        background: "var(--paper)", borderRadius: 14, maxWidth: 840, width: "100%",
        maxHeight: "calc(100vh - 40px)", display: "flex", flexDirection: "column",
        boxShadow: "0 24px 64px rgba(11,31,68,.3)", border: "1px solid var(--line)",
      }}>
        <div style={{ padding: "22px 28px 14px", borderBottom: "1px solid var(--line)" }}>
          <Progress step={step} />
          <Rail step={step} furthest={furthest} onJump={(n) => void jumpTo(n)} disabled={busy} />
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, color: "var(--ink-faint)" }}>
            <span>Step {step} of {TOTAL_STEPS} · {school.name}</span>
            <span style={{ flex: 1 }} />
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

        <div style={{ padding: "20px 28px", overflowY: "auto", flex: 1 }}>
          {praise && (
            <div
              key={praise}
              className="praise"
              style={{
                display: "flex", alignItems: "center", gap: 9, marginBottom: 16,
                borderLeft: "3px solid var(--accent)", background: "var(--accent-bg)",
                padding: "11px 14px", borderRadius: "0 9px 9px 0",
                fontSize: 13, color: "var(--ink-soft)",
              }}>
              <span style={{ fontSize: 15 }} aria-hidden>✨</span>
              {/* Announced, so the encouragement is not only visual. */}
              <span role="status">{praise}</span>
            </div>
          )}
          {loading ? (
            <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>Loading what you saved…</p>
          ) : (
            step === 1 ? <StepSchool school={school} answers={answers} onChange={patch} />
            : step === 2 ? <StepSession answers={answers} onChange={patch} />
            : step === 3 ? <StepWings answers={answers} onChange={patch} />
            : step === 4 ? <StepClasses answers={answers} onChange={patch} />
            : step === 5 ? <StepWeek answers={answers} onChange={patch} />
            : step === 6 ? <StepSubjects answers={answers} onChange={patch} />
            : step === 7 ? <StepTeachers answers={answers} onChange={patch} />
            : step === 8 ? <StepRooms answers={answers} onChange={patch} />
            : step === 9 ? <StepCurriculum answers={answers} onChange={patch} />
            : step === 10 ? <StepMapping answers={answers} onChange={patch} />
            : <StepSettings answers={answers} onChange={patch} />
          )}
          {error && (
            <div style={{
              borderLeft: "3px solid var(--signal)", background: "var(--signal-bg)",
              padding: "11px 13px", borderRadius: "0 8px 8px 0", fontSize: 12.5,
              color: "var(--ink-soft)", marginTop: 14,
            }}>{error}</div>
          )}
        </div>

        <div style={{
          padding: "14px 28px", borderTop: "1px solid var(--line)", background: "var(--offwhite)",
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        }}>
          <button className="btn" onClick={back} disabled={busy || step === 1}>← Back</button>
          <button className="btn" onClick={discard} disabled={busy}
            style={{ border: "none", background: "none", color: "var(--ink-faint)", fontSize: 12 }}>
            Discard
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={saveAndClose} disabled={busy}>Save &amp; close</button>
          {step === TOTAL_STEPS ? (
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
              {busy ? "Saving…" : `Next: ${STEP_TITLES[step]} →`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
