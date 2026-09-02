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

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** One parallel lesson inside a §4.9 elective block. */
export interface BoardOption {
  optionId: number;
  subjectId: number;
  teacherId: number;
  roomId: number;
}

/**
 * One draggable card. Three shapes, all of which move as a single unit:
 *
 *   - an ordinary lesson (one section, one subject, one teacher)
 *   - a merged-group occupancy collapsed across its member sections (§4.9)
 *   - a split-elective block: several member sections holding one slot open
 *     while several lessons run inside it, each with its own teacher and room
 *
 * A block has no subject or teacher of its own — the lessons do — which is why
 * both are nullable. Reading `subjectId` without checking `electiveBlockId`
 * first is the mistake this nullability exists to make impossible.
 */
export interface BoardEntry {
  /** stable key: `S{classSectionId}` / `G{mergedGroupId}` / `B{electiveBlockId}`, + `@d:p` */
  key: string;
  classSectionIds: number[];
  subjectId: number | null;
  teacherId: number | null;
  roomId: number | null;
  mergedGroupId: number | null;
  /** §4.9 — set when this card is a whole elective block. */
  electiveBlockId: number | null;
  /** the block's parallel lessons; empty for every other kind of card */
  options: BoardOption[];
  day: number;
  period: number;
  locked: boolean;
}

/** True when a card occupies several sections at once — merged or elective.
 *  Those need the group swap, because a plain move demands every member cell
 *  be free at the target and in a full school that is almost never true. */
export const isMultiSection = (e: BoardEntry): boolean =>
  e.mergedGroupId !== null || e.electiveBlockId !== null || e.classSectionIds.length > 1;

export interface BoardVerdict {
  ok: boolean;
  /** room the entry would occupy at the target (lab reassignment allowed) */
  roomId: number | null;
  /** human-readable specific reason when not ok (§7.1) */
  reason?: string;
  /**
   * §20 — legal, but it costs something worth saying out loud: the move drops
   * a teacher's day below their minimum periods/day.
   *
   * Deliberately a warning and not a refusal. Refusing would make a day that
   * sits *exactly* at the minimum impossible to clear — every card on it would
   * be frozen, including the ones you would move to empty the day properly.
   * The guarantee belongs to generation, where the solver can see the whole
   * week at once; here an admin is overriding on purpose and needs to be told,
   * not blocked.
   */
  warning?: string;
}

export type CellVerdict =
  | { kind: "move"; roomId: number | null; warning?: string }
  | {
      kind: "swap";
      withKey: string;
      roomAtTarget: number | null;
      otherRoomAtSource: number | null;
      /** §7.3 group swap: every entry displaced by this drop, with the room
       *  it takes at the source. One element for an ordinary two-card swap. */
      displaced?: Array<{ key: string; roomId: number | null }>;
      warning?: string;
    }
  | { kind: "illegal"; reason: string };

/**
 * A raw draft row.
 *
 * §4.9 puts two row shapes in here that an ordinary lesson does not have: a
 * block's *member* row (a section, but no subject, teacher or room) and its
 * *option* rows (a subject, teacher and room, but no section). `rowsToEntries`
 * folds a cell's worth of both into one card.
 */
export interface SlotRow {
  classSectionId: number | null;
  dayOfWeek: number;
  periodNumber: number;
  subjectId: number | null;
  teacherId: number | null;
  roomId: number | null;
  mergedGroupId: number | null;
  electiveBlockId: number | null;
  electiveOptionId: number | null;
  isLocked: boolean;
}

export const entryKeyOf = (row: {
  classSectionId: number | null;
  mergedGroupId: number | null;
  electiveBlockId?: number | null;
  dayOfWeek: number;
  periodNumber: number;
}) =>
  row.electiveBlockId != null
    ? `B${row.electiveBlockId}@${row.dayOfWeek}:${row.periodNumber}`
    : row.mergedGroupId !== null
      ? `G${row.mergedGroupId}@${row.dayOfWeek}:${row.periodNumber}`
      : `S${row.classSectionId}@${row.dayOfWeek}:${row.periodNumber}`;

/**
 * Collapse raw slot rows into board entries.
 *
 * Three foldings happen here, and they are not the same:
 *   - a merged group's echo rows contribute their SECTION to one card
 *   - an elective block's member rows contribute their SECTION, and its option
 *     rows contribute a LESSON (`options[]`) while contributing no section —
 *     `class_section_id` is NULL on them by design (invariant 9)
 *   - everything else is one row, one card
 */
export function rowsToEntries(rows: SlotRow[]): BoardEntry[] {
  const byKey = new Map<string, BoardEntry>();
  for (const r of rows) {
    const key = entryKeyOf(r);
    let e = byKey.get(key);
    if (!e) {
      e = {
        key,
        classSectionIds: [],
        // A block's identity is its options, never the subject of whichever
        // row happened to be read first.
        subjectId: r.electiveBlockId != null ? null : r.subjectId,
        teacherId: r.electiveBlockId != null ? null : r.teacherId,
        roomId: r.electiveBlockId != null ? null : r.roomId,
        mergedGroupId: r.mergedGroupId,
        electiveBlockId: r.electiveBlockId ?? null,
        options: [],
        day: r.dayOfWeek,
        period: r.periodNumber,
        locked: false,
      };
      byKey.set(key, e);
    }
    if (r.classSectionId !== null && !e.classSectionIds.includes(r.classSectionId)) {
      e.classSectionIds.push(r.classSectionId);
    }
    if (r.electiveOptionId != null && r.subjectId !== null && r.teacherId !== null && r.roomId !== null) {
      e.options.push({
        optionId: r.electiveOptionId,
        subjectId: r.subjectId,
        teacherId: r.teacherId,
        roomId: r.roomId,
      });
    } else if (r.electiveBlockId == null) {
      e.roomId = e.roomId ?? r.roomId;
    }
    e.locked = e.locked || r.isLocked;
  }
  // Stable order so a card's option list reads the same on every render and
  // two engines built from the same rows produce identical keys downstream.
  for (const e of byKey.values()) {
    e.options.sort((a, b) => a.optionId - b.optionId);
    e.classSectionIds.sort((a, b) => a - b);
  }
  return [...byKey.values()];
}

export class BoardEngine {
  private state: SolverState;
  private entries = new Map<string, BoardEntry>();
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
  /** §4.9 — a block's own daily cap and display name, by block id. */
  private blockById = new Map<number, { name: string; maxPeriodsPerDay: number }>();

  /**
   * §4.9 blocks used to arrive as opaque `reserved` cells — cells the board
   * knew were taken but could not move. They are ordinary entries now: a block
   * IS draggable, as one unit, and the same SolverState that placed it during
   * generation is what re-validates the drag.
   */
  constructor(
    private readonly input: SolverInput,
    rows: SlotRow[],
  ) {
    // locked cells are modelled as regular entries here (so blockers resolve
    // to a nameable card), never through SolverState's lockedSlots seeding.
    this.state = new SolverState({ ...input, lockedSlots: [] });
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
    for (const b of snap.electiveBlocks) {
      this.blockById.set(b.id, { name: b.name, maxPeriodsPerDay: b.maxPeriodsPerDay });
      for (const o of b.options) this.subjectNames.set(o.subjectId, o.subjectName);
    }

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

  /** The display name of a card — a block by its own name, a lesson by subject. */
  labelOf(e: BoardEntry): string {
    if (e.electiveBlockId !== null) {
      return this.blockById.get(e.electiveBlockId)?.name ?? `elective block #${e.electiveBlockId}`;
    }
    return this.subjectNames.get(e.subjectId ?? -1) ?? `subject #${e.subjectId}`;
  }

  private varOf(e: BoardEntry, opts?: { roomId?: number | null }): SolverVariable {
    // §4.9 — a block becomes the same macro-variable the solver placed: one
    // slot claimed across every member section, with every option's teacher
    // and room occupied at once. SolverState already enforces exactly that
    // (optionTeachersOf / optionRoomsOf), so nothing here re-implements it.
    if (e.electiveBlockId !== null) {
      const meta = this.blockById.get(e.electiveBlockId);
      return {
        id: this.idByKey.get(e.key) ?? 0,
        classSectionIds: e.classSectionIds,
        classSectionLabels: e.classSectionIds.map((id) => this.sectionLabels.get(id) ?? `#${id}`),
        subjectId: null,
        subjectName: meta?.name ?? `elective block #${e.electiveBlockId}`,
        teacherId: null,
        mergedGroupId: null,
        electiveBlockId: e.electiveBlockId,
        options: e.options.map((o) => ({
          optionId: o.optionId,
          subjectId: o.subjectId,
          subjectName: this.subjectNames.get(o.subjectId) ?? `subject #${o.subjectId}`,
          teacherId: o.teacherId,
          roomId: o.roomId,
        })),
        // The options carry their own rooms, so the block never draws on the
        // lab pool and its member sections' own rooms stay free.
        labRoomIds: [],
        homeRoomId: null,
        needsLabRoom: false,
        preferredRoomId: null,
        // Counted against the block, not a subject: a section takes one
        // language period a day, not one of French and one of German.
        dayKey: `B${e.electiveBlockId}`,
        mappingId: null,
        span: 1,
        samePeriodKey: null,
        maxPerDay: Math.min(meta?.maxPeriodsPerDay ?? 1, this.input.snapshot.config.periodsPerDay),
        domain: [],
      };
    }
    const roomId = opts && "roomId" in opts ? (opts.roomId ?? null) : e.roomId;
    // Past the elective branch above, a card always has a subject and teacher:
    // only a block lacks them, and only member/option rows can produce one.
    const subjectId = e.subjectId as number;
    const teacherId = e.teacherId as number;
    // a lab-subject card in a lab room may re-home to ANY free lab on a move;
    // a preferred-room assignment (non-lab) stays hard (§3)
    const labFlexible =
      this.labSubjects.has(subjectId) && (roomId === null || this.input.labRoomIds.includes(roomId));
    const classId = this.classIdBySection.get(e.classSectionIds[0]);
    const samePeriodKey =
      e.mergedGroupId === null && classId !== undefined && this.samePeriodSubjects.has(`${classId}:${subjectId}`)
        ? `${e.classSectionIds[0]}:${subjectId}`
        : null;
    return {
      id: this.idByKey.get(e.key) ?? 0,
      classSectionIds: e.classSectionIds,
      classSectionLabels: e.classSectionIds.map((id) => this.sectionLabels.get(id) ?? `#${id}`),
      subjectId,
      subjectName: this.subjectNames.get(subjectId) ?? `subject #${subjectId}`,
      teacherId,
      mergedGroupId: e.mergedGroupId,
      // The board edits ordinary and merged cells. A §4.9 elective block is
      // placed by the solver and moved as a whole; its member rows carry no
      // subject, so they never become a BoardEntry in the first place.
      electiveBlockId: null,
      options: [],
      labRoomIds: [],
      homeRoomId: null,
      dayKey: `S${subjectId}`,
      mappingId: null,
      span: 1,
      needsLabRoom: labFlexible,
      preferredRoomId: labFlexible ? null : roomId,
      samePeriodKey,
      maxPerDay:
        classId !== undefined
          ? (this.maxPerDayByClassSubject.get(`${classId}:${subjectId}`) ??
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

  /**
   * §4.7 domain rules that the solver enforces via pruning, re-checked here.
   *
   * A §4.9 block runs every option at once, so its domain is the INTERSECTION
   * of its option teachers' domains: one of them out on Thursday takes the
   * whole block off Thursday. Checking a single teacher would offer a drop the
   * solver was forbidden to consider — the split invariant 7 exists to close.
   */
  private domainCheck(e: BoardEntry, day: number, period: number): string | null {
    if (!this.input.snapshot.config.workingDays.includes(day)) return "Not a working day";
    if (period < 1 || period > this.input.snapshot.config.periodsPerDay) return "No such period";
    const teacherIds =
      e.options.length > 0 ? e.options.map((o) => o.teacherId) : e.teacherId !== null ? [e.teacherId] : [];
    for (const teacherId of teacherIds) {
      const tc = this.state.teacherCtx.get(teacherId);
      if (!tc) continue;
      const name = this.teacherNames.get(teacherId) ?? "This teacher";
      const forBlock = e.electiveBlockId !== null ? `, and ${this.labelOf(e)} cannot meet without them` : "";
      if (!tc.allowedDays.has(day)) {
        return `${name} teaches on alternate days only — this day is not in their set${forBlock}`;
      }
      if (tc.blocked.has(cellKey(day, period))) {
        return `${name} is marked unavailable in this slot${forBlock}`;
      }
      if (tc.hasP1Rule && period === 1 && !e.classSectionIds.every((id) => tc.p1OwnSections.has(id))) {
        return `${name} is a class teacher who must take Period 1 in their own class`;
      }
    }
    return null;
  }

  /**
   * §20 — taking this card off its current day would leave the teacher there
   * with a stub of a day. Reported, never refused (see `BoardVerdict.warning`).
   */
  private minDayWarning(e: BoardEntry, toDay: number): string | undefined {
    if (e.day === toDay) return undefined;
    // Moving a block takes EVERY option teacher off that day at once, so each
    // of them can be stranded by the one drag.
    const teacherIds =
      e.options.length > 0 ? e.options.map((o) => o.teacherId) : e.teacherId !== null ? [e.teacherId] : [];
    const notes: string[] = [];
    for (const teacherId of teacherIds) {
      const min = this.state.minPerDayOf(teacherId);
      if (min <= 1) continue;
      const before = this.state.teacherDayLoad(teacherId, e.day);
      const after = before - 1;
      if (before < min || after <= 0 || after >= min) continue;
      const name = this.teacherNames.get(teacherId) ?? "This teacher";
      notes.push(`${name} is left with ${after} period${after === 1 ? "" : "s"} on ${DAY_NAMES[e.day] ?? `day ${e.day}`} — below their minimum of ${min}/day.`);
    }
    return notes.length > 0 ? notes.join(" ") : undefined;
  }

  private describeBlocker(varId: number, fallback: string): string {
    const key = this.keyById.get(varId);
    const b = key ? this.entries.get(key) : undefined;
    if (!b) return fallback;
    const sections = b.classSectionIds.map((id) => this.sectionLabels.get(id) ?? `#${id}`).join(" / ");
    if (b.electiveBlockId !== null) {
      return `${sections} ${b.classSectionIds.length === 1 ? "is" : "are"} in ${this.labelOf(b)} in this slot`;
    }
    const teacher = this.teacherNames.get(b.teacherId ?? -1) ?? `teacher #${b.teacherId}`;
    const subject = this.subjectNames.get(b.subjectId ?? -1) ?? `subject #${b.subjectId}`;
    return `${teacher} already teaches ${sections} ${subject} in this slot`;
  }

  /** Which of a block's options is already busy at (day, period), by name. */
  private blockingOption(e: BoardEntry, day: number, period: number): string | null {
    for (const o of e.options) {
      if (this.state.teacherBusy(o.teacherId, day, period) || this.state.roomBusy(o.roomId, day, period)) {
        const who = this.teacherNames.get(o.teacherId) ?? `teacher #${o.teacherId}`;
        return `${who} (${this.subjectNames.get(o.subjectId) ?? "one option"})`;
      }
    }
    return null;
  }

  private explain(e: BoardEntry, day: number, period: number, reason: string | undefined, blockers: number[]): string {
    // For a block, "the teacher" is whichever option is actually in the way —
    // naming an arbitrary one of three would send the admin to the wrong row.
    const teacher =
      e.electiveBlockId !== null
        ? this.blockingOption(e, day, period) ?? `An option teacher of ${this.labelOf(e)}`
        : (this.teacherNames.get(e.teacherId ?? -1) ?? "This teacher");
    const subject = e.electiveBlockId !== null ? this.labelOf(e) : (this.subjectNames.get(e.subjectId ?? -1) ?? "this subject");
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
    if (res.ok) return { ok: true, roomId: res.roomId, warning: this.minDayWarning(e, day) };
    return { ok: false, roomId: null, reason: this.explain(e, day, period, res.reason, res.blockers) };
  }

  /** Swap two cards (§7.3) — legal only if BOTH sides stay legal. Pure check. */
  checkSwap(
    keyA: string,
    keyB: string,
  ): { ok: boolean; reason?: string; warning?: string; roomA: number | null; roomB: number | null } {
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
    if (reason) return { ok: false, reason, roomA: null, roomB: null };
    // Both cards change day, so either side can strand a short day (§20).
    const warning = [this.minDayWarning(a, b.day), this.minDayWarning(b, a.day)].filter(Boolean).join(" ");
    return { ok: true, roomA, roomB, warning: warning || undefined };
  }

  /**
   * §7.3 extended — move a multi-section card onto an occupied cell.
   *
   * A merged group or a §4.9 elective block holds one cell across N sections.
   * A plain move needs the target free in ALL of them, which in a full school
   * essentially never happens — so before this, dragging one anywhere useful
   * was refused and the feature read as broken. Here the displaced lessons
   * come back the other way: the card takes the target, and every distinct
   * entry sitting at the target across those sections moves to the source.
   *
   * Checked as one transaction. Everything is lifted first (so nothing blocks
   * itself or a sibling), each side is then checked in its new home, and the
   * board is restored exactly as found — this is a pure query.
   *
   * Note what is NOT assumed: a displaced entry may span sections the dragged
   * card does not (a merged group over 5-A and 6-A), so 6-A's source cell has
   * to be free too. Lifting everything and asking SolverState is what makes
   * that fall out rather than needing its own rule.
   */
  checkSwapGroup(
    key: string,
    day: number,
    period: number,
  ): {
    ok: boolean;
    reason?: string;
    warning?: string;
    roomAtTarget: number | null;
    /** the displaced entries and the room each takes at the source cell */
    displaced: Array<{ key: string; roomId: number | null }>;
  } {
    const fail = (reason: string) => ({ ok: false, reason, roomAtTarget: null, displaced: [] });
    const e = this.entries.get(key);
    if (!e) return fail("Card no longer exists — the board changed under you");
    if (e.locked) return fail("This card is locked — unpin it first");
    const dom = this.domainCheck(e, day, period);
    if (dom) return fail(dom);

    // Every distinct entry standing where this card wants to go.
    const occupants = new Map<string, BoardEntry>();
    for (const csId of e.classSectionIds) {
      const at = this.entryAt(csId, day, period);
      if (at && at.key !== e.key) occupants.set(at.key, at);
    }
    if (occupants.size === 0) {
      const move = this.checkMove(key, day, period);
      return move.ok
        ? { ok: true, roomAtTarget: move.roomId, displaced: [], warning: move.warning }
        : fail(move.reason ?? "Illegal");
    }
    for (const o of occupants.values()) {
      // Another occurrence of the SAME block or merged group. Swapping them is
      // a no-op — both cells still hold the identical card afterwards — so
      // offering it as a legal green destination is just a lie the user acts
      // on. On a full school this was every "legal" destination a block had.
      if (
        (e.electiveBlockId !== null && o.electiveBlockId === e.electiveBlockId) ||
        (e.mergedGroupId !== null && o.mergedGroupId === e.mergedGroupId)
      ) {
        return fail(`${this.labelOf(e)} already runs in this slot — moving it here would change nothing`);
      }
      if (o.locked) return fail(`${this.labelOf(o)} in that slot is locked — unpin it first`);
      const odom = this.domainCheck(o, e.day, e.period);
      if (odom) return fail(`${this.labelOf(o)} cannot move here: ${odom}`);
    }

    // ---- lift everything, then check each in its new home ----
    const lifted: Array<{ e: BoardEntry; v: SolverVariable }> = [];
    const lift = (x: BoardEntry) => {
      const v = { ...this.varOf(x), id: this.idByKey.get(x.key) ?? 0 };
      this.state.unplace(v, x.day, x.period, x.roomId);
      lifted.push({ e: x, v });
    };
    lift(e);
    for (const o of occupants.values()) lift(o);

    const placedBack: Array<{ v: SolverVariable; day: number; period: number; roomId: number | null }> = [];
    let reason: string | undefined;
    let roomAtTarget: number | null = null;
    const displaced: Array<{ key: string; roomId: number | null }> = [];

    const dragged = lifted[0];
    const res = this.state.check(dragged.v, day, period);
    if (!res.ok) {
      reason = this.explain(e, day, period, res.reason, res.blockers);
    } else {
      roomAtTarget = res.roomId;
      this.state.place(dragged.v, day, period, roomAtTarget);
      placedBack.push({ v: dragged.v, day, period, roomId: roomAtTarget });
      for (const o of lifted.slice(1)) {
        const r = this.state.check(o.v, e.day, e.period);
        if (!r.ok) {
          reason = `${this.labelOf(o.e)} cannot take the slot this card is leaving: ${this.explain(o.e, e.day, e.period, r.reason, r.blockers)}`;
          break;
        }
        this.state.place(o.v, e.day, e.period, r.roomId);
        placedBack.push({ v: o.v, day: e.day, period: e.period, roomId: r.roomId });
        displaced.push({ key: o.e.key, roomId: r.roomId });
      }
    }

    // ---- restore, whatever happened ----
    for (const p of placedBack) this.state.unplace(p.v, p.day, p.period, p.roomId);
    for (const l of lifted) this.state.place(l.v, l.e.day, l.e.period, l.e.roomId);

    if (reason) return fail(reason);
    const warning = [
      this.minDayWarning(e, day),
      ...[...occupants.values()].map((o) => this.minDayWarning(o, e.day)),
    ]
      .filter(Boolean)
      .join(" ");
    return { ok: true, roomAtTarget, displaced, warning: warning || undefined };
  }

  /** Placing a brand-new card (from the unplaced tray) at (day, period). */
  checkPlace(
    entry: Omit<BoardEntry, "key" | "day" | "period" | "locked">,
    day: number,
    period: number,
  ): BoardVerdict {
    // Normalised at the boundary: this is the one entry the engine does not
    // build itself, so a caller compiled against an older shape (or a payload
    // that crossed the wire) must not reach domainCheck half-formed.
    const probe: BoardEntry = {
      ...entry,
      electiveBlockId: entry.electiveBlockId ?? null,
      options: entry.options ?? [],
      key: "__probe__",
      day,
      period,
      locked: false,
    };
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
        if (!occupant) {
          const move = this.checkMove(e.key, day, p);
          out.set(cell, move.ok ? { kind: "move", roomId: move.roomId, warning: move.warning } : { kind: "illegal", reason: move.reason ?? "Illegal" });
          continue;
        }
        // Either side spanning several sections needs the group swap: a merged
        // group or a §4.9 block can displace a DIFFERENT lesson in each of its
        // member sections, which a two-card swap cannot express. Until this
        // existed, both simply refused every occupied cell.
        if (isMultiSection(e) || isMultiSection(occupant)) {
          const swap = this.checkSwapGroup(e.key, day, p);
          out.set(
            cell,
            swap.ok
              ? {
                  kind: "swap",
                  withKey: occupant.key,
                  roomAtTarget: swap.roomAtTarget,
                  otherRoomAtSource: swap.displaced[0]?.roomId ?? null,
                  displaced: swap.displaced,
                  warning: swap.warning,
                }
              : { kind: "illegal", reason: swap.reason ?? "Swap breaks a rule" },
          );
          continue;
        }
        const swap = this.checkSwap(e.key, occupant.key);
        out.set(
          cell,
          swap.ok
            ? { kind: "swap", withKey: occupant.key, roomAtTarget: swap.roomA, otherRoomAtSource: swap.roomB, warning: swap.warning }
            : { kind: "illegal", reason: swap.reason ?? "Swap breaks a rule" },
        );
      }
    }
    return out;
  }

  /**
   * §22.3 — hard-constraint violations on the grid AS STORED.
   *
   * Zero by construction the moment a solve finishes, so this is not about
   * distrusting the solver: it is about what happens afterwards. A curriculum
   * edit lowers a subject's max/day, a teacher's pattern changes to
   * alternate-day, an import rewrites a mapping — and a draft generated last
   * week is quietly illegal. The Draft Board has to be able to say so before
   * somebody publishes it.
   *
   * Each entry is lifted and re-checked in its own cell, so it never blocks
   * itself. This is the one rules engine's third call site — the same
   * `SolverState.check()` the solver searched with and the board drags with.
   */
  violations(): Array<{ key: string; reason: string }> {
    const out: Array<{ key: string; reason: string }> = [];
    for (const e of this.all) {
      const v = { ...this.varOf(e), id: this.idByKey.get(e.key) ?? 0 };
      this.state.unplace(v, e.day, e.period, e.roomId);
      const dom = this.domainCheck(e, e.day, e.period);
      const res = dom ? null : this.state.check(v, e.day, e.period);
      this.state.place(v, e.day, e.period, e.roomId);
      if (dom) out.push({ key: e.key, reason: dom });
      else if (res && !res.ok) out.push({ key: e.key, reason: this.explain(e, e.day, e.period, res.reason, res.blockers) });
    }
    return out;
  }

  /** Mutate the in-memory board after a confirmed move (client optimistic / server apply). */
  applyMove(key: string, day: number, period: number, roomId: number | null) {
    const e = this.entries.get(key);
    if (!e) return;
    this.removeEntry(e);
    this.addEntry({
      ...e,
      key: entryKeyOf({
        classSectionId: e.classSectionIds[0] ?? null,
        mergedGroupId: e.mergedGroupId,
        electiveBlockId: e.electiveBlockId,
        dayOfWeek: day,
        periodNumber: period,
      }),
      day,
      period,
      roomId,
    });
  }

  /**
   * Optimistic client-side apply of a group swap. Every entry is lifted before
   * any is re-placed: replaying the moves one at a time would transit through
   * a state with two cards in one cell, which SolverState rightly refuses.
   */
  applySwapGroup(
    key: string,
    day: number,
    period: number,
    roomAtTarget: number | null,
    displaced: Array<{ key: string; roomId: number | null }>,
  ) {
    const e = this.entries.get(key);
    if (!e) return;
    const src = { day: e.day, period: e.period };
    const moving = [
      { entry: e, to: { day, period }, roomId: roomAtTarget },
      ...displaced
        .map((d) => ({ entry: this.entries.get(d.key), to: src, roomId: d.roomId }))
        .filter((m): m is { entry: BoardEntry; to: { day: number; period: number }; roomId: number | null } => !!m.entry),
    ];
    for (const m of moving) this.removeEntry(m.entry);
    for (const m of moving) {
      this.addEntry({
        ...m.entry,
        key: entryKeyOf({
          classSectionId: m.entry.classSectionIds[0] ?? null,
          mergedGroupId: m.entry.mergedGroupId,
          electiveBlockId: m.entry.electiveBlockId,
          dayOfWeek: m.to.day,
          periodNumber: m.to.period,
        }),
        day: m.to.day,
        period: m.to.period,
        roomId: m.roomId,
      });
    }
  }
}
