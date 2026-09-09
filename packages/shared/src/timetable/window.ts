/**
 * §30.5 — how a timetable's validity window is written, in one place.
 *
 * Shared because the server puts it in refusal messages and the client puts it
 * on eighteen screens, and two formatters would eventually disagree about the
 * one thing this feature exists to make legible.
 *
 * **A window that is null at both ends is NOT rendered as a date range.** It
 * means "the whole session", which is every school that has never used this
 * feature — and printing dates for them would put a number on every screen that
 * means nothing and invites a question nobody can answer.
 */
export interface DateWindow {
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-04-01" → "1 Apr 2026". Takes the date string as given: these are DATE
 *  columns, so parsing them into a Date only risks a timezone shifting the day. */
export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/**
 * The line a screen shows: null when the timetable runs for the whole session,
 * so callers fall back to the session's own name rather than printing a range.
 */
export function windowLabel(w: DateWindow): string | null {
  const from = shortDate(w.effectiveFrom);
  const to = shortDate(w.effectiveTo);
  if (!from && !to) return null;
  if (from && to) return `${from} – ${to}`;
  return from ? `from ${from}` : `until ${to}`;
}

/** Is `on` (an ISO date) inside the window? Unbounded ends include everything. */
export function windowCovers(w: DateWindow, on: string): boolean {
  if (w.effectiveFrom && on < w.effectiveFrom) return false;
  if (w.effectiveTo && on > w.effectiveTo) return false;
  return true;
}
