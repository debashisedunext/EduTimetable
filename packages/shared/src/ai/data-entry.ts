/**
 * §13.5 — natural-language master-data entry: the pure half.
 *
 * The assistant does not write. It **drafts rows**, which are then checked by
 * the same `validateWorkbook` the Excel importer and the ERP sync use, shown to
 * an admin, and committed only on a human click. This module is the adapter
 * between what a language model can reliably produce and what that validator
 * expects — nothing here touches a database or an LLM, so every rule below is
 * unit-testable on its own.
 *
 * The awkward detail it exists for: `RawSheet` cells are keyed by the column's
 * **header text** (`"Employee Code"`, `"Requires Double Period"`), because that
 * is what a spreadsheet actually contains. Asking a model to reproduce those
 * exactly — spaces, casing, the lot — would fail often and fail silently, with
 * the cell simply reading as blank. So a model may key a row by either the
 * header or the field name (`employeeCode`), in any case and spacing, and this
 * maps it onto the header the validator reads.
 *
 * A key that matches nothing is REPORTED, never dropped. A silently ignored
 * column is how "I told it the room and it ignored me" happens.
 */
import { SHEETS, type ColumnDef } from "../import/contract";
import type { RawSheet } from "../import/types";

/**
 * The masters the assistant may draft. Deliberately a subset: no rooms (they
 * carry lab mappings), no academic years (a session is a decision, not a typo
 * to fix), no electives, and above all nothing that touches a timetable.
 *
 * Phase C added `Class Teachers`, which writes one pointer on a class-section
 * the school already has — the same authority as the Class-Teacher Assignment
 * screen, and the thing people ask for in the same breath as a mapping.
 */
export const AI_ENTRY_SHEETS = [
  "Classes",
  "Class Sections",
  "Subjects",
  "Teachers",
  "Curriculum",
  "Class Teachers",
  "Subject Mapping",
] as const;

export type AiEntrySheet = (typeof AI_ENTRY_SHEETS)[number];

export function isAiEntrySheet(name: string): name is AiEntrySheet {
  return (AI_ENTRY_SHEETS as readonly string[]).includes(name);
}

/** One row as the model emits it: loose keys, loose values. */
export type DraftRow = Record<string, unknown>;

export interface DraftSheet {
  sheet: string;
  rows: DraftRow[];
}

/**
 * Which fields a drafted row actually MENTIONED, per sheet and row.
 *
 * Load-bearing for updates. `validateWorkbook` returns a fully-populated row —
 * every column, with defaults filled in for the ones the draft left out — so a
 * diff computed against that row reports "changes" for every field the model
 * never spoke about, including nulls for optional columns. The only reliable
 * record of what was actually asked for is what arrived here.
 */
export interface MentionedFields {
  sheet: string;
  row: number;
  fields: string[];
}

/** Something the adapter could not place — surfaced, never swallowed. */
export interface DraftIssue {
  sheet: string;
  row: number | null;
  message: string;
  fix: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

/** Longest common subsequence-ish closeness, enough for "did you mean". */
function closest(target: string, options: string[]): string | null {
  const t = norm(target);
  let best: { name: string; score: number } | null = null;
  for (const o of options) {
    const n = norm(o);
    let score = 0;
    if (n.startsWith(t) || t.startsWith(n)) score = 3;
    else if (n.includes(t) || t.includes(n)) score = 2;
    else if (n[0] === t[0]) score = 1;
    if (score > 0 && (!best || score > best.score)) best = { name: o, score };
  }
  return best?.name ?? null;
}

/** Every name a column will answer to: its header, and its field key. */
function aliasesOf(col: ColumnDef): string[] {
  return [col.header, col.key];
}

/**
 * Turn drafted sheets into the `RawSheet[]` the validator consumes.
 *
 * Row numbers start at 2 to match a spreadsheet, so every issue the validator
 * raises reads as `Teachers!B3` — the same reference the Excel path produces,
 * which means the preview component and the error copy are shared too.
 */
export function toRawSheets(
  drafts: DraftSheet[],
): { sheets: RawSheet[]; issues: DraftIssue[]; mentioned: MentionedFields[] } {
  const issues: DraftIssue[] = [];
  const sheets: RawSheet[] = [];
  const mentioned: MentionedFields[] = [];

  for (const draft of drafts) {
    const def = SHEETS.find((s) => norm(s.name) === norm(draft.sheet));
    if (!def) {
      issues.push({
        sheet: draft.sheet,
        row: null,
        message: `There is no master called "${draft.sheet}".`,
        fix: `Use one of: ${AI_ENTRY_SHEETS.join(", ")}.`,
      });
      continue;
    }
    if (!isAiEntrySheet(def.name)) {
      issues.push({
        sheet: def.name,
        row: null,
        message: `${def.name} cannot be created from a conversation.`,
        fix: `The assistant may add: ${AI_ENTRY_SHEETS.join(", ")}. Use the Setup Wizard or the Excel import for anything else.`,
      });
      continue;
    }

    const headers = def.columns.map((c) => c.header);
    const rows = (draft.rows ?? []).map((row, i) => {
      const cells: Record<string, unknown> = {};
      const named: string[] = [];
      for (const [rawKey, value] of Object.entries(row ?? {})) {
        const col = def.columns.find((c) => aliasesOf(c).some((a) => norm(a) === norm(rawKey)));
        if (!col) {
          const suggestion = closest(rawKey, headers);
          issues.push({
            sheet: def.name,
            row: i + 2,
            message: `${def.name} has no column "${rawKey}", so that value was not used.`,
            fix: suggestion ? `Did you mean "${suggestion}"?` : `Columns are: ${headers.join(", ")}.`,
          });
          continue;
        }
        cells[col.header] = value;
        named.push(col.key);
      }
      mentioned.push({ sheet: def.name, row: i + 2, fields: named });
      return { row: i + 2, cells };
    });

    sheets.push({ name: def.name, headers, rows });
  }

  return { sheets, issues, mentioned };
}

/**
 * A compact description of one sheet's columns, for the tool schema.
 *
 * Generated from the contract rather than written out, so a column added to the
 * importer is a column the assistant knows about on the next build — the two
 * cannot drift, which a hand-written copy of this list certainly would.
 */
export function sheetGuide(sheet: AiEntrySheet): string {
  const def = SHEETS.find((s) => s.name === sheet);
  if (!def) return "";
  const cols = def.columns.map((c) => {
    const bits: string[] = [c.key];
    if (c.required) bits.push("REQUIRED");
    if (c.type === "enum" && c.values) bits.push(`one of: ${c.values.join(" | ")}`);
    else if (c.type === "int") bits.push(`number${c.min !== undefined ? ` ${c.min}-${c.max}` : ""}`);
    else if (c.type === "list") bits.push(`comma-separated list`);
    else if (c.type === "date") bits.push("YYYY-MM-DD");
    if (c.help) bits.push(c.help);
    return `    ${bits.join(" — ")}`;
  });
  return `  ${def.name} (unique by ${def.keyLabel}): ${def.help}\n${cols.join("\n")}`;
}

/** The whole guide, for the tool description and the system prompt. */
export function allSheetGuides(): string {
  return AI_ENTRY_SHEETS.map(sheetGuide).join("\n");
}

/**
 * Common school subjects, for the picker and for the assistant to draw on.
 *
 * Shared so the two agree: a subject the picker offers is a subject the model
 * names identically, which keeps "add the science subjects" from producing
 * "Physics" beside an existing "Physics ".
 */
export const COMMON_SUBJECTS: { group: string; subjects: { name: string; code: string; isLab?: boolean }[] }[] = [
  {
    group: "Languages",
    subjects: [
      { name: "English", code: "ENG" },
      { name: "Hindi", code: "HIN" },
      { name: "Sanskrit", code: "SAN" },
      { name: "French", code: "FRE" },
      { name: "German", code: "GER" },
      { name: "Urdu", code: "URD" },
      { name: "Regional Language", code: "RGL" },
    ],
  },
  {
    group: "Mathematics & Science",
    subjects: [
      { name: "Mathematics", code: "MAT" },
      { name: "Science", code: "SCI", isLab: true },
      { name: "Physics", code: "PHY", isLab: true },
      { name: "Chemistry", code: "CHE", isLab: true },
      { name: "Biology", code: "BIO", isLab: true },
    ],
  },
  {
    group: "Social Sciences",
    subjects: [
      { name: "Social Science", code: "SST" },
      { name: "History", code: "HIS" },
      { name: "Geography", code: "GEO" },
      { name: "Civics", code: "CIV" },
      { name: "Economics", code: "ECO" },
      { name: "Political Science", code: "POL" },
    ],
  },
  {
    group: "Commerce & Computing",
    subjects: [
      { name: "Computer Science", code: "CMP", isLab: true },
      { name: "Information Technology", code: "IT", isLab: true },
      { name: "Accountancy", code: "ACC" },
      { name: "Business Studies", code: "BST" },
    ],
  },
  {
    group: "Arts & Activity",
    subjects: [
      { name: "Art & Craft", code: "ART" },
      { name: "Music", code: "MUS" },
      { name: "Dance", code: "DAN" },
      { name: "Physical Education", code: "PE" },
      { name: "Moral Science", code: "MOR" },
      { name: "General Knowledge", code: "GK" },
      { name: "Library", code: "LIB" },
    ],
  },
];

/** Flat list, for a quick membership test. */
export const COMMON_SUBJECT_NAMES = COMMON_SUBJECTS.flatMap((g) => g.subjects.map((s) => s.name));
