/**
 * §16 — the Excel layer. exceljs lives here and nowhere else: it turns the
 * declarative contract into a styled template, lifts an uploaded file into
 * plain rows for the pure validator, and writes the annotated error file.
 */
import ExcelJS from "exceljs";
import {
  SHEETS,
  YES_NO,
  type ColumnDef,
  type SheetDef,
} from "@edutimetable/shared";
import type { ImportIssue, RawSheet } from "@edutimetable/shared";

const BRAND = "FF2563EB";
const HEADER_TEXT = "FFFFFFFF";
const REQUIRED_TINT = "FFE7EEFA";
const SAMPLE_TEXT = "FF8695A9";
const ERROR_FILL = "FFFBEAE9";
const ERROR_TEXT = "FFC2372F";

export const MAX_ROWS_PER_SHEET = 5000;

function styleHeader(ws: ExcelJS.Worksheet, sheet: SheetDef) {
  const header = ws.getRow(1);
  sheet.columns.forEach((col, i) => {
    const cell = header.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true, color: { argb: HEADER_TEXT }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: "FFDBE3F0" } } };
    // the note explains the column without the user leaving Excel
    cell.note = `${col.required ? "REQUIRED. " : "Optional. "}${col.help}`;
    ws.getColumn(i + 1).width = col.width ?? 18;
  });
  header.height = 26;
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
}

/** Real Excel dropdowns for every enum column, so bad values are hard to type. */
function addValidation(ws: ExcelJS.Worksheet, sheet: SheetDef, lastRow: number) {
  sheet.columns.forEach((col, i) => {
    if (col.type !== "enum" || !col.values) return;
    const letter = ws.getColumn(i + 1).letter;
    for (let r = 2; r <= lastRow; r++) {
      ws.getCell(`${letter}${r}`).dataValidation = {
        type: "list",
        allowBlank: !col.required,
        formulae: [`"${col.values.join(",")}"`],
        showErrorMessage: true,
        errorStyle: "warning",
        errorTitle: col.header,
        error: `Allowed values: ${col.values.join(", ")}`,
      };
    }
  });
}

function requiredTint(ws: ExcelJS.Worksheet, sheet: SheetDef, lastRow: number) {
  sheet.columns.forEach((col, i) => {
    if (!col.required) return;
    for (let r = 2; r <= lastRow; r++) {
      ws.getCell(r, i + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: REQUIRED_TINT } };
    }
  });
}

function instructionsSheet(wb: ExcelJS.Workbook) {
  const ws = wb.addWorksheet("Instructions", { properties: { tabColor: { argb: BRAND } } });
  ws.getColumn(1).width = 4;
  ws.getColumn(2).width = 34;
  ws.getColumn(3).width = 96;

  const title = ws.getCell("B2");
  title.value = "EduTimetable — master data import";
  title.font = { bold: true, size: 16, color: { argb: "FF0B1F44" } };

  const lines: Array<[string, string]> = [
    ["How it works", "Fill in the sheets below, then upload this file on Build → Import from Excel. Nothing is saved until you review the preview and press Confirm."],
    ["Order matters a little", "Sheets are ordered by dependency. You can reference something you are adding in this same file — e.g. a class on the Classes sheet can be used on Class Sections straight away."],
    ["Use names, not numbers", "Everywhere you refer to a class, subject, room or teacher, type its name (or the teacher's employee code). The importer resolves them for you."],
    ["Nothing gets overwritten", "If a row already exists it is reported as 'already exists' and left exactly as it is. Re-uploading the same file is safe and changes nothing."],
    ["All or nothing", "If any row has an error, nothing at all is imported. Fix the errors and upload again — you can download an annotated copy of this file with every problem marked in red."],
    ["Blue cells are required", "Shaded columns must be filled in. Hover any header for a note explaining that column."],
    ["Grey 'e.g.' rows are examples", "The sample rows are ignored by the importer. Type over them or delete them."],
    ["Extra columns are fine", "Columns the importer does not recognise are ignored, and you can reorder or hide columns freely — matching is by header name."],
    ["Limits", `Up to ${MAX_ROWS_PER_SHEET.toLocaleString()} rows per sheet, 10 MB per file.`],
  ];
  let row = 4;
  for (const [head, body] of lines) {
    ws.getCell(`B${row}`).value = head;
    ws.getCell(`B${row}`).font = { bold: true, size: 11, color: { argb: "FF2563EB" } };
    ws.getCell(`B${row}`).alignment = { vertical: "top" };
    ws.getCell(`C${row}`).value = body;
    ws.getCell(`C${row}`).alignment = { wrapText: true, vertical: "top" };
    ws.getRow(row).height = 30;
    row += 1;
  }

  row += 1;
  ws.getCell(`B${row}`).value = "What each sheet creates";
  ws.getCell(`B${row}`).font = { bold: true, size: 13, color: { argb: "FF0B1F44" } };
  row += 1;
  for (const s of SHEETS) {
    ws.getCell(`B${row}`).value = s.name;
    ws.getCell(`B${row}`).font = { bold: true, size: 10.5 };
    ws.getCell(`C${row}`).value = s.help;
    ws.getCell(`C${row}`).alignment = { wrapText: true, vertical: "top" };
    ws.getRow(row).height = 26;
    row += 1;
  }
}

function referenceSheet(wb: ExcelJS.Workbook, existing: Record<string, string[]>) {
  const ws = wb.addWorksheet("Reference", { properties: { tabColor: { argb: "FF5578A8" } } });
  ws.getCell("A1").value = "Copy exact spellings from here";
  ws.getCell("A1").font = { bold: true, size: 13, color: { argb: "FF0B1F44" } };
  ws.getCell("A2").value = "These are the values already in your system. Anything you add in this file can be referenced too.";
  ws.getCell("A2").font = { size: 10.5, color: { argb: "FF8695A9" } };

  const groups = Object.entries(existing);
  groups.forEach(([label, values], gi) => {
    const col = gi + 1;
    ws.getColumn(col).width = 26;
    const head = ws.getCell(4, col);
    head.value = label;
    head.font = { bold: true, color: { argb: HEADER_TEXT } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF5578A8" } };
    values.slice(0, 400).forEach((v, i) => {
      ws.getCell(5 + i, col).value = v;
    });
    if (values.length === 0) {
      ws.getCell(5, col).value = "(none yet)";
      ws.getCell(5, col).font = { italic: true, color: { argb: SAMPLE_TEXT } };
    }
  });
}

export interface TemplateOptions {
  /** existing values, shown on the Reference sheet */
  existing: Record<string, string[]>;
  /** when provided, sheets are filled with these rows instead of samples */
  data?: Record<string, Record<string, unknown>[]>;
}

/** Build the template (blank + samples) or the export (filled with real data). */
export async function buildWorkbook(opts: TemplateOptions): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "EduTimetable";
  wb.created = new Date();

  instructionsSheet(wb);

  for (const sheet of SHEETS) {
    const ws = wb.addWorksheet(sheet.name);
    styleHeader(ws, sheet);

    const rows = opts.data?.[sheet.name];
    if (rows && rows.length > 0) {
      for (const r of rows) {
        ws.addRow(sheet.columns.map((c) => formatOut(r[c.key], c)));
      }
    } else if (!opts.data) {
      // sample row, greyed and ignored by the importer via the "e.g." marker
      const sample = ws.addRow(sheet.columns.map((c) => c.sample?.[0] ?? ""));
      sample.font = { italic: true, color: { argb: SAMPLE_TEXT } };
    }

    const lastRow = Math.max(ws.rowCount, 200); // validation for rows they will add
    requiredTint(ws, sheet, Math.max(ws.rowCount, 2));
    addValidation(ws, sheet, lastRow);
  }

  referenceSheet(wb, opts.existing);
  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}

function formatOut(value: unknown, col: ColumnDef): string | number | null {
  if (value === null || value === undefined) return null;
  if (col.type === "list" && Array.isArray(value)) return value.join(", ");
  if (col.type === "enum" && col.values?.[0] === YES_NO[0] && typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number") return value;
  return String(value);
}

/** exceljs cell values come in several shapes — flatten to something plain. */
function flatten(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if ("text" in o) return o.text;                       // hyperlink
    if ("result" in o) return o.result;                   // formula
    if ("richText" in o) return (o.richText as { text: string }[]).map((t) => t.text).join("");
    if ("error" in o) return "";                          // #REF! etc.
  }
  return v;
}

export interface ParseResult {
  sheets: RawSheet[];
  /** sheet names found in the file that the contract does not know about */
  unknownSheets: string[];
  truncated: string[];
}

export async function parseWorkbook(buffer: Buffer): Promise<ParseResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  const known = new Set(SHEETS.map((s) => s.name.toLowerCase()));
  const sheets: RawSheet[] = [];
  const unknownSheets: string[] = [];
  const truncated: string[] = [];

  wb.eachSheet((ws) => {
    const name = ws.name.trim();
    if (name.toLowerCase() === "instructions" || name.toLowerCase() === "reference") return;
    if (!known.has(name.toLowerCase())) {
      unknownSheets.push(name);
      return;
    }
    const headerRow = ws.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col - 1] = String(flatten(cell.value) ?? "").trim();
    });

    const rows: RawSheet["rows"] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      if (rows.length >= MAX_ROWS_PER_SHEET) { truncated.push(name); break; }
      const row = ws.getRow(r);
      const cells: Record<string, unknown> = {};
      let any = false;
      headers.forEach((h, i) => {
        if (!h) return;
        const v = flatten(row.getCell(i + 1).value);
        cells[h] = v;
        if (String(v ?? "").trim() !== "") any = true;
      });
      if (any) rows.push({ row: r, cells });
    }
    sheets.push({ name: SHEETS.find((s) => s.name.toLowerCase() === name.toLowerCase())!.name, headers, rows });
  });

  return { sheets, unknownSheets, truncated };
}

/**
 * Return the uploaded file with an "Import Errors" column appended to each
 * sheet and every offending cell tinted — so the admin fixes problems in the
 * file they already have rather than hunting through a web list.
 */
export async function annotateWorkbook(buffer: Buffer, issues: ImportIssue[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  const bySheet = new Map<string, ImportIssue[]>();
  for (const i of issues) {
    const list = bySheet.get(i.sheet.toLowerCase()) ?? [];
    list.push(i);
    bySheet.set(i.sheet.toLowerCase(), list);
  }

  for (const sheet of SHEETS) {
    const ws = wb.getWorksheet(sheet.name);
    const list = bySheet.get(sheet.name.toLowerCase());
    if (!ws || !list || list.length === 0) continue;

    const headerRow = ws.getRow(1);
    let width = 0;
    headerRow.eachCell({ includeEmpty: true }, (_c, col) => { width = Math.max(width, col); });
    const errCol = width + 1;

    const head = ws.getCell(1, errCol);
    head.value = "Import Errors";
    head.font = { bold: true, color: { argb: HEADER_TEXT } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ERROR_TEXT } };
    ws.getColumn(errCol).width = 70;

    const byRow = new Map<number, ImportIssue[]>();
    for (const i of list) {
      if (i.row === null) continue;
      const l = byRow.get(i.row) ?? [];
      l.push(i);
      byRow.set(i.row, l);
    }
    for (const [row, rowIssues] of byRow) {
      const cell = ws.getCell(row, errCol);
      cell.value = rowIssues.map((i) => `${i.severity === "error" ? "✗" : "!"} ${i.column ? `${i.column}: ` : ""}${i.message} → ${i.fix}`).join("\n");
      cell.alignment = { wrapText: true, vertical: "top" };
      cell.font = { color: { argb: ERROR_TEXT }, size: 10 };
      // tint the offending cells themselves
      for (const i of rowIssues) {
        if (!i.column) continue;
        let idx = -1;
        headerRow.eachCell({ includeEmpty: true }, (c, col) => {
          if (String(flatten(c.value) ?? "").trim().toLowerCase() === i.column!.toLowerCase()) idx = col;
        });
        if (idx > 0) {
          ws.getCell(row, idx).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ERROR_FILL } };
        }
      }
    }

    // sheet-level issues (missing columns etc.) go at the top
    const sheetLevel = list.filter((i) => i.row === null);
    if (sheetLevel.length > 0) {
      const cell = ws.getCell(1, errCol);
      cell.note = sheetLevel.map((i) => `${i.message} → ${i.fix}`).join("\n");
    }
  }

  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}
