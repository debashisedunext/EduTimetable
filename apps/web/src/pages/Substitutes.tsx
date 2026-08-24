import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import { api, getToken } from "../api";
import { asMessage, Card, DataTable, ErrorNote, Field } from "../components";
import { useApi } from "../hooks";
import { inputStyle } from "./Timetables";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface AbsenceRow {
  id: number;
  teacherId: number;
  teacherName: string;
  date: string;
  reason: string | null;
  status: string;
  substitutionCount: number;
}
interface Candidate { teacherId: number; name: string; score: number; reasons: string[] }
interface PlanSlot {
  slot: { slotId: string; classSectionLabel: string; period: number; subjectName: string; viaSubstitution?: boolean };
  candidates: Candidate[];
  assigned: number | null;
  fallback: string | null;
}
interface PlanResponse {
  absence: { id: number; teacherId: number; teacherName: string; date: string; dayOfWeek: number; reason: string | null; status: string };
  plan: { slots: PlanSlot[]; coveredCount: number; unmatchedCount: number };
  confirmed: Array<{ slotId: string; period: number; classSectionLabel: string; subjectName: string; substituteName: string }>;
}

const initials = (name: string) => name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const fmtDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** Screen 7 (§8.2) — Substitute Teacher Center: matches computed the moment an
 *  absence is logged; Confirm All writes date-scoped overlays (§6.2). */
export function Substitutes() {
  const today = new Date().toISOString().slice(0, 10);
  const { data: absences, refetch: refetchAbsences } = useApi<AbsenceRow[]>("/absences");
  const { data: teachers } = useApi<any[]>("/teachers");
  const [form, setForm] = useState({ teacherId: "", date: today, reason: "" });
  const [openId, setOpenId] = useState<number | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [choices, setChoices] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadPlan = async (id: number) => {
    setOpenId(id);
    setError(null);
    setNote(null);
    try {
      const p = await api<PlanResponse>(`/absences/${id}/plan`);
      setPlan(p);
      const c: Record<string, number> = {};
      for (const s of p.plan.slots) if (s.assigned !== null) c[s.slot.slotId] = s.assigned;
      setChoices(c);
    } catch (e) { setError(asMessage(e)); setPlan(null); }
  };

  useEffect(() => {
    const socket = io({ auth: { token: getToken() } });
    socket.on("substitutions:changed", () => {
      refetchAbsences();
      if (openId !== null) loadPlan(openId);
    });
    return () => { socket.disconnect(); };
  }, [openId]);

  const report = async () => {
    setBusy(true);
    try {
      const res = await api<{ id: number }>("/absences", {
        method: "POST",
        body: JSON.stringify({ teacherId: Number(form.teacherId), date: form.date, reason: form.reason || undefined }),
      });
      setError(null);
      setForm({ ...form, teacherId: "", reason: "" });
      refetchAbsences();
      await loadPlan(res.id);
    } catch (e) { setError(asMessage(e)); } finally { setBusy(false); }
  };

  const confirmAll = async () => {
    if (!plan) return;
    const assignments = Object.entries(choices).map(([slotId, substituteTeacherId]) => ({ slotId, substituteTeacherId }));
    if (assignments.length === 0) { setError("Nothing to confirm — no slot has an eligible substitute selected."); return; }
    setBusy(true);
    try {
      const res = await api<{ confirmed: number }>(`/absences/${plan.absence.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ assignments }),
      });
      setError(null);
      setNote(`${res.confirmed} substitution(s) confirmed — the base timetable is untouched; they apply to ${fmtDate(plan.absence.date)} only.`);
      refetchAbsences();
      await loadPlan(plan.absence.id);
    } catch (e) { setError(asMessage(e)); } finally { setBusy(false); }
  };

  const removeAbsence = async (a: AbsenceRow) => {
    if (!window.confirm(`Remove ${a.teacherName}'s absence on ${a.date}? Its ${a.substitutionCount} substitution(s) for that date are removed too.`)) return;
    try {
      await api(`/absences/${a.id}`, { method: "DELETE" });
      if (openId === a.id) { setOpenId(null); setPlan(null); }
      refetchAbsences();
    } catch (e) { setError(asMessage(e)); }
  };

  const pendingCount = useMemo(
    () => plan?.plan.slots.filter((s) => choices[s.slot.slotId] !== undefined).length ?? 0,
    [plan, choices],
  );

  return (
    <div>
      <Card title="Report an absence" sub="Matches are computed automatically the moment an absence is logged (§6).">
        <ErrorNote message={error} />
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1.4fr auto", gap: 10, alignItems: "end" }}>
          <Field label="Teacher">
            <select style={inputStyle} value={form.teacherId} onChange={(e) => setForm({ ...form, teacherId: e.target.value })}>
              <option value="">— choose teacher —</option>
              {(teachers ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Date"><input type="date" style={inputStyle} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
          <Field label="Reason (optional)"><input style={inputStyle} value={form.reason} placeholder="sick leave…" onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          <button className="btn btn-primary" style={{ marginBottom: 18 }} disabled={!form.teacherId || !form.date || busy} onClick={report}>
            Mark absent
          </button>
        </div>
      </Card>

      {plan && (
        <>
          <div className="absence-banner">
            <div className="avatar">{initials(plan.absence.teacherName)}</div>
            <div>
              <h3>{plan.absence.teacherName} — Absent {fmtDate(plan.absence.date)}</h3>
              <p>
                {plan.plan.slots.length} period(s) affected · {plan.plan.coveredCount} auto-matched
                {plan.plan.unmatchedCount > 0 ? ` · ${plan.plan.unmatchedCount} need review` : ""}
                {plan.confirmed.length > 0 ? ` · ${plan.confirmed.length} already confirmed` : ""}
              </p>
            </div>
            {plan.plan.slots.length > 0 && (
              <button className="btn btn-primary" disabled={busy || pendingCount === 0} onClick={confirmAll}>
                Confirm All ({pendingCount})
              </button>
            )}
          </div>

          {note && <div className="card" style={{ borderColor: "#34a06a", background: "#eefaf2", color: "#1d6b45", padding: 12, marginBottom: 14, fontWeight: 600, fontSize: 12.5 }}>{note}</div>}

          {plan.plan.slots.length === 0 && plan.confirmed.length === 0 && (
            <Card><p className="screen-sub">No published periods for {plan.absence.teacherName} on {DAY_NAMES[plan.absence.dayOfWeek]} — nothing to cover.</p></Card>
          )}

          {plan.plan.slots.length > 0 && (
            <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 18 }}>
              <div className="sub-row" style={{ background: "var(--offwhite)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ink-faint)", fontWeight: 700 }}>
                <div>Period</div><div>Class-Section</div><div>Subject</div><div>Suggested Substitute</div><div>Status</div>
              </div>
              {plan.plan.slots.map((s) => {
                const chosen = choices[s.slot.slotId];
                const chosenCand = s.candidates.find((c) => c.teacherId === chosen);
                return (
                  <div key={s.slot.slotId} className={`sub-row${s.candidates.length === 0 ? " needs-review" : ""}`}>
                    <div>P{s.slot.period}{s.slot.viaSubstitution ? " (was covering)" : ""}</div>
                    <div>{s.slot.classSectionLabel}</div>
                    <div>{s.slot.subjectName}</div>
                    <div>
                      {s.candidates.length === 0 ? (
                        <>
                          <select className="sub-select" disabled><option>No eligible substitute</option></select>
                          <div className="rationale">{s.fallback}</div>
                        </>
                      ) : (
                        <>
                          <select className="sub-select" value={chosen ?? ""}
                            onChange={(e) => setChoices({ ...choices, [s.slot.slotId]: Number(e.target.value) })}>
                            {s.candidates.map((c) => (
                              <option key={c.teacherId} value={c.teacherId}>{c.name} — score {c.score}</option>
                            ))}
                          </select>
                          {chosenCand && <div className="rationale">{chosenCand.reasons.join(" · ")}</div>}
                        </>
                      )}
                    </div>
                    <div>
                      {s.candidates.length === 0
                        ? <span className="badge badge-warn">⚠ Action needed</span>
                        : <span className="badge badge-ok">✓ Ready</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {plan.confirmed.length > 0 && (
            <Card title="Confirmed for this date" sub="Date-scoped overlay rows in substitution_log — the published grid itself is untouched (invariant 4).">
              <DataTable
                headers={["Period", "Class-Section", "Subject", "Substitute"]}
                rows={plan.confirmed.map((c) => [
                  `P${c.period}`, c.classSectionLabel, c.subjectName,
                  <span key="s"><b>{c.substituteName}</b> <span className="chip mono">sub</span></span>,
                ])}
              />
            </Card>
          )}
        </>
      )}

      <Card title="Absence log" sub="Click a row to open its substitution plan.">
        <DataTable
          headers={["Date", "Teacher", "Reason", "Status", "Substitutions", ""]}
          onRowClick={(i) => { const a = (absences ?? [])[i]; if (a) loadPlan(a.id); }}
          rows={(absences ?? []).map((a) => [
            fmtDate(a.date),
            <b key="t">{a.teacherName}</b>,
            a.reason ?? "—",
            a.status === "substitutes_assigned"
              ? <span key="s" className="badge badge-ok">substitutes assigned</span>
              : <span key="s" className="badge badge-warn">{a.status}</span>,
            a.substitutionCount,
            <button key="d" className="btn btn-secondary" style={{ padding: "4px 10px", fontSize: 11.5, color: "var(--signal)" }}
              onClick={(e) => { e.stopPropagation(); removeAbsence(a); }}>🗑</button>,
          ])}
          empty="No absences reported yet."
        />
      </Card>
    </div>
  );
}
