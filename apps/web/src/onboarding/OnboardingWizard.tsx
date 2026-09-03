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
import { useEffect, useState } from "react";
import { api } from "../api";
import { asMessage } from "../components";
import { commitWeeks, commitWings, StepClasses, StepWeek, StepWings } from "./steps/Structure";
import { StepSubjects, StepTeachers } from "./steps/People";
import { defaultSettings, StepCurriculum, StepMapping, StepRooms, StepSettings } from "./steps/Syllabus";
import { planClasses, type SubjectAnswer, type TeacherAnswer } from "@edutimetable/shared";

export const TOTAL_STEPS = 11;

export const STEP_TITLES = [
  "School", "Session", "Wings", "Classes", "Timetable", "Subjects",
  "Teachers", "Rooms", "Curriculum", "Mapping", "Settings",
];

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

function Rail({ step }: { step: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: 8, marginBottom: 18 }}>
      {STEP_TITLES.map((label, i) => {
        const n = i + 1;
        const state = n < step ? "done" : n === step ? "now" : "todo";
        return (
          <div key={label} style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
            {i > 0 && <span style={{ width: 10, height: 1, background: "var(--line)", margin: "0 5px" }} />}
            <span style={{
              display: "flex", alignItems: "center", gap: 5, fontSize: 11, whiteSpace: "nowrap",
              color: state === "now" ? "var(--brand)" : "var(--ink-faint)",
              fontWeight: state === "now" ? 600 : 400,
            }}>
              <span style={{
                width: 20, height: 20, borderRadius: "50%", display: "grid", placeItems: "center",
                font: "600 10px/1 var(--mono, monospace)",
                background: state === "done" ? "var(--accent)" : state === "now" ? "var(--brand)" : "var(--paper)",
                color: state === "todo" ? "var(--ink-faint)" : "#fff",
                border: `1.5px solid ${state === "todo" ? "var(--line)" : "transparent"}`,
              }}>{state === "done" ? "✓" : n}</span>
              {/* Only the current step is named, or eleven labels wrap into a wall */}
              {state === "now" && label}
            </span>
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

  const problem = (): string | null => {
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
  const commitStep = async (n: number) => {
    if (n === 2) await api("/onboarding/commit/2", { method: "POST" });
    if (n === 3) await commitWings(answers);
    if (n === 4) await api("/onboarding/commit/4", { method: "POST" });
    if (n === 5) await commitWeeks(answers);
    // Steps 6–10 all go through the §16 importer, which is what makes them
    // idempotent — pressing Next twice, or coming back, creates nothing extra.
    if (n >= 6 && n <= 10) await api(`/onboarding/commit/${n}`, { method: "POST" });
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
    onClose("saved");
  };

  const next = async () => {
    const bad = problem();
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
    try {
      await commitStep(step);
    } catch (e) {
      setError(asMessage(e));
      setBusy(false);
      return;
    }
    setBusy(false);
    if (await persist(Math.min(TOTAL_STEPS, step + 1))) setStep((s) => Math.min(TOTAL_STEPS, s + 1));
  };

  const back = async () => {
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
          <Rail step={step} />
          <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
            Step {step} of {TOTAL_STEPS} · {school.name}
          </div>
        </div>

        <div style={{ padding: "20px 28px", overflowY: "auto", flex: 1 }}>
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
            <button className="btn btn-primary" onClick={finish} disabled={busy}>
              {busy ? "Finishing…" : "Finish setup →"}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={next} disabled={busy}>
              {busy ? "Saving…" : `Next: ${STEP_TITLES[step]} →`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
