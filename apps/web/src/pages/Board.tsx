import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { io } from "socket.io-client";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  BoardEngine,
  type BoardEntry,
  type CellVerdict,
  type SlotRow,
  type SolverInput,
} from "@edutimetable/shared";
import { api, getToken } from "../api";
import { useApi, useConfigCtx } from "../hooks";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface SlotsPayload {
  status: string;
  workingDays: number[];
  periods: { periodNumber: number | null; startTime: string; isBreak: boolean; breakName: string | null }[];
  sections: { id: number; label: string }[];
  subjects: Record<string, string>;
  teachers: Record<string, string>;
  rooms: Record<string, string>;
  slots: Array<Array<number | null>>;
}

interface TrayItem {
  subjectId: number;
  teacherId: number;
  missing: number;
}

const initials = (name: string) =>
  name.split(" ").map((w) => w[0]).join("").slice(0, 3).toUpperCase();

/** §7.1 audible beep on an illegal drop — tiny WebAudio square blip. */
function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 220;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    osc.onended = () => ctx.close();
  } catch {
    /* audio unavailable — visual feedback still fires */
  }
}

function DraggableCard({
  entry, label, sub, disabled, dragging,
  onLock, onRemove,
}: {
  entry: BoardEntry;
  label: string;
  sub: string;
  disabled: boolean;
  dragging: boolean;
  onLock: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: entry.key,
    disabled: disabled || entry.locked,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`dnd-card${entry.mergedGroupId !== null ? " merged" : ""}${entry.locked ? " locked" : ""}${dragging ? " dragging" : ""}`}
    >
      <div className="t">
        {label}
        {entry.mergedGroupId !== null ? " 🔗" : ""}
        {entry.locked ? " 🔒" : ""}
      </div>
      <div className="s">{sub}</div>
      <div className="tools">
        <button title={entry.locked ? "Unpin (allow moves & solver changes)" : "Pin (fix for drags and solver re-runs)"}
          onPointerDown={(e) => e.stopPropagation()} onClick={onLock}>
          {entry.locked ? "🔓" : "📌"}
        </button>
        {!entry.locked && entry.mergedGroupId === null && (
          <button title="Remove to unplaced tray" onPointerDown={(e) => e.stopPropagation()} onClick={onRemove}>
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

function TrayCard({ id, label, sub, count }: { id: string; label: string; sub: string; count: number }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className="dnd-card" style={{ width: 150 }}>
      <div className="t">{label} <span className="mono" style={{ fontWeight: 400 }}>×{count}</span></div>
      <div className="s">{sub}</div>
    </div>
  );
}

function DropCell({
  day, period, verdict, shaking, children,
}: {
  day: number;
  period: number;
  verdict: CellVerdict | null;
  shaking: boolean;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: `cell:${day}:${period}` });
  const cls = [
    "dnd-cell",
    verdict?.kind === "move" ? "legal" : "",
    verdict?.kind === "swap" ? "legal-swap" : "",
    isOver ? "over" : "",
    shaking ? "rejected" : "",
  ].filter(Boolean).join(" ");
  return <div ref={setNodeRef} className={cls}>{children}</div>;
}

/** Screen §8.4 — the Draft Board: drag cards with instant client-side legality
 *  (shared BoardEngine), server revalidation on drop (invariant 7). */
export function Board() {
  const { current } = useConfigCtx();
  const configId = current?.id ?? null;
  const { data: ctx } = useApi<SolverInput>(configId ? `/timetable-configs/${configId}/board/context` : null);
  const { data, refetch } = useApi<SlotsPayload>(configId ? `/timetable-configs/${configId}/slots?status=draft` : null);

  const [sectionId, setSectionId] = useState<number | null>(null);
  const [view, setView] = useState<"section" | "teacher">("section");
  const [teacherId, setTeacherId] = useState<number | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [legal, setLegal] = useState<Map<string, CellVerdict> | null>(null);
  const [shakeCell, setShakeCell] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const say = useCallback((kind: "ok" | "err", msg: string) => {
    setToast({ kind, msg });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  // concurrent-admin awareness (task 3.1): any board change anywhere refetches
  useEffect(() => {
    const socket = io({ auth: { token: getToken() } });
    socket.on("slots:changed", (d: { configId: number }) => {
      if (d.configId === configId) refetch();
    });
    return () => { socket.disconnect(); };
  }, [configId, refetch]);

  const slotRows: SlotRow[] = useMemo(
    () =>
      (data?.slots ?? []).map((s) => ({
        classSectionId: s[0] as number,
        dayOfWeek: s[1] as number,
        periodNumber: s[2] as number,
        subjectId: s[3] as number,
        teacherId: s[4] as number,
        roomId: s[5],
        mergedGroupId: s[6],
        isLocked: s[7] === 1,
      })),
    [data],
  );

  const engine = useMemo(
    () => (ctx && data ? new BoardEngine(ctx, slotRows) : null),
    [ctx, data, slotRows],
  );

  const entriesByCell = useMemo(() => {
    const m = new Map<string, BoardEntry>();
    if (!engine) return m;
    for (const e of engine.all) {
      for (const cs of e.classSectionIds) m.set(`${cs}@${e.day}:${e.period}`, e);
    }
    return m;
  }, [engine]);

  const sections = data?.sections ?? [];
  const activeSection = sectionId ?? sections[0]?.id ?? null;
  const teacherIds = useMemo(
    () => Object.keys(data?.teachers ?? {}).map(Number).sort((a, b) =>
      (data?.teachers[String(a)] ?? "").localeCompare(data?.teachers[String(b)] ?? "")),
    [data],
  );
  const activeTeacher = teacherId ?? teacherIds[0] ?? null;

  // unplaced tray (per selected section): mapping demand minus placed cards
  const tray: TrayItem[] = useMemo(() => {
    if (!ctx || !engine || activeSection === null) return [];
    const placed = new Map<string, number>();
    for (const e of engine.all) {
      if (e.mergedGroupId !== null || !e.classSectionIds.includes(activeSection)) continue;
      const k = `${e.subjectId}:${e.teacherId}`;
      placed.set(k, (placed.get(k) ?? 0) + 1);
    }
    const out: TrayItem[] = [];
    for (const m of ctx.snapshot.mappings) {
      if (m.classSectionId !== activeSection) continue;
      const missing = m.periodsPerWeek - (placed.get(`${m.subjectId}:${m.teacherId}`) ?? 0);
      if (missing > 0) out.push({ subjectId: m.subjectId, teacherId: m.teacherId, missing });
    }
    return out;
  }, [ctx, engine, activeSection]);

  const teachingPeriods = (data?.periods ?? []).filter((p) => p.periodNumber !== 0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const post = useCallback(
    async (path: string, body: unknown, okMsg?: string) => {
      if (!configId) return false;
      setBusy(true);
      try {
        await api(`/timetable-configs/${configId}/board/${path}`, { method: "POST", body: JSON.stringify(body) });
        if (okMsg) say("ok", okMsg);
        refetch();
        return true;
      } catch (e) {
        const msg = (e as Error).message.replace(/^\d+: /, "");
        try {
          say("err", JSON.parse(msg).message ?? msg);
        } catch {
          say("err", msg);
        }
        refetch();
        return false;
      } finally {
        setBusy(false);
      }
    },
    [configId, refetch, say],
  );

  const onDragStart = (ev: DragStartEvent) => {
    const id = String(ev.active.id);
    setActiveKey(id);
    if (!engine) return;
    if (id.startsWith("tray:")) {
      // tray card: verdict per cell via checkPlace
      const [, subj, teach] = id.split(":");
      const map = new Map<string, CellVerdict>();
      for (const day of data?.workingDays ?? []) {
        for (const p of teachingPeriods) {
          if (p.isBreak || p.periodNumber === null) continue;
          const cellEntry = entriesByCell.get(`${activeSection}@${day}:${p.periodNumber}`);
          if (cellEntry) continue; // tray cards only land on empty cells
          const v = engine.checkPlace(
            { classSectionIds: [activeSection as number], subjectId: Number(subj), teacherId: Number(teach), roomId: null, mergedGroupId: null },
            day, p.periodNumber,
          );
          map.set(`${day}:${p.periodNumber}`, v.ok ? { kind: "move", roomId: v.roomId } : { kind: "illegal", reason: v.reason ?? "" });
        }
      }
      setLegal(map);
    } else {
      setLegal(engine.legalDestinations(id)); // §7.2 highlight mode
    }
  };

  const onDragEnd = async (ev: DragEndEvent) => {
    const id = String(ev.active.id);
    setActiveKey(null);
    const map = legal;
    setLegal(null);
    if (!ev.over || !engine || !map) return;
    const [, dayS, periodS] = String(ev.over.id).split(":");
    const day = Number(dayS);
    const period = Number(periodS);
    const verdict = map.get(`${day}:${period}`);
    if (!verdict) return; // own cell

    if (verdict.kind === "illegal") {
      beep();
      setShakeCell(`${day}:${period}`);
      setTimeout(() => setShakeCell(null), 400);
      say("err", `⚠ Can't move here — ${verdict.reason}`);
      return;
    }

    if (id.startsWith("tray:")) {
      const [, subj, teach] = id.split(":");
      await post("place", {
        classSectionId: activeSection, subjectId: Number(subj), teacherId: Number(teach), day, period,
      }, "Placed from tray ✓");
      return;
    }

    const e = engine.get(id);
    if (!e) return;
    const from = { classSectionId: e.classSectionIds[0], day: e.day, period: e.period };
    const expect = { subjectId: e.subjectId, teacherId: e.teacherId };
    if (verdict.kind === "swap") {
      const other = engine.get(verdict.withKey);
      if (!other) return;
      await post("swap", {
        a: from, expectA: expect,
        b: { classSectionId: other.classSectionIds[0], day: other.day, period: other.period },
        expectB: { subjectId: other.subjectId, teacherId: other.teacherId },
      }, "Swapped ✓");
    } else {
      await post("move", { from, expect, to: { day, period } }, "Moved ✓");
    }
  };

  const autoFill = async () => {
    if (!configId) return;
    setBusy(true);
    try {
      await api(`/timetable-configs/${configId}/generate`, { method: "POST" });
      say("ok", "Auto-fill started — locked cards stay fixed (§7.4). Watch Generate for progress.");
    } catch (e) {
      const msg = (e as Error).message.replace(/^\d+: /, "");
      try { say("err", JSON.parse(msg).message ?? msg); } catch { say("err", msg); }
    } finally {
      setBusy(false);
    }
  };

  if (!current) return <p className="screen-sub">Select a timetable first.</p>;
  if (!ctx || !data || !engine) return <p className="screen-sub">Loading draft board…</p>;

  const activeEntry = activeKey && !activeKey.startsWith("tray:") ? engine.get(activeKey) : null;

  const grid = (rowsFor: (day: number, period: number) => BoardEntry | undefined, editable: boolean) => (
    <div style={{ display: "grid", gridTemplateColumns: `64px repeat(${data.workingDays.length}, 1fr)`, gap: 6 }}>
      <div />
      {data.workingDays.map((d) => (
        <div key={d} style={{ textAlign: "center", fontWeight: 700, fontSize: 11, color: "var(--brand)", letterSpacing: "0.05em" }}>
          {DAY_NAMES[d]}
        </div>
      ))}
      {teachingPeriods.map((p, ri) =>
        p.isBreak ? (
          <div key={`b${ri}`} style={{ gridColumn: `1 / span ${data.workingDays.length + 1}` }} className="dnd-break">
            {p.breakName ?? "Break"} · {p.startTime}
          </div>
        ) : (
          [
            <div key={`p${ri}`} style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-end", paddingRight: 6 }}>
              <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--steel)" }}>P{p.periodNumber}</span>
              <span className="mono" style={{ fontSize: 9, color: "var(--ink-faint)" }}>{p.startTime}</span>
            </div>,
            ...data.workingDays.map((d) => {
              const e = rowsFor(d, p.periodNumber as number);
              const cellId = `${d}:${p.periodNumber}`;
              const content = e ? (
                editable ? (
                  <DraggableCard
                    entry={e}
                    label={data.subjects[String(e.subjectId)] ?? "?"}
                    sub={`${initials(data.teachers[String(e.teacherId)] ?? "")}${e.roomId ? ` · ${data.rooms[String(e.roomId)]}` : ""}${e.mergedGroupId !== null ? ` · ${e.classSectionIds.map((id) => sections.find((s) => s.id === id)?.label ?? id).join("+")}` : ""}`}
                    disabled={busy}
                    dragging={activeKey === e.key}
                    onLock={() => post("lock", { from: { classSectionId: e.classSectionIds[0], day: e.day, period: e.period }, locked: !e.locked }, e.locked ? "Unpinned" : "Pinned — solver re-runs keep this cell")}
                    onRemove={() => post("remove", { from: { classSectionId: e.classSectionIds[0], day: e.day, period: e.period }, expect: { subjectId: e.subjectId, teacherId: e.teacherId } }, "Moved to unplaced tray")}
                  />
                ) : (
                  <div className={`dnd-card${e.mergedGroupId !== null ? " merged" : ""}`} style={{ cursor: "default" }}>
                    <div className="t">{e.classSectionIds.map((id) => sections.find((s) => s.id === id)?.label ?? id).join(" + ")}</div>
                    <div className="s">{data.subjects[String(e.subjectId)] ?? "?"}{e.roomId ? ` · ${data.rooms[String(e.roomId)]}` : ""}</div>
                  </div>
                )
              ) : (
                <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-faint)", fontSize: 10 }}>—</span>
              );
              return editable ? (
                <DropCell key={cellId} day={d} period={p.periodNumber as number} verdict={activeKey ? (legal?.get(cellId) ?? null) : null} shaking={shakeCell === cellId}>
                  {content}
                </DropCell>
              ) : (
                <div key={cellId} className="dnd-cell">{content}</div>
              );
            }),
          ]
        ),
      )}
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <select value={view} onChange={(e) => setView(e.target.value as "section" | "teacher")}
            style={{ padding: "8px 11px", border: "1px solid var(--line)", borderRadius: 8, fontWeight: 600, fontSize: 13 }}>
            <option value="section">By Class-Section</option>
            <option value="teacher">By Teacher (read-only)</option>
          </select>
          {view === "section" ? (
            <select value={activeSection ?? ""} onChange={(e) => setSectionId(Number(e.target.value))}
              style={{ padding: "8px 11px", border: "1px solid var(--line)", borderRadius: 8, fontWeight: 700, fontSize: 13, color: "var(--brand)" }}>
              {sections.map((s) => <option key={s.id} value={s.id}>{s.label} · Draft</option>)}
            </select>
          ) : (
            <select value={activeTeacher ?? ""} onChange={(e) => setTeacherId(Number(e.target.value))}
              style={{ padding: "8px 11px", border: "1px solid var(--line)", borderRadius: 8, fontWeight: 700, fontSize: 13, color: "var(--brand)" }}>
              {teacherIds.map((t) => <option key={t} value={t}>{data.teachers[String(t)]}</option>)}
            </select>
          )}
          <span className="badge badge-warn">DRAFT — not published</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn" onClick={autoFill} disabled={busy}>Auto-fill remaining gaps</button>
          <Link to="/publish" className="btn btn-primary" style={{ textDecoration: "none" }}>Publish…</Link>
        </div>
      </div>

      {data.slots.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 40 }}>
          <p style={{ fontWeight: 700, marginBottom: 6 }}>No draft to edit.</p>
          <p className="screen-sub">Generate a timetable, or start a new draft from the published version.</p>
          <button className="btn btn-primary" disabled={busy}
            onClick={() => post("draft-from-published", {}, "Draft created from the published timetable")}>
            Create draft from published
          </button>
        </div>
      ) : view === "section" ? (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => { setActiveKey(null); setLegal(null); }}>
          {grid((d, p) => entriesByCell.get(`${activeSection}@${d}:${p}`), true)}

          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--ink-faint)", marginBottom: 6 }}>
              Unplaced tray — drag onto the grid ({tray.reduce((n, t) => n + t.missing, 0)} period{tray.reduce((n, t) => n + t.missing, 0) === 1 ? "" : "s"})
            </div>
            <div className="tray">
              {tray.length === 0 ? (
                <span style={{ fontSize: 11.5, color: "var(--ink-faint)", alignSelf: "center" }}>
                  Every required period for this class-section is placed ✓ &nbsp;(drop a card here? use ✕ on a card to return it)
                </span>
              ) : (
                tray.map((t) => (
                  <TrayCard key={`${t.subjectId}:${t.teacherId}`} id={`tray:${t.subjectId}:${t.teacherId}`}
                    label={data.subjects[String(t.subjectId)] ?? "?"}
                    sub={data.teachers[String(t.teacherId)] ?? ""} count={t.missing} />
                ))
              )}
            </div>
          </div>

          <DragOverlay dropAnimation={null}>
            {activeKey ? (
              <div className="drag-overlay-card">
                {activeKey.startsWith("tray:")
                  ? data.subjects[activeKey.split(":")[1]] ?? "…"
                  : `${data.subjects[String(activeEntry?.subjectId)] ?? "…"} · ${initials(data.teachers[String(activeEntry?.teacherId)] ?? "")}`}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        grid((d, p) => {
          for (const e of engine.all) {
            if (e.teacherId === activeTeacher && e.day === d && e.period === p) return e;
          }
          return undefined;
        }, false)
      )}

      <p className="screen-sub" style={{ marginTop: 14 }}>
        Pick up a card — every legal destination glows green (cyan = swap proposal). Illegal drops shake, beep, and
        explain the exact rule. 📌 pins a card so drags and solver re-runs treat it as fixed.
      </p>

      {toast && <div className={`board-toast ${toast.kind}`}>{toast.msg}</div>}
    </div>
  );
}
