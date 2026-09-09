/**
 * §25 Phase 26 — the arithmetic of terms, away from any database.
 *
 * A session is either **year-wise** (exactly as the app has always worked) or
 * **term-wise**: two or more named spans of dates that between them cover the
 * session. Everything in this file answers one of three questions — how a
 * session splits into N terms, whether a set of terms is legal, and which term
 * a date falls in — and none of them need a row to answer.
 *
 * Dates are handled as **plain `YYYY-MM-DD` strings**, never `Date` objects.
 * A term boundary is a calendar fact about a school, not an instant: build a
 * `Date` from "2026-10-01" in a container running UTC, render it in IST, and
 * the term starts on the 30th of September. The only arithmetic that needs a
 * real calendar is "add N months", and that is done in UTC and stringified
 * before anything else touches it.
 */

/** One term as the screens and the API pass it around. */
export interface TermSpan {
  name: string;
  /** `YYYY-MM-DD`, inclusive. */
  startDate: string;
  /** `YYYY-MM-DD`, inclusive. */
  endDate: string;
}

export interface TermIssue {
  /** Which term the problem is about, by index; -1 for the set as a whole. */
  index: number;
  message: string;
  fix: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Days since epoch — the only ordering this module needs, and it needs no time. */
function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

const toIso = (utcMs: number): string => new Date(utcMs).toISOString().slice(0, 10);

/** `2026-04-01` + 1 day. Used only to make one term start the day after the last ended. */
export function nextDay(iso: string): string {
  return toIso(dayNumber(iso) * 86_400_000 + 86_400_000);
}

/** The 1st of the month `offset` months after `YYYY-MM`. */
const firstOfMonth = (year: number, month1: number, offset: number): string =>
  toIso(Date.UTC(year, month1 - 1 + offset, 1));

/**
 * The last day of the month `offset` months after `YYYY-MM`.
 *
 * Day 0 of the following month, which is how you ask a calendar for "the last
 * one" without knowing whether it is 28, 29, 30 or 31 — so a February in a leap
 * year needs no special case, and cannot acquire one by accident later.
 */
const lastOfMonth = (year: number, month1: number, offset: number): string =>
  toIso(Date.UTC(year, month1 - 1 + offset + 1, 0));

/**
 * Split a session evenly into `count` terms.
 *
 * The requirement in the user's words: "if user select the first date as
 * 01-Apr-2026 and he selected 2 terms then automatically it will set 6 months
 * for each term". So the split is **by whole months** — 1 Apr–30 Sep and 1
 * Oct–31 Mar, which is what a school recognises, rather than 1 Apr–1 Oct and 2
 * Oct–31 Mar, which is arithmetic showing its working.
 *
 * Months are used only when they are actually meaningful: the session starts on
 * the 1st and divides evenly. Anything else — a session starting on the 15th, a
 * 40-day summer school, five terms in a twelve-month year — splits by days
 * instead. That is a deliberate narrowing rather than a limitation: "six months
 * each" has no obvious meaning for a session running 15 Apr to 14 Apr, and a
 * rule that guesses one would put a boundary somewhere nobody chose. The day
 * split still ends on the session's own last day, so nothing is lost.
 *
 * Every term is contiguous with the next: term N+1 starts the day after term N
 * ends, and the last term ends on the session's own end date, exactly. Gaps are
 * something an admin may create by editing; they are never produced here.
 */
export function splitSession(
  startDate: string,
  endDate: string,
  count: number,
  /** Existing names are kept where there are any, so a re-split does not rename "Autumn Term". */
  names: string[] = [],
): TermSpan[] {
  const n = Math.max(1, Math.min(12, Math.floor(count)));
  if (!ISO.test(startDate) || !ISO.test(endDate)) return [];
  const firstDay = dayNumber(startDate);
  const lastDay = dayNumber(endDate);
  if (lastDay < firstDay) return [];

  const nameFor = (i: number) => names[i]?.trim() || `Term ${i + 1}`;

  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em] = endDate.split("-").map(Number);
  // Whole months the session spans, counted the way a school counts them:
  // 1-Apr-2026 to 31-Mar-2027 is 12.
  const months = (ey - sy) * 12 + (em - sm) + 1;

  const spans: TermSpan[] = [];
  if (sd === 1 && endDate === lastOfMonth(ey, em, 0) && months >= n && months % n === 0) {
    const per = months / n;
    for (let i = 0; i < n; i++) {
      spans.push({
        name: nameFor(i),
        startDate: firstOfMonth(sy, sm, i * per),
        // The last term ends on the session's own end date — which this branch
        // has already established IS the end of its month, so the two agree.
        endDate: i === n - 1 ? endDate : lastOfMonth(sy, sm, (i + 1) * per - 1),
      });
    }
    return spans;
  }

  // Uneven, or shorter than a month per term: split the days instead. The last
  // term absorbs the remainder so the session's own end date is preserved.
  const totalDays = lastDay - firstDay + 1;
  const per = Math.floor(totalDays / n);
  if (per < 1) return [{ name: nameFor(0), startDate, endDate }];
  let cursor = firstDay;
  for (let i = 0; i < n; i++) {
    const end = i === n - 1 ? lastDay : cursor + per - 1;
    spans.push({
      name: nameFor(i),
      startDate: toIso(cursor * 86_400_000),
      endDate: toIso(end * 86_400_000),
    });
    cursor = end + 1;
  }
  return spans;
}

/**
 * Everything wrong with a proposed set of terms, named row by row.
 *
 * The same contract as the Feasibility Engine's: each issue names the exact row
 * and the fix, because "invalid dates" is not something anybody can act on.
 */
export function validateTerms(
  terms: TermSpan[],
  session: { startDate: string; endDate: string },
): TermIssue[] {
  const issues: TermIssue[] = [];
  if (terms.length === 0) return issues;
  if (terms.length === 1) {
    issues.push({
      index: -1,
      message: "A term-wise session needs at least two terms.",
      fix: "Add a term, or switch the session back to running as a whole year.",
    });
  }

  const seen = new Map<string, number>();
  terms.forEach((t, i) => {
    const name = t.name.trim();
    if (name === "") {
      issues.push({ index: i, message: "This term has no name.", fix: `Name it, for example "Term ${i + 1}".` });
    } else if (name.length > 30) {
      issues.push({ index: i, message: `"${name}" is longer than 30 characters.`, fix: "Shorten the name." });
    } else {
      const first = seen.get(name.toLowerCase());
      if (first !== undefined) {
        issues.push({
          index: i,
          message: `Two terms are both called "${name}".`,
          fix: `Rename this one — every dropdown in the app shows terms by name, and row ${first + 1} already has it.`,
        });
      } else {
        seen.set(name.toLowerCase(), i);
      }
    }

    if (!ISO.test(t.startDate) || !ISO.test(t.endDate)) {
      issues.push({ index: i, message: `${name || `Term ${i + 1}`} needs a start and an end date.`, fix: "Fill both dates in." });
      return;
    }
    if (dayNumber(t.endDate) < dayNumber(t.startDate)) {
      issues.push({
        index: i,
        message: `${name || `Term ${i + 1}`} ends before it starts.`,
        fix: `Set its end date after ${t.startDate}.`,
      });
    }
    if (dayNumber(t.startDate) < dayNumber(session.startDate) || dayNumber(t.endDate) > dayNumber(session.endDate)) {
      issues.push({
        index: i,
        message: `${name || `Term ${i + 1}`} falls outside the session, which runs ${session.startDate} to ${session.endDate}.`,
        fix: "Move the term inside the session, or change the session's own dates first.",
      });
    }
  });

  // Overlaps, reported against the pair in date order so the message names the
  // two rows a person is looking at rather than "some terms overlap".
  const ordered = terms
    .map((t, i) => ({ ...t, i }))
    .filter((t) => ISO.test(t.startDate) && ISO.test(t.endDate))
    .sort((a, b) => dayNumber(a.startDate) - dayNumber(b.startDate));
  for (let k = 1; k < ordered.length; k++) {
    const prev = ordered[k - 1];
    const cur = ordered[k];
    if (dayNumber(cur.startDate) <= dayNumber(prev.endDate)) {
      issues.push({
        index: cur.i,
        message: `${cur.name || `Term ${cur.i + 1}`} starts on ${cur.startDate}, but ${prev.name || `Term ${prev.i + 1}`} runs to ${prev.endDate}.`,
        fix: `Start it on ${nextDay(prev.endDate)} or later — a day cannot belong to two terms, or the timetable for that day is two timetables.`,
      });
    }
  }
  return issues;
}

/**
 * Which term a date falls in, or `null` for a date in a gap or outside them all.
 *
 * This is what makes the term selector a default rather than a chore: a teacher
 * opening their timetable in November is shown November's. `null` is a real
 * answer — the summer holidays are not in a term — and the caller decides what
 * to show then (the screens fall back to the first term).
 */
export function termForDate<T extends { startDate: string; endDate: string }>(
  terms: T[],
  date: string,
): T | null {
  if (!ISO.test(date)) return null;
  const d = dayNumber(date);
  return terms.find((t) => ISO.test(t.startDate) && ISO.test(t.endDate)
    && d >= dayNumber(t.startDate) && d <= dayNumber(t.endDate)) ?? null;
}

/** "1 Oct 2026 – 31 Mar 2027" — the label that sits beside every term-wise grid. */
export function formatSpan(term: { startDate: string; endDate: string }): string {
  const one = (iso: string) => {
    if (!ISO.test(iso)) return iso;
    const [y, m, d] = iso.split("-").map(Number);
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d} ${MONTHS[m - 1]} ${y}`;
  };
  return `${one(term.startDate)} – ${one(term.endDate)}`;
}
