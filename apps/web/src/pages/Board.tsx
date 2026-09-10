import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  isMultiSection,
  type SlotRow,
  type SolverInput,
  type Swatch,
} from "@edutimetable/shared";
import { api, getToken } from "../api";
import { useApi, useConfigCtx } from "../hooks";
import { useColors } from "../colors-context";
import type { StripGroup } from "./strip";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface SlotsPayload {
  status: string;
  /** §22 — the draft the SERVER resolved this payload from. */
  draftId: number | null;
  workingDays: number[];
  periods: { periodNumber: number | null; startTime: string; isBreak: boolean; breakName: string | null }[];
  sections: { id: number; label: string }[];
  subjects: Record<string, string>;
  teachers: Record<string, string>;
  rooms: Record<string, string>;
  /** §4.9 split electives, keyed by block id — the parallel lessons in one slot */
  blocks: Record<string, { name: string; options: { subject: string; teacher: string; room: string }[] }>;
  /** [classSectionId, day, period, subjectId, teacherId, roomId, mergedGroupId, locked, substituted, electiveBlockId] */
  slots: Array<Array<number | null>>;
}

/** §22 — one row of the draft registry, with its stamped numbers. */
interface Draft {
  id: number;
  draftNo: number;
  label: string | null;
  status: "draft" | "published" | "archived" | "discarded";
  requiredLessons: number | null;
  placedLessons: number | null;
  generationPct: number | null;
  errorCount: number | null;
  warningCount: number | null;
  generatedAt: string | null;
  createdAt: string;
}

interface TrayItem {
  subjectId: number;
  teacherId: number;
  missing: number;
}

/** §4.9 — recover an option's id from the compact payload, which carries only
 *  the block and the subject. Unique within a block: the endpoints refuse two
 *  options sharing a subject, teacher or room. */
const optionIdOf = (ctx: SolverInput | null | undefined, blockId: number, subjectId: number): number | null =>
  ctx?.snapshot.electiveBlocks
    .find((b) => b.id === blockId)
    ?.options.find((o) => o.subjectId === subjectId)?.id ?? null;

const initials = (name: string) =>
  name.split(" ").map((w) => w[0]).join("").slice(0, 3).toUpperCase();

/** What a card says. A §4.9 block is named by the block; its second line lists
 *  the parallel lessons, because "3 options" tells a reader nothing. */
const cardLabel = (e: BoardEntry, data: SlotsPayload) =>
  e.electiveBlockId !== null
    ? (data.blocks?.[String(e.electiveBlockId)]?.name ?? "Elective")
    : (data.subjects[String(e.subjectId)] ?? "?");

/** §10.5 — the subject a card is coloured by. A §4.9 block is several subjects
 *  at once, so no single colour is truthful: it keeps its dashed steel tint. */
const colorNameOf = (e: BoardEntry, data: SlotsPayload) =>
  e.electiveBlockId !== null ? null : (data.subjects[String(e.subjectId)] ?? null);

function ReadOnlyCard({ entry, data, sections, swatch }: {
  entry: BoardEntry;
  data: SlotsPayload;
  sections: { id: number; label: string }[];
  swatch: Swatch | null;
}) {
  return (
    <div className={`dnd-card${entry.mergedGroupId !== null ? " merged" : ""}${entry.electiveBlockId !== null ? " elective" : ""}`}
      style={{ cursor: "default", ...(swatch ? { background: swatch.bg, borderColor: swatch.border } : {}) }}>
      <div className="t" style={swatch ? { color: swatch.fg } : undefined}>
        {entry.classSectionIds.map((id) => sections.find((s) => s.id === id)?.label ?? id).join(" + ")}
      </div>
      <div className="s" style={swatch ? { color: swatch.fg, opacity: 0.75 } : undefined}>
        {cardLabel(entry, data)}{entry.roomId ? ` · ${data.rooms[String(entry.roomId)]}` : ""}
      </div>
    </div>
  );
}

const cardSub = (e: BoardEntry, data: SlotsPayload, sections: { id: number; label: string }[]) => {
  if (e.electiveBlockId !== null) {
    return (data.blocks?.[String(e.electiveBlockId)]?.options ?? [])
      .map((o) => `${o.subject} · ${initials(o.teacher)} (${o.room})`)
      .join("  |  ");
  }
  const who = initials(data.teachers[String(e.teacherId)] ?? "");
  const room = e.roomId ? ` · ${data.rooms[String(e.roomId)]}` : "";
  const merged =
    e.mergedGroupId !== null
      ? ` · ${e.classSectionIds.map((id) => sections.find((s) => s.id === id)?.label ?? id).join("+")}`
      : "";
  return `${who}${room}${merged}`;
};

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
  entry, label, sub, swatch, disabled, dragging,
  onLock, onRemove,
}: {
  entry: BoardEntry;
  label: string;
  sub: string;
  /** §10.5 subject colour, or null for a block (several subjects at once). */
  swatch: Swatch | null;
  disabled: boolean;
  dragging: boolean;
  onLock: () => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: entry.key,
    disabled: disabled || entry.locked,
  });
  const isBlock = entry.electiveBlockId !== null;
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`dnd-card${entry.mergedGroupId !== null ? " merged" : ""}${isBlock ? " elective" : ""}${entry.locked ? " locked" : ""}${dragging ? " dragging" : ""}`}
      // A pinned card keeps the grey "locked" fill: 🔒 is a state you must be
      // able to see across a full board, and it outranks which subject it is.
      style={swatch && !entry.locked ? { background: swatch.bg, borderColor: swatch.border } : undefined}
      title={
        isBlock
          ? "Drag to move the whole block — every option and every attending section moves together.\nTo keep it at a fixed time, set Fixed slots on the Electives screen."
          : undefined
      }
    >
      <div className="t" style={swatch && !entry.locked ? { color: swatch.fg } : undefined}>
        {label}
        {entry.mergedGroupId !== null ? " 🔗" : ""}
        {isBlock ? " ⋔" : ""}
        {entry.locked ? " 🔒" : ""}
      </div>
      <div className="s" style={swatch && !entry.locked ? { color: swatch.fg, opacity: 0.75 } : undefined}>{sub}</div>
      {/*
        §4.9: no 📌 and no ✕ on a block, and neither is an oversight.
        `lockedSlots` is built filtered to rows with a section, a subject and a
        teacher, so a block's rows never reach the solver as locks — a pin here
        would be ignored by the next Generate. Phase 15's `placement: fixed`
        is the tool that actually holds a block's time, and it works by domain
        pruning, so it survives regeneration. And a removed block could not go
        to the tray: the tray is mapping demand, and a block is not a mapping.
      */}
      {!isBlock && (
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
      )}
    </div>
  );
}

function TrayCard({ id, label, sub, count, swatch, fill }: { id: string; label: string; sub: string; count: number; swatch: Swatch | null; fill?: boolean }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className="dnd-card"
      // §31.11 — in the Master Grid the tray is a narrow COLUMN beside the
      // grid, so a card takes the column's width rather than a fixed 150.
      style={{ width: fill ? "auto" : 150, ...(swatch ? { background: swatch.bg, borderColor: swatch.border } : {}) }}>
      <div className="t" style={swatch ? { color: swatch.fg } : undefined}>
        {label} <span className="mono" style={{ fontWeight: 400 }}>×{count}</span>
      </div>
      <div className="s" style={swatch ? { color: swatch.fg, opacity: 0.75 } : undefined}>{sub}</div>
    </div>
  );
}

function DropCell({
  day, period, verdict, shaking, selected, onSelect, children,
}: {
  day: number;
  period: number;
  verdict: CellVerdict | null;
  shaking: boolean;
  /** §31.11 — this is the cell the strip is explaining. */
  selected?: boolean;
  /** §31.11 — given only when there is a strip to fill; the standalone screen
   *  has nowhere to put the answer, so its cells are not selectable. */
  onSelect?: () => void;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: `cell:${day}:${period}` });
  const cls = [
    "dnd-cell",
    verdict?.kind === "move" ? "legal" : "",
    verdict?.kind === "swap" ? "legal-swap" : "",
    isOver ? "over" : "",
    shaking ? "rejected" : "",
    selected ? "picked" : "",
  ].filter(Boolean).join(" ");
  /*
    A plain onClick, and it does not fight the drag: the PointerSensor is armed
    with `distance: 4`, so a press that never moves is not a drag at all and the
    click still arrives. Pressing and moving starts a drag and no click fires.
  */
  return <div ref={setNodeRef} className={cls} onClick={onSelect}>{children}</div>;
}

function StatBox({ n, l, color }: { n: React.ReactNode; l: string; color?: string }) {
  return (
    <div className="stat-box" style={{ flex: 1, background: "var(--offwhite)", borderRadius: 10, padding: "13px 14px", textAlign: "center" }}>
      <div style={{ fontFamily: "var(--font-display, inherit)", fontSize: 22, fontWeight: 700, color: color ?? "var(--brand)" }}>{n}</div>
      <div style={{ fontSize: 10, color: "var(--ink-faint)", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 3 }}>{l}</div>
    </div>
  );
}

/**
 * §22.5 — every live draft's numbers side by side, best value per column
 * highlighted, publish available per row.
 *
 * This is the screen the whole phase exists for: "which draft is looking good"
 * becomes a reading rather than a recollection. Best is `max` on generation and
 * `min` on errors and warnings — and a column where every draft ties is NOT
 * highlighted, because marking all three as the winner tells a reader nothing.
 */
function DraftCompare({
  drafts, shownId, onOpen, onDiscard, busy,
}: {
  drafts: Draft[];
  shownId: number | null;
  onOpen: (id: number) => void;
  onDiscard: (d: Draft) => void;
  busy: boolean;
}) {
  const nums = (pick: (d: Draft) => number | null) =>
    drafts.map(pick).filter((x): x is number => x !== null);
  const bestOf = (pick: (d: Draft) => number | null, mode: "max" | "min") => {
    const vals = nums(pick);
    if (vals.length === 0) return null;
    const best = mode === "max" ? Math.max(...vals) : Math.min(...vals);
    // Everyone equal = nobody wins. Highlighting all of them is noise.
    return vals.every((v) => v === best) ? null : best;
  };
  const bestPct = bestOf((d) => d.generationPct, "max");
  const bestErr = bestOf((d) => d.errorCount, "min");
  const bestWarn = bestOf((d) => d.warningCount, "min");
  const hi: React.CSSProperties = {
    background: "var(--accent-bg)", color: "var(--accent)", fontWeight: 700,
    borderRadius: 6, padding: "2px 7px",
  };
  const cell: React.CSSProperties = { padding: "9px 8px", fontSize: 13 };

  return (
    <div className="card" style={{ padding: "16px 18px", marginBottom: 14 }}>
      <div className="section-label" style={{ display: "block", marginBottom: 12 }}>
        Compare live drafts — best value per column highlighted · publish straight from the winning row
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--ink-faint)", fontSize: 11 }}>
              <th style={cell}>Draft</th>
              <th style={cell}>Generation %</th>
              <th style={cell}>Total allocation</th>
              <th style={cell}>Actual</th>
              <th style={cell}>Errors</th>
              <th style={cell}>Warnings</th>
              <th style={cell}>Generated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {drafts.map((d) => (
              <tr key={d.id} style={{ borderTop: "1px solid var(--line)", background: d.id === shownId ? "var(--offwhite)" : undefined }}>
                <td style={cell}>
                  <b>Draft #{d.draftNo}</b>
                  {d.label && <span style={{ color: "var(--ink-faint)" }}> · {d.label}</span>}
                  {d.status !== "draft" && <span className="chip mono" style={{ marginLeft: 6, fontSize: 10 }}>{d.status}</span>}
                </td>
                <td style={cell}>
                  <span style={d.generationPct !== null && d.generationPct === bestPct ? hi : undefined}>
                    {d.generationPct === null ? "—" : `${d.generationPct}%`}
                  </span>
                </td>
                <td style={cell}>{(d.requiredLessons ?? 0).toLocaleString()}</td>
                <td style={cell}>{(d.placedLessons ?? 0).toLocaleString()}</td>
                <td style={cell}>
                  <span style={d.errorCount !== null && d.errorCount === bestErr ? hi : undefined}>{d.errorCount ?? "—"}</span>
                </td>
                <td style={cell}>
                  <span style={d.warningCount !== null && d.warningCount === bestWarn ? hi : undefined}>{d.warningCount ?? "—"}</span>
                </td>
                <td style={{ ...cell, color: "var(--ink-faint)", whiteSpace: "nowrap" }}>
                  {d.generatedAt ? new Date(d.generatedAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}
                </td>
                <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap" }}>
                  {d.id !== shownId && (
                    <button className="btn" style={{ border: "1px solid var(--line)", padding: "5px 11px", fontSize: 12 }} onClick={() => onOpen(d.id)}>
                      Open
                    </button>
                  )}
                  <Link to={`/publish?draftId=${d.id}`} className="btn btn-primary"
                    style={{ textDecoration: "none", padding: "5px 11px", fontSize: 12, marginLeft: 6 }}>
                    Publish this →
                  </Link>
                  {d.status !== "published" && (
                    <button className="btn" disabled={busy}
                      style={{ border: "1px solid var(--line)", padding: "5px 9px", fontSize: 12, color: "var(--signal)", marginLeft: 6 }}
                      onClick={() => onDiscard(d)} title="Discard this draft and delete its lessons">
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * §31.11 — what the Master Grid needs to host this screen as a tab.
 *
 * Every field is optional, so `<Board />` on `/board` is exactly the screen it
 * has always been. The Master Grid embeds the REAL board rather than drawing a
 * second one, for the reason §31.10 gave for the Lesson Grid tab: the rules
 * engine, the server revalidation on drop and the §29.1 freeze guard all live
 * here, and a second board over the same slots would be a second writer over
 * placement — the one mistake this whole phase has been careful not to make.
 */
export interface BoardProps {
  /** Draw for a host's pane: portalled toolbar, denser cells, no page chrome. */
  embedded?: boolean;
  /**
   * §22 — the draft to edit, when the HOST owns the choice.
   *
   * The Master Grid already has a draft picker governing its other four tabs.
   * Two pickers over one screen is two answers to "which draft am I looking
   * at?", so when the host supplies `onDraftChange` this board hides its own
   * and follows.
   */
  draftId?: number | null;
  onDraftChange?: (id: number | null) => void;
  /** Where the toolbar is drawn. Null renders it in place, as the page does. */
  toolbarHost?: HTMLElement | null;
  /** §31.6 — the strip under the host's grid, fed from THIS payload. */
  onStrip?: (groups: StripGroup[] | null) => void;
}

/** Screen §8.4 — the Draft Board: drag cards with instant client-side legality
 *  (shared BoardEngine), server revalidation on drop (invariant 7). */
export function Board({
  embedded = false,
  draftId: hostDraftId,
  onDraftChange,
  toolbarHost,
  onStrip,
}: BoardProps) {
  const { current } = useConfigCtx();
  const colors = useColors();
  const configId = current?.id ?? null;
  // §22 — which of the school's drafts this board is editing. `null` means
  // "whichever the server considers current", which is what a single-draft
  // school always gets and is why nothing changes for them.
  const [ownDraftId, setOwnDraftId] = useState<number | null>(null);
  /** The host owns the choice when it offered to hear about it. */
  const controlled = onDraftChange !== undefined;
  const draftId = controlled ? (hostDraftId ?? null) : ownDraftId;
  const chooseDraft = (id: number | null) => {
    if (onDraftChange) onDraftChange(id);
    else setOwnDraftId(id);
  };
  const { data: drafts, refetch: refetchDrafts } = useApi<Draft[]>(
    configId ? `/timetable-configs/${configId}/drafts` : null,
  );
  const q = draftId !== null ? `&draftId=${draftId}` : "";
  const { data: ctx } = useApi<SolverInput>(
    configId ? `/timetable-configs/${configId}/board/context${draftId !== null ? `?draftId=${draftId}` : ""}` : null,
  );
  const { data, refetch } = useApi<SlotsPayload>(
    configId ? `/timetable-configs/${configId}/slots?status=draft${q}` : null,
  );
  const [comparing, setComparing] = useState(false);

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
      // §4.9: member AND option rows both reach the engine now — it folds a
      // cell's worth of them into one draggable block card. The payload has no
      // option id, so it is derived from (block, subject): an option is unique
      // within its block by subject, which is what the endpoints enforce.
      (data?.slots ?? []).map((s) => ({
        classSectionId: s[0],
        dayOfWeek: s[1] as number,
        periodNumber: s[2] as number,
        subjectId: s[3],
        teacherId: s[4],
        roomId: s[5],
        mergedGroupId: s[6],
        electiveBlockId: s[9],
        electiveOptionId: s[9] !== null && s[0] === null ? optionIdOf(ctx, s[9] as number, s[3] as number) : null,
        isLocked: s[7] === 1,
      })),
    [data, ctx],
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

  // The row the picker and the stat cards describe. `data.draftId` is what the
  // SERVER resolved, so an unset picker still names the right draft rather
  // than guessing at "the newest".
  const liveDrafts = (drafts ?? []).filter((d) => d.status !== "discarded");
  const shownDraftId = draftId ?? data?.draftId ?? null;
  const shown = liveDrafts.find((d) => d.id === shownDraftId) ?? null;

  const newDraft = async () => {
    if (!configId) return;
    const label = window.prompt(
      "Name this draft — what are you trying differently?\n(e.g. \"Labs freed on Friday\")",
      "",
    );
    if (label === null) return;
    setBusy(true);
    try {
      // Forked from the draft on screen, not empty: an empty draft is 2,000
      // cells of nothing to drag. "Try something on a copy of this" is the
      // action a person actually wants from this button.
      const made = await api<{ id: number }>(`/timetable-configs/${configId}/drafts`, {
        method: "POST",
        body: JSON.stringify({ label: label.trim() || null, copyFromDraftId: shownDraftId }),
      });
      chooseDraft(made.id);
      refetchDrafts();
      say("ok", "New draft created from this one — edits here no longer touch the original");
    } catch (e) {
      const msg = (e as Error).message.replace(/^\d+: /, "");
      try { say("err", JSON.parse(msg).message ?? msg); } catch { say("err", msg); }
    } finally {
      setBusy(false);
    }
  };

  const discardDraft = async (d: Draft) => {
    if (!configId) return;
    if (!window.confirm(`Discard Draft #${d.draftNo}${d.label ? ` — ${d.label}` : ""}?\n\nIts ${d.placedLessons ?? 0} placed lessons are deleted. Other drafts are untouched.`)) return;
    setBusy(true);
    try {
      await api(`/timetable-configs/${configId}/drafts/${d.id}`, { method: "DELETE" });
      if (shownDraftId === d.id) chooseDraft(null);
      refetchDrafts();
      refetch();
      say("ok", `Draft #${d.draftNo} discarded`);
    } catch (e) {
      const msg = (e as Error).message.replace(/^\d+: /, "");
      try { say("err", JSON.parse(msg).message ?? msg); } catch { say("err", msg); }
    } finally {
      setBusy(false);
    }
  };

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
      // A §4.9 block is not mapping demand — it has no subject or teacher of
      // its own, and counting it would key the tally on "null:null".
      if (e.mergedGroupId !== null || e.electiveBlockId !== null) continue;
      if (!e.classSectionIds.includes(activeSection)) continue;
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

  /*
    §31.11 — the cell the host's strip is explaining.

    Only ever set when a strip exists to receive it: on `/board` there is
    nowhere to put the answer, so the cells are not selectable there and this
    stays null for the life of the screen.

    It is a CELL and not a card, deliberately. An empty cell is a fact — this
    class has Thursday P4 free — and it is the one the tray is about to fill.
  */
  const [picked, setPicked] = useState<{ day: number; period: number } | null>(null);
  // A cell names a position in the grid on screen, so it cannot outlive a
  // change of grid: Monday P3 in 5-A is a different lesson from Monday P3 in
  // 5-B, and the strip would go on describing the one you left.
  useEffect(() => setPicked(null), [draftId, view, sectionId, teacherId]);

  /**
   * §31.11 — what the strip says while this tab is open.
   *
   * Two halves. The first describes the selected cell, or, with nothing
   * selected, says how the board works — the sentence that used to sit under
   * the grid and cost a row of school. The second is **the draft's own
   * numbers**, which is where the five stat boxes went: they are the figures
   * this draft is judged on, and the strip is a row that already exists.
   *
   * Built from THIS component's payload rather than handed up as ids. The host
   * is looking at its own copy of `/slots` — possibly a different draft, or the
   * published week — and a strip resolved against that would explain a lesson
   * that is not on the board (§31.10's rule, restated for cards).
   */
  const stripGroups: StripGroup[] | null = useMemo(() => {
    if (!onStrip || !data) return null;
    const groups: StripGroup[] = [];

    if (picked) {
      const period = data.periods.find((p) => p.periodNumber === picked.period);
      const when = `${DAY_NAMES[picked.day]} · P${picked.period}`
        + (period ? ` · ${period.startTime}` : "");
      const rowName = view === "section"
        ? (sections.find((x) => x.id === activeSection)?.label ?? "")
        : (data.teachers[String(activeTeacher)] ?? "");
      // The same lookup the cell itself used, so the strip and the card cannot
      // disagree about what is in the cell. §4.9: in the teacher view a block
      // is this person's lesson when one of its OPTIONS is theirs — matching
      // `teacherId` alone leaves every language teacher's week blank.
      const e = view === "section"
        ? entriesByCell.get(`${activeSection}@${picked.day}:${picked.period}`)
        : (engine?.all ?? []).find((x) =>
            x.day === picked.day && x.period === picked.period
            && (x.teacherId === activeTeacher || x.options.some((op) => op.teacherId === activeTeacher)));

      if (!e) {
        groups.push({ label: "The cell", primary: "Free", lines: [when, rowName].filter(Boolean) });
      } else {
        const subject = e.subjectId !== null ? (data.subjects[String(e.subjectId)] ?? null) : null;
        const block = e.electiveBlockId !== null ? data.blocks?.[String(e.electiveBlockId)] : undefined;
        const room = e.roomId !== null ? (data.rooms[String(e.roomId)] ?? null) : null;
        const attending = e.classSectionIds
          .map((id) => sections.find((x) => x.id === id)?.label)
          .filter(Boolean) as string[];

        groups.push({
          label: "The card",
          // §10.5 — a block is several subjects at once and belongs to none of
          // them, so it is named by the block and keeps no subject's colour.
          primary: subject ?? block?.name ?? "Lesson",
          swatch: subject ? colors.subject(subject) : null,
          lines: [
            when,
            [room, e.locked ? "pinned" : null].filter(Boolean).join(" · "),
          ].filter(Boolean),
        });

        if (attending.length > 0) {
          groups.push({
            label: attending.length > 1 ? "The classes" : "The class",
            primary: attending.length > 2 ? `${attending.length} sections` : attending.join(", "),
            swatch: colors.classOf(attending[0]),
            lines: [
              attending.length > 2 ? attending.join(", ") : "",
              e.mergedGroupId !== null ? "Taught together as one lesson (§4.10)" : "",
            ].filter(Boolean),
          });
        }

        if (e.teacherId !== null) {
          groups.push({
            label: "The teacher",
            primary: data.teachers[String(e.teacherId)] ?? "—",
            lines: [
              e.locked
                ? "Pinned — drags and solver re-runs treat this cell as fixed"
                : "Drag the card to move it; every legal destination glows",
            ],
          });
        }

        if (block) {
          groups.push({
            label: "Running inside it",
            chips: block.options.map((op) => ({
              text: `${op.subject} ${initials(op.teacher)}`,
              swatch: colors.subject(op.subject),
              title: `${op.subject} — ${op.teacher} (${op.room})`,
            })),
          });
        }
      }
    } else {
      groups.push({
        label: "The board",
        lines: [
          "Pick up a card — every legal destination glows green, cyan proposes a swap.",
          "Illegal drops shake and explain the rule. Click any cell to see what it is.",
        ],
      });
    }

    if (shown) {
      const errs = shown.errorCount ?? 0;
      const warns = shown.warningCount ?? 0;
      groups.push({
        label: `Draft #${shown.draftNo}`,
        primary: shown.generationPct === null ? "—" : `${shown.generationPct}% generated`,
        lines: [
          `${(shown.placedLessons ?? 0).toLocaleString()} of ${(shown.requiredLessons ?? 0).toLocaleString()} lessons placed`,
          `${errs} error${errs === 1 ? "" : "s"} · ${warns} warning${warns === 1 ? "" : "s"}`,
          shown.label ?? "",
        ].filter(Boolean),
      });
    }
    return groups;
  }, [onStrip, data, picked, view, activeSection, activeTeacher, entriesByCell, engine, sections, colors, shown]);

  /*
    Emitted on CONTENT, not on identity.

    The host's handler puts these in its own state, which re-renders this
    component, which would rebuild the array — so a dependency on the array
    itself is a loop waiting for one unmemoised value upstream (`useColors`,
    say) to arm it. Comparing the serialised groups makes the loop impossible
    by construction rather than by everybody upstream staying careful. The
    groups are five small objects, so the cost is nothing.
  */
  const lastStrip = useRef<string>("");
  useEffect(() => {
    if (!onStrip) return;
    const key = JSON.stringify(stripGroups);
    if (key === lastStrip.current) return;
    lastStrip.current = key;
    onStrip(stripGroups);
  });

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
            { classSectionIds: [activeSection as number], subjectId: Number(subj), teacherId: Number(teach), roomId: null, mergedGroupId: null, electiveBlockId: null, options: [] },
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
    // §4.9: a block is named by its own id — its option rows belong to no
    // section, so a section-based reference would leave the lessons behind.
    const refOf = (x: BoardEntry) =>
      x.electiveBlockId !== null
        ? { electiveBlockId: x.electiveBlockId, day: x.day, period: x.period }
        : { classSectionId: x.classSectionIds[0], day: x.day, period: x.period };
    const expectOf = (x: BoardEntry) =>
      x.electiveBlockId !== null
        ? { electiveOptionIds: x.options.map((o) => o.optionId) }
        : { subjectId: x.subjectId, teacherId: x.teacherId };
    const from = refOf(e);
    const expect = expectOf(e);
    if (verdict.kind === "swap") {
      const other = engine.get(verdict.withKey);
      if (!other) return;
      // A multi-section card can displace a DIFFERENT lesson in each of its
      // member sections, which the two-card endpoint cannot express — the
      // server works out what moves, from the engine, not from this request.
      if (isMultiSection(e) || isMultiSection(other)) {
        const n = verdict.displaced?.length ?? 1;
        await post("swap-group", { from, expect, to: { day, period } },
          `Swapped ✓ — ${n} card${n === 1 ? "" : "s"} moved the other way${verdict.warning ? ` · ${verdict.warning}` : ""}`);
        return;
      }
      await post("swap", {
        a: from, expectA: expect,
        b: refOf(other),
        expectB: expectOf(other),
      }, `Swapped ✓${verdict.warning ? ` — ${verdict.warning}` : ""}`);
    } else {
      // §20: legal, but worth saying — the day this card leaves behind may now
      // be too thin to be worth the teacher's journey in.
      await post("move", { from, expect, to: { day, period } }, `Moved ✓${verdict.warning ? ` — ${verdict.warning}` : ""}`);
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

  // A host draws this inside a bordered pane, so a bare sentence at the very
  // top-left of it reads as a rendering fault rather than a state.
  const holdStyle = embedded ? { padding: 20 } : undefined;
  if (!current) return <p className="screen-sub" style={holdStyle}>Select a timetable first.</p>;
  if (!ctx || !data || !engine) return <p className="screen-sub" style={holdStyle}>Loading draft board…</p>;

  const activeEntry = activeKey && !activeKey.startsWith("tray:") ? engine.get(activeKey) : null;

  const grid = (
    rowsFor: (day: number, period: number) => BoardEntry | undefined,
    editable: boolean,
    // §4.9: in the By Teacher view a block cell must show THIS teacher's
    // option — French in Room 41 — not the block's whole menu, which would
    // credit them with two colleagues' lessons.
    forTeacher?: number | null,
  ) => (
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
              const mine = e && forTeacher != null ? e.options.find((o) => o.teacherId === forTeacher) : undefined;
              const content = mine && e ? (
                <div className="dnd-card elective" style={{ cursor: "default" }}
                  title={`${cardLabel(e, data)} — runs alongside ${
                    e.options.filter((o) => o.teacherId !== forTeacher)
                      .map((o) => `${data.subjects[String(o.subjectId)] ?? "?"} (${data.teachers[String(o.teacherId)] ?? "?"})`)
                      .join(", ") || "no other option"
                  }`}>
                  <div className="t">{data.subjects[String(mine.subjectId)] ?? "?"} ⋔</div>
                  <div className="s">
                    {cardLabel(e, data)}
                    {mine.roomId ? ` · ${data.rooms[String(mine.roomId)]}` : ""}
                  </div>
                </div>
              ) : e ? (
                editable ? (
                  <DraggableCard
                    entry={e}
                    label={cardLabel(e, data)}
                    sub={cardSub(e, data, sections)}
                    swatch={colors.subject(colorNameOf(e, data))}
                    disabled={busy}
                    dragging={activeKey === e.key}
                    onLock={() => post("lock", { from: { classSectionId: e.classSectionIds[0], day: e.day, period: e.period }, locked: !e.locked }, e.locked ? "Unpinned" : "Pinned — solver re-runs keep this cell")}
                    onRemove={() => post("remove", { from: { classSectionId: e.classSectionIds[0], day: e.day, period: e.period }, expect: { subjectId: e.subjectId, teacherId: e.teacherId } }, "Moved to unplaced tray")}
                  />
                ) : (
                  <ReadOnlyCard entry={e} data={data} sections={sections} swatch={colors.subject(colorNameOf(e, data))} />
                )
              ) : (
                <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-faint)", fontSize: 10 }}>—</span>
              );
              // §31.11 — selectable only where there is a strip to answer in.
              const pick = onStrip
                ? () => setPicked({ day: d, period: p.periodNumber as number })
                : undefined;
              const isPicked = picked !== null && picked.day === d && picked.period === p.periodNumber;
              return editable ? (
                <DropCell key={cellId} day={d} period={p.periodNumber as number} verdict={activeKey ? (legal?.get(cellId) ?? null) : null} shaking={shakeCell === cellId}
                  selected={isPicked} onSelect={pick}>
                  {content}
                </DropCell>
              ) : (
                <div key={cellId} className={`dnd-cell${isPicked ? " picked" : ""}`} onClick={pick}>{content}</div>
              );
            }),
          ]
        ),
      )}
    </div>
  );

  /*
    §31.11 — the controls, written once and placed in one of two rows.

    On `/board` they are this screen's own toolbar, split left and right across
    the width. In the Master Grid they are portalled into the host's bar, which
    is the same device §31.10 used for the Allocation grid: the host already
    draws a toolbar, and a second one below it would cost a row of the grid on
    a screen whose whole design is about not spending rows.
  */
  const small: React.CSSProperties = embedded
    ? { padding: "5px 10px", fontSize: 12 }
    : {};
  const selectStyle: React.CSSProperties = embedded
    ? { padding: "5px 9px", border: "1px solid var(--line)", borderRadius: 8, fontWeight: 600, fontSize: 12 }
    : { padding: "8px 11px", border: "1px solid var(--line)", borderRadius: 8, fontWeight: 600, fontSize: 13 };
  const pickerStyle: React.CSSProperties = { ...selectStyle, fontWeight: 700, color: "var(--brand)" };

  const pickers = (
    <>
      {/* §22.5 — which of the school's drafts this board is editing. Left of
          everything else because it scopes everything else.

          Hidden when the HOST has a picker of its own: the Master Grid's one
          governs its other four tabs too, and two selects over one screen is
          two answers to "which draft am I looking at?". */}
      {!controlled && liveDrafts.length > 0 && (
        <select
          value={shownDraftId ?? ""}
          onChange={(e) => chooseDraft(Number(e.target.value))}
          style={{ ...pickerStyle, border: "1px solid var(--brand)", background: "var(--steel-pale)" }}
        >
          {liveDrafts.map((d) => (
            <option key={d.id} value={d.id}>
              Draft #{d.draftNo}{d.label ? ` — ${d.label}` : ""}
              {d.generationPct !== null ? ` · ${d.generationPct}%` : ""}
            </option>
          ))}
        </select>
      )}
      <select value={view} onChange={(e) => setView(e.target.value as "section" | "teacher")} style={selectStyle}>
        <option value="section">By Class-Section</option>
        <option value="teacher">By Teacher (read-only)</option>
      </select>
      {view === "section" ? (
        <select value={activeSection ?? ""} onChange={(e) => setSectionId(Number(e.target.value))} style={pickerStyle}>
          {sections.map((s) => <option key={s.id} value={s.id}>{s.label} · Draft</option>)}
        </select>
      ) : (
        <select value={activeTeacher ?? ""} onChange={(e) => setTeacherId(Number(e.target.value))} style={pickerStyle}>
          {teacherIds.map((t) => <option key={t} value={t}>{data.teachers[String(t)]}</option>)}
        </select>
      )}
      {/* The pill states the SELECTED draft's standing, not a constant —
          an archived draft is read-only and a published one is the
          school's live timetable, and both must say so. */}
      <span className={`badge ${shown?.status === "published" ? "badge-ok" : shown?.status === "archived" ? "badge-neutral" : "badge-warn"}`}>
        {shown?.status === "published"
          ? `DRAFT #${shown.draftNo} — PUBLISHED`
          : shown?.status === "archived"
            ? `DRAFT #${shown.draftNo} — ARCHIVED`
            : shown
              ? `DRAFT #${shown.draftNo} — not published`
              : "DRAFT — not published"}
      </span>
    </>
  );

  const actions = (
    <>
      <button className="btn" style={small} onClick={newDraft} disabled={busy}>＋ New draft</button>
      <button className="btn" style={small} onClick={() => setComparing((c) => !c)} disabled={liveDrafts.length < 2}
        title={liveDrafts.length < 2 ? "Compare needs at least two drafts" : "Compare every draft's numbers side by side"}>
        {comparing ? "Hide comparison" : "Compare drafts"}
      </button>
      <button className="btn" style={small} onClick={autoFill} disabled={busy}>Auto-fill remaining gaps</button>
      <Link
        to={shownDraftId !== null ? `/publish?draftId=${shownDraftId}` : "/publish"}
        className="btn btn-primary"
        style={{ textDecoration: "none", ...small }}
      >
        {shown ? `Publish Draft #${shown.draftNo}…` : "Publish…"}
      </Link>
    </>
  );

  const controls = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {pickers}
      {actions}
    </div>
  );

  const trayTotal = tray.reduce((n, t) => n + t.missing, 0);
  const trayBlock = (
    <>
      <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--ink-faint)", marginBottom: 6 }}>
        Unplaced tray — drag onto the grid ({trayTotal} period{trayTotal === 1 ? "" : "s"})
      </div>
      <div className="tray">
        {tray.length === 0 ? (
          <span style={{ fontSize: 11.5, color: "var(--ink-faint)", alignSelf: "center" }}>
            Every required period for this class-section is placed ✓ &nbsp;(drop a card here? use ✕ on a card to return it)
          </span>
        ) : (
          tray.map((t) => (
            <TrayCard key={`${t.subjectId}:${t.teacherId}`} id={`tray:${t.subjectId}:${t.teacherId}`}
              swatch={colors.subject(data.subjects[String(t.subjectId)])}
              fill={embedded}
              label={data.subjects[String(t.subjectId)] ?? "?"}
              sub={data.teachers[String(t.teacherId)] ?? ""} count={t.missing} />
          ))
        )}
      </div>
    </>
  );

  const overlay = (
    <DragOverlay dropAnimation={null}>
      {activeKey ? (
        <div className="drag-overlay-card">
          {activeKey.startsWith("tray:")
            ? data.subjects[activeKey.split(":")[1]] ?? "…"
            : activeEntry?.electiveBlockId != null
              ? `${cardLabel(activeEntry, data)} ⋔ · ${activeEntry.options.length} lessons, ${activeEntry.classSectionIds.length} sections`
              : `${data.subjects[String(activeEntry?.subjectId)] ?? "…"} · ${initials(data.teachers[String(activeEntry?.teacherId)] ?? "")}`}
        </div>
      ) : null}
    </DragOverlay>
  );

  const sectionBoard = (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => { setActiveKey(null); setLegal(null); }}>
      {embedded ? (
        /*
          §31.11 — the tray is a COLUMN beside the grid, not a band under it.

          Height is the scarce dimension on this screen and width is not: the
          grid needs five day columns and the pane is 1,600px wide. Sticky, so
          it stays reachable while the grid scrolls — a drag target that has
          scrolled off the top is a drag nobody can finish.
        */
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            {grid((d, p) => entriesByCell.get(`${activeSection}@${d}:${p}`), true)}
          </div>
          <aside style={{ flex: "0 0 178px", position: "sticky", top: 0 }}>
            {trayBlock}
          </aside>
        </div>
      ) : (
        <>
          {grid((d, p) => entriesByCell.get(`${activeSection}@${d}:${p}`), true)}
          <div style={{ marginTop: 18 }}>{trayBlock}</div>
        </>
      )}
      {overlay}
    </DndContext>
  );

  const teacherBoard = grid(
    (d, p) => {
      for (const e of engine.all) {
        if (e.day !== d || e.period !== p) continue;
        // §4.9: a block is this teacher's lesson when one of its options
        // is theirs. Matching only `teacherId` left every language
        // teacher's week blank, because a block has no teacher of its own.
        if (e.teacherId === activeTeacher) return e;
        if (e.options.some((o) => o.teacherId === activeTeacher)) return e;
      }
      return undefined;
    },
    false,
    activeTeacher,
  );

  const emptyState = (
    <div className="card" style={{ textAlign: "center", padding: 40 }}>
      <p style={{ fontWeight: 700, marginBottom: 6 }}>No draft to edit.</p>
      <p className="screen-sub">Generate a timetable, or start a new draft from the published version.</p>
      <button className="btn btn-primary" disabled={busy}
        onClick={() => post("draft-from-published", {}, "Draft created from the published timetable")}>
        Create draft from published
      </button>
    </div>
  );

  const body = data.slots.length === 0 ? emptyState : view === "section" ? sectionBoard : teacherBoard;

  const compare = (
    <DraftCompare drafts={liveDrafts} shownId={shownDraftId} onOpen={(id) => { chooseDraft(id); setComparing(false); }} onDiscard={discardDraft} busy={busy} />
  );

  if (embedded) {
    /*
      §31.11 — one screen, and the scarce dimension is height.

      Three things that cost rows on `/board` are gone here rather than shrunk.
      The five stat boxes moved into the strip, which already exists and was
      showing nothing on this tab. The comparison table REPLACES the grid
      instead of sitting above it — it is a different way to look at the same
      drafts, not an addition to this one. And the paragraph under the grid is
      in the strip's opening line.

      What is left is a flex column: the pane takes what the host leaves and
      scrolls inside itself, so nothing below it — least of all the strip — is
      pushed off the bottom of the page.
    */
    return (
      <div className="board-compact" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {toolbarHost ? createPortal(controls, toolbarHost) : controls}
        <div style={{ flex: "1 1 auto", minHeight: 0, overflow: "auto", padding: "10px 12px" }}>
          {comparing && liveDrafts.length > 0 ? compare : body}
        </div>
        {toast && <div className={`board-toast ${toast.kind}`}>{toast.msg}</div>}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>{pickers}</div>
        <div style={{ display: "flex", gap: 10 }}>{actions}</div>
      </div>

      {/* §22.5 — the numbers this draft is judged on, read off the registry
          row rather than counted from 2,000 slots per render (§14). */}
      {shown && (
        <div style={{ display: "flex", gap: 10, margin: "0 0 14px" }}>
          <StatBox n={shown.generationPct === null ? "—" : `${shown.generationPct}%`} l="Generation"
            color={shown.generationPct === null ? undefined : shown.generationPct >= 100 ? "var(--accent)" : shown.generationPct < 97 ? "var(--amber)" : undefined} />
          <StatBox n={(shown.requiredLessons ?? 0).toLocaleString()} l="Total allocation (required)" />
          <StatBox n={(shown.placedLessons ?? 0).toLocaleString()} l="Actual allocation (placed)" />
          <StatBox n={shown.errorCount ?? "—"} l="Errors — unplaced / violations"
            color={shown.errorCount ? "var(--signal)" : "var(--accent)"} />
          <StatBox n={shown.warningCount ?? "—"} l="Warnings — advisory"
            color={shown.warningCount ? "var(--amber)" : "var(--accent)"} />
        </div>
      )}

      {comparing && liveDrafts.length > 0 && compare}

      {body}

      <p className="screen-sub" style={{ marginTop: 14 }}>
        Pick up a card — every legal destination glows green (cyan = swap proposal). Illegal drops shake, beep, and
        explain the exact rule. 📌 pins a card so drags and solver re-runs treat it as fixed.
      </p>

      {toast && <div className={`board-toast ${toast.kind}`}>{toast.msg}</div>}
    </div>
  );
}
