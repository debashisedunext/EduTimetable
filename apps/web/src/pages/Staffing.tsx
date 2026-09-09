/**
 * §29.2 — Staffing Changes.
 *
 * A teacher resigns, goes on leave, or joins, and their classes have to move
 * without disturbing anybody else's week. This screen opens a change, names the
 * teachers on each side, shows exactly what the leaving teacher carries, and
 * (§29.3) who could take each piece of it. It writes no mapping, no slot and no
 * class teacher — §29.4's apply lands below the plan, and until it does the
 * screen says so rather than pretending.
 *
 * The list is deliberately the whole history, not just the open one: "who
 * taught Class 5-A Maths before September, and why did it move?" is the
 * question a record exists to answer, and a screen that only ever showed the
 * current plan could not answer it.
 */
import { useState } from "react";
import { api } from "../api";
import { asMessage, Card, confirmDelete, ErrorNote, Field } from "../components";
import { useApi, useConfigCtx } from "../hooks";
import { inputStyle } from "./Timetables";
import { ChipPicker } from "../onboarding/steps/ChipPicker";

interface TeacherRef { id: number; name: string }

interface ChangeRow {
  id: number;
  reason: string;
  status: string;
  effectiveFrom: string | null;
  note: string | null;
  createdAt: string;
  appliedAt: string | null;
  releasing: TeacherRef[];
  receiving: TeacherRef[];
  itemCount: number;
}

interface Unit {
  type: "mapping" | "merged_group" | "elective_option" | "class_teacher";
  id: number;
  label: string;
  teacherName: string;
  subjectName: string | null;
  periodsPerWeek: number;
  slotCount: number;
  unpublished: boolean;
}

interface Candidate {
  teacherId: number;
  teacherName: string;
  ok: boolean;
  reasons: string[];
  loadBefore: number;
  loadAfter: number;
  loadCap: number;
}

interface Assignment {
  unit: { type: Unit["type"]; id: number; label: string; periodsPerWeek: number; cells: unknown[] };
  toTeacherId: number | null;
  candidates: Candidate[];
}

interface Plan {
  mode: "replace" | "redistribute";
  scope: { selected: number; available: number };
  plan: {
    assignments: Assignment[];
    covered: number;
    uncovered: number;
    ejections: number;
    loads: Array<{
      teacherId: number; teacherName: string;
      before: number; after: number; cap: number;
      /** §28.1 — at or above the school's own "getting full" line. */
      alert: boolean;
    }>;
  };
}

interface ChangeDetail extends ChangeRow {
  frozen: boolean;
  units: Unit[];
  totals: {
    units: number; lessons: number; classSections: number;
    byType: Record<Unit["type"], number>;
  };
}

const REASONS: Array<{ value: string; label: string; hint: string }> = [
  { value: "resigned", label: "Resigned", hint: "They have left — everything they hold is released" },
  { value: "leave", label: "On leave", hint: "Maternity, sabbatical or long absence" },
  { value: "joined", label: "Someone joined", hint: "A new teacher takes over another's classes" },
  { value: "adjustment", label: "Adjustment", hint: "Rebalancing between teachers who are all staying" },
];

/** The four things that carry "who teaches" (§29.2), in the order a school reads them. */
const TYPE_LABEL: Record<Unit["type"], string> = {
  class_teacher: "Class teacher",
  mapping: "Subject",
  merged_group: "Merged group",
  elective_option: "Elective option",
};

export function Staffing() {
  const { current } = useConfigCtx();
  const { data: changes, refetch } = useApi<ChangeRow[]>(
    current ? `/timetable-configs/${current.id}/staffing-changes` : null,
  );
  const { data: teachers } = useApi<Array<{ id: number; name: string; employmentType?: string; isActive?: boolean }>>("/teachers");
  const [openId, setOpenId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!current) return <p className="screen-sub">Select a timetable first.</p>;

  return (
    <div>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 21, fontWeight: 600, marginBottom: 4 }}>
        Staffing Changes
      </h2>
      <p className="screen-sub" style={{ marginBottom: 14 }}>
        Move a teacher's classes on a timetable that is already published — without touching anybody
        else's week. {current.frozenAt
          ? "This timetable is frozen, so a staffing change is the only way its allocation moves."
          : "This timetable is not frozen; a staffing change still records what moved and why."}
      </p>

      <ErrorNote message={error} />

      <NewChange
        configId={current.id}
        teachers={teachers ?? []}
        onError={setError}
        onCreated={(id) => { setError(null); setOpenId(id); refetch(); }}
      />

      <Card title="History" sub="Newest first. An applied change is kept for ever — it is the school's record of what moved.">
        {(changes ?? []).length === 0 && (
          <p style={{ fontSize: 12.5, color: "var(--ink-faint)", margin: 0 }}>
            Nothing yet. Open a change above when a teacher leaves, goes on leave, or joins.
          </p>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(changes ?? []).map((c) => (
            <ChangeCard
              key={c.id}
              row={c}
              open={openId === c.id}
              onToggle={() => setOpenId(openId === c.id ? null : c.id)}
              onError={setError}
              onChanged={() => { setOpenId(null); refetch(); }}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── opening one

function NewChange({ configId, teachers, onCreated, onError }: {
  configId: number;
  teachers: Array<{ id: number; name: string; employmentType?: string; isActive?: boolean }>;
  onCreated: (id: number) => void;
  onError: (m: string | null) => void;
}) {
  const [reason, setReason] = useState("resigned");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [note, setNote] = useState("");
  const [releasing, setReleasing] = useState<string[]>([]);
  const [receiving, setReceiving] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const byName = (n: string) => teachers.find((t) => t.name === n)?.id;
  /*
    §18 — a guest is never offered the regular curriculum, so they are not on
    the receiving list at all. The server refuses it by name as well; leaving
    them out here means nobody has to be refused to find out.
  */
  const canReceive = teachers.filter((t) => t.employmentType !== "guest" && t.isActive !== false);
  const toggle = (list: string[], set: (v: string[]) => void) => (name: string) =>
    set(list.includes(name) ? list.filter((x) => x !== name) : [...list, name]);

  const submit = async () => {
    setBusy(true);
    try {
      const made = await api<{ id: number }>(`/timetable-configs/${configId}/staffing-changes`, {
        method: "POST",
        body: JSON.stringify({
          reason,
          effectiveFrom: effectiveFrom || null,
          note: note || null,
          releasing: releasing.map(byName).filter(Boolean),
          receiving: receiving.map(byName).filter(Boolean),
        }),
      });
      setReleasing([]); setReceiving([]); setNote(""); setEffectiveFrom("");
      onCreated(made.id);
    } catch (e) {
      onError(asMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const hint = REASONS.find((r) => r.value === reason)?.hint ?? "";

  return (
    <Card title="Open a change" sub="Nothing is written until you apply it — this only decides what is on the table.">
      <div style={{ display: "grid", gridTemplateColumns: "170px 150px 1fr", gap: 12, alignItems: "end" }}>
        <Field label="What happened">
          <select style={inputStyle} value={reason} onChange={(e) => setReason(e.target.value)}>
            {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </Field>
        <Field label="Effective from">
          <input type="date" style={inputStyle} value={effectiveFrom}
            title="Recorded only — a change takes effect when you apply it, never on a date by itself"
            onChange={(e) => setEffectiveFrom(e.target.value)} />
        </Field>
        <Field label="Note (optional)">
          <input style={inputStyle} value={note} maxLength={200} placeholder={hint}
            onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 14 }}>
        <div>
          <div style={LABEL}>Releasing — their classes come free</div>
          <div style={PICKER}>
            <ChipPicker
              all={teachers.map((t) => ({ name: t.name }))}
              chosen={releasing}
              noun="teacher"
              keepOrder
              label="the teachers whose classes are being released"
              onToggle={toggle(releasing, setReleasing)}
            />
          </div>
        </div>
        <div>
          {/*
            Named "may be given work", not "replacing". In the redistribute case
            (§29.3) nobody replaces anybody — several existing teachers each
            take a piece, and the engine decides which.
          */}
          <div style={LABEL}>Receiving — they may be given work</div>
          <div style={PICKER}>
            <ChipPicker
              all={canReceive.map((t) => ({ name: t.name }))}
              chosen={receiving}
              noun="teacher"
              keepOrder
              label="the teachers who may be given the released classes"
              onToggle={toggle(receiving, setReceiving)}
            />
          </div>
        </div>
      </div>

      <button className="btn btn-primary" style={{ marginTop: 14 }}
        disabled={busy || releasing.length === 0} onClick={submit}>
        {busy ? "Opening…" : "Open the change"}
      </button>
      {releasing.length === 0 && (
        <span style={{ fontSize: 11.5, color: "var(--ink-faint)", marginLeft: 10 }}>
          Name at least one teacher whose classes are being released.
        </span>
      )}
    </Card>
  );
}

// ───────────────────────────────────────────────────── one change, expanded

function ChangeCard({ row, open, onToggle, onChanged, onError }: {
  row: ChangeRow;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onError: (m: string | null) => void;
}) {
  const { data: detail } = useApi<ChangeDetail>(open ? `/staffing-changes/${row.id}` : null);

  const discard = async () => {
    if (!confirmDelete(`staffing change #${row.id}`)) return;
    try {
      await api(`/staffing-changes/${row.id}`, { method: "DELETE" });
      onError(null);
      onChanged();
    } catch (e) {
      onError(asMessage(e));
    }
  };

  const reason = REASONS.find((r) => r.value === row.reason)?.label ?? row.reason;

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left",
          padding: "11px 14px", border: "none", background: "none", cursor: "pointer",
        }}
      >
        <span aria-hidden style={{ color: "var(--ink-faint)", fontSize: 11 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontWeight: 600, fontSize: 13 }}>#{row.id} · {reason}</span>
        <span className={`badge ${row.status === "applied" ? "badge-ok" : row.status === "reverted" ? "badge-warn" : ""}`}>
          {row.status}
        </span>
        <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>
          {row.releasing.map((t) => t.name).join(", ") || "nobody"}
          {row.receiving.length > 0 && <> → {row.receiving.map((t) => t.name).join(", ")}</>}
        </span>
        {row.effectiveFrom && (
          <span style={{ fontSize: 11.5, color: "var(--ink-faint)", marginLeft: "auto" }}>
            from {new Date(row.effectiveFrom).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
          </span>
        )}
      </button>

      {open && (
        <div style={{ borderTop: "1px solid var(--line)", padding: "12px 14px" }}>
          {!detail && <p style={{ fontSize: 12.5, color: "var(--ink-faint)", margin: 0 }}>Reading what they carry…</p>}
          {detail && (
            <>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 10, fontSize: 12.5 }}>
                <Stat n={detail.totals.units} label="things to reassign" />
                <Stat n={detail.totals.lessons} label="lessons a week" />
                <Stat n={detail.totals.classSections} label="class-sections affected" />
              </div>

              {detail.units.length === 0 ? (
                <p style={{ fontSize: 12.5, color: "var(--ink-faint)", margin: 0 }}>
                  They teach nothing in this timetable — there is nothing to move.
                </p>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      <th style={TH}>What</th>
                      <th style={TH}>Kind</th>
                      <th style={{ ...TH, textAlign: "right" }}>Periods/week</th>
                      <th style={{ ...TH, textAlign: "right" }}>Lessons placed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.units.map((u) => (
                      <tr key={`${u.type}:${u.id}`}>
                        <td style={TD}>{u.label}</td>
                        <td style={{ ...TD, color: "var(--ink-soft)" }}>{TYPE_LABEL[u.type]}</td>
                        <td style={{ ...TD, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {u.type === "class_teacher" ? "—" : u.periodsPerWeek}
                        </td>
                        <td style={{ ...TD, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {/*
                            Zero means two different things, so it never stands
                            alone: a class-teacher role has no lessons by nature,
                            while a mapping added since the last publish has none
                            YET. Both still have to be reassigned.
                          */}
                          {u.type === "class_teacher"
                            ? <span style={{ color: "var(--ink-faint)" }}>not a lesson</span>
                            : u.unpublished
                              ? <span style={{ color: "var(--amber)" }}>not published yet</span>
                              : u.slotCount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {row.status === "planning" && detail.units.length > 0 && (
                <PlanPanel changeId={row.id} receiving={row.receiving} units={detail.units}
                  onError={onError} onApplied={onChanged} />
              )}

              {/*
                §29.5 — the way back, on the record of what happened.

                Beside the change it undoes, not among the actions that create
                one: this moves a published week, and a control that does that
                standing next to "open a change" is a mis-click with a
                school-wide audience — the same reasoning §3.14 uses for
                Withdraw.
              */}
              {row.status === "applied" && (
                <RevertPanel changeId={row.id} onError={onError} onDone={onChanged} />
              )}

              <div style={{
                marginTop: 12, paddingTop: 10, borderTop: "1px dashed var(--line)",
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap",
              }}>
                <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
                  Nothing above has been written. Applying it is the next step.
                </span>
                {row.status === "planning" && (
                  <button onClick={discard}
                    style={{
                      border: "none", background: "none", padding: 0, cursor: "pointer",
                      fontSize: 12, fontWeight: 600, color: "var(--signal)",
                    }}>
                    Discard this plan
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────── §29.3 who could take it

/**
 * The plan, as a question rather than a commitment.
 *
 * Two modes, and the screen does not choose between them: "somebody joined"
 * usually means replace and "adjustment" usually means redistribute, but a
 * school that hires one teacher for half a leaver's classes and spreads the
 * rest is doing both, and picking for them would take that away.
 */
function PlanPanel({ changeId, receiving, units, onError, onApplied }: {
  changeId: number;
  receiving: TeacherRef[];
  units: Unit[];
  onError: (m: string | null) => void;
  onApplied: () => void;
}) {
  const [mode, setMode] = useState<"replace" | "redistribute">(receiving.length > 1 ? "redistribute" : "replace");
  const [toTeacherId, setToTeacherId] = useState<number | "">(receiving[0]?.id ?? "");
  /**
   * §29.2 — which of the released items are on the table.
   *
   * `null` means all of them, which is what a resignation means and what the
   * panel opens on. An explicit set appears only once somebody unticks
   * something, so the common case sends no filter at all.
   */
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [picking, setPicking] = useState(false);
  /**
   * §29.4 — "leave these unstaffed".
   *
   * Reset whenever the plan changes, so a tick made against one plan can never
   * be applied to a different one: the server refuses regardless, but a
   * checkbox that silently carried over would be an invitation to be refused.
   */
  const [acceptGaps, setAcceptGaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data: teachers } = useApi<Array<{ id: number; name: string; employmentType?: string }>>("/teachers");

  const keyOf = (u: Unit) => `${u.type}:${u.id}`;
  const selected = chosen ?? new Set(units.map(keyOf));
  const toggleUnit = (k: string) => {
    const next = new Set(selected);
    if (next.has(k)) next.delete(k); else next.add(k);
    setChosen(next);
  };
  const scopeQuery = chosen && chosen.size !== units.length
    ? `&units=${encodeURIComponent([...chosen].join(","))}`
    : "";

  const url = selected.size === 0
    ? null
    : mode === "redistribute"
      ? `/staffing-changes/${changeId}/plan?mode=redistribute${scopeQuery}`
      : toTeacherId
        ? `/staffing-changes/${changeId}/plan?mode=replace&toTeacherId=${toTeacherId}${scopeQuery}`
        : null;
  const { data, error } = useApi<Plan>(url);
  if (error) onError(asMessage(error));
  // Keyed on the request, so changing mode, teacher or scope clears the tick.
  const [tickedFor, setTickedFor] = useState<string | null>(null);
  if (acceptGaps && tickedFor !== url) { setAcceptGaps(false); setTickedFor(null); }

  const applyIt = async () => {
    setBusy(true);
    try {
      await api(`/staffing-changes/${changeId}/apply`, {
        method: "POST",
        body: JSON.stringify({
          mode,
          toTeacherId: mode === "replace" ? toTeacherId : undefined,
          units: chosen && chosen.size !== units.length ? [...chosen] : undefined,
          acceptGaps: acceptGaps || undefined,
        }),
      });
      onError(null);
      onApplied();
    } catch (e) {
      onError(asMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const plan = data?.plan;
  const nameOf = (id: number | null) =>
    id === null ? null : plan?.loads.find((l) => l.teacherId === id)?.teacherName
      ?? (teachers ?? []).find((t) => t.id === id)?.name
      ?? `teacher ${id}`;

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <span style={LABEL}>Who takes it</span>
        <div style={{ display: "flex", gap: 4 }}>
          {(["replace", "redistribute"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              style={{
                font: `${mode === m ? 600 : 400} 11.5px/1 Inter`, padding: "5px 10px", borderRadius: 20,
                cursor: "pointer", border: `1px solid ${mode === m ? "var(--brand)" : "var(--line)"}`,
                background: mode === m ? "var(--steel-pale)" : "var(--paper)",
                color: mode === m ? "var(--brand-dark)" : "var(--ink-soft)",
              }}>
              {m === "replace" ? "One teacher takes it all" : "Spread across the receiving list"}
            </button>
          ))}
        </div>
        {mode === "replace" && (
          <select
            style={{ ...inputStyle, width: 200 }}
            aria-label="The teacher taking over"
            value={toTeacherId}
            onChange={(e) => setToTeacherId(e.target.value ? Number(e.target.value) : "")}
          >
            <option value="">— choose a teacher —</option>
            {(teachers ?? []).filter((t) => t.employmentType !== "guest").map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
        {/*
          Hidden behind a link, because narrowing the release is the unusual
          case: a resignation moves everything, and a checkbox column on every
          row would charge every school for the one that does not.
        */}
        <button onClick={() => setPicking(!picking)}
          style={{
            marginLeft: "auto", border: "none", background: "none", padding: 0, cursor: "pointer",
            fontSize: 11.5, fontWeight: 600, color: "var(--brand)",
          }}>
          {selected.size === units.length ? "Move only some of it" : `${selected.size} of ${units.length} chosen`}
        </button>
      </div>

      {picking && (
        <div style={{
          border: "1px solid var(--line)", borderRadius: 8, padding: "8px 10px", marginBottom: 10,
          display: "flex", flexWrap: "wrap", gap: "4px 14px",
        }}>
          {units.map((u) => (
            <label key={keyOf(u)} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input type="checkbox" checked={selected.has(keyOf(u))} onChange={() => toggleUnit(keyOf(u))} />
              {u.label}
            </label>
          ))}
          {selected.size === 0 && (
            <span style={{ fontSize: 11.5, color: "var(--amber)" }}>Choose at least one.</span>
          )}
        </div>
      )}

      {mode === "replace" && !toTeacherId && (
        <p style={{ fontSize: 12.5, color: "var(--ink-faint)", margin: 0 }}>
          Choose who is taking over and the plan appears — nothing is written either way.
        </p>
      )}
      {mode === "redistribute" && receiving.length === 0 && (
        <p style={{ fontSize: 12.5, color: "var(--amber)", margin: 0 }}>
          Nobody is on the receiving list yet. Add the teachers whose weeks may move.
        </p>
      )}

      {plan && (
        <>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 10, fontSize: 12.5 }}>
            <Stat n={plan.covered} label="covered" />
            <span style={{ color: plan.uncovered > 0 ? "var(--signal)" : "var(--ink-soft)" }}>
              <strong style={{ fontVariantNumeric: "tabular-nums" }}>{plan.uncovered}</strong> uncovered
            </span>
            {/*
              §29.3 — said out loud rather than left as a silent improvement.
              A plan that quietly rearranged itself is one nobody can check.
            */}
            {plan.ejections > 0 && (
              <span style={{ color: "var(--ink-faint)" }}>
                {plan.ejections} rearranged to fit
              </span>
            )}
          </div>

          {/*
            The load report. Not a footnote: what a school is really deciding is
            whose week gets heavier, and by how much.
          */}
          {plan.loads.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
              {plan.loads.map((l) => (
                <span key={l.teacherId}
                  title={l.alert ? "At or above this school's load-alert line — a warning, never a refusal" : undefined}
                  style={{
                    font: "500 11.5px/1 Inter", padding: "5px 9px", borderRadius: 20,
                    border: `1px solid ${l.alert ? "var(--amber)" : "var(--line)"}`,
                    background: l.alert ? "#FBF3E4" : "var(--paper)",
                    color: l.alert ? "var(--amber)" : "var(--ink-soft)",
                  }}>
                  {l.teacherName}{" "}
                  <strong style={{ fontVariantNumeric: "tabular-nums" }}>{l.before} → {l.after}</strong>
                  <span style={{ opacity: 0.75 }}> of {l.cap}</span>
                  {l.alert && " ⚠"}
                </span>
              ))}
            </div>
          )}

          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                <th style={TH}>What</th>
                <th style={TH}>Goes to</th>
                <th style={TH}>Why not</th>
              </tr>
            </thead>
            <tbody>
              {plan.assignments.map((a) => (
                <tr key={`${a.unit.type}:${a.unit.id}`}>
                  <td style={TD}>{a.unit.label}</td>
                  <td style={{ ...TD, fontWeight: a.toTeacherId ? 600 : 400 }}>
                    {a.toTeacherId
                      ? nameOf(a.toTeacherId)
                      : <span style={{ color: "var(--signal)" }}>nobody</span>}
                  </td>
                  <td style={{ ...TD, color: "var(--ink-soft)" }}>
                    {a.toTeacherId
                      ? <span style={{ color: "var(--ink-faint)" }}>—</span>
                      : <Blocked candidates={a.candidates} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/*
            The write. Below the table on purpose: what it does is exactly what
            is listed above it, and a button placed before the list would be
            asking somebody to agree to something they have not read.
          */}
          <div style={{
            marginTop: 12, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
          }}>
            <button className="btn btn-primary" style={{ fontSize: 12.5 }}
              disabled={busy || (plan.uncovered > 0 && !acceptGaps)}
              onClick={applyIt}>
              {busy ? "Applying…" : `Apply — move ${plan.covered} of ${plan.assignments.length}`}
            </button>
            {plan.uncovered > 0 && (
              <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5 }}>
                <input type="checkbox" checked={acceptGaps} onChange={(e) => { setAcceptGaps(e.target.checked); setTickedFor(url); }} />
                Leave the {plan.uncovered} uncovered {plan.uncovered === 1 ? "one" : "ones"} as they are
              </label>
            )}
            <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
              {/* Said plainly, because it is the whole promise. */}
              No lesson moves period or room — only who teaches it. This can be undone.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** §29.5 — undo an applied change, from its own record of what it did. */
function RevertPanel({ changeId, onError, onDone }: {
  changeId: number;
  onError: (m: string | null) => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<string[] | null>(null);

  const revert = async () => {
    if (!confirmDelete(`the effect of staffing change #${changeId}`)) return;
    setBusy(true);
    try {
      const r = await api<{ units: number; slots: number; skipped: string[] }>(
        `/staffing-changes/${changeId}/revert`, { method: "POST" },
      );
      onError(null);
      // Named, not counted: "3 could not be put back" is a number nobody can
      // act on, while "Class 5-A Maths has been moved again since" tells
      // somebody where to look.
      if (r.skipped.length > 0) setSkipped(r.skipped);
      else onDone();
    } catch (e) {
      onError(asMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
      {skipped && (
        <p style={{ fontSize: 12.5, color: "var(--amber)", margin: "0 0 8px" }}>
          Put back, except: <strong>{skipped.join(", ")}</strong> — {skipped.length === 1 ? "it has" : "they have"}{" "}
          been moved again since, so {skipped.length === 1 ? "it was" : "they were"} left alone.
        </p>
      )}
      <button onClick={revert} disabled={busy}
        style={{
          border: "none", background: "none", padding: 0, cursor: "pointer",
          fontSize: 12, fontWeight: 600, color: "var(--signal)",
        }}>
        {busy ? "Putting it back…" : "↩ Put these classes back"}
      </button>
    </div>
  );
}

/**
 * Why nobody can take it — EVERY candidate, not just the best one.
 *
 * The single-best version read as one person's problem and sent people to fix
 * the wrong thing. What a school has to see is the shape of the wall: "Rekha is
 * busy Thursday P2 · Anil does not teach Maths · Priya would be over 30 a week"
 * is three different remedies, and only one of them is worth doing.
 */
function Blocked({ candidates }: { candidates: Candidate[] }) {
  if (candidates.length === 0) {
    return <span style={{ color: "var(--amber)" }}>nobody was on the receiving list</span>;
  }
  return (
    <span>
      {candidates.slice(0, 4).map((c, i) => (
        <span key={c.teacherId}>
          {i > 0 && <span style={{ color: "var(--line)" }}> · </span>}
          <strong style={{ fontWeight: 600 }}>{c.teacherName}</strong> {c.reasons.join(", ")}
        </span>
      ))}
      {candidates.length > 4 && (
        <span style={{ color: "var(--ink-faint)" }}> · and {candidates.length - 4} more</span>
      )}
    </span>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <span>
      <strong style={{ fontVariantNumeric: "tabular-nums" }}>{n}</strong>{" "}
      <span style={{ color: "var(--ink-soft)" }}>{label}</span>
    </span>
  );
}

const LABEL: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em",
  color: "var(--ink-faint)", marginBottom: 5,
};
const PICKER: React.CSSProperties = {
  border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", minHeight: 34,
};
const TH: React.CSSProperties = {
  textAlign: "left", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase",
  letterSpacing: "0.06em", color: "var(--ink-faint)", padding: "5px 8px",
  borderBottom: "1px solid var(--line)",
};
const TD: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid var(--line)" };
