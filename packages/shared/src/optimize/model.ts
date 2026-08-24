/**
 * Task 6.1 — translation between our CSP model and the CP-SAT microservice.
 *
 * Deliberate split of responsibilities (this is the parity-safety decision):
 *   - TypeScript keeps ownership of §4.7 domain pruning and room assignment,
 *     so CP-SAT inherits rules that are already property-tested.
 *   - CP-SAT owns search + the §5.6 soft objectives only.
 *   - Whatever CP-SAT returns is re-verified cell by cell through the SAME
 *     SolverState.check() the fast engine uses (verifyAssignment below), so an
 *     optimizer bug can never reach the database.
 */
import type { Placement, SolverInput, SolverVariable } from "../solver/types";
import { SolverState } from "../solver/state";
import { cellKey } from "../solver/variables";
import type { ObjectiveWeights } from "./objective";

export interface CpSatVariable {
  id: number;
  span: number;
  classSectionIds: number[];
  teacherId: number;
  /** `${classSectionId}:${subjectId}` keys this variable counts against per day */
  subjectDayKeys: string[];
  maxPerDay: number;
  samePeriodKey: string | null;
  needsLabRoom: boolean;
  /** hard (non-lab) room this variable must occupy, if any */
  preferredRoomId: number | null;
  /** legal (day, period) starts after §4.7 pruning AND locked-cell removal */
  domain: Array<[number, number]>;
}

export interface CpSatModel {
  periodsPerDay: number;
  workingDays: number[];
  variables: CpSatVariable[];
  /** teacher -> day -> periods still available under their daily cap */
  teacherDayCap: Record<string, number>;
  /** `${classSectionId}:${subjectId}` -> day -> remaining allowance */
  subjectDayCap: Record<string, number>;
  /** teachers who may never take two adjacent periods (§4.7) */
  alternatePeriodTeachers: number[];
  /** `${day}:${period}` -> how many lab-needing variables may sit there */
  labCapacity: Record<string, number>;
  weights: ObjectiveWeights;
  timeLimitSec: number;
}

export interface CpSatAssignment {
  variableId: number;
  day: number;
  period: number;
}

export interface CpSatResponse {
  status: string;
  assignments: CpSatAssignment[];
  objective?: number;
  wallTimeSec?: number;
}

/**
 * Build the CP-SAT payload. Locked slots are folded in as removed domain
 * candidates and reduced caps, so the optimizer never has to know about them.
 */
export function buildCpSatModel(
  input: SolverInput,
  variables: SolverVariable[],
  weights: ObjectiveWeights,
  timeLimitSec: number,
): CpSatModel {
  const perDay = input.snapshot.config.periodsPerDay;
  const days = input.snapshot.config.workingDays;
  const labRoomCount = input.labRoomIds.length;

  // ---- occupancy already consumed by locked cells (§7.4) ----
  const lockedSection = new Set<string>();
  const lockedTeacher = new Set<string>();
  const lockedRoom = new Set<string>();
  const lockedLabAt = new Map<string, number>();
  const lockedTeacherDay = new Map<string, number>();
  const lockedSubjectDay = new Map<string, number>();
  const labSubjects = new Set(input.snapshot.labSubjectIds);
  for (const l of input.lockedSlots) {
    const ck = cellKey(l.dayOfWeek, l.periodNumber);
    lockedSection.add(`${l.classSectionId}@${ck}`);
    lockedTeacher.add(`${l.teacherId}@${ck}`);
    if (l.roomId !== null) lockedRoom.add(`${l.roomId}@${ck}`);
    if (l.roomId !== null && input.labRoomIds.includes(l.roomId)) {
      lockedLabAt.set(ck, (lockedLabAt.get(ck) ?? 0) + 1);
    } else if (labSubjects.has(l.subjectId)) {
      lockedLabAt.set(ck, (lockedLabAt.get(ck) ?? 0) + 1);
    }
    const tdk = `${l.teacherId}@${l.dayOfWeek}`;
    lockedTeacherDay.set(tdk, (lockedTeacherDay.get(tdk) ?? 0) + 1);
    const sdk = `${l.classSectionId}:${l.subjectId}@${l.dayOfWeek}`;
    lockedSubjectDay.set(sdk, (lockedSubjectDay.get(sdk) ?? 0) + 1);
  }

  const cpVars: CpSatVariable[] = variables.map((v) => {
    const domain: Array<[number, number]> = [];
    for (const { day, period } of v.domain) {
      let ok = true;
      for (let s = 0; s < v.span && ok; s++) {
        const ck = cellKey(day, period + s);
        if (lockedTeacher.has(`${v.teacherId}@${ck}`)) ok = false;
        if (ok && v.preferredRoomId !== null && lockedRoom.has(`${v.preferredRoomId}@${ck}`)) ok = false;
        if (ok) {
          for (const cs of v.classSectionIds) {
            if (lockedSection.has(`${cs}@${ck}`)) { ok = false; break; }
          }
        }
      }
      if (ok) domain.push([day, period]);
    }
    return {
      id: v.id,
      span: v.span,
      classSectionIds: v.classSectionIds,
      teacherId: v.teacherId,
      subjectDayKeys: v.classSectionIds.map((cs) => `${cs}:${v.subjectId}`),
      maxPerDay: v.maxPerDay,
      samePeriodKey: v.samePeriodKey,
      needsLabRoom: v.needsLabRoom,
      preferredRoomId: v.preferredRoomId,
      domain,
    };
  });

  const teacherDayCap: Record<string, number> = {};
  for (const t of input.snapshot.teachers) {
    for (const day of days) {
      const used = lockedTeacherDay.get(`${t.id}@${day}`) ?? 0;
      teacherDayCap[`${t.id}@${day}`] = Math.max(0, t.maxPeriodsPerDay - used);
    }
  }

  const subjectDayCap: Record<string, number> = {};
  for (const v of variables) {
    for (const cs of v.classSectionIds) {
      for (const day of days) {
        const key = `${cs}:${v.subjectId}@${day}`;
        if (key in subjectDayCap) continue;
        const used = lockedSubjectDay.get(key) ?? 0;
        subjectDayCap[key] = Math.max(0, v.maxPerDay - used);
      }
    }
  }

  const labCapacity: Record<string, number> = {};
  for (const day of days) {
    for (let p = 1; p <= perDay; p++) {
      const ck = cellKey(day, p);
      labCapacity[ck] = Math.max(0, labRoomCount - (lockedLabAt.get(ck) ?? 0));
    }
  }

  return {
    periodsPerDay: perDay,
    workingDays: days,
    variables: cpVars,
    teacherDayCap,
    subjectDayCap,
    alternatePeriodTeachers: input.snapshot.teachers
      .filter((t) => t.periodPattern === "alternate_period")
      .map((t) => t.id),
    labCapacity,
    weights,
    timeLimitSec,
  };
}

export interface VerifyResult {
  ok: boolean;
  placements: Placement[];
  /** first rule the optimizer's answer broke, if any — reported, then fallback */
  reason?: string;
}

/**
 * Task 6.3 parity gate: replay the optimizer's assignment through the real
 * ConstraintChecker. Rooms are chosen here, exactly as the fast engine does,
 * so an "optimized" timetable is byte-for-byte as safe as a fast one.
 */
export function verifyAssignment(
  input: SolverInput,
  variables: SolverVariable[],
  assignments: CpSatAssignment[],
): VerifyResult {
  const state = new SolverState(input);
  const byId = new Map(variables.map((v) => [v.id, v]));
  const placements: Placement[] = [];
  const seen = new Set<number>();

  for (const a of assignments) {
    const v = byId.get(a.variableId);
    if (!v) return { ok: false, placements: [], reason: `unknown variable ${a.variableId}` };
    if (seen.has(a.variableId)) {
      return { ok: false, placements: [], reason: `variable ${a.variableId} assigned twice` };
    }
    if (!v.domain.some((d) => d.day === a.day && d.period === a.period)) {
      return { ok: false, placements: [], reason: `variable ${a.variableId} placed outside its legal domain` };
    }
    const res = state.check(v, a.day, a.period);
    if (!res.ok) {
      return {
        ok: false,
        placements: [],
        reason: `${v.subjectName} for ${v.classSectionLabels.join("+")} at day ${a.day} P${a.period}: ${res.reason}`,
      };
    }
    state.place(v, a.day, a.period, res.roomId);
    seen.add(a.variableId);
    placements.push({
      variableId: v.id,
      classSectionIds: v.classSectionIds,
      subjectId: v.subjectId,
      teacherId: v.teacherId,
      mergedGroupId: v.mergedGroupId,
      day: a.day,
      period: a.period,
      span: v.span,
      roomId: res.roomId,
    });
  }
  return { ok: true, placements };
}
