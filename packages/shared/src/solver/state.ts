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

/**
 * The teachers a variable occupies at once. One for an ordinary or merged
 * placement; one per option for a §4.9 elective, because all of its parallel
 * lessons run in the same slot.
 */
export const teachersOf = (v: SolverVariable): number[] =>
  v.options.length > 0 ? v.options.map((o) => o.teacherId) : v.teacherId !== null ? [v.teacherId] : [];

/** The rooms an elective's options each claim; empty for everything else. */
export const optionRoomsOf = (v: SolverVariable): number[] => v.options.map((o) => o.roomId);

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
      this.bump(this.subjDay, `${l.classSectionId}:S${l.subjectId}@${l.dayOfWeek}`, 1);
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
    const teacherIds = teachersOf(v);

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
      // constraint 2 — teacher occupancy (merged = one event; an elective
      // occupies every option's teacher, since they all teach at once, §4.9)
      for (const t of teacherIds) {
        const tHolder = this.teacher.get(`${t}@${ck}`);
        if (tHolder !== undefined) {
          if (tHolder > 0) blockers.push(tHolder);
          return { ok: false, roomId: null, reason: "teacher occupied", blockers };
        }
      }
    }

    // constraint 6 — alternate_period: never adjacent placements, and a block
    // of span>1 is internally adjacent → always illegal for such teachers (§4.7)
    for (const t of teacherIds) {
      const info = this.teacherCtx.get(t)?.info;
      if (info?.periodPattern === "alternate_period") {
        if (v.span > 1) return { ok: false, roomId: null, reason: "alternate-period teacher cannot take blocks", blockers };
        for (const adj of [period - 1, period + v.span]) {
          const holder = this.teacher.get(`${t}@${cellKey(day, adj)}`);
          if (holder !== undefined) {
            if (holder > 0) blockers.push(holder);
            return { ok: false, roomId: null, reason: "adjacent period (alternate-period rule)", blockers };
          }
        }
      }

      // constraint 5 — teacher daily maximum (pattern-adjusted capacity is in
      // feasibility; here the raw per-day cap applies)
      if (info) {
        const used = this.teacherDay.get(`${t}@${day}`) ?? 0;
        if (used + v.span > info.maxPeriodsPerDay) {
          return { ok: false, roomId: null, reason: "teacher daily max", blockers };
        }
      }
    }

    // constraint 4 — subject max/day per class-section, or block max/day for a
    // split elective (one language period a day, not one of each option)
    for (const cs of v.classSectionIds) {
      const used = this.subjDay.get(`${cs}:${v.dayKey}@${day}`) ?? 0;
      if (used + v.span > v.maxPerDay) {
        return { ok: false, roomId: null, reason: "subject daily max", blockers };
      }
    }

    // constraint 3 — room free. An elective needs EVERY option's room free at
    // once; the options carry fixed rooms, so there is nothing to choose.
    for (const r of optionRoomsOf(v)) {
      const holder = this.room.get(`${r}@${cellKey(day, period)}`);
      if (holder !== undefined) {
        if (holder > 0) blockers.push(holder);
        return { ok: false, roomId: null, reason: "elective option room occupied", blockers };
      }
    }

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
      // §19: only the labs that serve THIS subject. A free physics lab is not
      // a place to teach biology, however empty it is. `labRoomIds` on the
      // variable narrows to the subject's own labs; falling back to every lab
      // when the school has not mapped any keeps older data working.
      const pool = v.labRoomIds.length > 0 ? v.labRoomIds : this.labRoomIds;
      roomId = this.findFreeRoom(pool, day, period, v.span, blockers);
      if (roomId === null) {
        return { ok: false, roomId: null, reason: "no lab room free", blockers };
      }
    } else if (v.homeRoomId !== null) {
      // §19: the class-section's own room. Claimed rather than left null, so
      // the timetable actually says where the lesson is — and so a room that
      // is home to two sections collides here instead of silently double-
      // booking a physical room the school believes is theirs.
      for (let s = 0; s < v.span; s++) {
        const holder = this.room.get(`${v.homeRoomId}@${cellKey(day, period + s)}`);
        if (holder !== undefined) {
          if (holder > 0) blockers.push(holder);
          return { ok: false, roomId: null, reason: "home room occupied", blockers };
        }
      }
      roomId = v.homeRoomId;
    }

    return { ok: true, roomId, blockers: [] };
  }

  private findFreeRoom(pool: number[], day: number, period: number, span: number, blockers: number[]): number | null {
    for (const r of pool) {
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
    const teacherIds = teachersOf(v);
    for (let s = 0; s < v.span; s++) {
      const ck = cellKey(day, period + s);
      for (const cs of v.classSectionIds) this.section.set(`${cs}@${ck}`, v.id);
      for (const t of teacherIds) this.teacher.set(`${t}@${ck}`, v.id);
      for (const r of optionRoomsOf(v)) this.room.set(`${r}@${ck}`, v.id);
      if (roomId !== null) this.room.set(`${roomId}@${ck}`, v.id);
    }
    for (const cs of v.classSectionIds) this.bump(this.subjDay, `${cs}:${v.dayKey}@${day}`, v.span);
    for (const t of teacherIds) this.bump(this.teacherDay, `${t}@${day}`, v.span);
    if (v.samePeriodKey) {
      const cur = this.samePeriod.get(v.samePeriodKey);
      if (cur) cur.count++;
      else this.samePeriod.set(v.samePeriodKey, { period, count: 1 });
    }
  }

  unplace(v: SolverVariable, day: number, period: number, roomId: number | null) {
    const teacherIds = teachersOf(v);
    for (let s = 0; s < v.span; s++) {
      const ck = cellKey(day, period + s);
      for (const cs of v.classSectionIds) this.section.delete(`${cs}@${ck}`);
      for (const t of teacherIds) this.teacher.delete(`${t}@${ck}`);
      for (const r of optionRoomsOf(v)) this.room.delete(`${r}@${ck}`);
      if (roomId !== null) this.room.delete(`${roomId}@${ck}`);
    }
    for (const cs of v.classSectionIds) this.bump(this.subjDay, `${cs}:${v.dayKey}@${day}`, -v.span);
    for (const t of teacherIds) this.bump(this.teacherDay, `${t}@${day}`, -v.span);
    if (v.samePeriodKey) {
      const cur = this.samePeriod.get(v.samePeriodKey);
      if (cur && --cur.count <= 0) this.samePeriod.delete(v.samePeriodKey);
    }
  }

  /** `dayKey` is `S<subjectId>` normally, `B<blockId>` for a §4.9 elective. */
  sectionDayLoad(csId: number, dayKey: string, day: number): number {
    return this.subjDay.get(`${csId}:${dayKey}@${day}`) ?? 0;
  }
  teacherDayLoad(teacherId: number, day: number): number {
    return this.teacherDay.get(`${teacherId}@${day}`) ?? 0;
  }
}
