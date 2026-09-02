/**
 * §23 — what a sync would change, decided in one pure function.
 *
 * The ERP hands us rows; we already hold rows. This works out which are new,
 * which differ, and — the part that matters — differ *in a field the ERP is
 * allowed to change*. A teacher whose `max_periods_per_day` differs is NOT a
 * change: that number is the timetable's, and the ERP's copy of it (if it even
 * has one) is not authoritative.
 *
 * Pure and dependency-free, like the feasibility and import engines, so every
 * ownership rule is unit-testable without a database or an ERP.
 */
import {
  ERP_OWNED,
  SYNC_KEY,
  type SyncFieldChange,
  type SyncMode,
  type SyncRowPlan,
  type SyncSheet,
  type SyncSheetPlan,
} from "./contract";

/** A row from either side, keyed by the §16 column keys. */
export type SyncRow = Record<string, unknown>;

const norm = (v: unknown): string =>
  String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** The natural key of a row, as one comparable string. */
export function keyOf(sheet: SyncSheet, row: SyncRow): string {
  return SYNC_KEY[sheet].map((k) => norm(row[k])).join("||");
}

/**
 * Are two values the same, for sync purposes?
 *
 * Deliberately forgiving about how the two systems spell things, and
 * deliberately strict about nothing else:
 *  - strings compare trimmed and case-insensitively, so "  Mathematics " from
 *    an ERP text column is not reported as a change every single night;
 *  - dates compare by calendar day, because one side stores a DATE and the
 *    other a DATETIME and midnight-vs-midnight is not a difference;
 *  - null and "" are the same absence — an ERP's empty string is not a value.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const d = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : norm(v).slice(0, 10));
    return d(a) === d(b);
  }
  if (typeof a === "boolean" || typeof b === "boolean") {
    const t = (v: unknown) => v === true || v === 1 || norm(v) === "true" || norm(v) === "yes" || norm(v) === "1";
    return t(a) === t(b);
  }
  if (typeof a === "number" || typeof b === "number") {
    const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
    const [x, y] = [n(a), n(b)];
    if (x === null || y === null) return x === y;
    return Number.isNaN(x) || Number.isNaN(y) ? norm(a) === norm(b) : x === y;
  }
  return norm(a) === norm(b);
}

/**
 * Which ERP-owned fields differ. An incoming field that is *absent* is not a
 * change: a source that does not carry `strength` must leave ours alone rather
 * than blank it, which is the difference between a partial sync and data loss.
 */
export function changedFields(sheet: SyncSheet, incoming: SyncRow, mine: SyncRow): SyncFieldChange[] {
  const out: SyncFieldChange[] = [];
  for (const field of ERP_OWNED[sheet]) {
    if (!(field in incoming) || incoming[field] === undefined) continue;
    if (sameValue(incoming[field], mine[field])) continue;
    out.push({ field, from: mine[field] ?? null, to: incoming[field] ?? null });
  }
  return out;
}

/**
 * The plan for one sheet.
 *
 * `label` is what a person reads in the preview, so it is asked for rather than
 * derived: "Class 5-A" and "EDX-1042 — Aditi Verma" come from different columns
 * and only the caller knows which.
 *
 * Both modes end with our rows saying what the ERP says (see `SyncMode`). In
 * `refresh` a row we hold that the ERP no longer returns is a **removal**, not
 * something to leave lying about: the admin asked for the ERP's list, and a
 * teacher who left it is not on it. In `replace` every row we hold is a removal
 * and every row the ERP sent is new — no matching is attempted at all, which is
 * exactly why the ids change.
 */
export function reconcileSheet(
  sheet: SyncSheet,
  incoming: SyncRow[],
  mine: SyncRow[],
  label: (row: SyncRow) => string,
  mode: SyncMode = "refresh",
): SyncSheetPlan {
  const rows: SyncRowPlan[] = [];
  const seen = new Set<string>();
  const idOf = (r: SyncRow) => (r.id === null || r.id === undefined ? null : Number(r.id));

  // A source that repeats a row is not a reason to write it twice. The first
  // wins, deterministically, because the ERP's own order is not meaningful.
  const distinct = incoming.filter((row) => {
    const key = keyOf(sheet, row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (mode === "replace") {
    for (const row of distinct) rows.push({ key: keyOf(sheet, row), label: label(row), verdict: "new", changes: [] });
    for (const row of mine) {
      rows.push({ key: keyOf(sheet, row), label: label(row), verdict: "remove", changes: [], id: idOf(row) });
    }
  } else {
    const byKey = new Map(mine.map((r) => [keyOf(sheet, r), r]));
    for (const row of distinct) {
      const key = keyOf(sheet, row);
      const existing = byKey.get(key);
      if (!existing) {
        rows.push({ key, label: label(row), verdict: "new", changes: [] });
        continue;
      }
      const changes = changedFields(sheet, row, existing);
      rows.push({
        key,
        label: label(row),
        verdict: changes.length > 0 ? "update" : "unchanged",
        changes,
        id: idOf(existing),
      });
    }
    for (const row of mine) {
      const key = keyOf(sheet, row);
      if (seen.has(key)) continue;
      rows.push({ key, label: label(row), verdict: "remove", changes: [], id: idOf(row) });
    }
  }

  const count = (v: SyncRowPlan["verdict"]) => rows.filter((r) => r.verdict === v).length;
  return {
    sheet,
    mode,
    read: distinct.length,
    create: count("new"),
    update: count("update"),
    unchanged: count("unchanged"),
    remove: count("remove"),
    rows,
  };
}

/**
 * The write payload for an update: ONLY the ERP's own fields, and only those
 * that actually differ.
 *
 * Built from the plan rather than from the incoming row, so a field the
 * ownership table does not list cannot reach the database even if the adapter
 * fetched it — the table is the gate, not a convention the writer follows.
 */
export function updatePayload(plan: SyncRowPlan): Record<string, unknown> {
  return Object.fromEntries(plan.changes.map((c) => [c.field, c.to]));
}
