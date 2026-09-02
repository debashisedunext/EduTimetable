/**
 * §23 — ERP master-data sync: what the ERP owns, and what it must never touch.
 *
 * The ERP is the school's system of record for *who and what exists*: staff,
 * classes, sections, subjects, sessions. The timetable is the system of record
 * for *how those things are scheduled*: how many periods a subject gets, how
 * many a teacher may take in a day, which pattern they work.
 *
 * Both systems hold the same rows. They do not hold the same fields, and this
 * table is the whole reason a sync is safe to run unattended. Without it,
 * "the ERP wins" would overwrite `max_periods_per_day` with whatever the staff
 * master happened to contain, the next Generate would produce a different
 * timetable, and nothing on any screen would say why.
 *
 * Read this as: **on a re-sync, these are the only fields that may change.**
 * Everything else about an existing row is left exactly as it is.
 */

/** The masters in scope (Phase 22 step 1: core identity). */
export const SYNC_SHEETS = [
  "Academic Years",
  "Classes",
  "Class Sections",
  "Subjects",
  "Teachers",
] as const;

export type SyncSheet = (typeof SYNC_SHEETS)[number];

/**
 * Fields the ERP owns, per sheet, keyed the same way the §16 import contract
 * keys its columns — so a sync row and an import row are the same shape and
 * the same validator checks both.
 *
 * A field absent from this list is the timetable's, and a sync will not write
 * it on a row that already exists. It may still be *set* when the row is
 * created, from the app's own defaults.
 */
export const ERP_OWNED: Record<SyncSheet, readonly string[]> = {
  // Which sessions the school runs, and which one is current.
  "Academic Years": ["name", "startDate", "endDate", "isActive"],
  // The ladder of classes and the order they sit in.
  Classes: ["className", "sequence"],
  // Strength moves every term as admissions land; the rest of a class-section
  // (its timetable, its home room, its class teacher) is scheduling.
  "Class Sections": ["strength"],
  // `isLab` and `requiresDoublePeriod` are deliberately absent: they are
  // statements about how a subject must be TIMETABLED, and an ERP's subject
  // master has no opinion on them.
  Subjects: ["subjectName", "code"],
  // `name` and `isActive` and nothing else. Every remaining teacher field —
  // max/min periods per day, periods per week, period pattern, alternate days,
  // the class-teacher rule — is scheduling configuration that took an admin
  // real thought, and an ERP staff record cannot know it.
  //
  // `employmentType` is NOT here on purpose. Our enum carries `guest`, which is
  // a §18 timetabling concept the ERP has no equivalent for; mapping their
  // vocabulary onto it would be guesswork that silently changes who may be
  // offered as a substitute.
  Teachers: ["name", "isActive"],
};

/** The natural key of each sheet — what makes two rows "the same row". */
export const SYNC_KEY: Record<SyncSheet, readonly string[]> = {
  "Academic Years": ["name"],
  Classes: ["className"],
  "Class Sections": ["className", "sectionName", "academicYear"],
  Subjects: ["subjectName"],
  Teachers: ["employeeCode"],
};

/**
 * How a sync reconciles one master.
 *
 * Both modes end with our rows saying exactly what the ERP says. They differ in
 * one respect, and it is the one that matters:
 *
 *  - `refresh` matches on the natural key above, updates in place, inserts what
 *    is new and deletes what the ERP no longer has. **Row ids survive**, so the
 *    mappings, timetables and teacher logins that point at them survive too.
 *  - `replace` deletes every row and re-inserts from the ERP. Ids are new. That
 *    is right for a first load and wrong for a live school, because nothing in
 *    the database stops it: `timetable_slots.teacher_id` has no foreign key, so
 *    a published timetable silently ends up pointing at teachers that no longer
 *    exist and no error is raised anywhere.
 *
 * The engine treats them identically apart from matching. The difference in
 * consequence is reported by the impact count, not decided here.
 */
export type SyncMode = "refresh" | "replace";

/**
 * Which masters must already be in place before this one can be synced.
 *
 * A class-section is a class, a section and a session at once, so syncing it
 * into an empty school would silently drop every row for want of a parent. The
 * button reports the missing master rather than reporting "0 imported".
 */
export const SYNC_DEPENDS_ON: Record<SyncSheet, readonly SyncSheet[]> = {
  "Academic Years": [],
  Classes: [],
  "Class Sections": ["Classes", "Academic Years"],
  Subjects: [],
  Teachers: [],
};

/** One field that differs between the ERP and us, on a row that exists in both. */
export interface SyncFieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

/** What a sync would do to one row. */
export interface SyncRowPlan {
  key: string;
  /** how the row reads to a person, e.g. "Class 5-A" */
  label: string;
  verdict: "new" | "update" | "unchanged" | "remove";
  changes: SyncFieldChange[];
  /**
   * Our own row id, on the verdicts that have one (`update`, `remove`). Carried
   * on the plan so the writer never has to re-look-up what the planner already
   * matched — the plan is recomputed server-side on every apply, so this id is
   * always one the server itself just read.
   */
  id?: number | null;
}

export interface SyncSheetPlan {
  sheet: SyncSheet;
  mode: SyncMode;
  read: number;
  create: number;
  update: number;
  unchanged: number;
  /** rows of ours the ERP no longer has (refresh), or all of them (replace) */
  remove: number;
  rows: SyncRowPlan[];
}

export interface SyncPlan {
  sheets: SyncSheetPlan[];
  totals: { read: number; create: number; update: number; unchanged: number; remove: number };
}

/** True when this sheet lets the ERP change anything at all on an existing row. */
export function hasOwnedFields(sheet: SyncSheet): boolean {
  return ERP_OWNED[sheet].length > 0;
}
