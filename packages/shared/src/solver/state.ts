/**
 * Occupancy state + ConstraintChecker (§5.1's ten hard constraints). One rules
 * engine, many call sites: the solver search uses it during placement, and
 * Phase 3's drag-drop legality/"suggest legal moves" reuse the same checks.
 */
import type { SolverInput, SolverVariable } from "./types";
import { buildTeacherCtx, cellKey, type TeacherCtx } from "./variables";

export interface PlacedRecord {
  variableId: number;
  day: number;
  period: number;
  roomId: number | null;
}

export interface CheckResult {
  ok: boolean;
  roomId: number | null;
  reason?: string;
  /** variable ids whose placements blocked this value (conflict-directed backjumping) */
  blockers: number[];
}

export class SolverState {
  readonly teacherCtx: Map<number, TeacherCtx>;
  private section = new Map<string, number>(); // `${cs}@${d}:${p}` -> varId
  private teacher = new Map<string, number>(); // `${t}@${d}:${p}` -> varId
  private room = new Map<string, number>(); // `${r}@${d}:${p}` -> varId
  private subjDay = new Map<string, number>(); // `${cs}:${subj}@${d}` -> count
  private teacherDay = new Map<string, number>(); // `${t}@${d}` -> count
  private samePeriod = new Map<string, { period: number; count: number }>();
  readonly labRoomIds: number[];

  constructor(private readonly input: SolverInput) {
    this.teacherCtx = buildTeacherCtx(input);
    this.labRoomIds = input.labRoomIds;
    // §7.4: locked cells occupy state before search begins (varId 0 = locked)
    for (const l of input.lockedSlots) {
      this.section.set(`${l.classSectionId}@${cellKey(l.dayOfWeek, l.periodNumber)}`, 0);
      this.teacher.set(`${l.teacherId}@${cellKey(l.dayOfWeek, l.periodNumber)}`, 0);
      if (l.roomId !== null) this.room.set(`${l.roomId}@${cellKey(l.dayOfWeek, l.periodNumber)}`, 0);
      this.bump(this.subjDay, `${l.classSectionId}:${l.subjectId}@${l.dayOfWeek}`, 1);
      this.bump(this.teacherDay, `${l.teacherId}@${l.dayOfWeek}`, 1);
    }
  }

  private bump(map: Map<string, number>, key: string, delta: number) {
    const next = (map.get(key) ?? 0) + delta;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  }

  /** All ten §5.1 hard checks for placing `v` at (day, period..period+span-1). */
  check(v: SolverVariable, day: number, period: number): CheckResult {
    const blockers: number[] = [];
    const tc = this.teacherCtx.get(v.teacherId);
    const teacherInfo = tc?.info;

    // constraint 8 — same subject, same period across the week (§4.6)
    if (v.samePeriodKey) {
      const fixed = this.samePeriod.get(v.samePeriodKey);
      if (fixed && fixed.period !== period) {
        return { ok: false, roomId: null, reason: "same-period rule", blockers };
      }
    }

    for (let s = 0; s < v.span; s++) {
      const ck = cellKey(day, period + s);
      // constraint 1 — class-section slot free (every member for merged groups, §4.9)
      for (const cs of v.classSectionIds) {
        const holder = this.section.get(`${cs}@${ck}`);
        if (holder !== undefined) {
          if (holder > 0) blockers.push(holder);
          return { ok: false, roomId: null, reason: "section occupied", blockers };
        }
      }
      // constraint 2 — teacher occupancy (merged = one event)
      const tHolder = this.teacher.get(`${v.teacherId}@${ck}`);
      if (tHolder !== undefined) {
        if (tHolder > 0) blockers.push(tHolder);
        return { ok: false, roomId: null, reason: "teacher occupied", blockers };
      }
    }

    // constraint 6 — alternate_period: never adjacent placements, and a block
    // of span>1 is internally adjacent → always illegal for such teachers (§4.7)
    if (teacherInfo?.periodPattern === "alternate_period") {
      if (v.span > 1) return { ok: false, roomId: null, reason: "alternate-period teacher cannot take blocks", blockers };
      for (const adj of [period - 1, period + v.span]) {
        const holder = this.teacher.get(`${v.teacherId}@${cellKey(day, adj)}`);
        if (holder !== undefined) {
          if (holder > 0) blockers.push(holder);
          return { ok: false, roomId: null, reason: "adjacent period (alternate-period rule)", blockers };
        }
      }
    }

    // constraint 5 — teacher daily maximum (pattern-adjusted capacity is in feasibility;
    // here the raw per-day cap applies)
    if (teacherInfo) {
      const used = this.teacherDay.get(`${v.teacherId}@${day}`) ?? 0;
      if (used + v.span > teacherInfo.maxPeriodsPerDay) {
        return { ok: false, roomId: null, reason: "teacher daily max", blockers };
      }
    }

    // constraint 4 — subject max/day per class-section
    for (const cs of v.classSectionIds) {
      const used = this.subjDay.get(`${cs}:${v.subjectId}@${day}`) ?? 0;
      if (used + v.span > v.maxPerDay) {
        return { ok: false, roomId: null, reason: "subject daily max", blockers };
      }
    }

    // constraint 3 — room free (preferred room hard; lab subjects need a free lab)
    let roomId: number | null = null;
    if (v.preferredRoomId !== null) {
      for (let s = 0; s < v.span; s++) {
        const holder = this.room.get(`${v.preferredRoomId}@${cellKey(day, period + s)}`);
        if (holder !== undefined) {
          if (holder > 0) blockers.push(holder);
          return { ok: false, roomId: null, reason: "preferred room occupied", blockers };
        }
      }
      roomId = v.preferredRoomId;
    } else if (v.needsLabRoom) {
      roomId = this.findFreeLab(day, period, v.span, blockers);
      if (roomId === null) {
        return { ok: false, roomId: null, reason: "no lab room free", blockers };
      }
    }

    return { ok: true, roomId, blockers: [] };
  }

  private findFreeLab(day: number, period: number, span: number, blockers: number[]): number | null {
    for (const r of this.labRoomIds) {
      let free = true;
      for (let s = 0; s < span; s++) {
        const holder = this.room.get(`${r}@${cellKey(day, period + s)}`);
        if (holder !== undefined) {
          if (holder > 0) blockers.push(holder);
          free = false;
          break;
        }
      }
      if (free) return r;
    }
    return null;
  }

  place(v: SolverVariable, day: number, period: number, roomId: number | null) {
    for (let s = 0; s < v.span; s++) {
      const ck = cellKey(day, period + s);
      for (const cs of v.classSectionIds) this.section.set(`${cs}@${ck}`, v.id);
      this.teacher.set(`${v.teacherId}@${ck}`, v.id);
      if (roomId !== null) this.room.set(`${roomId}@${ck}`, v.id);
    }
    for (const cs of v.classSectionIds) this.bump(this.subjDay, `${cs}:${v.subjectId}@${day}`, v.span);
    this.bump(this.teacherDay, `${v.teacherId}@${day}`, v.span);
    if (v.samePeriodKey) {
      const cur = this.samePeriod.get(v.samePeriodKey);
      if (cur) cur.count++;
      else this.samePeriod.set(v.samePeriodKey, { period, count: 1 });
    }
  }

  unplace(v: SolverVariable, day: number, period: number, roomId: number | null) {
    for (let s = 0; s < v.span; s++) {
      const ck = cellKey(day, period + s);
      for (const cs of v.classSectionIds) this.section.delete(`${cs}@${ck}`);
      this.teacher.delete(`${v.teacherId}@${ck}`);
      if (roomId !== null) this.room.delete(`${roomId}@${ck}`);
    }
    for (const cs of v.classSectionIds) this.bump(this.subjDay, `${cs}:${v.subjectId}@${day}`, -v.span);
    this.bump(this.teacherDay, `${v.teacherId}@${day}`, -v.span);
    if (v.samePeriodKey) {
      const cur = this.samePeriod.get(v.samePeriodKey);
      if (cur && --cur.count <= 0) this.samePeriod.delete(v.samePeriodKey);
    }
  }

  sectionDayLoad(csId: number, subjectId: number, day: number): number {
    return this.subjDay.get(`${csId}:${subjectId}@${day}`) ?? 0;
  }
  teacherDayLoad(teacherId: number, day: number): number {
    return this.teacherDay.get(`${teacherId}@${day}`) ?? 0;
  }
}
