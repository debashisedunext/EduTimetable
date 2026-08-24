/** §16 — import result model. Every issue names the exact cell and the fix,
 *  the same contract the Feasibility Engine uses for blockers. */

export type ImportIssueSeverity = "error" | "warning";

export interface ImportIssue {
  severity: ImportIssueSeverity;
  sheet: string;
  /** 1-based worksheet row (row 1 is the header), null for sheet-level issues */
  row: number | null;
  column?: string;
  /** Excel-style reference the user can type into the Name Box, e.g. "C7" */
  cell?: string;
  value?: string;
  code: string;
  message: string;
  fix: string;
}

export interface SheetPlan {
  sheet: string;
  title: string;
  /** data rows found (samples and blank rows excluded) */
  read: number;
  /** rows that will create something */
  create: number;
  /** rows already present in the system — left untouched */
  skip: number;
  /** rows that cannot be imported */
  errors: number;
}

export interface ImportPlan {
  ok: boolean;
  sheets: SheetPlan[];
  issues: ImportIssue[];
  totals: { read: number; create: number; skip: number; errors: number; warnings: number };
}

/** One parsed worksheet handed to the validator: raw cell values by column key. */
export interface RawSheet {
  name: string;
  /** header text → column index, as found in the file */
  headers: string[];
  rows: Array<{ row: number; cells: Record<string, unknown> }>;
}

/** What the workbook contains once validated — ready for the committer. */
export interface ParsedRow<T = Record<string, unknown>> {
  row: number;
  data: T;
}
