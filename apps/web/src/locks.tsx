/**
 * §29.8 — the lock, on screen.
 *
 * Two components, and the split is the point:
 *
 * - `LockRibbon` is what a locked screen says. It goes above whatever the page
 *   edits, because it changes what every control below it will do.
 * - `UnlockDialog` is where a grant is opened. Two lists and a price.
 *
 * ## What the screen is for, given the server already refuses
 *
 * `FreezeService` guards the write, not the button, so none of this enforces
 * anything — it exists to explain. That is not a small job: a lock nobody can
 * see is a screen that appears broken, and the difference between a feature
 * people use and one they route around is whether the refusal names the thing
 * to unlock. Every control that is disabled here is *also* refused server-side;
 * nothing here is the only thing standing between a school and a bad write.
 *
 * ## The price
 *
 * The dialog says how many published lessons the ticked entities would open,
 * live, before anybody presses anything. §21 made this call for relax remedies
 * and the argument is the same: a number in front of a decision is what stops
 * "select all" being the reflex.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";

export interface UnlockEntity {
  kind: "teacher" | "class_section";
  id: number;
  label: string;
}

export interface UnlockGrant {
  id: number;
  reason: string;
  unlockedAt: string;
  expiresAt: string | null;
  closedAt: string | null;
  /** One word for three database states — see `UnlockService.list`. */
  state: "live" | "expired" | "closed";
  writes: number;
  entities: UnlockEntity[];
}

interface UnlockList {
  configId: number;
  name: string;
  locked: boolean;
  frozenAt: string | null;
  unlocks: UnlockGrant[];
}

interface Option {
  id: number;
  label: string;
  lessons: number;
}

interface Options {
  id: number;
  name: string;
  locked: boolean;
  classSections: Option[];
  teachers: Option[];
}

/** A grant that is admitting writes right now. */
export const isLive = (g: UnlockGrant) => g.state === "live";

/**
 * Read a timetable's grants.
 *
 * Exposed as a hook rather than fetched inside the ribbon because two screens
 * want the same answer at once (the ribbon, and whatever it sits above needing
 * to know which rows to dim), and two fetches would be two answers.
 */
export function useUnlocks(configId: number | null) {
  const [data, setData] = useState<UnlockList | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (configId === null) { setData(null); return; }
    setLoading(true);
    try {
      setData(await api<UnlockList>(`/timetable-configs/${configId}/unlocks`));
    } catch {
      // A 403 here is a teacher looking at a screen that happens to render the
      // ribbon. Silent rather than an error banner: they cannot act on it, and
      // the page below still works.
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [configId]);

  useEffect(() => { void reload(); }, [reload]);

  const live = useMemo(() => (data?.unlocks ?? []).filter(isLive), [data]);
  return { data, live, loading, reload };
}

const fmtWhen = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

/** "in 3h 40m", or "" once it has lapsed. */
function untilLabel(expiresAt: string | null): string {
  if (!expiresAt) return "until it is closed";
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m left`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m left`;
}

// ───────────────────────────────────────────────────────────── the ribbon

export function LockRibbon({
  configId,
  configName,
  frozenAt,
  canManage,
  onChanged,
}: {
  configId: number;
  configName: string;
  frozenAt: string | null;
  /**
   * `timetable.publish` — the same permission freeze/unfreeze already needs.
   *
   * Optional, and when it is omitted the answer is *"did the grants list
   * load?"*. `GET /unlocks` is guarded by that very permission, so a 403 is the
   * server's own answer to the question — which beats threading `me` through
   * four screens that do not otherwise need it, and cannot drift from what the
   * write path will allow (§31.10's rule that a control must not offer what the
   * server refuses).
   */
  canManage?: boolean;
  onChanged?: () => void;
}) {
  const { data, live, reload } = useUnlocks(frozenAt ? configId : null);
  const mayManage = canManage ?? data !== null;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!frozenAt) return null;

  const close = async (id: number) => {
    setBusy(true);
    try {
      await api(`/timetable-configs/${configId}/unlocks/${id}/close`, { method: "POST" });
      await reload();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card" style={{
        borderColor: live.length > 0 ? "var(--accent)" : "var(--brand)",
        background: live.length > 0 ? "var(--accent-bg)" : "var(--steel-pale)",
        padding: "11px 14px", marginBottom: 16, fontSize: 12.6, lineHeight: 1.55,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span aria-hidden style={{ fontSize: 15 }}>{live.length > 0 ? "🔓" : "🔒"}</span>
          <span style={{ flex: 1, minWidth: 220 }}>
            <strong>{configName} is locked.</strong>{" "}
            {live.length === 0 ? (
              <>Its published week is settled, so nothing here can change what a class is
              taught, who teaches it, or when. Locked {fmtWhen(frozenAt)}.</>
            ) : (
              <>
                {live.length === 1 ? "One unlock is" : `${live.length} unlocks are`} open —
                everything else stays refused.
              </>
            )}
          </span>
          {mayManage && (
            <button className="btn" onClick={() => setOpen(true)}
              style={{ whiteSpace: "nowrap", fontSize: 12.5 }}>
              Unlock what you need to change…
            </button>
          )}
        </div>

        {/*
          The grants are listed HERE rather than on a screen of their own.
          §29.2's lesson: a record you have to go looking for is not doing its
          job, and the moment somebody needs to know what is open is the moment
          they are being refused.
        */}
        {live.length > 0 && (
          <div style={{ marginTop: 10, display: "grid", gap: 7 }}>
            {live.map((g) => (
              <div key={g.id} style={{
                background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 7,
                padding: "8px 10px", display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap",
              }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 3 }}>
                    {g.entities.map((e) => (
                      <span key={`${e.kind}:${e.id}`} className="chip"
                        style={{
                          background: "var(--accent-bg)", color: "var(--accent)",
                          borderColor: "var(--accent)", fontSize: 11,
                        }}>
                        {e.kind === "teacher" ? "◍ " : "▦ "}{e.label}
                      </span>
                    ))}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-soft)", fontStyle: "italic" }}>
                    “{g.reason}”
                  </div>
                  <div style={{ fontSize: 10.8, color: "var(--ink-faint)", marginTop: 2 }}>
                    opened {fmtWhen(g.unlockedAt)} · {untilLabel(g.expiresAt)} ·{" "}
                    {g.writes === 0 ? "nothing changed yet" : `${g.writes} change${g.writes === 1 ? "" : "s"} so far`}
                  </div>
                </div>
                {mayManage && (
                  <button className="btn" disabled={busy} onClick={() => void close(g.id)}
                    style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>
                    Close &amp; relock
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {open && (
        <UnlockDialog
          configId={configId}
          configName={data?.name ?? configName}
          onClose={() => setOpen(false)}
          onOpened={async () => { setOpen(false); await reload(); onChanged?.(); }}
        />
      )}
    </>
  );
}

// ───────────────────────────────────────────────────────────── the dialog

/** How long a grant lasts. "Until closed" is a real choice, never a default. */
const DURATIONS: Array<{ label: string; mins: number | null }> = [
  { label: "1 hour", mins: 60 },
  { label: "4 hours", mins: 240 },
  { label: "Today", mins: 60 * 12 },
  { label: "Until I close it", mins: null },
];

export function UnlockDialog({
  configId,
  configName,
  onClose,
  onOpened,
}: {
  configId: number;
  configName: string;
  onClose: () => void;
  onOpened: () => void;
}) {
  const [opts, setOpts] = useState<Options | null>(null);
  const [secs, setSecs] = useState<Set<number>>(new Set());
  const [teachers, setTeachers] = useState<Set<number>>(new Set());
  const [reason, setReason] = useState("");
  const [mins, setMins] = useState<number | null>(240);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<Options>(`/timetable-configs/${configId}/unlocks/options`)
      .then(setOpts)
      .catch((e: Error) => setError(e.message));
  }, [configId]);

  const toggle = (set: Set<number>, put: (s: Set<number>) => void, id: number) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    put(next);
  };

  /*
    The price, computed from the same numbers the server counted.

    A sum of per-entity lesson counts OVER-states it whenever an unlocked
    teacher teaches an unlocked class — that lesson is opened once and counted
    twice. Named rather than hidden: the exact figure needs the slot rows
    themselves, and a number that is too big is the safe direction for a warning
    to be wrong in. The server's own count comes back on the response.
  */
  const price = useMemo(() => {
    if (!opts) return 0;
    let n = 0;
    for (const c of opts.classSections) if (secs.has(c.id)) n += c.lessons;
    for (const t of opts.teachers) if (teachers.has(t.id)) n += t.lessons;
    return n;
  }, [opts, secs, teachers]);

  const ticked = secs.size + teachers.size;
  const ready = ticked > 0 && reason.trim().length >= 4 && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/timetable-configs/${configId}/unlocks`, {
        method: "POST",
        body: JSON.stringify({
          reason: reason.trim(),
          classSectionIds: [...secs],
          teacherIds: [...teachers],
          expiresInMinutes: mins,
        }),
      });
      onOpened();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const match = (s: string) => s.toLowerCase().includes(filter.trim().toLowerCase());
  const shownSecs = (opts?.classSections ?? []).filter((c) => !filter || match(c.label));
  const shownTeachers = (opts?.teachers ?? []).filter((t) => !filter || match(t.label));

  const chip = (o: Option, on: boolean, hit: () => void, kind: string) => (
    <button key={`${kind}${o.id}`} type="button" onClick={hit} aria-pressed={on}
      style={{
        font: "inherit", fontSize: 12, cursor: "pointer", borderRadius: 999,
        padding: "4px 11px", whiteSpace: "nowrap",
        border: `1px solid ${on ? "var(--accent)" : "var(--line)"}`,
        background: on ? "var(--accent)" : "var(--surface)",
        color: on ? "#fff" : "var(--ink-soft)",
        fontWeight: on ? 600 : 400,
      }}>
      {o.label}
      <span className="mono" style={{ fontSize: 10, opacity: 0.75, marginLeft: 4 }}>{o.lessons}</span>
    </button>
  );

  return (
    <div role="dialog" aria-modal="true" aria-label={`Unlock part of ${configName}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 500, background: "rgba(11,31,68,.45)",
        display: "grid", placeItems: "center", padding: 18,
      }}>
      <div className="card" style={{ width: "min(620px,100%)", maxHeight: "90vh", overflow: "auto", padding: 0 }}>
        <div style={{ padding: "15px 18px 12px", borderBottom: "1px solid var(--line)", display: "flex", gap: 10 }}>
          <span aria-hidden style={{
            width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center", flexShrink: 0,
            background: "var(--accent-bg)", color: "var(--accent)", fontSize: 16,
          }}>🔓</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ font: "700 15px/1.25 Inter" }}>Unlock part of {configName}</div>
            <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 3 }}>
              Everything you tick can be re-planned. Everything else stays locked.
            </div>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{ border: "none", background: "none", cursor: "pointer", fontSize: 16, color: "var(--ink-faint)" }}>✕</button>
        </div>

        <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 13, fontSize: 12.6 }}>
          {error && (
            <div className="card" style={{
              borderColor: "var(--signal)", background: "var(--signal-bg)",
              color: "var(--signal)", padding: "9px 11px", fontSize: 12.2,
            }}>{error}</div>
          )}

          <input value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter classes and teachers…" aria-label="Filter"
            style={{
              font: "inherit", fontSize: 12.6, padding: "7px 10px",
              border: "1px solid var(--line)", borderRadius: 7, width: "100%",
            }} />

          <div>
            <div className="mono" style={{
              fontSize: 10.5, letterSpacing: ".08em", textTransform: "uppercase",
              color: "var(--steel)", marginBottom: 6,
            }}>
              Class-sections — opens their whole week
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {shownSecs.length === 0
                ? <span style={{ color: "var(--ink-faint)", fontSize: 12 }}>None match.</span>
                : shownSecs.map((c) => chip(c, secs.has(c.id), () => toggle(secs, setSecs, c.id), "c"))}
            </div>
          </div>

          <div>
            <div className="mono" style={{
              fontSize: 10.5, letterSpacing: ".08em", textTransform: "uppercase",
              color: "var(--steel)", marginBottom: 6,
            }}>
              Teachers — opens every lesson they hold, in any class
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {shownTeachers.length === 0
                ? <span style={{ color: "var(--ink-faint)", fontSize: 12 }}>None match.</span>
                : shownTeachers.map((t) => chip(t, teachers.has(t.id), () => toggle(teachers, setTeachers, t.id), "t"))}
            </div>
          </div>

          {/*
            The honest sentence. A teacher grant opens lessons sitting inside
            classes nobody ticked — that is the point of it, not a leak, and
            somebody about to press Unlock should read it here rather than
            discover it afterwards.
          */}
          {teachers.size > 0 && (
            <div style={{
              fontSize: 11.8, lineHeight: 1.55, color: "var(--ink-soft)",
              borderLeft: "3px solid var(--amber)", background: "var(--amber-bg)",
              padding: "8px 11px", borderRadius: "0 6px 6px 0",
            }}>
              A teacher unlock opens their lessons <strong>inside classes that stay locked</strong> —
              which is what lets one person be re-staffed without unlocking every class they teach.
              Those classes are named in the record.
            </div>
          )}

          <div style={{
            background: "var(--offwhite)", border: "1px dashed var(--line)",
            borderRadius: 7, padding: "8px 11px", fontSize: 12.2,
          }}>
            {ticked === 0
              ? <span style={{ color: "var(--ink-faint)" }}>Nothing ticked yet. A grant is priced before it is given.</span>
              : <>This opens <strong>{price}</strong> lesson{price === 1 ? "" : "s"} across{" "}
                <strong>{ticked}</strong> {ticked === 1 ? "entity" : "entities"}.</>}
          </div>

          <label style={{ display: "block" }}>
            <span style={{ display: "block", marginBottom: 4, fontWeight: 600 }}>
              Why is this being unlocked?
            </span>
            <input value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="Class 1-A morning has to be rebuilt before Monday"
              style={{
                font: "inherit", fontSize: 12.6, padding: "7px 10px",
                border: "1px solid var(--line)", borderRadius: 7, width: "100%",
              }} />
            <span style={{ fontSize: 11, color: "var(--ink-faint)", marginTop: 3, display: "block" }}>
              Recorded against every change this grant admits, with who made it and when.
            </span>
          </label>

          <div>
            <span style={{ display: "block", marginBottom: 5, fontWeight: 600 }}>For how long?</span>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {DURATIONS.map((d) => (
                <button key={d.label} type="button" onClick={() => setMins(d.mins)}
                  aria-pressed={mins === d.mins}
                  style={{
                    font: "inherit", fontSize: 12, cursor: "pointer", borderRadius: 6,
                    padding: "5px 11px",
                    border: `1px solid ${mins === d.mins ? "var(--brand)" : "var(--line)"}`,
                    background: mins === d.mins ? "var(--brand)" : "var(--surface)",
                    color: mins === d.mins ? "#fff" : "var(--ink-soft)",
                  }}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div style={{
          padding: "12px 18px", borderTop: "1px solid var(--line)",
          display: "flex", gap: 8, justifyContent: "flex-end",
        }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready} onClick={() => void submit()}>
            {busy ? "Unlocking…" : ticked > 0 ? `Unlock ${ticked} ${ticked === 1 ? "entity" : "entities"}` : "Unlock"}
          </button>
        </div>
      </div>
    </div>
  );
}
