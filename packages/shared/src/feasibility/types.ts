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
  // Check 9 — fixed room assignment (§19)
  | "LAB_SUBJECT_UNSERVED"
  | "LAB_SUBJECT_OVERFLOW"
  | "HOME_ROOM_SHARED"
  | "HOME_ROOM_UNSET"
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
  // Check 7b — elective placement (§4.9, Phase 15)
  | "ELECTIVE_PIN_COUNT"
  | "ELECTIVE_PIN_INVALID"
  | "ELECTIVE_PIN_DUPLICATE"
  | "ELECTIVE_PIN_UNAVAILABLE"
  | "ELECTIVE_PIN_CLASH"
  | "ELECTIVE_SAME_PERIOD_TIGHT"
  // Check 10 — minimum periods per day (§20)
  | "MIN_DAY_IMPOSSIBLE"
  | "MIN_DAY_RELAXED"
  // Check 8 — teaching scope and engagement (§18)
  | "TEACHER_NOT_ELIGIBLE"
  | "TEACHER_SCOPE_UNSET"
  | "GUEST_IN_CURRICULUM"
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

/**
 * §21 — a machine-applicable form of the `fix` line.
 *
 * `fix` is prose written for a person ("Reassign [5-A Maths: 6 periods] to
 * another teacher, or raise their max load"). Auto-resolve must never parse
 * that: a resolver that reads English is guessing at the exact moment it is
 * about to write to the school's master data. So the engine emits the remedy
 * *as data*, decided where the numbers are already in scope, and the applier
 * gets exact writes with no judgement of its own to make.
 *
 * Three kinds, because they carry very different risk:
 *
 *   - `complete` — fills in something the school simply has not stated yet
 *     (a class teacher, a home room, a teaching scope). Nothing is loosened.
 *   - `redistribute` — a real change with no rule relaxed: the same teaching
 *     moved to someone who has room for it.
 *   - `relax` — raises a cap or lowers a floor. Always shown with its cost,
 *     never covered by "do not ask again", because a resolver free to loosen
 *     can take any school to a Readiness Score of 100 without changing one
 *     real thing, and the score is the whole promise.
 */
export type RemedyKind = "complete" | "redistribute" | "relax";

/** The tables a remedy is allowed to touch. */
export type RemedyEntity =
  | "teacher"
  | "classSection"
  | "mapping"
  | "electiveOption"
  | "electiveBlock"
  | "classSubject";

/** Join tables, where a change is a row that exists or does not. */
export type RemedyLink = "teacherClass" | "roomSubject";

export type RemedyValue = string | number | boolean | null | number[];

export type RemedyChange =
  | { op: "set"; entity: RemedyEntity; id: number; field: string; from: RemedyValue; to: RemedyValue }
  | { op: "link"; entity: RemedyLink; id: number; otherId: number }
  | { op: "create"; entity: RemedyEntity; data: Record<string, RemedyValue> };

export interface Remedy {
  kind: RemedyKind;
  /** one line for the consent card, naming what changes and to what */
  summary: string;
  /** every write, in order. Applied together or not at all. */
  changes: RemedyChange[];
}

/** One actionable finding — maps 1:1 to a row on the Readiness Dashboard (§4). */
export interface FeasibilityIssue {
  code: IssueCode;
  severity: IssueSeverity;
  /** plain, specific, actionable — §4's exact message style */
  message: string;
  entity: EntityRef;
  fix?: string;
  /**
   * Stable enough to consent against: assigned by `finalize()`, not by each
   * check, so a new check cannot forget it. Two issues sharing a code and an
   * entity get an ordinal.
   */
  key?: string;
  /** §21: present only when this issue can be fixed mechanically. */
  remedy?: Remedy;
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
  /** §20: a day is either free or carries at least this many periods. */
  minPeriodsPerDay: number;
  maxPeriodsPerWeek: number;
  classTeacherPeriodRule: "none" | "always_first_period" | "random";
  periodPattern: "every_period" | "alternate_period" | "alternate_day";
  alternateDaySet: number[] | null;
  /** days fully unavailable (weekly off) */
  /** §18: classes this teacher may take. Empty = not stated yet. */
  eligibleClassIds: number[];
  /** §18: `guest` teachers belong to extra classes, not the curriculum. */
  employmentType: "permanent" | "adhoc" | "guest";
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
/**
 * §4.9 Phase 15 — when the block runs.
 *
 *  - `solver`      the solver picks, as it always has. The default.
 *  - `same_period` one period NUMBER across the block's days: P4 Mon–Fri, so a
 *                  whole grade changes rooms together at a known time.
 *  - `fixed`       exact cells, named by the admin.
 *
 * All three are enforced by pruning the variable's domain before search
 * (invariant 2), so the solver can never consider a slot the school ruled out.
 */
export type ElectivePlacement = "solver" | "same_period" | "fixed";

/** One pinned cell. Read only when `placement` is `fixed`. */
export interface ElectivePin {
  day: number;
  period: number;
}

export interface SnapshotElectiveBlock {
  id: number;
  name: string;
  periodsPerWeek: number;
  maxPeriodsPerDay: number;
  placement: ElectivePlacement;
  /** one per occurrence, in order; empty unless `placement` is `fixed` */
  fixedSlots: ElectivePin[];
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
  /** §19: the fixed room each class-section sits in, when one is recorded. */
  homeRoomBySection: Record<number, number | null>;
  /** §19: which lab rooms serve each lab subject. A lab with no subjects
   *  listed is general and appears under every lab subject. */
  labRoomsBySubject: Record<number, number[]>;
  /** Room names, for messages that have to name one. */
  roomNames: Record<number, string>;
  /**
   * §21: every room, with the type a remedy needs to tell a classroom from a
   * lab. `roomNames` alone cannot answer "give this section a free room".
   */
  rooms: SnapshotRoom[];
}

export interface SnapshotRoom {
  id: number;
  name: string;
  roomType: string;
  capacity: number | null;
  isShared: boolean;
  /** §19: the subjects this room is set up for; empty = a general room. */
  subjectIds: number[];
}
