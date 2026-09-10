/**
 * §13.5 Phase B — updating a row that already exists.
 *
 * Phase A could only add: a row the school already had came back as "already
 * exists" and was left alone. That is right for an Excel upload, which promises
 * never to overwrite hand-entered data, and wrong for a conversation — "make
 * Class 5's English six periods" is the commonest thing anyone wants to say.
 *
 * Three rules shape this file.
 *
 * **The natural key is never writable.** Changing what identifies a row is not
 * an edit of that row, it is a different row; `UPDATABLE` below lists only the
 * fields that may move, and the key columns are deliberately absent from every
 * one of them.
 *
 * **A field the draft did not mention is not a change.** The model sends what
 * the admin said, not a whole record, so an absent field means "leave it" — not
 * "set it to null". This is the same rule §23's reconcile engine holds to, and
 * for the same reason: the alternative is silent data loss on every partial
 * instruction.
 *
 * **The diff is computed here, against the database.** `validateWorkbook` knows
 * a row exists — it matches names — but not what that row currently contains,
 * so it cannot produce `old → new`. Doing it in the API layer keeps the shared
 * validator untouched, which keeps the Excel path exactly as it was.
 */
import type { ValidatedRow } from "@edutimetable/shared";

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * Which table a diff lands on.
 *
 * `row` is the Phase B case — one drafted row, one database row, one
 * `update()`. The other three are Phase C, where a drafted Subject Mapping row
 * is not one row at all: it fans out to one mapping per class-section, or
 * collapses into a single merged group, and a Class Teachers row writes a
 * pointer on a class-section rather than a record of its own.
 */
export type UpdateKind = "row" | "mapping" | "merged" | "classTeacher";

export interface RowUpdate {
  sheet: string;
  /** how the row reads to a person, e.g. "Class 5 · English" */
  label: string;
  /** the database id of the row being changed */
  id: number;
  changes: FieldChange[];
  /** which table `id` belongs to; absent means the Phase B `row` case */
  kind?: UpdateKind;
}

/**
 * What may be changed on an existing row, per master.
 *
 * Read this as the whole of the assistant's write authority over things that
 * already exist. A field absent here cannot be moved from a conversation, and
 * the natural key of every sheet is absent by design.
 */
export const UPDATABLE: Record<string, string[]> = {
  // `name` is the key — a renamed class is a new class.
  Classes: ["sequence"],
  // The key is class + section + year; what a section can gain is a size, a
  // home room and a timetable.
  "Class Sections": ["strength", "homeRoom", "timetable"],
  Subjects: ["code", "isLab", "requiresDoublePeriod"],
  Teachers: [
    "name", "maxPeriodsPerDay", "minPeriodsPerDay", "maxPeriodsPerWeek",
    "classTeacherPeriodRule", "periodPattern", "alternateDaySet", "employmentType", "isActive",
  ],
  Curriculum: [
    "periodsPerWeek", "maxPeriodsPerDay", "samePeriodAcrossWeek",
    // §31.10 — the block's shape, and whether a break may fall inside it.
    // Listed beside its two companions deliberately: they are one decision, and
    // a conversation able to set a block size but not say whether it may cross
    // a break could only ever produce the stricter half of what was asked.
    "consecutiveBlockSize", "consecutiveBlocksPerWeek", "blockMayCrossBreak",
  ],
  // The unique key is (subject, class-section), so WHO teaches it is a change
  // rather than an identity — which makes "move Class 5-A maths to Rekha" an
  // update, and a very common one.
  "Subject Mapping": ["employeeCode", "periodsPerWeek", "room"],
  // The key is the class-section; the whole row is the pointer.
  "Class Teachers": ["employeeCode"],
};

/**
 * The same allow-list for a **merged** teaching group (§4.9).
 *
 * A group is identified by its subject, its teacher AND its member sections
 * together — that is the key the importer dedupes on — so `employeeCode` moves
 * from "updatable" to "part of the key" the moment `merged` is Yes. Naming a
 * different teacher is therefore a *different group*, not an edit, and the plan
 * says so instead of quietly creating a second one.
 */
export const MERGED_UPDATABLE = ["periodsPerWeek", "room"];

/** Sheets the assistant may update at all. */
export const UPDATABLE_SHEETS = Object.keys(UPDATABLE);

const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** Same value, allowing for how two systems spell one. */
function same(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined || b === "";
  if (typeof a === "boolean" || typeof b === "boolean") {
    const t = (v: unknown) => v === true || v === 1 || lower(v) === "yes" || lower(v) === "true";
    return t(a) === t(b);
  }
  if (typeof a === "number" || typeof b === "number") {
    const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
    return n(a) === n(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    const arr = (v: unknown) => (Array.isArray(v) ? v : String(v ?? "").split(",")).map((x) => lower(x)).filter(Boolean).sort();
    return JSON.stringify(arr(a)) === JSON.stringify(arr(b));
  }
  return lower(a) === lower(b);
}

/**
 * Which of the drafted fields actually differ from what is stored.
 *
 * `drafted` is the validator's coerced row; `current` is the shape below,
 * already mapped out of Prisma. Only fields the draft MENTIONED and that
 * `UPDATABLE` permits are considered.
 */
export function changedFields(
  sheet: string,
  drafted: Record<string, unknown>,
  current: Record<string, unknown>,
  mentioned: string[],
  allowedOverride?: string[],
): FieldChange[] {
  const allowed = allowedOverride ?? UPDATABLE[sheet] ?? [];
  const said = new Set(mentioned);
  const out: FieldChange[] = [];
  for (const field of allowed) {
    // `drafted` is the VALIDATOR's row: every column, with defaults filled in
    // for the ones nobody typed. Diffing against that reports a change for
    // every field the draft never mentioned — including a null for each blank
    // optional column, which would quietly wipe them. Only what was actually
    // said is a candidate.
    if (!said.has(field)) continue;
    if (!(field in drafted) || drafted[field] === undefined) continue;
    if (same(drafted[field], current[field])) continue;
    out.push({ field, from: current[field] ?? null, to: drafted[field] ?? null });
  }
  return out;
}

/** How a row of each sheet reads to a person, for the preview. */
export function labelOf(sheet: string, data: Record<string, any>): string {
  switch (sheet) {
    case "Classes": return String(data.name);
    case "Class Sections": return `${data.className}-${data.sectionName} (${data.academicYear})`;
    case "Subjects": return String(data.name);
    case "Teachers": return `${data.employeeCode} — ${data.name ?? ""}`.trim();
    case "Curriculum": return `${data.className} · ${data.subjectName} (${data.academicYear})`;
    case "Subject Mapping": return `${data.subjectName} → ${data.classSections}`;
    case "Class Teachers": return `${data.classSection} — class teacher`;
    default: return JSON.stringify(data).slice(0, 60);
  }
}

/** True when this sheet's rows can be updated from a conversation at all. */
export function isUpdatable(sheet: string): boolean {
  return sheet in UPDATABLE;
}

/**
 * Rows the caller should attempt to update: existing, on an updatable sheet.
 *
 * Kept separate from the diff so the caller can load exactly the records it
 * needs in one query per sheet rather than one per row.
 */
export function existingRowsOf(sheet: string, rows: ValidatedRow[]): ValidatedRow[] {
  if (!isUpdatable(sheet)) return [];
  return rows.filter((r) => r.existing);
}
