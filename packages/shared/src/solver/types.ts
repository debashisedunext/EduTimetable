/**
 * Phase B — CSP solver contracts (§5). Pure module: the API worker feeds it a
 * SolverInput (built from the same snapshot the Feasibility Engine uses) and
 * gets back placements. It only ever runs after runFeasibility() says ready —
 * that is the "cannot fail" contract; the repair path exists for edge cases.
 */
import type { FeasibilitySnapshot } from "../feasibility/types";

export interface SolverInput {
  snapshot: FeasibilitySnapshot;
  /** full per-slot unavailability (feasibility only needs counts) */
  teacherUnavailability: Array<{ teacherId: number; dayOfWeek: number; periodNumber: number | null }>;
  labRoomIds: number[];
  /** preferred rooms per mapping id (hard when set, §3) */
  preferredRoomByMapping: Record<number, number>;
  mergedGroupRooms: Record<number, number | null>;
  /** manually pinned cells the solver must treat as fixed (§7.4) */
  lockedSlots: Array<{
    classSectionId: number;
    dayOfWeek: number;
    periodNumber: number;
    subjectId: number;
    teacherId: number;
    roomId: number | null;
  }>;
  seed?: number;
}

/** One decision unit (§5.1): a single occurrence, a consecutive block, or a
 *  merged-group occurrence spanning several sections at once. */
export interface SolverVariable {
  id: number;
  classSectionIds: number[];
  classSectionLabels: string[];
  subjectId: number;
  subjectName: string;
  teacherId: number;
  mergedGroupId: number | null;
  mappingId: number | null;
  /** contiguous periods claimed on one day (1 = normal period) */
  span: number;
  needsLabRoom: boolean;
  preferredRoomId: number | null;
  /** all occurrences sharing this key must land on the same period number (§4.6) */
  samePeriodKey: string | null;
  /** subject's max periods/day for the section(s) */
  maxPerDay: number;
  /** legal (day, startPeriod) pairs after §4.7 domain pruning */
  domain: Array<{ day: number; period: number }>;
}

export interface Placement {
  variableId: number;
  classSectionIds: number[];
  subjectId: number;
  teacherId: number;
  mergedGroupId: number | null;
  day: number;
  /** first period of the span */
  period: number;
  span: number;
  roomId: number | null;
}

export interface UnplacedVariable {
  variableId: number;
  label: string;
  reason: string;
}

export interface SolverResult {
  placements: Placement[];
  unplaced: UnplacedVariable[];
  totalVariables: number;
  stats: { steps: number; backtracks: number; restarts: number; ms: number };
}

export interface SolveOptions {
  budgetMs?: number;
  onProgress?: (placed: number, total: number) => void;
}
