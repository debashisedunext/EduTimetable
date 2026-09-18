import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, switchSchool } from "../api";
import { openOnboarding, resumeOnboarding } from "../onboarding/Onboarding";
import { Card, ErrorNote, Field } from "../components";
import { PageActions } from "../page-actions";
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
  /*
    §24.9 — one request for every timetable's progress, not one per card.
    Refetched beside `configs`, because creating or deleting a timetable
    changes the list this is keyed on.
  */
  const { data: progress, refetch: refetchProgress } = useApi<ConfigSetup[]>("/onboarding/progress");
  const setupOf = new Map((progress ?? []).map((p) => [p.id, p]));
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
      refetchProgress();
      setCurrentId(created.id);
      navigate(to);
    } catch (e) {
      // The timetable may well exist by now — the draft write is the half that
      // usually fails — so the list is refreshed either way rather than leaving
      // somebody looking at a screen that does not show what they just made.
      if (!crossSchool) { refetch(); refetchProgress(); }
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    /*
      §8.7 — no `maxWidth`.

      It was 1080, which on a 1,900px screen left a third of the page empty to
      the right of every card. The card is what fills the width now: its body
      is two columns, identity on the left and this timetable's setup on the
      right, so the space goes to the most informative thing on the screen
      rather than to a stretched gap between a name and five buttons.
    */
    <div>
      <ErrorNote message={error} />
      {/*
        §8.7 — the three primary actions live in the top bar's action slot.

        They had a header row of their own: a line of the page spent on three
        controls, with the prose on the left and several hundred pixels of
        nothing between. The bar already ends in empty space, and the split it
        draws is the right one — where you can go on the left, what you can do
        here on the right.
      */}
      <PageActions>
        {/* §15.3 Phase 25.2 — the permanent way back to the three doors. The
            welcome screen stops opening by itself once a school has a
            timetable, or once somebody has waved it away; this is how they get
            to it afterwards, and how a colleague finds it at all. */}
        <button className="btn btn-secondary" onClick={openOnboarding}>✦ Set up</button>
        {/* §16: skip the hand-entry route entirely and load the masters from a
            spreadsheet. Also reachable from More — kept here because it is one
            of the three ways a school starts, and the place it is looked for. */}
        <Link to="/import" className="btn btn-secondary" style={{ textDecoration: "none" }}>⬆ Import</Link>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>＋ New Timetable</button>
      </PageActions>
      <p className="screen-sub" style={{ margin: "0 0 14px" }}>
        Every wing runs its own timetable — different timings, periods, and breaks — built and published independently (§3.10).
      </p>

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
          <div className="grid2" style={{ gap: 10 }}>
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

      {configs.length === 0 && <NoTimetablesYet />}

      {configs.map((c) => (
        deletingId === c.id ? (
          <div key={c.id}>
            <DeleteTimetable
              config={c}
              onCancel={() => setDeletingId(null)}
              onDone={() => { setDeletingId(null); refetch(); refetchProgress(); }}
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
          {/* §8.7 — three areas, so a wide screen puts the setup beside the
              identity rather than leaving the middle of the card empty. */}
          <div className="tt-card">
            <div className="tt-main">
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
                {/*
                  §29.8 — "locked", not "frozen".

                  The word changed with the meaning: publishing now does this
                  rather than a separate press, and what a school does next is
                  unlock a class or a teacher rather than thaw the lot. A badge
                  saying "frozen" would describe a button nobody pressed.
                */}
                {c.frozenAt && (
                  <span className="badge" title="Locked — published, and settled. Unlock the classes or teachers you need to re-plan."
                    style={{ background: "var(--steel-pale)", color: "var(--brand-dark)", borderColor: "var(--brand)" }}>
                    🔒 locked
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
            <div className="actions tt-actions">
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
                onClick={() => { setCurrentId(c.id); void adoptAndResume(setError, navigate); }}>
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
            {/* §24.9 — this timetable's own progress, in this timetable's own
                card. The old bar sat above all of them and belonged to none. */}
            <div className="tt-setup">
            <SetupStrip
            setup={setupOf.get(c.id)}
            onCarryOn={(st) => {
              // The timetable first, always: every destination is scoped by the
              // top bar's selection (§30.13), so landing on the Lesson grid or
              // the wizard pointed at a different wing would be worse than not
              // going at all.
              setCurrentId(c.id);
              if (st.route) { navigate(st.route); return; }
              void adoptAndResume(setError, navigate, st.step);
            }}
            />
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
 * §24.9 — how far a TIMETABLE is, read from the timetable.
 *
 * ## What was wrong with the old one
 *
 * It drew one bar for the WHOLE SCHOOL, above every card, from
 * `(onboarding draft's current_step - 1) / 10`. Three separate faults, all
 * reported at once:
 *
 *  - **It measured a cursor, not the school.** `current_step` is where somebody
 *    last clicked. Opening the wizard to look at step 3 sent a fully generated
 *    school back to 20%, and it stayed there.
 *  - **It could never reach 100%.** Nothing in it knew the timetable had been
 *    generated, which is the thing the whole setup exists to reach.
 *  - **It belonged to no timetable.** One number above two wings describes
 *    neither of them, and read as a claim about both.
 *
 * Every milestone here is a fact about the database, computed per
 * `timetable_config` on the server, so the only way to move the bar is to
 * create the thing it counts.
 *
 * The school-wide version survives for exactly one case — a school with **no
 * timetables at all**, where there is no card to attach anything to and where
 * somebody most needs the way in.
 */
export interface SetupStep {
  key: string;
  label: string;
  done: boolean;
  step: number | null;
  route: string | null;
  hint: string;
}
export interface ConfigSetup {
  id: number;
  steps: SetupStep[];
  done: number;
  total: number;
  pct: number;
  generated: boolean;
  published: boolean;
  nextStep: number | null;
  nextRoute: string | null;
  nextLabel: string | null;
}

function Bar({ pct, complete }: { pct: number; complete: boolean }) {
  return (
    <div style={{ height: 6, borderRadius: 3, background: "var(--steel-pale)", overflow: "hidden", flex: 1, minWidth: 90 }}>
      <div style={{
        width: `${pct}%`, height: "100%", borderRadius: 3,
        background: complete
          ? "var(--accent)"
          : "linear-gradient(90deg,var(--brand),var(--accent))",
        transition: "width 520ms cubic-bezier(.22,.68,.36,1)",
      }} />
    </div>
  );
}

/** One timetable's progress, inside that timetable's card. */
function SetupStrip({
  setup, onCarryOn,
}: {
  setup: ConfigSetup | undefined;
  onCarryOn: (step: SetupStep) => void;
}) {
  if (!setup) return null;
  const next = setup.steps.find((s) => !s.done) ?? null;

  /*
    Finished is a STATE with something to say, not an absent bar.

    "Nothing to show once it is done" was the old rule and it is why a school
    that had generated its week got no acknowledgement anywhere — the thing it
    had been working towards simply stopped being mentioned.
  */
  if (!next) {
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
        borderRadius: 9, background: "var(--accent-bg)", border: "1px solid var(--accent)",
      }}>
        <span style={{ fontSize: 14 }}>✓</span>
        <strong style={{ fontSize: 12.5, color: "var(--accent)" }}>
          {setup.published
            ? "Set up and published — this timetable is on the wall."
            : "Set up and generated — this timetable is ready to publish."}
        </strong>
        <Bar pct={100} complete />
        <span style={{ font: "700 13px/1 var(--font-mono)", color: "var(--accent)" }}>100%</span>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12.5 }}>⚡ Setup</strong>
        <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>
          {setup.done} of {setup.total} done · next up, {next.label}
        </span>
        <Bar pct={setup.pct} complete={false} />
        <span style={{ font: "700 13px/1 var(--font-mono)", color: "var(--brand-dark)" }}>{setup.pct}%</span>
        <button className="btn btn-primary" style={{ padding: "6px 11px", fontSize: 12 }}
          title={next.hint}
          onClick={() => onCarryOn(next)}>
          Carry on →
        </button>
      </div>
      {/*
        The milestones themselves, because "6 of 8" tells somebody how far they
        are and not what is missing — and what is missing is the only part they
        can act on. Each carries its own `hint` from the server, which is also
        what the Carry on button obeys, so the two cannot point different ways.
      */}
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 9 }}>
        {setup.steps.map((st) => (
          <span key={st.key} title={st.done ? `${st.label} — done` : st.hint}
            style={{
              font: "600 11px/1 Inter", padding: "5px 9px", borderRadius: 20,
              background: st.done ? "var(--accent-bg)" : "var(--offwhite)",
              color: st.done ? "var(--accent)" : "var(--ink-faint)",
              border: `1px solid ${st.done ? "transparent" : "var(--line)"}`,
            }}>
            {st.done ? "✓ " : ""}{st.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The way in for a school with NO timetables.
 *
 * The only thing the school-wide banner is still right about: there is no card
 * to attach progress to, and this is exactly when somebody needs the door most.
 * It carries no percentage — nothing has been started, and "0%" is a number
 * pretending to be a measurement.
 */
function NoTimetablesYet() {
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <strong style={{ fontSize: 14 }}>⚡ Guided setup</strong>
          <p style={{ fontSize: 12.5, color: "var(--ink-faint)", margin: "4px 0 0" }}>
            No timetables yet. The guided setup asks for your classes, week, subjects and staff, and
            creates the first one — each timetable then shows its own progress here.
          </p>
        </div>
        <button className="btn btn-primary" onClick={resumeOnboarding}>Start →</button>
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
async function adoptAndResume(
  setError: (m: string | null) => void,
  go: (to: string) => void,
  at?: number | null,
) {
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
    /*
      §24.9 — open at the step that is actually missing, when one was named.

      `resumeOnboarding` reopens the draft at its stored `current_step`, which
      is where somebody last clicked — the very thing that made the progress
      bar wrong. With a milestone in hand the destination is known, and `?at=`
      is already how the welcome flow and the §24.6 chat hand-over say it.
    */
    if (at != null) go(`/guided-setup?at=${at}`);
    else resumeOnboarding();
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
}
