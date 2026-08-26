/**
 * §7 — drag-and-drop legality engine. Wraps the SAME SolverState the CSP
 * solver places with (one rules engine, three call sites: solver search,
 * client-side drag legality, server-side drop revalidation). Also enforces
 * the §4.7 domain rules that live in variable construction during solving
 * (teacher unavailability, alternate_day, class-teacher P1) — a manual move
 * must never reach a cell the solver itself was forbidden to consider.
 */
import type { SolverInput, SolverVariable } from "../solver/types";
import { SolverState } from "../solver/state";
import { cellKey, segmentOfPeriod } from "../solver/variables";

/** One draggable card: a single slot, or a merged-group occupancy collapsed
 *  across its member sections (drags as one linked unit, §4.9). */
export interface BoardEntry {
  /** stable key: `S{classSectionId}` single / `G{mergedGroupId}` merged, + `@d:p` */
  key: string;
  classSectionIds: number[];
  subjectId: number;
  teacherId: number;
  roomId: number | null;
  mergedGroupId: number | null;
  day: number;
  period: number;
  locked: boolean;
}

export interface BoardVerdict {
  ok: boolean;
  /** room the entry would occupy at the target (lab reassignment allowed) */
  roomId: number | null;
  /** human-readable specific reason when not ok (§7.1) */
  reason?: string;
}

export type CellVerdict =
  | { kind: "move"; roomId: number | null }
  | { kind: "swap"; withKey: string; roomAtTarget: number | null; otherRoomAtSource: number | null }
  | { kind: "illegal"; reason: string };

/** A cell held by something the board cannot move — see the constructor. */
export interface ReservedCell {
  classSectionId: number;
  day: number;
  period: number;
  /** what to tell the user is already there, e.g. "Class 5 Third Language" */
  label: string;
}

export interface SlotRow {
  classSectionId: number;
  dayOfWeek: number;
  periodNumber: number;
  subjectId: number;
  teacherId: number;
  roomId: number | null;
  mergedGroupId: number | null;
  isLocked: boolean;
}

export const entryKeyOf = (row: {
  classSectionId: number;
  mergedGroupId: number | null;
  dayOfWeek: number;
  periodNumber: number;
}) =>
  row.mergedGroupId !== null
    ? `G${row.mergedGroupId}@${row.dayOfWeek}:${row.periodNumber}`
    : `S${row.classSectionId}@${row.dayOfWeek}:${row.periodNumber}`;

/** Collapse raw slot rows (primary + merged echo rows) into board entries. */
export function rowsToEntries(rows: SlotRow[]): BoardEntry[] {
  const byKey = new Map<string, BoardEntry>();
  for (const r of rows) {
    const key = entryKeyOf(r);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.classSectionIds.includes(r.classSectionId)) {
        existing.classSectionIds.push(r.classSectionId);
      }
      existing.roomId = existing.roomId ?? r.roomId;
      existing.locked = existing.locked || r.isLocked;
    } else {
      byKey.set(key, {
        key,
        classSectionIds: [r.classSectionId],
        subjectId: r.subjectId,
        teacherId: r.teacherId,
        roomId: r.roomId,
        mergedGroupId: r.mergedGroupId,
        day: r.dayOfWeek,
        period: r.periodNumber,
        locked: r.isLocked,
      });
    }
  }
  return [...byKey.values()];
}

export class BoardEngine {
  private state: SolverState;
  private entries = new Map<string, BoardEntry>();
  private reservedByCell = new Map<string, string>();
  /** numeric pseudo-variable id per entry key (SolverState indexes by id) */
  private idByKey = new Map<string, number>();
  private keyById = new Map<number, string>();
  private nextId = 1;
  private seg: number[];
  private samePeriodSubjects: Set<string>; // `${classId}:${subjectId}`
  private maxPerDayByClassSubject = new Map<string, number>();
  private classIdBySection = new Map<number, number>();
  private labSubjects: Set<number>;
  private subjectNames = new Map<number, string>();
  private teacherNames = new Map<number, string>();
  private sectionLabels = new Map<number, string>();

  /**
   * `reserved` marks cells the board cannot touch but must not pretend are
   * free — today, the member cells of a §4.9 elective block. They are not
   * entries because there is nothing draggable about them: a block moves as a
   * whole or not at all, and half of one is not a card. Without them the
   * client would happily offer a drop the server then refuses, which is the
   * one thing invariant 7's client-first legality is supposed to prevent.
   */
  constructor(
    private readonly input: SolverInput,
    rows: SlotRow[],
    reserved: ReservedCell[] = [],
  ) {
    // locked cells are modelled as regular entries here (so blockers resolve
    // to a nameable card), never through SolverState's lockedSlots seeding.
    this.state = new SolverState({ ...input, lockedSlots: [] });
    for (const c of reserved) {
      this.reservedByCell.set(`${c.classSectionId}@${c.day}:${c.period}`, c.label);
    }
    const snap = input.snapshot;
    this.seg = segmentOfPeriod(snap.config.daySegments, snap.config.periodsPerDay);
    this.labSubjects = new Set(snap.labSubjectIds);
    this.samePeriodSubjects = new Set(
      snap.subjectRequirements.filter((r) => r.samePeriodAcrossWeek).map((r) => `${r.classId}:${r.subjectId}`),
    );
    for (const r of snap.subjectRequirements) {
      this.maxPerDayByClassSubject.set(`${r.classId}:${r.subjectId}`, r.maxPeriodsPerDay);
    }
    for (const cs of snap.classSections) {
      this.classIdBySection.set(cs.id, cs.classId);
      this.sectionLabels.set(cs.id, cs.label);
    }
    for (const s of snap.subjectRequirements) this.subjectNames.set(s.subjectId, s.subjectName);
    for (const m of snap.mappings) this.subjectNames.set(m.subjectId, m.subjectName);
    for (const g of snap.mergedGroups) this.subjectNames.set(g.subjectId, g.subjectName);
    for (const t of snap.teachers) this.teacherNames.set(t.id, t.name);

    for (const e of rowsToEntries(rows)) this.addEntry(e);
  }

  get all(): BoardEntry[] {
    return [...this.entries.values()];
  }
  get(key: string): BoardEntry | undefined {
    return this.entries.get(key);
  }
  entryAt(classSectionId: number, day: number, period: number): BoardEntry | undefined {
    for (const e of this.entries.values()) {
      if (e.day === day && e.period === period && e.classSectionIds.includes(classSectionId)) return e;
    }
    return undefined;
  }

  private varOf(e: BoardEntry, opts?: { roomId?: number | null }): SolverVariable {
    const roomId = opts && "roomId" in opts ? (opts.roomId ?? null) : e.roomId;
    // a lab-subject card in a lab room may re-home to ANY free lab on a move;
    // a preferred-room assignment (non-lab) stays hard (§3)
    const labFlexible =
      this.labSubjects.has(e.subjectId) && (roomId === null || this.input.labRoomIds.includes(roomId));
    const classId = this.classIdBySection.get(e.classSectionIds[0]);
    const samePeriodKey =
      e.mergedGroupId === null && classId !== undefined && this.samePeriodSubjects.has(`${classId}:${e.subjectId}`)
        ? `${e.classSectionIds[0]}:${e.subjectId}`
        : null;
    return {
      id: this.idByKey.get(e.key) ?? 0,
      classSectionIds: e.classSectionIds,
      classSectionLabels: e.classSectionIds.map((id) => this.sectionLabels.get(id) ?? `#${id}`),
      subjectId: e.subjectId,
      subjectName: this.subjectNames.get(e.subjectId) ?? `subject #${e.subjectId}`,
      teacherId: e.teacherId,
      mergedGroupId: e.mergedGroupId,
      // The board edits ordinary and merged cells. A §4.9 elective block is
      // placed by the solver and moved as a whole; its member rows carry no
      // subject, so they never become a BoardEntry in the first place.
      electiveBlockId: null,
      options: [],
      labRoomIds: [],
      homeRoomId: null,
      dayKey: `S${e.subjectId}`,
      mappingId: null,
      span: 1,
      needsLabRoom: labFlexible,
      preferredRoomId: labFlexible ? null : roomId,
      samePeriodKey,
      maxPerDay:
        classId !== undefined
          ? (this.maxPerDayByClassSubject.get(`${classId}:${e.subjectId}`) ??
            this.input.snapshot.config.periodsPerDay)
          : this.input.snapshot.config.periodsPerDay,
      domain: [],
    };
  }

  private addEntry(e: BoardEntry) {
    const id = this.nextId++;
    this.idByKey.set(e.key, id);
    this.keyById.set(id, e.key);
    this.entries.set(e.key, e);
    this.state.place({ ...this.varOf(e), id }, e.day, e.period, e.roomId);
  }

  private removeEntry(e: BoardEntry) {
    const id = this.idByKey.get(e.key);
    this.state.unplace({ ...this.varOf(e), id: id ?? 0 }, e.day, e.period, e.roomId);
    this.entries.delete(e.key);
    this.idByKey.delete(e.key);
    if (id !== undefined) this.keyById.delete(id);
  }

  /** §4.7 domain rules that the solver enforces via pruning, re-checked here. */
  private domainCheck(e: BoardEntry, day: number, period: number): string | null {
    const tc = this.state.teacherCtx.get(e.teacherId);
    const name = this.teacherNames.get(e.teacherId) ?? "This teacher";
    if (!this.input.snapshot.config.workingDays.includes(day)) return "Not a working day";
    if (period < 1 || period > this.input.snapshot.config.periodsPerDay) return "No such period";
    // A §4.9 block holds this cell in every section that attends it, and it is
    // not a card that can be pushed aside.
    for (const csId of e.classSectionIds) {
      const held = this.reservedByCell.get(`${csId}@${day}:${period}`);
      if (held) {
        const label = this.sectionLabels.get(csId) ?? `#${csId}`;
        return `${label} is in ${held} in this slot — an elective block moves as a whole, not card by card`;
      }
    }
    if (tc) {
      if (!tc.allowedDays.has(day)) return `${name} teaches on alternate days only — this day is not in their set`;
      if (tc.blocked.has(cellKey(day, period))) return `${name} is marked unavailable in this slot`;
      if (tc.hasP1Rule && period === 1 && !e.classSectionIds.every((id) => tc.p1OwnSections.has(id))) {
        return `${name} is a class teacher who must take Period 1 in their own class`;
      }
    }
    return null;
  }

  private describeBlocker(varId: number, fallback: string): string {
    const key = this.keyById.get(varId);
    const b = key ? this.entries.get(key) : undefined;
    if (!b) return fallback;
    const teacher = this.teacherNames.get(b.teacherId) ?? `teacher #${b.teacherId}`;
    const subject = this.subjectNames.get(b.subjectId) ?? `subject #${b.subjectId}`;
    const sections = b.classSectionIds.map((id) => this.sectionLabels.get(id) ?? `#${id}`).join(" / ");
    return `${teacher} already teaches ${sections} ${subject} in this slot`;
  }

  private explain(e: BoardEntry, day: number, period: number, reason: string | undefined, blockers: number[]): string {
    const teacher = this.teacherNames.get(e.teacherId) ?? "This teacher";
    const subject = this.subjectNames.get(e.subjectId) ?? "this subject";
    const section = e.classSectionIds.map((id) => this.sectionLabels.get(id) ?? `#${id}`).join(" / ");
    switch (reason) {
      case "teacher occupied":
        return this.describeBlocker(blockers[0], `${teacher} is already teaching in this slot`);
      case "section occupied":
        return this.describeBlocker(blockers[0], `${section} already has a period in this slot`);
      case "subject daily max":
        return `${section} already has the daily maximum of ${subject} on this day`;
      case "teacher daily max":
        return `${teacher} is already at their daily period limit on this day`;
      case "same-period rule":
        return `${subject} for ${section} must stay in the same period on every day (same-period rule)`;
      case "adjacent period (alternate-period rule)":
        return `${teacher} is configured for alternate periods only — this cell is adjacent to another of their periods`;
      case "alternate-period teacher cannot take blocks":
        return `${teacher} is configured for alternate periods only and cannot take consecutive periods`;
      case "preferred room occupied":
        return this.describeBlocker(blockers[0], `The room for this card is already in use in this slot`);
      case "no lab room free":
        return `No lab room is free in this slot (${subject} needs a lab)`;
      default:
        return reason ?? "This move breaks a scheduling rule";
    }
  }

  /**
   * Would moving `key` to (day, period) be legal? Pure check — board unchanged.
   * The entry is lifted out first so it never blocks itself.
   */
  checkMove(key: string, day: number, period: number): BoardVerdict {
    const e = this.entries.get(key);
    if (!e) return { ok: false, roomId: null, reason: "Card no longer exists — the board changed under you" };
    if (e.locked) return { ok: false, roomId: null, reason: "This card is locked — unpin it first" };
    if (e.day === day && e.period === period) return { ok: true, roomId: e.roomId };
    const dom = this.domainCheck(e, day, period);
    if (dom) return { ok: false, roomId: null, reason: dom };

    const id = this.idByKey.get(e.key) ?? 0;
    const v = { ...this.varOf(e), id };
    this.state.unplace(v, e.day, e.period, e.roomId);
    const res = this.state.check(v, day, period);
    this.state.place(v, e.day, e.period, e.roomId);
    if (res.ok) return { ok: true, roomId: res.roomId };
    return { ok: false, roomId: null, reason: this.explain(e, day, period, res.reason, res.blockers) };
  }

  /** Swap two cards (§7.3) — legal only if BOTH sides stay legal. Pure check. */
  checkSwap(keyA: string, keyB: string): { ok: boolean; reason?: string; roomA: number | null; roomB: number | null } {
    const a = this.entries.get(keyA);
    const b = this.entries.get(keyB);
    if (!a || !b) return { ok: false, reason: "Card no longer exists — the board changed under you", roomA: null, roomB: null };
    if (a.locked || b.locked) return { ok: false, reason: "A locked card cannot take part in a swap — unpin it first", roomA: null, roomB: null };
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const dom = this.domainCheck(x, y.day, y.period);
      if (dom) return { ok: false, reason: dom, roomA: null, roomB: null };
    }
    const idA = this.idByKey.get(a.key) ?? 0;
    const idB = this.idByKey.get(b.key) ?? 0;
    const vA = { ...this.varOf(a), id: idA };
    const vB = { ...this.varOf(b), id: idB };
    this.state.unplace(vA, a.day, a.period, a.roomId);
    this.state.unplace(vB, b.day, b.period, b.roomId);
    let reason: string | undefined;
    let roomA: number | null = null;
    let roomB: number | null = null;
    const resA = this.state.check(vA, b.day, b.period);
    if (!resA.ok) {
      reason = this.explain(a, b.day, b.period, resA.reason, resA.blockers);
    } else {
      roomA = resA.roomId;
      this.state.place(vA, b.day, b.period, roomA);
      const resB = this.state.check(vB, a.day, a.period);
      if (!resB.ok) reason = this.explain(b, a.day, a.period, resB.reason, resB.blockers);
      else roomB = resB.roomId;
      this.state.unplace(vA, b.day, b.period, roomA);
    }
    this.state.place(vA, a.day, a.period, a.roomId);
    this.state.place(vB, b.day, b.period, b.roomId);
    return reason ? { ok: false, reason, roomA: null, roomB: null } : { ok: true, roomA, roomB };
  }

  /** Placing a brand-new card (from the unplaced tray) at (day, period). */
  checkPlace(
    entry: Omit<BoardEntry, "key" | "day" | "period" | "locked">,
    day: number,
    period: number,
  ): BoardVerdict {
    const probe: BoardEntry = { ...entry, key: "__probe__", day, period, locked: false };
    const dom = this.domainCheck(probe, day, period);
    if (dom) return { ok: false, roomId: null, reason: dom };
    const res = this.state.check({ ...this.varOf(probe), id: 0 }, day, period);
    if (res.ok) return { ok: true, roomId: res.roomId };
    return { ok: false, roomId: null, reason: this.explain(probe, day, period, res.reason, res.blockers) };
  }

  /**
   * §7.2 "suggest where I can move this": verdict for EVERY cell of the grid —
   * empty cells check a move, occupied cells check a swap.
   */
  legalDestinations(key: string): Map<string, CellVerdict> {
    const e = this.entries.get(key);
    const out = new Map<string, CellVerdict>();
    if (!e) return out;
    const { workingDays, periodsPerDay } = this.input.snapshot.config;
    for (const day of workingDays) {
      for (let p = 1; p <= periodsPerDay; p++) {
        if (day === e.day && p === e.period) continue;
        const occupant = this.entryAt(e.classSectionIds[0], day, p);
        const cell = `${day}:${p}`;
        if (occupant && e.mergedGroupId === null && occupant.mergedGroupId === null) {
          const swap = this.checkSwap(e.key, occupant.key);
          out.set(
            cell,
            swap.ok
              ? { kind: "swap", withKey: occupant.key, roomAtTarget: swap.roomA, otherRoomAtSource: swap.roomB }
              : { kind: "illegal", reason: swap.reason ?? "Swap breaks a rule" },
          );
        } else if (occupant) {
          // merged cards swap only with... nothing for now: moving multi-section
          // occupancies through a swap needs every member cell free both ways.
          const move = this.checkMove(e.key, day, p);
          out.set(cell, move.ok ? { kind: "move", roomId: move.roomId } : { kind: "illegal", reason: move.reason ?? "Occupied" });
        } else {
          const move = this.checkMove(e.key, day, p);
          out.set(cell, move.ok ? { kind: "move", roomId: move.roomId } : { kind: "illegal", reason: move.reason ?? "Illegal" });
        }
      }
    }
    return out;
  }

  /** Mutate the in-memory board after a confirmed move (client optimistic / server apply). */
  applyMove(key: string, day: number, period: number, roomId: number | null) {
    const e = this.entries.get(key);
    if (!e) return;
    this.removeEntry(e);
    this.addEntry({ ...e, key: entryKeyOf({ classSectionId: e.classSectionIds[0], mergedGroupId: e.mergedGroupId, dayOfWeek: day, periodNumber: period }), day, period, roomId });
  }
}
