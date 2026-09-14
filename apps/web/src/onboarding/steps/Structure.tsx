/**
 * §15.3 Phase 25.3 — steps 3, 4 and 5: wings, classes, and the week.
 *
 * These are the steps that first put real rows in the database, and how they do
 * it is the point:
 *
 *  - **Classes and sections go through the §16 importer** (`POST
 *    /onboarding/commit/4`), the same pipeline an uploaded spreadsheet uses.
 *    That gives identical validation and, more usefully, idempotency: pressing
 *    Next twice or resuming a draft creates nothing extra.
 *  - **Wings and the week go through the endpoints that already own them** —
 *    `POST /timetable-configs` and `PUT /:id/structure`. §16 is masters only;
 *    period and break structure has always lived here.
 *
 * Nothing in this file writes a row itself.
 */
import { useEffect, useMemo, useState } from "react";
import {
  CLASS_LADDER,
  CLASS_LADDER_SHORT,
  DEFAULT_WING_SECTIONS,
  planClasses,
  planSummary,
  type SchoolShape,
  dayEndsAt,
  halfDayPeriods,
  weeklyCapacity,
  WING_SUGGESTIONS,
  wingRangeFor,
  type WingAnswer,
} from "@edutimetable/shared";
import { api } from "../../api";
import { asMessage } from "../../components";
import { DraftActivities, type ActivityRow } from "../../timetable/Activities";
import { LinkButton } from "./ui";

const DAYS = [
  { n: 1, label: "Mon" }, { n: 2, label: "Tue" }, { n: 3, label: "Wed" },
  { n: 4, label: "Thu" }, { n: 5, label: "Fri" }, { n: 6, label: "Sat" }, { n: 7, label: "Sun" },
];

const label = {
  display: "block", font: "600 11px/1.4 Inter", textTransform: "uppercase" as const,
  letterSpacing: "0.06em", color: "var(--steel)", marginBottom: 5,
};
const input = {
  width: "100%", padding: "8px 11px", border: "1px solid var(--line)", borderRadius: 8,
  fontSize: 13.5, background: "var(--paper)", color: "var(--ink)",
};

export function Note({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warn" | "ok" }) {
  const c = tone === "warn"
    ? { bg: "var(--amber-bg)", line: "var(--amber)" }
    : tone === "ok" ? { bg: "var(--accent-bg)", line: "var(--accent)" }
    : { bg: "var(--steel-pale)", line: "var(--brand)" };
  return (
    <div style={{
      borderLeft: `3px solid ${c.line}`, background: c.bg, padding: "11px 13px",
      borderRadius: "0 8px 8px 0", fontSize: 12.8, color: "var(--ink-soft)", marginTop: 12,
    }}>{children}</div>
  );
}

// ───────────────────────────────────────────────────────── step 3: wings

export function StepWings({ answers, onChange }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}) {
  const wings: WingAnswer[] = answers.wings ?? [];
  const [name, setName] = useState("");
  /**
   * The suggested names, editable before they are added. Held here rather than
   * in the draft because an untouched suggestion is not an answer — nothing the
   * admin has not tapped should reach the server.
   */
  const [suggested, setSuggested] = useState<string[]>(() => WING_SUGGESTIONS.map((s) => s.name));
  /**
   * The wings that are already `timetable_config` rows — which is what decides
   * whether this screen may take one off the list at all (§3.13).
   *
   * Read once on mount rather than derived from the draft, because a resumed or
   * adopted setup has wings in its answers that were created long ago, and a
   * draft cannot tell you which. Empty on failure: the list then offers no
   * removals, which is the safe direction to be wrong in.
   */
  const [created, setCreated] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    api<Array<{ name: string }>>("/timetable-configs")
      .then((cfgs) => { if (live) setCreated(new Set(cfgs.map((c) => c.name.toLowerCase()))); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  const has = (n: string) => wings.some((w) => w.name.toLowerCase() === n.trim().toLowerCase());
  const set = (next: WingAnswer[]) => onChange({ wings: next });

  const add = (
    n: string,
    // The default range and section count live in `shared` — three doors create
    // a wing now, and each used to carry its own copy of 4/9/2.
    range: { fromIndex: number; toIndex: number } = wingRangeFor(n),
    onto: WingAnswer[] = wings,
  ): WingAnswer[] => {
    const trimmed = n.trim();
    if (!trimmed) return onto;
    if (onto.some((w) => w.name.toLowerCase() === trimmed.toLowerCase())) return onto;
    return [...onto, { name: trimmed, ...range, sections: DEFAULT_WING_SECTIONS }];
  };

  const addTyped = () => {
    const next = add(name);
    if (next === wings) return;
    set(next);
    setName("");
  };

  /**
   * Add every suggestion that is not already there, in ONE patch.
   *
   * Three separate `set` calls would each read the same stale `wings` from this
   * render and the last would win, leaving one wing out of three — the classic
   * shape of a bug that looks like the button "sometimes" working.
   */
  const addAll = () =>
    set(WING_SUGGESTIONS.reduce(
      (acc, s, i) => add(suggested[i], { fromIndex: s.fromIndex, toIndex: s.toIndex }, acc),
      wings,
    ));

  const open = WING_SUGGESTIONS.map((s, i) => ({ ...s, typed: suggested[i], i }))
    .filter((s) => !has(s.typed));

  return (
    <>
      <h2 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 22, margin: "0 0 4px" }}>
        Which wings does the school timetable separately?
      </h2>
      <p style={{ fontSize: 13.5, color: "var(--ink-soft)", margin: "0 0 16px" }}>
        A wing gets its own week — its own working days, period count and start time. Most schools
        run two or three. One is perfectly normal.
      </p>

      {wings.length > 0 && (
        <div style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", marginBottom: 14 }}>
          {wings.map((w, i) => (
            <div key={w.name} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 13px",
              borderBottom: i < wings.length - 1 ? "1px solid var(--line)" : "none",
            }}>
              <strong style={{ fontSize: 13.5 }}>{w.name}</strong>
              <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>
                {CLASS_LADDER[w.fromIndex]} – {CLASS_LADDER[w.toIndex]}
              </span>
              <span style={{ flex: 1 }} />
              {/*
                §3.13 — "Remove" is gone for a wing that has been CREATED, and
                the distinction is the whole point.

                It only ever removed the wing from this draft. Once step 3 has
                run the `timetable_config` exists, and nothing on this screen
                takes it away — so the button emptied a row from a list, left
                the timetable standing, and the admin met it again on the
                Timetables screen wondering what "Remove" had done. Deleting a
                timetable is a real operation with a cascade behind it, and it
                belongs on the card where the timetable actually is.

                A wing that has NOT been created yet is a different thing: it is
                a line the admin typed a minute ago, and it is only in the
                draft. Taking that away has to stay possible, or a mistyped name
                is created on Next and comes BACK on the next Next — the draft
                would keep re-proposing a wing already deleted elsewhere.
              */}
              {created.has(w.name.toLowerCase()) ? (
                <span className="chip" style={{ fontSize: 11 }} title="Already created — delete it from the Timetables screen">
                  created
                </span>
              ) : (
                <button className="btn" style={{ padding: "4px 9px", fontSize: 11.5, border: "none", background: "none", color: "var(--signal)" }}
                  title="Take this off the list — it has not been created yet"
                  onClick={() => set(wings.filter((x) => x.name !== w.name))}>Remove</button>
              )}
            </div>
          ))}
        </div>
      )}

      {open.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 7 }}>
            <label style={{ ...label, marginBottom: 0 }}>
              {wings.length === 0 ? "The usual three — tap to add" : "Add another"}
            </label>
            <span style={{ flex: 1 }} />
            {open.length > 1 && (
              <button className="btn" onClick={addAll}
                style={{ padding: "4px 10px", fontSize: 11.5, borderColor: "var(--brand)", color: "var(--brand)" }}>
                Add all {open.length}
              </button>
            )}
          </div>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))" }}>
            {open.map((s) => (
              <div key={s.name} style={{
                display: "flex", alignItems: "center", gap: 8, padding: "9px 10px",
                border: "1px dashed var(--steel-light)", borderRadius: 10, background: "var(--offwhite)",
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* Editable, because "Primary Wing" is a suggestion and a school
                      that calls it "Junior School" should not have to delete ours
                      and retype from scratch. */}
                  <input
                    style={{ ...input, padding: "5px 8px", fontSize: 13, fontWeight: 600 }}
                    value={s.typed}
                    aria-label={`Name for the ${s.name} wing`}
                    onChange={(e) => setSuggested(suggested.map((v, j) => (j === s.i ? e.target.value : v)))}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      set(add(s.typed, { fromIndex: s.fromIndex, toIndex: s.toIndex }));
                    }}
                  />
                  <div style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 4, paddingLeft: 2 }}>
                    {CLASS_LADDER[s.fromIndex]} – {CLASS_LADDER[s.toIndex]}
                  </div>
                </div>
                <button className="btn btn-primary" disabled={!s.typed.trim()}
                  style={{ padding: "5px 11px", fontSize: 12 }}
                  onClick={() => set(add(s.typed, { fromIndex: s.fromIndex, toIndex: s.toIndex }))}>
                  + Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "end" }}>
        <div style={{ flex: 1 }}>
          <label style={label}>{open.length > 0 ? "Or name your own" : "Add a wing"}</label>
          <input style={input} value={name} placeholder="e.g. Pre-Primary"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTyped(); } }} />
        </div>
        <button className="btn btn-primary" onClick={addTyped} disabled={!name.trim()}>+ Add wing</button>
      </div>

      <Note>
        A wing <em>is</em> a timetable — the same <code>timetable_config</code> the rest of the app
        works with. Wings generate, publish and are edited entirely independently of one another.
        {" "}A wing marked <strong>created</strong> already exists as a timetable; to remove one for
        good, delete it on the Timetables screen — that takes its periods and everything placed in
        it with it, which is not something this list can do.
      </Note>
    </>
  );
}

/**
 * Create one config per wing, skipping any that already exist.
 *
 * Returns how many the school now has — not how many were created — because
 * the sentence it feeds ("two wings, each with its own week to come") is about
 * the school, and on a resumed draft nothing new is made.
 */
export async function commitWings(answers: Record<string, any>): Promise<number> {
  const wings: WingAnswer[] = answers.wings ?? [];
  if (wings.length === 0) throw new Error("Add at least one wing.");

  const years = await api<Array<{ id: number; name: string }>>("/academic-years");
  const year = years.find((y) => y.name === answers.session?.name) ?? years[0];
  if (!year) throw new Error("The session was not created — go back to step 2.");

  // Re-read rather than trusting the draft: the wizard may be resuming, or a
  // colleague may have made one. Creating a duplicate name would 409 anyway;
  // skipping is the honest version of the same rule.
  const existing = await api<Array<{ id: number; name: string }>>("/timetable-configs");
  for (const w of wings) {
    if (existing.some((c) => c.name.toLowerCase() === w.name.toLowerCase())) continue;
    await api("/timetable-configs", {
      method: "POST",
      /*
        §30.9 — the pool the wing says it is in.

        The wizard never creates an individual timetable itself (they come from
        the Timetables screen, which is where the choice is offered), so in
        practice this always sends `grouped` and the individual ones are
        skipped above by name. It is sent anyway because the alternative is a
        default that is right only by coincidence: if an individual wing ever
        did reach here it would be created as a wing of the main school, which
        would silently put its classes into the shared pool.
      */
      body: JSON.stringify({
        name: w.name,
        academicYearId: year.id,
        mode: w.individual ? "individual" : "grouped",
      }),
    });
  }
  return wings.length;
}

// ─────────────────────────────────────────────────────── step 4: classes

function Ladder({ wing, onChange }: { wing: WingAnswer; onChange: (w: WingAnswer) => void }) {
  const span = CLASS_LADDER.length - 1;
  const lo = Math.min(wing.fromIndex, wing.toIndex);
  const hi = Math.max(wing.fromIndex, wing.toIndex);

  return (
    <div style={{ background: "var(--offwhite)", border: "1px solid var(--line)", borderRadius: 10, padding: "16px 18px 8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
        {CLASS_LADDER_SHORT.map((c, i) => (
          <span key={c} style={{
            flex: 1, textAlign: "center", fontSize: 10, fontFamily: "var(--mono, monospace)",
            color: i >= lo && i <= hi ? "var(--brand)" : "var(--ink-faint)",
            fontWeight: i >= lo && i <= hi ? 700 : 400,
          }}>{c}</span>
        ))}
      </div>
      <div style={{ position: "relative", height: 26 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 12, height: 4, borderRadius: 3, background: "var(--steel-light)" }} />
        <div style={{
          position: "absolute", top: 12, height: 4, borderRadius: 3, background: "var(--brand)",
          left: `${(lo / span) * 100}%`, width: `${((hi - lo) / span) * 100}%`,
        }} />
        {/* Two handles, not one. A Senior wing runs 9–12; with a single handle
            that means creating Pre-Nursery through 12 and deleting nine
            classes. The Primary case simply never moves the left one. */}
        {(["fromIndex", "toIndex"] as const).map((k) => (
          <input
            key={k}
            type="range" min={0} max={span} value={wing[k]}
            aria-label={k === "fromIndex" ? "First class" : "Last class"}
            onChange={(e) => onChange({ ...wing, [k]: Number(e.target.value) })}
            style={{
              position: "absolute", left: 0, top: 0, width: "100%", height: 26, margin: 0,
              background: "none", pointerEvents: "none", WebkitAppearance: "none", appearance: "none",
            }}
            className="ladder-range"
          />
        ))}
      </div>
    </div>
  );
}

export function StepClasses({ answers, onChange, startWing = null }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
  /**
   * §3.10a — open on this wing rather than the first one.
   *
   * Somebody arriving from "New Timetable" has one wing in mind, and on a
   * school that already runs three, landing on the ladder for Primary Wing
   * reads as the button having done nothing. Read ONCE, as the initial tab: a
   * value that kept re-applying would fight every click on the tab strip.
   */
  startWing?: string | null;
}) {
  const wings: WingAnswer[] = answers.wings ?? [];
  /**
   * §3.10b — what the school already is.
   *
   * This step used to be a pure plan: slider range x sections, computed from
   * the draft and never checked against anything. The §16 importer skips by
   * natural key and has no delete path, so a plan describing a smaller school
   * than exists created nothing, deleted nothing and reported success — the
   * number on screen was simply believed, and it was wrong.
   *
   * Fetched rather than stored in the draft, for the same reason `stampPools`
   * re-reads the pool mode: a copy of a fact about the school, held in a
   * half-finished setup, is a copy that goes stale.
   *
   * Empty on failure, which is the safe direction: the floor then falls back
   * to 1 and this screen behaves exactly as it did before — it may plan too
   * few, and the commit still cannot delete anything.
   */
  const [shape, setShape] = useState<SchoolShape>({});
  const year: string | undefined = answers.session?.name;
  useEffect(() => {
    let live = true;
    api<SchoolShape>(`/onboarding/classes-shape${year ? `?year=${encodeURIComponent(year)}` : ""}`)
      .then((s) => { if (live) setShape(s ?? {}); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [year]);
  const [active, setActive] = useState(() => {
    const want = (startWing ?? "").trim().toLowerCase();
    if (!want) return 0;
    const i = wings.findIndex((w) => w.name.trim().toLowerCase() === want);
    return i < 0 ? 0 : i;
  });
  /*
    §30.9 — clamped, because the list can SHRINK under a stored index.

    The wizard narrows `answers.wings` to the resource pool being set up, so
    switching from a school with three grouped wings to an individual timetable
    leaves one. Without this, `active` still pointed at 2 and the step rendered
    "Add a wing on the previous step first" for a wing that is plainly there.
  */
  const idx = wings.length === 0 ? 0 : Math.min(active, wings.length - 1);
  const wing = wings[idx];
  const { classes, issues } = useMemo(() => planClasses(wings, shape), [wings, shape]);
  const summary = useMemo(() => planSummary({ wings }, shape), [wings, shape]);

  if (!wing) return <Note tone="warn">Add a wing on the previous step first.</Note>;

  /*
    The tightest floor among the classes this wing runs.

    One number, because "sections per class" is one number. It is a floor on
    the box, not on each class: a class whose own floor is higher keeps it,
    applied by `planClasses` and shown in its own row below. Raising the box to
    the widest floor instead would silently widen every other class in the wing.
  */
  const mine = classes.filter((c) => c.wing === wing.name);
  const wingFloor = mine.length === 0 ? 1 : Math.min(...mine.map((c) => c.floor));

  const update = (w: WingAnswer) => onChange({ wings: wings.map((x, i) => (i === idx ? w : x)) });
  const override = (className: string, patch: { sections?: number; removed?: boolean }) =>
    update({ ...wing, overrides: { ...(wing.overrides ?? {}), [className]: { ...(wing.overrides?.[className] ?? {}), ...patch } } });

  return (
    <>
      <h2 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 22, margin: "0 0 4px" }}>
        Which classes does <span style={{ color: "var(--brand)" }}>{wing.name}</span> run?
      </h2>
      <p style={{ fontSize: 13.5, color: "var(--ink-soft)", margin: "0 0 14px" }}>
        Drag both ends of the ladder. Sections are lettered automatically.
      </p>

      {wings.length > 1 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
          {wings.map((w, i) => (
            <button key={w.name} onClick={() => setActive(i)}
              className="btn"
              style={{
                padding: "5px 11px", fontSize: 12,
                background: i === idx ? "var(--brand)" : "var(--paper)",
                color: i === idx ? "#fff" : "var(--ink)",
                borderColor: i === idx ? "var(--brand)" : "var(--line)",
              }}>{w.name}</button>
          ))}
        </div>
      )}

      <label style={label}>Class range</label>
      <Ladder wing={wing} onChange={update} />

      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", marginTop: 14 }}>
        <div>
          <label style={label}>Sections per class</label>
          <input style={input} type="number" min={wingFloor} max={26} value={wing.sections}
            onChange={(e) => update({ ...wing, sections: Number(e.target.value) })} />
          {wingFloor > 1 && (
            <p style={{ fontSize: 11, color: "var(--ink-faint)", margin: "4px 0 0" }}>
              The school already runs {wingFloor} for some of these classes, so that is the fewest.
            </p>
          )}
        </div>
        <div>
          <label style={label}>This wing</label>
          <input style={{ ...input, background: "var(--offwhite)", color: "var(--ink-soft)" }} readOnly
            value={`${summary.perWing.find((p) => p.wing === wing.name)?.classes ?? 0} classes · ${summary.perWing.find((p) => p.wing === wing.name)?.sections ?? 0} sections`} />
        </div>
        <div>
          <label style={label}>All wings</label>
          <input style={{ ...input, background: "var(--offwhite)", color: "var(--ink-soft)" }} readOnly
            value={`${summary.classes} classes · ${summary.sections} sections`} />
        </div>
      </div>

      {issues.length > 0 && (
        <Note tone="warn">
          {issues.map((i, n) => <div key={n}><strong>{i.message}</strong> {i.fix}</div>)}
        </Note>
      )}

      <div style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "auto", maxHeight: 210, marginTop: 14 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead><tr>
            {["Class", "Sections", "Wing", ""].map((h) => (
              <th key={h} style={{
                textAlign: "left", font: "600 10px/1.3 Inter", textTransform: "uppercase",
                letterSpacing: "0.07em", color: "var(--steel)", padding: "8px 11px",
                borderBottom: "1px solid var(--line)", background: "var(--offwhite)",
                position: "sticky", top: 0,
              }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {mine.map((c) => {
              // Always a prefix — letters are assigned in order and nothing is
              // ever deleted — so "which of these are records?" is a count.
              const made = c.existing.length;
              return (
              <tr key={c.className} style={c.outsideRange ? { background: "var(--amber-bg)" } : undefined}>
                <td style={{ padding: "7px 11px", borderBottom: "1px solid var(--line)" }}>
                  {c.className}
                  {/*
                    §3.10c — why this class is here when the slider is not on it.

                    Without the note it simply reappears the moment the range
                    passes it, which reads as a slider that does not work. The
                    range describes what the wing teaches; it cannot un-teach
                    children who are already in a timetable, and the screen that
                    can is named.
                  */}
                  {c.outsideRange && (
                    <span title={`${c.className} is outside this wing's range, but it already has class-sections here. Delete them on the Classes master.`}
                      style={{
                        marginLeft: 7, font: "600 10px/1.5 Inter", color: "var(--amber)",
                        border: "1px solid var(--amber)", borderRadius: 5, padding: "1px 5px",
                      }}>outside the range · already taught</span>
                  )}
                </td>
                <td style={{ padding: "7px 11px", borderBottom: "1px solid var(--line)", fontFamily: "var(--mono, monospace)", fontSize: 11.5 }}>
                  <span style={{ color: "var(--ink-soft)" }}>{c.existing.join(", ")}</span>
                  {c.sections.length > made && (
                    <span style={{ color: "var(--accent)" }}>
                      {made > 0 ? ", " : ""}{c.sections.slice(made).join(", ")}
                      <span style={{ fontFamily: "Inter", fontSize: 10.5, marginLeft: 5 }}>new</span>
                    </span>
                  )}
                </td>
                <td style={{ padding: "7px 11px", borderBottom: "1px solid var(--line)", color: "var(--ink-faint)" }}>{c.wing}</td>
                <td style={{ padding: "4px 11px", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" }}>
                  <input type="number" min={c.floor} max={26} value={c.sections.length} aria-label={`Sections for ${c.className}`}
                    onChange={(e) => override(c.className, { sections: Number(e.target.value) })}
                    style={{ width: 52, padding: "3px 6px", border: "1px solid var(--line)", borderRadius: 6, fontSize: 12 }} />
                  {/*
                    §3.10b — no Remove once this wing teaches the class.

                    The button only dropped the class from the sheet; the §16
                    importer cannot delete, so its rows survived and the grid
                    simply stopped listing children who are still timetabled.
                    A cohort is deleted on the Classes master, which counts
                    what is about to go before it goes (§27.11).
                  */}
                  {made === 0 ? (
                    <button onClick={() => override(c.className, { removed: true })}
                      style={{ marginLeft: 6, border: "none", background: "none", color: "var(--signal)", cursor: "pointer", fontSize: 11.5 }}>
                      Remove
                    </button>
                  ) : (
                    <span title="Already created — remove it on the Classes master"
                      style={{ marginLeft: 6, fontSize: 11, color: "var(--ink-faint)" }}>created</span>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11.5, color: "var(--ink-faint)", margin: "8px 0 0" }}>
        A class with 6 sections next to classes with 4 is one edit here, not a reason to avoid the
        slider. Only the sections marked <span style={{ color: "var(--accent)" }}>new</span> are
        created when you press Next — creating them twice is impossible, so coming back is safe.
        Nothing on this screen deletes anything: a class or section that already exists is removed
        on the Classes master.
      </p>
    </>
  );
}

// ────────────────────────────────────────────────────────── step 5: week

export interface WeekAnswer {
  workingDays: number[];
  periodsPerDay: number;
  periodDurationMins: number;
  startTime: string;
  hasZeroPeriod: boolean;
  breaks: Array<{ afterPeriod: number; name: string; durationMins: number }>;
  /**
   * §28.3/28.4 — assembly, attendance, dispersal.
   *
   * On the WEEK step rather than the Settings step, because they are the shape
   * of the day rather than a rule about generation — they sit next to the
   * breaks they resemble, and they change the times printed beside every
   * period.
   */
  activities?: ActivityRow[];
}

export const defaultWeek = (): WeekAnswer => ({
  workingDays: [1, 2, 3, 4, 5],
  periodsPerDay: 8,
  periodDurationMins: 40,
  startTime: "08:00",
  hasZeroPeriod: false,
  breaks: [
    { afterPeriod: 2, name: "Short Break", durationMins: 15 },
    { afterPeriod: 5, name: "Lunch", durationMins: 30 },
  ],
});

/**
 * §33 — how long one lesson is, per class.
 *
 * A school running Class 1 on 30-minute periods and Class 10 on 60, same start
 * and same finish, is **not** two clocks. 60 is exactly two 30s, so there is one
 * grid of eight 30-minute periods and Class 10's lessons are *double periods*
 * on it — a thing the solver has placed atomically since it was written.
 *
 * That distinction is the whole safety argument. §28.5 refuses two *unaligned*
 * lengths because `uq_teacher_slot` compares period NUMBERS, so an overlap in
 * wall clock is invisible to it. A double period has no such hole: one slot row
 * is written per period in the span, so an hour holds period 1 *and* period 2
 * and the same unique index refuses a teacher who is also in Class 1's second
 * half-hour. It is stricter than the §30 wings route, where the equivalent
 * collision is only a warning.
 *
 * Live rows rather than draft answers, deliberately. A lesson's length is a
 * property of a `timetable_config` that already exists, and it is read by the
 * solver rather than committed through the §16 importer; putting it in the
 * draft would mean it only took effect at the next Next.
 */
interface ClassShape {
  baseDurationMins: number;
  periodsPerDay: number;
  opensAt: string;
  closesAt: string | null;
  breaks: number;
  activities: number;
  allowed: Array<{ span: number; mins: number }>;
  classes: Array<{
    id: number; name: string; span: number; durationMins: number;
    lessonsPerDay: number; leftover: number;
  }>;
}

/**
 * The wing's class lengths, fetched once for the STEP rather than per screen.
 *
 * §33.3 — the table moved behind a link, and the link has to say whether there
 * is anything behind it. "Per class" on every school is a control that teaches
 * nothing; "2 classes differ" is worth a glance. That summary and the dialog
 * are the same rows, so they are one fetch — two would be free to disagree
 * about how many classes differ from the number sitting next to them.
 */
function useClassLengths(wingName: string) {
  const [shape, setShape] = useState<ClassShape | null>(null);
  const [configId, setConfigId] = useState<number | null>(null);

  /*
    Found by NAME, as everything else in this wizard is: the draft describes
    wings by name and has no ids in it at all.
  */
  const reload = async () => {
    // No wing yet (step 3 has not run) — nothing to look up, and asking would
    // be a request per render of an empty step.
    if (!wingName.trim()) { setShape(null); setConfigId(null); return; }
    try {
      const configs = await api<Array<{ id: number; name: string }>>("/timetable-configs");
      const cfg = configs.find((c) => c.name.trim().toLowerCase() === wingName.trim().toLowerCase());
      if (!cfg) { setShape(null); setConfigId(null); return; }
      setConfigId(cfg.id);
      setShape(await api<ClassShape>(`/timetable-configs/${cfg.id}/class-periods`));
    } catch { setShape(null); setConfigId(null); }
  };
  useEffect(() => { void reload(); }, [wingName]);

  return { shape, configId, reload };
}

/**
 * The per-class lesson lengths, in a dialog.
 *
 * §33.3 — it was a table under the week's own form, and that is the wrong
 * place for it twice over: it is the *exception* rather than the setting (most
 * schools run one length for everybody), and it pushed the weekly-capacity
 * note — which every school reads — below the fold. It is a link under the
 * fields it qualifies now, stating what it holds ("2 classes run longer
 * lessons") so nobody has to open it to find out whether anything is there.
 *
 * **The form offers lengths, never a free number.** The server sends the
 * multiples this grid can express, so a length that does not divide the day is
 * not a value the screen can produce — the divisibility rule has one author and
 * no invalid state exists to validate against.
 */
function ClassLengthsDialog({ shape, configId, reload, onClose }: {
  shape: ClassShape;
  configId: number;
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
    Escape on the WINDOW, not on the overlay.

    A `div` receives key events only when something inside it has focus, and
    nothing here is focused on open — so `onKeyDown` on the overlay is a
    handler that looks right and never fires.
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setSpan = async (classId: number, span: number) => {
    setBusy(classId);
    setError(null);
    try {
      await api(`/timetable-configs/${configId}/class-periods`, {
        method: "PUT", body: JSON.stringify({ classId, span }),
      });
      await reload();
    } catch (e) {
      setError(asMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Lesson length per class"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 500, background: "rgba(11,31,68,.45)",
        display: "grid", placeItems: "center", padding: 18,
      }}>
      <div style={{
        background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 14,
        boxShadow: "0 24px 64px rgba(11,31,68,.3)", width: "min(620px,100%)",
        maxHeight: "88vh", display: "flex", flexDirection: "column",
      }}>
        <div style={{ padding: "15px 18px 12px", borderBottom: "1px solid var(--line)" }}>
          <h3 style={{ margin: 0, fontFamily: "Fraunces, Georgia, serif", fontSize: 18 }}>
            How long is one lesson?
          </h3>
          <p style={{ fontSize: 12.3, color: "var(--ink-soft)", margin: "6px 0 0" }}>
            The grid is {shape.periodsPerDay} × {shape.baseDurationMins} min, {shape.opensAt}
            {shape.closesAt ? `–${shape.closesAt}` : ""}
            {shape.breaks > 0 ? ` · ${shape.breaks} break${shape.breaks === 1 ? "" : "s"}` : ""}
            {shape.activities > 0 ? ` · ${shape.activities} activit${shape.activities === 1 ? "y" : "ies"}` : ""}.
            A class on longer lessons takes two or more of these at a time — the day still opens and
            closes together for everybody.
          </p>
        </div>

        <div style={{ overflow: "auto", flex: 1 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead><tr>
              {["Class", "One lesson", "Lessons a day", ""].map((h) => (
                <th key={h} style={{
                  textAlign: "left", font: "600 10px/1.3 Inter", textTransform: "uppercase",
                  letterSpacing: "0.07em", color: "var(--steel)", padding: "8px 14px",
                  borderBottom: "1px solid var(--line)", background: "var(--offwhite)",
                  position: "sticky", top: 0,
                }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {shape.classes.map((c) => (
                <tr key={c.id}>
                  <td style={{ padding: "6px 14px", borderBottom: "1px solid var(--line)" }}>{c.name}</td>
                  <td style={{ padding: "4px 14px", borderBottom: "1px solid var(--line)" }}>
                    <select
                      value={c.span}
                      disabled={busy === c.id}
                      aria-label={`Lesson length for ${c.name}`}
                      onChange={(e) => void setSpan(c.id, Number(e.target.value))}
                      style={{
                        padding: "3px 7px", border: "1px solid var(--line)", borderRadius: 6,
                        fontSize: 12, background: "var(--paper)", color: "var(--ink)",
                      }}
                    >
                      {shape.allowed.map((a) => (
                        <option key={a.span} value={a.span}>
                          {a.mins} min{a.span > 1 ? ` · ${a.span} periods` : ""}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{
                    padding: "6px 14px", borderBottom: "1px solid var(--line)",
                    fontFamily: "var(--mono, monospace)", fontSize: 11.5, color: "var(--ink-faint)",
                  }}>{c.lessonsPerDay}</td>
                  <td style={{ padding: "6px 14px", borderBottom: "1px solid var(--line)", fontSize: 11.5, color: "var(--amber)" }}>
                    {/*
                      The day does not divide by this length, so the last lesson
                      would run past the end of the grid. Said where the number
                      is rather than refused: it is a real state mid-edit, and
                      the school may be about to change the period count next.
                    */}
                    {c.leftover > 0
                      ? `${c.leftover} period${c.leftover === 1 ? "" : "s"} left over`
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 11.5, color: "var(--ink-faint)", flex: 1 }}>
            Saved as you change them — this is a property of the timetable, not of the draft.
          </span>
          <button className="btn btn-primary" style={{ padding: "5px 14px", fontSize: 12.5 }} onClick={onClose}>
            Done
          </button>
        </div>
        {error && <div style={{ padding: "0 18px 14px" }}><Note tone="warn">{error}</Note></div>}
      </div>
    </div>
  );
}

/**
 * §34 — the weekdays that run a shape of their own.
 *
 * A school that works Saturday usually works a SHORT Saturday: four periods of
 * thirty minutes where the rest of the week runs eight of forty. Until now the
 * model could not say it — periods, duration and start time all belonged to the
 * `timetable_config`, so they belonged to every working day at once.
 *
 * Safe where §28.5 is not, and the unique key already says why: `day_of_week`
 * is part of `uq_teacher_slot`, so Saturday's period 3 and Monday's are
 * different cells today and nobody is in two days at once. §28.5's collision is
 * *within* a day; this never crosses one.
 *
 * Live rows rather than draft answers, for the same reason §33's class lengths
 * are: it is a property of a `timetable_config` that already exists and the
 * solver reads it, so putting it in the draft would mean it only took effect at
 * the next Next.
 */
interface DayShapeRow {
  day: number;
  periodsPerDay: number;
  periodDurationMins: number;
  full: boolean;
}

function useDayShapes(wingName: string, workingDays: number[]) {
  const [rows, setRows] = useState<DayShapeRow[] | null>(null);
  const [configId, setConfigId] = useState<number | null>(null);

  const reload = async () => {
    if (!wingName.trim()) { setRows(null); setConfigId(null); return; }
    try {
      const configs = await api<Array<{ id: number; name: string }>>("/timetable-configs");
      const cfg = configs.find((c) => c.name.trim().toLowerCase() === wingName.trim().toLowerCase());
      if (!cfg) { setRows(null); setConfigId(null); return; }
      setConfigId(cfg.id);
      const got = await api<{ days: DayShapeRow[] }>(`/timetable-configs/${cfg.id}/day-shapes`);
      setRows(got.days ?? []);
    } catch { setRows(null); setConfigId(null); }
  };
  /*
    Re-read when the WORKING DAYS change, not only when the wing does.

    Ticking Saturday is what makes a Saturday shape askable at all, and the
    server only returns rows for days the timetable works — so without this the
    prompt below would have nothing to attach itself to until the step was
    left and re-entered.
  */
  useEffect(() => { void reload(); }, [wingName, workingDays.join(",")]);

  return { rows, configId, reload };
}

/**
 * "Is Saturday a half day?" — asked where the day was just ticked.
 *
 * Only for the weekend, deliberately. Monday to Friday being full is the
 * assumption every school shares, and a half/full question against each of them
 * is five questions nobody has. A weekday that genuinely differs is still
 * reachable — the row appears once its shape is not the week's — but it is not
 * *asked*.
 *
 * The default when somebody picks "half" is half the week's periods rounded up
 * (`halfDayPeriods`), in a field they can change. A default is a starting
 * point; the school may run five on a Saturday out of eight.
 */
function DayShapes({ wingName, week, answers }: {
  wingName: string;
  week: WeekAnswer;
  /** The whole draft — see `save` for why this step may have to commit first. */
  answers: Record<string, any>;
}) {
  const { rows, configId, reload } = useDayShapes(wingName, week.workingDays);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (day: number, body: Record<string, unknown>) => {
    if (!configId) return;
    setBusy(day);
    setError(null);
    try {
      /*
        Push the WEEK first when the server has not heard of this day yet.

        Ticking Saturday changes the draft; the `timetable_config` only learns
        about it when the step is committed. The day-shape route refuses a day
        the timetable does not work — rightly, since a shape for a day nobody
        teaches is a row nothing would ever read — so without this, answering
        the question this control exists to ask fails with "add it to the
        working days first", which is precisely what the person just did.

        `changedOnly` because `PUT /:id/structure` rewrites a wing's period
        grid wholesale; this is the same guarded call the wizard makes on Next.
      */
      if (!(rows ?? []).some((r) => r.day === day)) {
        await commitWeeks(answers, { changedOnly: true });
      }
      await api(`/timetable-configs/${configId}/day-shapes`, {
        method: "PUT", body: JSON.stringify({ day, ...body }),
      });
      await reload();
    } catch (e) {
      setError(asMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!rows || configId === null) return null;

  /*
    §34.4 — driven by the DRAFT's working days, not the server's.

    `rows` is what the `timetable_config` currently says, and the draft is
    ahead of it: the week is written on Next. Filtering by the server's list
    got both directions wrong — unticking Saturday left its row on screen
    until the step was committed, and ticking Saturday showed nothing at all,
    so the question this control exists to ask never appeared.

    A weekend day the draft has but the server has not seen is synthesised as
    "full", which is what an unanswered day is.
  */
  const WEEKEND = [6, 7];
  const working = week.workingDays ?? [];
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const shown = working
    .slice()
    .sort((a, b) => a - b)
    .map((day) => byDay.get(day) ?? {
      day, periodsPerDay: week.periodsPerDay, periodDurationMins: week.periodDurationMins, full: true,
    })
    /*
      The weekend, plus any OTHER day already shortened. The second half
      matters: a Wednesday shortened through the API, or one arriving by
      clone, must still be visible and changeable — offering the question for
      Sat/Sun alone would hide a row that is shaping the week.
    */
    .filter((r) => WEEKEND.includes(r.day) || !r.full);
  if (shown.length === 0) return null;

  const dayName = (n: number) => DAYS.find((d) => d.n === n)?.label ?? `Day ${n}`;

  return (
    <div style={{ marginTop: 13 }}>
      {shown.map((r) => (
        <div key={r.day} style={{
          display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
          padding: "7px 10px", marginBottom: 6, borderRadius: 8,
          background: r.full ? "var(--offwhite)" : "var(--amber-bg)",
          border: `1px solid ${r.full ? "var(--line)" : "var(--amber)"}`,
        }}>
          <strong style={{ fontSize: 12.5, minWidth: 34 }}>{dayName(r.day)}</strong>

          {/*
            Two buttons rather than a dropdown: there are exactly two answers,
            and the one somebody is picking is the one they can see is not
            selected.
          */}
          <div style={{ display: "flex", gap: 4 }}>
            {[true, false].map((full) => (
              <button key={String(full)} className="btn" disabled={busy === r.day}
                onClick={() => void save(r.day, full
                  ? { full: true }
                  : {
                      full: false,
                      periodsPerDay: halfDayPeriods(week.periodsPerDay),
                      periodDurationMins: week.periodDurationMins,
                    })}
                style={{
                  padding: "3px 10px", fontSize: 11.5,
                  background: r.full === full ? "var(--brand)" : "var(--paper)",
                  color: r.full === full ? "#fff" : "var(--ink)",
                  borderColor: r.full === full ? "var(--brand)" : "var(--line)",
                }}>{full ? "Full day" : "Half day"}</button>
            ))}
          </div>

          {r.full ? (
            <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
              same as the rest of the week — {r.periodsPerDay} × {r.periodDurationMins} min
            </span>
          ) : (
            <>
              <input style={{ ...input, width: 54 }} type="number" min={1} max={14}
                value={r.periodsPerDay} disabled={busy === r.day}
                aria-label={`Periods on ${dayName(r.day)}`}
                onChange={(e) => void save(r.day, {
                  full: false,
                  periodsPerDay: Number(e.target.value),
                  periodDurationMins: r.periodDurationMins,
                })} />
              <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>periods of</span>
              <input style={{ ...input, width: 58 }} type="number" min={20} max={120}
                value={r.periodDurationMins} disabled={busy === r.day}
                aria-label={`Period length on ${dayName(r.day)}`}
                onChange={(e) => void save(r.day, {
                  full: false,
                  periodsPerDay: r.periodsPerDay,
                  periodDurationMins: Number(e.target.value),
                })} />
              <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>min</span>
            </>
          )}
        </div>
      ))}
      {error && <Note tone="warn">{error}</Note>}
    </div>
  );
}

/**
 * §33.5 — the week on one screen.
 *
 * This step was a single column of full-width sections, each with a block
 * label above it: working days, then four numbers, then breaks, then a
 * three-line note about activities, then the activities, and finally — below
 * the fold — the weekly-capacity readout that every one of those inputs exists
 * to produce. Three problems, and the third is the one that mattered:
 *
 *  1. **The measure was the whole pane.** Since §33 put this step in
 *     `WIDE_STEPS` it has the full width, and a single column simply left half
 *     the screen empty while making the page twice as tall.
 *  2. **Every field cost two lines.** A block label over a 150px input is the
 *     right shape for a form of prose fields and the wrong one for four
 *     numbers that belong on one line.
 *  3. **The answer was last.** "40 periods a week" is what somebody is here to
 *     decide, and it sat under everything, so the number moved while nobody
 *     was looking at it.
 *
 * So: the shape of the day on the left, the things inside it on the right, and
 * the readout in a strip at the TOP where it is next to the controls that
 * change it. Nothing was removed — this is the same five inputs, the same
 * breaks and the same activities.
 */
export function StepWeek({ answers, onChange }: {
  answers: Record<string, any>;
  onChange: (patch: Record<string, any>) => void;
}) {
  const wings: WingAnswer[] = answers.wings ?? [];
  const [active, setActive] = useState(0);
  // §30.9 — same clamp, same reason: the scope switcher can shorten this list.
  const idx = wings.length === 0 ? 0 : Math.min(active, wings.length - 1);
  const wing = wings[idx];

  /*
    Every hook BEFORE the early return below.

    `useClassLengths` and the dialog's open flag sat after it, so a step with
    no wing ran two hooks fewer than a step with one — and React's hook order
    is positional, so the next render with a wing would read this component's
    state out of the wrong slots. The linter catches it; the failure it
    prevents is silent.
  */
  // §33.3 — fetched for the step, so the link's summary and the dialog's rows
  // are the same answer rather than two.
  const { shape, configId, reload } = useClassLengths(wing?.name ?? "");
  const [lengthsOpen, setLengthsOpen] = useState(false);

  if (!wing) return <Note tone="warn">Add a wing on step 3 first.</Note>;

  const weeks: Record<string, WeekAnswer> = answers.weeks ?? {};
  const week = { ...defaultWeek(), ...(weeks[wing.name] ?? {}) };
  const set = (patch: Partial<WeekAnswer>) =>
    onChange({ weeks: { ...weeks, [wing.name]: { ...week, ...patch } } });

  /** How many classes run a lesson longer than one base period. */
  const differing = (shape?.classes ?? []).filter((c) => c.span > 1).length;

  const capacity = weeklyCapacity(week.periodsPerDay, week.workingDays);
  const endsAt = dayEndsAt(week);
  const summary = planSummary({ wings });
  const mine = summary.perWing.find((p) => p.wing === wing.name);

  /** A field label that sits ON one line with its input, not above it. */
  const tight: React.CSSProperties = {
    font: "600 10px/1.3 Inter", textTransform: "uppercase", letterSpacing: "0.06em",
    color: "var(--steel)", display: "block", marginBottom: 4,
  };
  const box: React.CSSProperties = {
    background: "var(--paper)", border: "1px solid var(--line)",
    borderRadius: 11, padding: "14px 16px",
  };
  const heading: React.CSSProperties = {
    font: "800 10px/1 Inter", letterSpacing: "0.08em", textTransform: "uppercase",
    color: "var(--steel)", margin: "0 0 10px",
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <h2 style={{ fontFamily: "Fraunces, Georgia, serif", fontSize: 21, margin: 0 }}>
          How does <span style={{ color: "var(--brand)" }}>{wing.name}</span>'s week run?
        </h2>
        <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
          The ceiling for everything after it — no subject can ask for more than a week holds.
        </span>
      </div>

      {wings.length > 1 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          {wings.map((w, i) => (
            <button key={w.name} onClick={() => setActive(i)} className="btn"
              style={{
                padding: "5px 11px", fontSize: 12,
                background: i === idx ? "var(--brand)" : "var(--paper)",
                color: i === idx ? "#fff" : "var(--ink)",
                borderColor: i === idx ? "var(--brand)" : "var(--line)",
              }}>{w.name}</button>
          ))}
        </div>
      )}

      {/*
        The readout, at the TOP and beside the controls that change it.

        It was the last thing on the page, under the activities — so the one
        number this step exists to produce moved while nobody could see it.
      */}
      <div style={{
        display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
        background: "var(--steel-pale)", border: "1px solid var(--steel-light)",
        borderRadius: 11, padding: "10px 16px", marginBottom: 14,
      }}>
        <span style={{ font: "800 19px/1 Inter", color: "var(--brand-deep)" }}>
          {capacity}
        </span>
        <span style={{ fontSize: 12.5, color: "var(--ink-soft)", marginLeft: -8 }}>
          periods a week
        </span>
        <span style={{ color: "var(--steel-light)" }}>|</span>
        <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
          {week.periodsPerDay} × {week.periodDurationMins} min · {week.workingDays.length} day
          {week.workingDays.length === 1 ? "" : "s"}
        </span>
        {endsAt && (
          <>
            <span style={{ color: "var(--steel-light)" }}>|</span>
            <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
              {week.startTime}–<strong style={{ color: "var(--ink)" }}>{endsAt}</strong>
              {" "}school closes
            </span>
          </>
        )}
        {mine && (
          <span style={{ fontSize: 12, color: "var(--ink-faint)", marginLeft: "auto" }}>
            {mine.classes} classes · {mine.sections} sections
          </span>
        )}
      </div>

      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit,minmax(330px,1fr))", alignItems: "start" }}>

        {/* ───────────────────────────── the shape of the day */}
        <div style={box}>
          <p style={heading}>The day</p>

          <label style={tight}>Working days</label>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 13 }}>
            {DAYS.map((d) => {
              const on = week.workingDays.includes(d.n);
              return (
                <button key={d.n} className="btn"
                  onClick={() => set({
                    workingDays: on
                      ? week.workingDays.filter((x) => x !== d.n)
                      : [...week.workingDays, d.n].sort((a, b) => a - b),
                  })}
                  style={{
                    padding: "4px 9px", fontSize: 11.5,
                    background: on ? "var(--brand)" : "var(--paper)",
                    color: on ? "#fff" : "var(--ink)",
                    borderColor: on ? "var(--brand)" : "var(--line)",
                  }}>{d.label}</button>
              );
            })}
          </div>

          {/*
            §34 — asked where the day was just ticked, not in a panel elsewhere.
            Picking Saturday is the moment "is it a half day?" becomes a real
            question, and an answer given anywhere else is one somebody has to
            go and look for.
          */}
          <DayShapes wingName={wing.name} week={week} answers={answers} />

          {/*
            Four numbers on one line rather than four stacked fields. They are
            read together — "eight forties from eight o'clock" is one sentence
            — and a block label over each turned that sentence into eight rows.
          */}
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit,minmax(104px,1fr))" }}>
            <div>
              <label style={tight}>Periods</label>
              <input style={input} type="number" min={1} max={14} value={week.periodsPerDay}
                onChange={(e) => set({ periodsPerDay: Number(e.target.value) })} />
            </div>
            <div>
              <label style={tight}>Starts</label>
              <input style={input} type="time" value={week.startTime}
                onChange={(e) => set({ startTime: e.target.value })} />
            </div>
            <div>
              <label style={tight}>Each</label>
              <input style={input} type="number" min={20} max={120} value={week.periodDurationMins}
                onChange={(e) => set({ periodDurationMins: Number(e.target.value) })} />
            </div>
            <div>
              <label style={tight}>Zero period</label>
              <select style={input} value={week.hasZeroPeriod ? "yes" : "no"}
                onChange={(e) => set({ hasZeroPeriod: e.target.value === "yes" })}>
                <option value="no">No</option><option value="yes">Yes</option>
              </select>
            </div>
          </div>

          {/*
            §33.3 — the per-class exception, under the number it qualifies
            rather than squeezed into its label. Most schools run one length
            for everybody, so this is the exception; it earns a line, not a
            column.

            Shown only once the wing IS a timetable and teaches somebody:
            before step 5 there is no config to hold the answer, and a link to
            an empty dialog is worse than no link.
          */}
          {shape && shape.classes.length > 0 && (
            <div style={{ marginTop: 11, fontSize: 12, color: "var(--ink-faint)" }}>
              {differing > 0
                ? `${differing} class${differing === 1 ? "" : "es"} run longer lessons`
                : "Every class runs the same length"}
              {" · "}
              <LinkButton onClick={() => setLengthsOpen(true)}>
                {differing > 0 ? "review" : "set per class"}
              </LinkButton>
            </div>
          )}
        </div>

        {/* ───────────────────────────── what sits inside it */}
        <div style={box}>
          <p style={heading}>Breaks</p>
          {week.breaks.length === 0 && (
            <p style={{ fontSize: 12, color: "var(--ink-faint)", margin: "0 0 9px" }}>
              None yet — a lunch break is the usual one.
            </p>
          )}
          {week.breaks.map((b, i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 7, alignItems: "center" }}>
              <input style={{ ...input, flex: 1, minWidth: 0 }} value={b.name} aria-label={`Break ${i + 1} name`}
                onChange={(e) => set({ breaks: week.breaks.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)) })} />
              <span style={{ fontSize: 11.5, color: "var(--ink-faint)", whiteSpace: "nowrap" }}>after P</span>
              <input style={{ ...input, width: 52 }} type="number" min={1} max={week.periodsPerDay} value={b.afterPeriod}
                aria-label={`Break ${i + 1} follows which period`}
                onChange={(e) => set({ breaks: week.breaks.map((x, n) => (n === i ? { ...x, afterPeriod: Number(e.target.value) } : x)) })} />
              <input style={{ ...input, width: 58 }} type="number" min={5} max={120} value={b.durationMins}
                aria-label={`Break ${i + 1} minutes`}
                onChange={(e) => set({ breaks: week.breaks.map((x, n) => (n === i ? { ...x, durationMins: Number(e.target.value) } : x)) })} />
              <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>min</span>
              <button onClick={() => set({ breaks: week.breaks.filter((_, n) => n !== i) })}
                aria-label={`Remove break ${i + 1}`}
                style={{ border: "none", background: "none", color: "var(--signal)", cursor: "pointer", fontSize: 13, padding: "0 2px" }}>✕</button>
            </div>
          ))}
          <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }}
            onClick={() => set({ breaks: [...week.breaks, { afterPeriod: Math.min(week.periodsPerDay, week.breaks.length + 3), name: "Break", durationMins: 15 }] })}>
            + Add a break
          </button>

          {/*
            §28.3/28.4 — beside the breaks, because that is what they are next
            to on a real timetable. An assembly is not a rule about generation;
            it is part of the shape of the day.
          */}
          <p style={{ ...heading, marginTop: 18 }}>Before and after the day</p>
          <p style={{ fontSize: 11.8, color: "var(--ink-faint)", margin: "0 0 9px" }}>
            Assembly, attendance, dispersal. The solver never places a lesson in one.
          </p>
          <DraftActivities
            rows={week.activities ?? []}
            onChange={(next: ActivityRow[]) => set({ activities: next })}
            staff={[]}
            rooms={[]}
            workingDays={week.workingDays}
          />
        </div>
      </div>

      {lengthsOpen && shape && configId !== null && (
        <ClassLengthsDialog
          shape={shape}
          configId={configId}
          reload={reload}
          onClose={() => setLengthsOpen(false)}
        />
      )}
    </>
  );
}

/**
 * Write each wing's week through the endpoint that already owns it.
 *
 * `only` narrows it to the wings whose week actually differs from what the
 * server holds. §28's Allocation grid can change a period's LENGTH, and it
 * calls this on the way past — but `PUT /:id/structure` rewrites the period
 * rows wholesale, so re-pushing an unchanged week would rebuild the whole grid
 * for nothing. Narrow, not unconditional.
 */
export async function commitWeeks(
  answers: Record<string, any>,
  only?: { changedOnly: true },
): Promise<void> {
  const wings: WingAnswer[] = answers.wings ?? [];
  const weeks: Record<string, WeekAnswer> = answers.weeks ?? {};
  const configs = await api<Array<{
    id: number; name: string; periodsPerDay: number; periodDurationMins: number;
    workingDays: unknown; startTime: string;
  }>>("/timetable-configs");

  for (const w of wings) {
    if (only?.changedOnly) {
      const c = configs.find((x) => x.name.toLowerCase() === w.name.toLowerCase());
      const week = { ...defaultWeek(), ...(weeks[w.name] ?? {}) };
      const days = Array.isArray(c?.workingDays) ? c!.workingDays.length : -1;
      const same = c
        && c.periodDurationMins === week.periodDurationMins
        && c.periodsPerDay === week.periodsPerDay
        && c.startTime?.slice(0, 5) === week.startTime.slice(0, 5)
        && days === week.workingDays.length;
      if (same) continue;
    }
    const config = configs.find((c) => c.name.toLowerCase() === w.name.toLowerCase());
    if (!config) throw new Error(`${w.name} has no timetable yet — go back to step 3.`);
    const week = { ...defaultWeek(), ...(weeks[w.name] ?? {}) };
    if (week.workingDays.length === 0) throw new Error(`${w.name} needs at least one working day.`);
    // `PUT /:id/structure` rewrites the period rows wholesale, so running it
    // twice is the same as running it once — no bookkeeping needed here either.
    await api(`/timetable-configs/${config.id}/structure`, {
      method: "PUT",
      body: JSON.stringify({
        startTime: week.startTime,
        periodsPerDay: week.periodsPerDay,
        periodDurationMins: week.periodDurationMins,
        workingDays: week.workingDays,
        hasZeroPeriod: week.hasZeroPeriod,
        breaks: week.breaks,
      }),
    });
    /**
     * §28.3/28.4, AFTER the structure and not before it.
     *
     * `PUT /:id/structure` rebuilds the period rows wholesale from the config
     * plus whatever activities the table holds, and `PUT /:id/activities`
     * replaces the table and rebuilds again. Either order ends correct, but
     * this one ends correct for the right reason: the activities are written
     * last, so the final rebuild is the one that has seen them.
     */
    await api(`/timetable-configs/${config.id}/activities`, {
      method: "PUT",
      body: JSON.stringify({ activities: (week.activities ?? []).map((a, i) => ({ ...a, sortOrder: i })) }),
    });
  }
}
