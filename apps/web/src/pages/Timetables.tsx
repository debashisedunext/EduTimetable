import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, switchSchool } from "../api";
import { openOnboarding, resumeOnboarding } from "../onboarding/Onboarding";
import { STEP_TITLES, TOTAL_STEPS } from "../onboarding/OnboardingWizard";
import { Card, ErrorNote, Field } from "../components";
import { useApi, useConfigCtx } from "../hooks";
import { CloneTimetable } from "./CloneTimetable";
import type { MeResponse } from "@edutimetable/shared";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Screen 0 (§8.1): every wing's timetable, built and published independently. */
export function Timetables({ me }: { me: MeResponse }) {
  const { configs, setCurrentId, refetch } = useConfigCtx();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  // §3.12: which timetable's clone form is open, if any.
  const [cloningId, setCloningId] = useState<number | null>(null);
  const { data: years } = useApi<{ id: number; name: string }[]>("/academic-years");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A trust admin may run timetables for several schools, so the school is part
  // of creating one. Defaults to the school the session is already in, which is
  // the only option for a single-school user (§17.4).
  const [target, setTarget] = useState(me.school);
  const manySchools = me.schools.length > 1;

  const create = async () => {
    try {
      // Creating "for another school" means being in that school: the server
      // takes the school from the session, never from the request body, so
      // there is no way to create a timetable somewhere you are not (§17).
      if (target.id !== me.school.id || target.tenantId !== me.school.tenantId) {
        await switchSchool(target);
        const moved = await api<{ id: number }[]>("/academic-years");
        if (moved.length === 0) {
          setError("That school has no academic year yet — its Setup Wizard starts there.");
          window.location.href = "/setup";
          return;
        }
      }
      const years = await api<{ id: number }[]>("/academic-years");
      if (years.length === 0) {
        setError("Create an academic year first (Setup Wizard → Academic Year).");
        return;
      }
      const created = await api<{ id: number }>("/timetable-configs", {
        method: "POST",
        body: JSON.stringify({ name, academicYearId: years[0].id }),
      });
      setCreating(false);
      setName("");
      if (target.id !== me.school.id || target.tenantId !== me.school.tenantId) {
        // The whole page belongs to the previous school; reload into the new one.
        setCurrentId(created.id);
        window.location.href = "/setup";
        return;
      }
      refetch();
      setCurrentId(created.id);
      navigate("/setup");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div style={{ maxWidth: 880 }}>
      <ErrorNote message={error} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <p className="screen-sub" style={{ margin: 0 }}>
          Every wing runs its own timetable — different timings, periods, and breaks — built and published independently (§3.10).
        </p>
        <div style={{ display: "flex", gap: 10 }}>
          {/* §16: skip the hand-entry route entirely and load the masters from a spreadsheet */}
          {/* §15.3 Phase 25.2 — the permanent way back to the three doors. The
              welcome screen stops opening by itself once a school has a
              timetable, or once somebody has waved it away; this is how they
              get to it afterwards, and how a colleague finds it at all. */}
          <button className="btn btn-secondary" onClick={openOnboarding}>✦ Set up a timetable</button>
          <Link to="/import" className="btn btn-secondary" style={{ textDecoration: "none" }}>⬆ Import from Excel</Link>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>＋ New Timetable</button>
        </div>
      </div>

      {creating && (
        <Card title="New Timetable">
          {manySchools ? (
            <Field label="School">
              <select
                value={String(target.tenantId ?? target.id)}
                onChange={(e) =>
                  setTarget(
                    me.schools.find((s) => String(s.tenantId ?? s.id) === e.target.value) ?? me.school,
                  )
                }
                style={inputStyle}
              >
                {me.schools.map((s) => (
                  <option key={s.tenantId ?? s.id} value={String(s.tenantId ?? s.id)}>{s.name}</option>
                ))}
              </select>
            </Field>
          ) : (
            <p style={{ fontSize: 12.5, color: "var(--ink-soft)", margin: "0 0 12px" }}>
              For <strong>{me.school.name}</strong>
            </p>
          )}
          <Field label="Name (e.g. Senior Wing)">
            <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
          </Field>
          <button className="btn btn-primary" onClick={create} disabled={!name.trim()}>Create & open wizard</button>{" "}
          <button className="btn" style={{ border: "1px solid var(--line)" }} onClick={() => setCreating(false)}>Cancel</button>
        </Card>
      )}

      <SetupProgress />

      {configs.length === 0 && !creating && (
        <Card><p style={{ color: "var(--ink-faint)", fontSize: 13 }}>No timetables yet — create one to start the Setup Wizard.</p></Card>
      )}

      {configs.map((c) => (
        cloningId === c.id ? (
          <div key={c.id}>
            <CloneTimetable
              config={c}
              years={years ?? []}
              onCancel={() => setCloningId(null)}
              onDone={(newId) => {
                // Land on the new timetable's wizard: cloning is step one of
                // "adjust, then generate", and the adjusting happens there.
                setCloningId(null);
                refetch();
                setCurrentId(newId);
                navigate("/setup");
              }}
            />
          </div>
        ) : (
        <Card key={c.id}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 17 }}>{c.name}</h2>
              <p style={{ fontSize: 12.5, color: "var(--ink-soft)", margin: "4px 0 8px" }}>
                {c.description ?? "—"} · {c.academicYear}
              </p>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span className="chip mono">{c.workingDays.map((d) => DAY_NAMES[d]).join(" ")}</span>
                <span className="chip mono">{c.periodsPerDay} periods/day</span>
                <span className="chip mono">{c.startTime}–{c.endTime ?? "?"}</span>
                {c.classSections.length > 0 ? (
                  <span className="chip">{c.classSections.length} class-sections</span>
                ) : (
                  <span className="badge badge-error">no classes assigned</span>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className={`badge ${c.status === "active" ? "badge-ok" : "badge-error"}`} style={c.status === "draft" ? { background: "var(--amber-bg)", color: "var(--amber)" } : {}}>
                {c.status}
              </span>
              <button className="btn btn-primary" onClick={() => { setCurrentId(c.id); navigate("/setup"); }}>Edit</button>
              {/*
                §24.5c — the other way back in. "Edit" has always meant the
                step-by-step Setup Wizard, which is the wrong tool for somebody
                who built this school through the guided flow and wants to carry
                on there. Adopting reconstructs the guided setup's answers from
                what already exists, so it opens at the first thing still
                missing rather than at question one.
              */}
              <button className="btn" style={{ border: "1px solid var(--line)" }}
                title="Carry on in the guided setup — it fills in what is missing and changes nothing that is already there"
                onClick={() => { setCurrentId(c.id); void adoptAndResume(setError); }}>
                ⚡ Guided
              </button>
              <button className="btn" style={{ border: "1px solid var(--line)" }} onClick={() => { setCurrentId(c.id); navigate("/readiness"); }}>
                Readiness
              </button>
              {/* §3.12 — next session has the same classes and very nearly the
                  same staffing; retyping 600 rows to change 20 is the point. */}
              <button
                className="btn"
                style={{ border: "1px solid var(--line)" }}
                onClick={() => { setCreating(false); setCloningId(c.id); }}
                title="Copy this timetable's classes, syllabus and staffing into another session"
              >
                ⧉ Clone
              </button>
            </div>
          </div>
        </Card>
        )
      ))}
    </div>
  );
}

export const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 11px", border: "1px solid var(--line)", borderRadius: 8,
  fontSize: 13, fontFamily: "inherit", background: "var(--paper)",
};

/**
 * How far through the guided setup this school is, and the way back into it.
 *
 * On the Timetables page rather than on each timetable card, and the difference
 * is not cosmetic: a card is one `timetable_config`, while the guided setup is
 * one draft per person per SCHOOL that creates the configs in the first place.
 * A progress bar drawn on each card would be the same number repeated, attached
 * to the wrong thing — and would still be showing it on a school with no
 * timetables at all, which is exactly when somebody most needs to see it.
 *
 * Shown only while there is something unfinished. A completed setup is not
 * progress, it is history, and a permanent "11 of 11" would be clutter on every
 * visit forever.
 */
interface SetupState {
  resumeStep: number | null;
  resumeMode: string | null;
  resumeWings?: { name: string; weekReady: boolean }[];
}

function SetupProgress() {
  const [state, setState] = useState<SetupState | null>(null);

  useEffect(() => {
    api<SetupState>("/me/onboarding").then(setState).catch(() => setState(null));
  }, []);

  const step = state?.resumeStep ?? null;
  if (step === null) return null;

  const wings = state?.resumeWings ?? [];
  const done = Math.max(0, step - 1);
  const pct = Math.round((done / TOTAL_STEPS) * 100);
  const next = STEP_TITLES[step - 1] ?? "Settings";

  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 7 }}>
            <strong style={{ fontSize: 14 }}>
              {state?.resumeMode === "ai" ? "✦ Setting up by conversation" : "⚡ Guided setup"}
            </strong>
            <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>
              {done} of {TOTAL_STEPS} done · next up, {next}
            </span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: "var(--steel-pale)", overflow: "hidden" }}>
            <div style={{
              width: `${pct}%`, height: "100%", borderRadius: 3,
              background: "linear-gradient(90deg,var(--brand),var(--accent))",
              transition: "width 520ms cubic-bezier(.22,.68,.36,1)",
            }} />
          </div>

          {/*
            Which wings this is for — and the answer is "all of them".
            A guided setup is one draft for the whole school: step 3 names every
            wing at once and everything after covers all of them, so a progress
            bar per wing would be the same number drawn several times. What IS
            per wing is the week (step 5), which is filled in wing by wing — so
            a two-wing school can be half-way through one step, and this is the
            only place that would show it.
          */}
          {wings.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 9 }}>
              <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
                {wings.length === 1 ? "Wing:" : "Wings:"}
              </span>
              {wings.map((w) => (
                <span
                  key={w.name}
                  title={w.weekReady
                    ? `${w.name}'s week is set`
                    : `${w.name} has no working days or periods yet — step 5`}
                  style={{
                    font: "600 11px/1 Inter", padding: "5px 9px", borderRadius: 20,
                    background: w.weekReady ? "var(--accent-bg)" : "var(--offwhite)",
                    color: w.weekReady ? "var(--accent)" : "var(--ink-faint)",
                    border: `1px solid ${w.weekReady ? "transparent" : "var(--line)"}`,
                  }}>
                  {w.weekReady ? "✓ " : ""}{w.name}
                </span>
              ))}
              {wings.some((w) => !w.weekReady) && (
                <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
                  · ticked once its week is set
                </span>
              )}
            </div>
          )}
        </div>
        <span style={{
          font: "700 15px/1 var(--mono, monospace)", color: "var(--brand-dark)",
        }}>{pct}%</span>
        <button className="btn btn-primary" onClick={resumeOnboarding}>Carry on →</button>
      </div>
    </Card>
  );
}

/**
 * Reconstruct a guided draft from the school, then open the wizard on it.
 *
 * The reconstruction is the server's job — it reads the wings, the week, the
 * subjects and the staff and produces the same `answers` a person would have
 * typed — so nothing here has to know the wizard's shape.
 *
 * A wing whose classes are not on the fixed ladder cannot be described as a
 * range, and is reported rather than guessed at: creating the wrong classes
 * silently would be far worse than saying which wing to use the Setup Wizard
 * for.
 */
async function adoptAndResume(setError: (m: string | null) => void) {
  try {
    const r = await api<{ adopted: boolean; skippedWings: string[] }>(
      "/onboarding/session/adopt", { method: "POST" },
    );
    if (r.skippedWings?.length) {
      setError(
        `Carrying on in the guided setup, but ${r.skippedWings.join(" and ")} could not be included — ` +
          "its classes are not on the standard list, so the guided steps cannot describe it. " +
          "Use Edit for that one.",
      );
    }
    resumeOnboarding();
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
}
