/**
 * §4.7a/§4.7b — Availability: time off for a teacher, a class, a subject or a room.
 *
 * The rule itself was never missing. `teacher_unavailability` has existed since
 * Phase 1, the solver prunes it out of a teacher's domain **before search**
 * (invariant 2 — a hard constraint, never a penalty), the drag-drop board
 * refuses a move into a blocked cell, Feasibility Check 2 subtracts it from the
 * teacher's weekly capacity, and the substitute engine drops the teacher from
 * the candidate list outright rather than scoring them down.
 *
 * What was missing was any way to say it. Until this screen the only routes in
 * were the Excel importer's "Teacher Unavailability" sheet and a raw
 * `PUT /teachers/:id/unavailability`, so in practice nobody set it.
 *
 * The shape of the data is one row per blocked cell, `period_number = NULL`
 * meaning the whole day. Every case an admin describes reduces to that:
 *
 *   "not available Monday and Friday, periods 1–4"  → 8 cells
 *   "not available second half, daily"              → the back half of each day
 *   "comes in after 10am"                           → every period starting before 10:00
 *   "leaves early"                                  → every period ending after the time
 *
 * So the patterns below are entry shortcuts that compile down to cells, not a
 * second model. One representation, whichever way it was typed — the solver
 * cannot tell them apart, and neither can a later edit.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { asMessage, Card, ErrorNote } from "../components";
import { useSearchParams } from "react-router-dom";
import { useApi, useConfigCtx } from "../hooks";
import { inputStyle } from "./Timetables";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface UnavailRow {
  dayOfWeek: number;
  /** null = the whole day */
  periodNumber: number | null;
  reason: string | null;
}
/**
 * One pickable master, whichever kind is open. The server names them the way
 * the screen shows them (§4.7b), so this file never has to know that a teacher
 * has an employee code and a room has a type.
 */
interface Entity {
  id: number;
  name: string;
  short: string;
  blocked: UnavailRow[];
}

/**
 * The four kinds, and the words that change with them.
 *
 * The GRID is identical for all four — a week with some cells turned off — so
 * what varies is only what to call the thing and what a blocked cell means for
 * it. Kept as data rather than four screens, because four screens is four
 * places for the "a whole blocked day is one row" rule to drift.
 */
const KINDS = [
  {
    key: "teacher", label: "Teachers", noun: "teacher", search: "Search teacher…",
    sub: "When a teacher cannot be timetabled. Generate will not place a lesson there, the board refuses a drag into it, and the Substitute Center will not offer them.",
  },
  {
    key: "class", label: "Classes", noun: "class-section", search: "Search class…",
    sub: "When a class is not in school. This makes its week SMALLER — Readiness counts the remaining slots, so a class with an afternoon off is told at once if its curriculum no longer fits.",
  },
  {
    key: "subject", label: "Subjects", noun: "subject", search: "Search subject…",
    sub: "When a subject may not be taught, for every class at once — no games in period 1, nothing practical on a half day.",
  },
  {
    key: "room", label: "Rooms", noun: "room", search: "Search room…",
    sub: "When a room cannot be used. The solver will not send a lesson there, and the room checks count the periods it has left.",
  },
] as const;

type KindKey = (typeof KINDS)[number]["key"];

const key = (d: number, p: number) => `${d}-${p}`;

export function Availability() {
  const { current } = useConfigCtx();
  /*
    Which kind, and which one of them, live in the URL.

    So the Masters screen's "Time off" button is a link rather than a second
    copy of this grid — `?kind=class&id=9` opens exactly the entity somebody
    was looking at — and so a refresh, a bookmark or a shared link all still
    mean the same thing.
  */
  const [params, setParams] = useSearchParams();
  const kindQ = params.get("kind") ?? "teacher";
  const kind: KindKey = (KINDS.find((k) => k.key === kindQ)?.key ?? "teacher");
  const spec = KINDS.find((k) => k.key === kind)!;
  const idQ = params.get("id");

  const { data: teachers, refetch } = useApi<Entity[]>(
    current ? `/availability/${kind}?configId=${current.id}` : null,
  );

  const [selectedId, setSelectedId] = useState<number | null>(idQ ? Number(idQ) : null);
  const [q, setQ] = useState("");
  const [blocked, setBlocked] = useState<Map<string, string | null>>(new Map());
  const [reason, setReason] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /** The teaching periods of the current timetable, in order, with their times. */
  const periods = useMemo(() => {
    const all = (current as any)?.periods as
      | { periodNumber: number | null; startTime: string; endTime: string; isBreak: boolean; breakName: string | null }[]
      | undefined;
    if (!all) return [];
    // Breaks are shown but never blockable, and §18 extra periods are outside
    // the teaching day the solver reaches at all.
    return all.filter((p) => p.isBreak || (p.periodNumber !== null && p.periodNumber <= (current?.periodsPerDay ?? 0)));
  }, [current]);

  const teaching = periods.filter((p) => !p.isBreak) as
    { periodNumber: number; startTime: string; endTime: string; isBreak: boolean; breakName: string | null }[];
  const days = current?.workingDays ?? [];

  const selected = (teachers ?? []).find((t) => t.id === selectedId) ?? null;

  /** Load a teacher's saved rows into the grid. A whole-day row expands. */
  useEffect(() => {
    if (!selected) { setBlocked(new Map()); setDirty(false); return; }
    const m = new Map<string, string | null>();
    for (const u of selected.blocked ?? []) {
      if (u.periodNumber === null) {
        for (const p of teaching) m.set(key(u.dayOfWeek, p.periodNumber), u.reason);
      } else {
        m.set(key(u.dayOfWeek, u.periodNumber), u.reason);
      }
    }
    setBlocked(m);
    setDirty(false);
    setNote(null);
    setError(null);
    // Keyed on `selectedId`, NOT on `selected`. That object is re-found from
    // `teachers` on every render, so its identity changes whenever the list
    // refetches — and this effect overwrites `blocked`, which would silently
    // discard whatever the admin had clicked. `teaching.length` is here so the
    // grid reloads if the timetable's day length changes underneath it.
  }, [selectedId, teaching.length]);

  const mutate = (fn: (m: Map<string, string | null>) => void) => {
    setBlocked((prev) => { const m = new Map(prev); fn(m); return m; });
    setDirty(true);
    setNote(null);
  };

  const toggleCell = (d: number, p: number) =>
    mutate((m) => { const k = key(d, p); if (m.has(k)) m.delete(k); else m.set(k, reason.trim() || null); });

  const dayFull = (d: number) => teaching.length > 0 && teaching.every((p) => blocked.has(key(d, p.periodNumber)));
  const toggleDay = (d: number) =>
    mutate((m) => {
      const full = teaching.every((p) => m.has(key(d, p.periodNumber)));
      for (const p of teaching) {
        if (full) m.delete(key(d, p.periodNumber));
        else m.set(key(d, p.periodNumber), reason.trim() || null);
      }
    });

  const periodFull = (p: number) => days.length > 0 && days.every((d) => blocked.has(key(d, p)));
  const togglePeriod = (p: number) =>
    mutate((m) => {
      const full = days.every((d) => m.has(key(d, p)));
      for (const d of days) {
        if (full) m.delete(key(d, p));
        else m.set(key(d, p), reason.trim() || null);
      }
    });

  /** Block a set of periods on every working day — the shape of every pattern. */
  const applyToAllDays = (match: (p: { periodNumber: number; startTime: string; endTime: string }) => boolean) =>
    mutate((m) => {
      for (const d of days) {
        for (const p of teaching) if (match(p)) m.set(key(d, p.periodNumber), reason.trim() || null);
      }
    });

  const [arriveAt, setArriveAt] = useState("10:00");
  const [leaveAt, setLeaveAt] = useState("13:00");

  const secondHalf = () => {
    const half = Math.ceil(teaching.length / 2);
    const from = teaching[half]?.periodNumber;
    if (from === undefined) return;
    applyToAllDays((p) => p.periodNumber >= from);
  };

  const clearAll = () => mutate((m) => m.clear());

  /**
   * Collapse the grid back to rows.
   *
   * A day where every teaching period is blocked is stored as ONE row with a
   * null period, not as N rows. That is what the column means, and it keeps
   * meaning it if the timetable later gains a period — which N rows would not.
   */
  const save = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const rows: UnavailRow[] = [];
      for (const d of days) {
        const onThisDay = teaching.filter((p) => blocked.has(key(d, p.periodNumber)));
        if (onThisDay.length === 0) continue;
        if (onThisDay.length === teaching.length) {
          rows.push({ dayOfWeek: d, periodNumber: null, reason: blocked.get(key(d, teaching[0].periodNumber)) ?? null });
        } else {
          for (const p of onThisDay) {
            rows.push({ dayOfWeek: d, periodNumber: p.periodNumber, reason: blocked.get(key(d, p.periodNumber)) ?? null });
          }
        }
      }
      await api(`/availability//`, { method: "PUT", body: JSON.stringify({ rows }) });
      setDirty(false);
      setNote(
        rows.length === 0
          ? ` is now available in every period.`
          : `Saved — ${blocked.size} blocked period${blocked.size === 1 ? "" : "s"} for ${selected.name}.`,
      );
      refetch();
    } catch (e) { setError(asMessage(e)); }
    finally { setSaving(false); }
  };

  /** How many periods each entity is blocked for, for the list badge. */
  const blockedCount = (t: Entity) =>
    (t.blocked ?? []).reduce((n, u) => n + (u.periodNumber === null ? Math.max(teaching.length, 1) : 1), 0);

  const list = (teachers ?? [])
    .filter((t) => {
      const needle = q.trim().toLowerCase();
      return !needle || `${t.name} ${t.short}`.toLowerCase().includes(needle);
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  if (!current) {
    return (
      <Card title="Availability">
        <p className="screen-sub">Choose a timetable in the top bar first — the grid is that timetable's own days and periods.</p>
      </Card>
    );
  }

  return (
    <Card title="Availability" sub={spec.sub}>
      <ErrorNote message={error} />
      {note && (
        <div style={{ background: "var(--accent-bg)", color: "var(--accent)", border: "1px solid var(--accent)",
          borderRadius: 8, padding: "8px 12px", fontSize: 12.5, marginBottom: 12 }}>{note}</div>
      )}

      {/*
        §4.7b — the four kinds, as tabs.

        One screen rather than four nav entries: the grid, the quick patterns
        and the "a whole blocked day is one row" rule are identical, and a
        school setting up its week wants them in one place. Switching clears the
        selection, because an id means nothing under a different kind.
      */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {KINDS.map((k) => (
          <button key={k.key} className="btn"
            onClick={() => {
              if (dirty && !window.confirm("Discard unsaved availability changes?")) return;
              setSelectedId(null);
              const next = new URLSearchParams(params);
              next.set("kind", k.key);
              next.delete("id");
              setParams(next, { replace: true });
            }}
            style={{
              padding: "5px 13px", fontSize: 12.5,
              background: k.key === kind ? "var(--brand)" : "var(--paper)",
              color: k.key === kind ? "#fff" : "var(--ink)",
              borderColor: k.key === kind ? "var(--brand)" : "var(--line)",
            }}>{k.label}</button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0,1fr)", gap: 18, alignItems: "start" }}>
        {/* ── who ── */}
        <div>
          <input style={{ ...inputStyle, marginBottom: 8 }} placeholder={spec.search}
            value={q} onChange={(e) => setQ(e.target.value)} />
          <div style={{ border: "1px solid var(--line)", borderRadius: 10, maxHeight: 520, overflowY: "auto" }}>
            {list.length === 0 && <div style={{ padding: 12, fontSize: 12.5, color: "var(--ink-faint)" }}>Nothing matches.</div>}
            {list.map((t) => {
              const n = blockedCount(t);
              const on = t.id === selectedId;
              return (
                <button key={t.id}
                  onClick={() => {
                    if (dirty && !window.confirm("Discard unsaved availability changes?")) return;
                    setSelectedId(t.id);
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                    padding: "8px 11px", border: "none", borderBottom: "1px solid var(--line)",
                    background: on ? "var(--steel-pale)" : "var(--paper)", cursor: "pointer",
                  }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13, fontWeight: on ? 700 : 500,
                      color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.name}
                    </span>
                    {/* Whatever this kind's second line is — an employee code,
                        a subject code, a room type. The server chose it. */}
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-faint)" }}>{t.short}</span>
                  </span>
                  {n > 0 && <span className="chip mono" style={{ fontSize: 10 }}>{n}</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── when ── */}
        <div>
          {!selected ? (
            <div style={{ border: "1px dashed var(--line)", borderRadius: 10, padding: 28, textAlign: "center",
              color: "var(--ink-faint)", fontSize: 13 }}>
              Pick a {spec.noun} to set when it cannot be timetabled.
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                <strong style={{ fontSize: 14 }}>{selected.name}</strong>
                <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>
                  {blocked.size === 0 ? "available all week" : `${blocked.size} period${blocked.size === 1 ? "" : "s"} blocked`}
                </span>
                {dirty && <span className="badge" style={{ background: "var(--amber-bg)", color: "var(--amber)" }}>unsaved</span>}
                <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                  <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
                    {saving ? "Saving…" : "✓ Save availability"}
                  </button>
                </span>
              </div>

              {/* Patterns. Each writes cells — there is no second kind of rule. */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10,
                padding: "9px 11px", background: "var(--offwhite)", border: "1px solid var(--line)", borderRadius: 9 }}>
                <span style={{ fontSize: 11.5, color: "var(--ink-faint)", fontWeight: 600 }}>QUICK</span>
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <button className="btn" style={{ border: "1px solid var(--line)", fontSize: 12 }}
                    onClick={() => applyToAllDays((p) => p.startTime < arriveAt)}>Arrives after</button>
                  <input type="time" style={{ ...inputStyle, width: 108, padding: "5px 7px", fontSize: 12 }}
                    value={arriveAt} onChange={(e) => setArriveAt(e.target.value)} />
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <button className="btn" style={{ border: "1px solid var(--line)", fontSize: 12 }}
                    onClick={() => applyToAllDays((p) => p.endTime > leaveAt)}>Leaves by</button>
                  <input type="time" style={{ ...inputStyle, width: 108, padding: "5px 7px", fontSize: 12 }}
                    value={leaveAt} onChange={(e) => setLeaveAt(e.target.value)} />
                </span>
                <button className="btn" style={{ border: "1px solid var(--line)", fontSize: 12 }} onClick={secondHalf}>
                  Second half daily
                </button>
                <button className="btn" style={{ border: "1px solid var(--line)", fontSize: 12, color: "var(--signal)" }}
                  onClick={clearAll} disabled={blocked.size === 0}>Clear all</button>
                <input style={{ ...inputStyle, width: "auto", flex: "1 1 150px", minWidth: 130, fontSize: 12 }}
                  placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>

              {/* The week. Click a cell, a day header, or a period label. */}
              <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 10 }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={hdr}>Period</th>
                      {days.map((d) => (
                        <th key={d} style={{ ...hdr, cursor: "pointer", textAlign: "center" }}
                          title={`Block or clear all of ${DAY_NAMES[d]}`} onClick={() => toggleDay(d)}>
                          {DAY_NAMES[d]}
                          <div style={{ fontSize: 9.5, fontWeight: 400, color: dayFull(d) ? "var(--signal)" : "var(--ink-faint)" }}>
                            {dayFull(d) ? "whole day off" : "toggle day"}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {periods.map((p, i) =>
                      p.isBreak ? (
                        <tr key={`b${i}`}>
                          <td colSpan={days.length + 1} style={{
                            padding: "4px 10px", background: "var(--offwhite)", borderBottom: "1px solid var(--line)",
                            fontSize: 11, color: "var(--ink-faint)", textAlign: "center", letterSpacing: "0.04em",
                          }}>
                            {p.breakName ?? "Break"} · {p.startTime}–{p.endTime}
                          </td>
                        </tr>
                      ) : (
                        <tr key={`p${p.periodNumber}`}>
                          <td style={{ ...cell, cursor: "pointer", whiteSpace: "nowrap", fontWeight: 600 }}
                            title="Block or clear this period on every day"
                            onClick={() => togglePeriod(p.periodNumber as number)}>
                            P{p.periodNumber}
                            <span className="mono" style={{
                              display: "block", fontSize: 10, fontWeight: 400,
                              color: periodFull(p.periodNumber as number) ? "var(--signal)" : "var(--ink-faint)",
                            }}>
                              {periodFull(p.periodNumber as number) ? "every day" : `${p.startTime}–${p.endTime}`}
                            </span>
                          </td>
                          {days.map((d) => {
                            const k = key(d, p.periodNumber as number);
                            const off = blocked.has(k);
                            const why = blocked.get(k);
                            return (
                              <td key={d} onClick={() => toggleCell(d, p.periodNumber as number)}
                                title={off ? (why ? `Unavailable — ${why}` : "Unavailable") : "Available — click to block"}
                                style={{
                                  ...cell, textAlign: "center", cursor: "pointer", userSelect: "none",
                                  background: off ? "var(--signal-bg)" : "var(--paper)",
                                  color: off ? "var(--signal)" : "var(--ink-faint)",
                                  fontWeight: off ? 700 : 400,
                                }}>
                                {off ? "✕" : "·"}
                              </td>
                            );
                          })}
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>

              <p style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 8 }}>
                A day with every period blocked is stored as one whole-day rule, so it keeps meaning the same thing if
                the timetable later gains a period. Availability belongs to the teacher, not to one timetable — these
                periods are the <b>{current.name}</b> day, and the same rule applies wherever they teach.
              </p>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

const hdr: React.CSSProperties = {
  padding: "7px 10px", textAlign: "left", fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase",
  color: "var(--ink-faint)", background: "var(--offwhite)", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap",
};
const cell: React.CSSProperties = {
  padding: "6px 10px", borderBottom: "1px solid var(--line)", borderRight: "1px solid var(--line)", fontSize: 12.5,
};
