import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, switchSchool } from "../api";
import { openOnboarding, resumeOnboarding } from "../onboarding/Onboarding";
import { STEP_TITLES, TOTAL_STEPS } from "../onboarding/OnboardingWizard";
import { Card, ErrorNote, Field } from "../components";
import { useApi, useConfigCtx } from "../hooks";
import { CloneTimetable } from "./CloneTimetable";
import { DeleteTimetable } from "./DeleteTimetable";
import { windowLabel, type MeResponse } from "@edutimetable/shared";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Screen 0 (§8.1): every wing's timetable, built and published independently. */
export function Timetables({ me }: { me: MeResponse }) {
  const { configs, setCurrentId, refetch } = useConfigCtx();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  // §3.12: which timetable's clone form is open, if any.
  const [cloningId, setCloningId] = useState<number | null>(null);
  // §3.13: and which one's delete confirmation. Two states rather than one
  // "openPanel", because they open different forms and mixing them would make
  // "which panel is this?" a question the render has to answer.
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const { data: years } = useApi<{ id: number; name: string }[]>("/academic-years");
  const [name, setName] = useState("");
  // §30.5 — when the new timetable applies. Empty means the whole session,
  // which is what every timetable meant before this existed.
  const [runsFrom, setRunsFrom] = useState("");
  const [runsTo, setRunsTo] = useState("");
  // §30.1 — grouped by default, which is what every timetable was before this.
  const [mode, setMode] = useState<"grouped" | "individual">("grouped");
  const [error, setError] = useState<string | null>(null);
  // A trust admin may run timetables for several schools, so the school is part
  // of creating one. Defaults to the school the session is already in, which is
  // the only option for a single-school user (§17.4).
  const [target, setTarget] = useState(me.school);
  const manySchools = me.schools.length > 1;

  /**
   * §3.10a — creating a timetable is creating a WING, and the next question is
   * which classes it teaches.
   *
   * This used to hand the admin the step-by-step Setup Wizard, which then asked
   * them to build a whole school around the empty timetable, master by master.
   * But a wing is exactly what the guided setup's step 3 produces, so pressing
   * this button finishes that step and opens the next one — the class ladder —
   * rather than starting a second, differently-shaped setup beside it.
   *
   * Two things are deliberately not done here. The wing is recorded in the
   * draft by the SERVER (`POST /onboarding/session/wing`), because with no
   * draft yet it has to rebuild the school's existing answers first or they are
   * lost (§27.12); and the step to open at comes back from that call rather
   * than being typed into the URL, so "which step is Classes?" has one answer.
   */
  const create = async () => {
    const crossSchool = target.id !== me.school.id || target.tenantId !== me.school.tenantId;
    try {
      // Creating "for another school" means being in that school: the server
      // takes the school from the session, never from the request body, so
      // there is no way to create a timetable somewhere you are not (§17).
      if (crossSchool) {
        await switchSchool(target);
        const moved = await api<{ id: number }[]>("/academic-years");
        if (moved.length === 0) {
          setError("That school has no academic year yet — its Setup Wizard starts there.");
          window.location.href = "/setup";
          return;
        }
      }
      const years = await api<{ id: number; name: string }[]>("/academic-years");
      if (years.length === 0) {
        setError("Create an academic year first (Setup Wizard → Academic Year).");
        return;
      }
      /*
        The same year the guided setup's own step 3 picks (`commitWings`), so a
        wing created here and a wing created there land in the same session. A
        draft that names no session — or none at all — falls back to the newest
        year, which is what that step does too.
      */
      const draft = await api<{ answers?: { session?: { name?: string } } }>("/onboarding/session")
        .catch(() => null);
      const year = years.find((y) => y.name === draft?.answers?.session?.name) ?? years[0];

      const created = await api<{ id: number }>("/timetable-configs", {
        method: "POST",
        // Trimmed, because the name is the natural key the guided setup matches
        // wings by — `commitWings`, the §16 importer and the tab strip all
        // compare it, and " Senior Wing" would look like a fourth wing.
        body: JSON.stringify({
          name: name.trim(), academicYearId: year.id,
          effectiveFrom: runsFrom || null, effectiveTo: runsTo || null, mode,
        }),
      });
      const seeded = await api<{ currentStep: number }>(
        `/onboarding/session/wing/${created.id}`, { method: "POST" },
      );
      setCreating(false);
      setName(""); setRunsFrom(""); setRunsTo(""); setMode("grouped");
      // `wing` so step 4 opens on the ladder for THIS wing: on a school that
      // already runs three, landing on the first one's would read as the button
      // having done nothing.
      const to = `/guided-setup?at=${seeded.currentStep}&wing=${encodeURIComponent(name.trim())}`;
      if (crossSchool) {
        // The whole page belongs to the previous school; reload into the new one.
        setCurrentId(created.id);
        window.location.href = to;
        return;
      }
      refetch();
      setCurrentId(created.id);
      navigate(to);
    } catch (e) {
      // The timetable may well exist by now — the draft write is the half that
      // usually fails — so the list is refreshed either way rather than leaving
      // somebody looking at a screen that does not show what they just made.
      if (!crossSchool) refetch();
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    // Wider than the old 880 because each card now carries five actions: at 880
    // the row wrapped under the title on every card, which is the other half of
    // why it looked ragged.
    <div style={{ maxWidth: 1080 }}>
      <ErrorNote message={error} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 16 }}>
        <p className="screen-sub" style={{ margin: 0 }}>
          Every wing runs its own timetable — different timings, periods, and breaks — built and published independently (§3.10).
        </p>
        <div className="actions">
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
        <Card title="New wing">
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
          {/*
            §30.1 — the choice. Worded as what it DOES rather than as its name:
            "individual" and "grouped" are the model's words, and a school
            reading them cold has no way to know which one shares Class 1-A.
          */}
          <Field label="Resources">
            <div style={{ display: "grid", gap: 7 }}>
              {([
                ["grouped", "Shares with the other timetables",
                 "A class-section belongs to one of them, and teacher loads are added up across all of them. This is how every timetable has always worked."],
                ["individual", "Stands on its own",
                 "Its own copy of the classes it covers, and nothing from the other timetables counted against it. One wing only, and only one timetable can be published for a class at a time."],
              ] as const).map(([v, title, why]) => (
                <label key={v} style={{
                  display: "flex", gap: 9, alignItems: "flex-start", cursor: "pointer",
                  border: `1px solid ${mode === v ? "var(--brand)" : "var(--line)"}`,
                  background: mode === v ? "var(--steel-pale)" : "var(--paper)",
                  borderRadius: 9, padding: "9px 11px",
                }}>
                  <input type="radio" name="resource-mode" checked={mode === v}
                    onChange={() => setMode(v)} style={{ marginTop: 3 }} />
                  <span style={{ minWidth: 0 }}>
                    <b style={{ fontSize: 13 }}>{title}</b>
                    <span style={{ display: "block", fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>{why}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
          {/*
            §30.5 — optional dates. Left empty the timetable runs for the whole
            session, which is what it would have done before this feature; a
            school only fills these in when it runs two timetables over the same
            children at different times of year.
          */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Runs from (optional)">
              <input type="date" value={runsFrom} onChange={(e) => setRunsFrom(e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Runs until (optional)">
              <input type="date" value={runsTo} onChange={(e) => setRunsTo(e.target.value)} style={inputStyle} />
            </Field>
          </div>
          <p style={{ fontSize: 11.5, color: "var(--ink-faint)", margin: "-4px 0 12px" }}>
            Leave both empty for the whole session. A class can only be in one <em>published</em>
            timetable at a time, so two timetables covering the same classes need different dates.
          </p>
          {/* §3.10a — say what the button does before it does it. It creates the
              wing and then opens the guided setup on the class ladder, which is
              a different destination from the one it had for the last year. */}
          <p style={{ fontSize: 12, color: "var(--ink-faint)", margin: "0 0 12px" }}>
            A timetable <em>is</em> a wing — its own working days, periods and breaks. This creates
            it and opens the guided setup on <strong>Classes</strong>, to choose which classes it teaches.
          </p>
          <button className="btn btn-primary" onClick={create} disabled={!name.trim()}>
            Create wing & choose classes
          </button>{" "}
          <button className="btn btn-secondary" onClick={() => setCreating(false)}>Cancel</button>
        </Card>
      )}

      <SetupProgress />

      {configs.length === 0 && !creating && (
        <Card><p style={{ color: "var(--ink-faint)", fontSize: 13 }}>No timetables yet — create one and the guided setup picks up from there.</p></Card>
      )}

      {configs.map((c) => (
        deletingId === c.id ? (
          <div key={c.id}>
            <DeleteTimetable
              config={c}
              onCancel={() => setDeletingId(null)}
              onDone={() => { setDeletingId(null); refetch(); }}
            />
          </div>
        ) : cloningId === c.id ? (
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
              {/* The status belongs beside the name — it describes the
                  timetable, not something you can do to it. Standing in the
                  action row it was also the thing making that row ragged: a
                  pill 12px shorter than every button next to it. */}
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <h2 style={{ fontFamily: "var(--font-display)", fontSize: 17 }}>{c.name}</h2>
                <span
                  className={`badge ${c.status === "active" ? "badge-ok" : "badge-warn"}`}
                  title={c.status === "active" ? "Published and in use" : "Not published yet"}
                >
                  {c.status}
                </span>
                {/*
                  §29.1 — beside the status, not instead of it: frozen and
                  active are two different facts, and a school needs both
                  ("published, and settled"). The lock alone would leave
                  "published?" unanswered.
                */}
                {/* §30.1 — only when it is worth saying. A grouped timetable is
                    the normal case and needs no badge; every school before this
                    feature reads exactly what it read before. */}
                {c.resourceMode === "individual" && (
                  <span className="badge" title="Stands on its own — its own classes, and nothing from the other timetables counted against it"
                    style={{ background: "var(--offwhite)", color: "var(--steel)", borderColor: "var(--steel-light)" }}>
                    ⬚ individual
                  </span>
                )}
                {c.frozenAt && (
                  <span className="badge" title="Frozen — the allocation cannot be changed until it is unfrozen"
                    style={{ background: "var(--steel-pale)", color: "var(--brand-dark)", borderColor: "var(--brand)" }}>
                    🔒 frozen
                  </span>
                )}
              </div>
              {/*
                §30.5 — the window where the session already was. `windowLabel`
                returns null for an undated timetable, so a school that never
                uses this reads exactly what it read before.
              */}
              <p style={{ fontSize: 12.5, color: "var(--ink-soft)", margin: "4px 0 8px" }}>
                {c.description ?? "—"} · {c.academicYear}
                {windowLabel(c) && (
                  <> · <strong style={{ color: "var(--brand-dark)" }}>{windowLabel(c)}</strong></>
                )}
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
            {/*
              Five actions, coloured by what they do rather than all alike:
              two blues get on with the work, cyan checks it, grey copies it,
              red destroys it. Every one carries an icon — half of them did and
              half did not, which is most of why the row read as ragged.
            */}
            <div className="actions">
              <button className="btn btn-primary"
                title="Open the step-by-step Setup Wizard for this timetable"
                onClick={() => { setCurrentId(c.id); navigate("/setup"); }}>
                ✎ Edit
              </button>
              {/*
                §24.5c — the other way back in. "Edit" has always meant the
                step-by-step Setup Wizard, which is the wrong tool for somebody
                who built this school through the guided flow and wants to carry
                on there. Adopting reconstructs the guided setup's answers from
                what already exists, so it opens at the first thing still
                missing rather than at question one. Tinted brand rather than
                neutral: it is a sibling of Edit, not of Clone.
              */}
              <button className="btn btn-brand-soft"
                title="Carry on in the guided setup — it fills in what is missing and changes nothing that is already there"
                onClick={() => { setCurrentId(c.id); void adoptAndResume(setError); }}>
                ⚡ Guided
              </button>
              <button className="btn btn-accent-soft"
                title="Can this timetable generate? The Feasibility Engine's score and what to fix"
                onClick={() => { setCurrentId(c.id); navigate("/readiness"); }}>
                ◎ Readiness
              </button>
              {/* §3.12 — next session has the same classes and very nearly the
                  same staffing; retyping 600 rows to change 20 is the point. */}
              <button
                className="btn btn-secondary"
                onClick={() => { setCreating(false); setDeletingId(null); setCloningId(c.id); }}
                title="Copy this timetable's classes, syllabus and staffing into another session"
              >
                ⧉ Clone
              </button>
              {/* §3.13 — the way to undo "I made the wrong wing". Shown for
                  every timetable, because a greyed-out button explains nothing:
                  a published one opens the panel and is refused there, by name,
                  with what to do instead. */}
              <button
                className="btn btn-danger-soft"
                onClick={() => { setCreating(false); setCloningId(null); setDeletingId(c.id); }}
                title="Delete this timetable and everything placed in it — classes, subjects and teachers are kept"
              >
                🗑 Delete
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
