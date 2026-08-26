/**
 * Feasibility Engine contracts (§4). The engine is a pure function over a
 * snapshot — no I/O — so the API, tests, and (later) the solver share one
 * implementation. The API's ReadinessService builds the snapshot from the DB.
 */

export type IssueSeverity = "blocker" | "warning";

export type IssueCode =
  // Check 1 — slot capacity (§4.1)
  | "SLOT_OVERFLOW"
  | "SLOT_UNDERFLOW"
  // Check 2 — teacher weekly load (§4.2, pattern-aware §4.7, cross-config §3.10)
  | "TEACHER_OVERLOAD"
  | "ALT_DAY_UNSET"
  // Check 3 — daily distribution (§4.3, block-aware §4.8)
  | "DAILY_DISTRIBUTION"
  | "BLOCK_EXCEEDS_DAILY_MAX"
  | "BLOCK_FRAGMENTED"
  | "BLOCK_MATH_INVALID"
  | "BLOCK_TEACHER_PATTERN"
  // Check 4 — cross-section daily overlap / tightness (§4.4)
  | "DAILY_PIGEONHOLE"
  | "TEACHER_TIGHT"
  // Check 5 — shared/special room contention (§4.5)
  | "LAB_NONE"
  | "LAB_OVERFLOW"
  | "LAB_TIGHT"
  // Check 6 — structural conflicts (§4.6, §8.1b)
  | "CT_P1_DEADLOCK"
  | "CT_RULE_INERT"
  | "CT_UNASSIGNED"
  | "SAME_PERIOD_IMPOSSIBLE"
  | "SAME_PERIOD_PICK_DAYS"
  | "UNDER_MAPPED"
  | "OVER_MAPPED"
  // Check 7 — split electives (§4.9)
  | "ELECTIVE_NO_MEMBERS"
  | "ELECTIVE_TOO_FEW_OPTIONS"
  | "ELECTIVE_TEACHER_CLASH"
  | "ELECTIVE_ROOM_CLASH"
  | "ELECTIVE_DAILY_PIGEONHOLE"
  | "ELECTIVE_DAY_INTERSECTION"
  | "ELECTIVE_SUBJECT_DOUBLE_COUNTED"
  | "NO_DATA";

export interface EntityRef {
  /** which master screen to jump to for the fix */
  type:
    | "class_section"
    | "teacher"
    | "class_subject"
    | "mapping"
    | "room"
    | "config"
    | "merged_group"
    | "elective_block";
  id: number;
  label: string;
}

/** One actionable finding — maps 1:1 to a row on the Readiness Dashboard (§4). */
export interface FeasibilityIssue {
  code: IssueCode;
  severity: IssueSeverity;
  /** plain, specific, actionable — §4's exact message style */
  message: string;
  entity: EntityRef;
  fix?: string;
}

export interface FeasibilityResult {
  /** 0–100; 100 + zero blockers = the Generate button unlocks */
  score: number;
  ready: boolean;
  blockers: FeasibilityIssue[];
  warnings: FeasibilityIssue[];
  stats: {
    classSections: number;
    teachers: number;
    totalRequiredSlots: number;
    totalAvailableSlots: number;
  };
}

// ---------------- snapshot ----------------

export interface SnapshotConfig {
  id: number;
  name: string;
  /** ISO day numbers, 1=Mon..7=Sun */
  workingDays: number[];
  /** teaching periods per day (breaks & zero period excluded) */
  periodsPerDay: number;
  /**
   * lengths of contiguous teaching-period runs between breaks, e.g. a day of
   * P1-P3, break, P4-P7 → [3,4]. Empty means layout not yet built.
   */
  daySegments: number[];
}

export interface SnapshotClassSection {
  id: number;
  label: string; // "5-A"
  classId: number;
  classTeacherId: number | null;
}

/** One class_subjects row (applies to every section of that class). */
export interface SnapshotSubjectRequirement {
  id: number;
  classId: number;
  subjectId: number;
  subjectName: string;
  periodsPerWeek: number;
  maxPeriodsPerDay: number;
  samePeriodAcrossWeek: boolean;
  consecutiveBlockSize: number;
  consecutiveBlocksPerWeek: number | null;
}

export interface SnapshotTeacher {
  id: number;
  name: string;
  maxPeriodsPerDay: number;
  maxPeriodsPerWeek: number;
  classTeacherPeriodRule: "none" | "always_first_period" | "random";
  periodPattern: "every_period" | "alternate_period" | "alternate_day";
  alternateDaySet: number[] | null;
  /** days fully unavailable (weekly off) */
  unavailableFullDays: number[];
  /** count of additional single-period unavailability rows */
  unavailablePeriodCount: number;
}

export interface SnapshotMapping {
  id: number;
  teacherId: number;
  teacherName: string;
  subjectId: number;
  subjectName: string;
  classSectionId: number;
  classSectionLabel: string;
  periodsPerWeek: number;
}

export interface SnapshotMergedGroup {
  id: number;
  teacherId: number;
  subjectId: number;
  subjectName: string;
  periodsPerWeek: number;
  memberClassSectionIds: number[];
}

/**
 * §4.9 split elective — the mirror of a merged group. A merged group is one
 * teacher across several sections; this is several teachers inside one slot,
 * with every member section holding that slot open exactly once.
 */
export interface SnapshotElectiveBlock {
  id: number;
  name: string;
  periodsPerWeek: number;
  maxPeriodsPerDay: number;
  memberClassSectionIds: number[];
  memberLabels: string[];
  /** the parallel lessons — each its own subject, teacher and room */
  options: Array<{
    id: number;
    subjectId: number;
    subjectName: string;
    teacherId: number;
    teacherName: string;
    roomId: number;
    roomName: string;
  }>;
}

export interface FeasibilitySnapshot {
  config: SnapshotConfig;
  classSections: SnapshotClassSection[];
  subjectRequirements: SnapshotSubjectRequirement[];
  teachers: SnapshotTeacher[];
  mappings: SnapshotMapping[];
  mergedGroups: SnapshotMergedGroup[];
  electiveBlocks: SnapshotElectiveBlock[];
  /** teacher load carried in OTHER timetable configs (§3.10 cross-wing rule) */
  crossConfigTeacherLoad: Record<number, { periods: number; otherConfigNames: string[] }>;
  labRoomCount: number;
  labSubjectIds: number[];
}
