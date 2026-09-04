/**
 * §3.10: period start/end times are computed server-side from the config's
 * start time + cumulative durations, and mirrored to config.endTime. Pure
 * function so it's unit-testable without the DB.
 */

export interface BreakSpec {
  afterPeriod: number;
  name: string;
  durationMins: number;
}

export interface StructureSpec {
  startTime: string; // "HH:MM"
  periodsPerDay: number;
  periodDurationMins: number;
  hasZeroPeriod: boolean;
  zeroPeriodDurationMins?: number | null;
  breaks: BreakSpec[];
  /**
   * §18: periods appended after the teaching day, for extra and guest classes.
   * The solver places only into 1..periodsPerDay, so these are out of its
   * reach by construction — no new rule for it to remember.
   */
  extraPeriodsPerDay?: number;
  extraPeriodDurationMins?: number | null;
  /** Minutes between the last regular period and the first extra one. */
  extraGapMins?: number;
}

export interface PeriodRow {
  sortOrder: number;
  periodNumber: number | null;
  startTime: string;
  endTime: string;
  isBreak: boolean;
  /** §18: part of the extra-class window rather than the teaching day. */
  isExtra: boolean;
  breakName: string | null;
}

const toMins = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const toHHMM = (mins: number) =>
  `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

export function buildPeriodRows(spec: StructureSpec): { rows: PeriodRow[]; endTime: string; extraEndTime: string | null } {
  if (spec.periodsPerDay < 1 || spec.periodsPerDay > 12) {
    throw new Error("periodsPerDay must be between 1 and 12");
  }
  if (spec.periodDurationMins < 20 || spec.periodDurationMins > 120) {
    throw new Error("periodDurationMins must be between 20 and 120");
  }
  const breaksAfter = new Map<number, BreakSpec>();
  for (const b of spec.breaks) {
    if (b.afterPeriod < 1 || b.afterPeriod >= spec.periodsPerDay) {
      throw new Error(`Break after period ${b.afterPeriod} is outside the period range`);
    }
    if (breaksAfter.has(b.afterPeriod)) {
      throw new Error(`Two breaks configured after period ${b.afterPeriod}`);
    }
    breaksAfter.set(b.afterPeriod, b);
  }

  const rows: PeriodRow[] = [];
  let clock = toMins(spec.startTime);
  let sortOrder = 0;

  if (spec.hasZeroPeriod) {
    const dur = spec.zeroPeriodDurationMins ?? spec.periodDurationMins;
    rows.push({
      sortOrder: sortOrder++,
      periodNumber: 0,
      startTime: toHHMM(clock),
      endTime: toHHMM(clock + dur),
      isBreak: false,
      isExtra: false,
      breakName: null,
    });
    clock += dur;
  }

  for (let p = 1; p <= spec.periodsPerDay; p++) {
    rows.push({
      sortOrder: sortOrder++,
      periodNumber: p,
      startTime: toHHMM(clock),
      endTime: toHHMM(clock + spec.periodDurationMins),
      isBreak: false,
      isExtra: false,
      breakName: null,
    });
    clock += spec.periodDurationMins;
    const brk = breaksAfter.get(p);
    if (brk) {
      rows.push({
        sortOrder: sortOrder++,
        periodNumber: null,
        startTime: toHHMM(clock),
        endTime: toHHMM(clock + brk.durationMins),
        isBreak: true,
        isExtra: false,
        breakName: brk.name,
      });
      clock += brk.durationMins;
    }
  }

  // ---- §18 extra-class window ----
  // Numbered on from the teaching day so a cell reference stays unambiguous,
  // and flagged so every grid can show them apart from the day proper.
  const extraCount = spec.extraPeriodsPerDay ?? 0;
  const endOfDay = toHHMM(clock);
  if (extraCount > 0) {
    if (extraCount > 6) throw new Error("extraPeriodsPerDay must be 6 or fewer");
    clock += spec.extraGapMins ?? 10;
    const dur = spec.extraPeriodDurationMins ?? spec.periodDurationMins;
    for (let i = 1; i <= extraCount; i++) {
      rows.push({
        sortOrder: sortOrder++,
        periodNumber: spec.periodsPerDay + i,
        startTime: toHHMM(clock),
        endTime: toHHMM(clock + dur),
        isBreak: false,
        isExtra: true,
        breakName: null,
      });
      clock += dur;
    }
  }

  // `endTime` stays the end of the *teaching* day: it is what the school day
  // is, and what the Setup screen shows. The extra window is opt-in and sits
  // after it.
  return { rows, endTime: endOfDay, extraEndTime: extraCount > 0 ? toHHMM(clock) : null };
}

/**
 * Contiguous teaching-run lengths between breaks — feeds the §4.8 rule that a
 * double period may not straddle a break.
 *
 * Zero period and the §18 extra window are both excluded. The extra window
 * matters: it sits after the day with only a gap before it, so counting it
 * would silently lengthen the final run and tell the solver a block could span
 * from the last teaching period into an extra class.
 */
export function daySegmentsFromRows(rows: PeriodRow[]): number[] {
  const segments: number[] = [];
  let run = 0;
  for (const r of rows.filter((x) => x.periodNumber !== 0 && !x.isExtra)) {
    if (r.isBreak) {
      if (run > 0) segments.push(run);
      run = 0;
    } else {
      run++;
    }
  }
  if (run > 0) segments.push(run);
  return segments;
}

/**
 * §26.3 — the last teaching period before lunch, or null if the day has none.
 *
 * `daySegments` above collapses every break into a run length, which is all the
 * §4.8 block rule needs and is not enough for "before lunch": that rule needs to
 * know *which* break was lunch. Hence a second pass rather than a richer return
 * from the first — the two questions have different answers on a day with three
 * breaks, and merging them would make the common one harder to read.
 *
 * Three rules, in order, and the order is the point:
 *
 *  1. **A break named for lunch**, which is what a school actually types.
 *  2. Otherwise **the longest break**, since lunch is nearly always the long
 *     one and a 5-minute changeover is nearly never it.
 *  3. Otherwise **the break nearest the middle of the day**.
 *
 * `null` when there is no break at all, and that is a real answer rather than a
 * fallback: a day with no break has no side of lunch to be on, so the subject
 * rules that depend on it switch off instead of attaching to a guess.
 */
export function lunchAfterPeriodFromRows(rows: PeriodRow[]): number | null {
  const day = rows
    .filter((r) => r.periodNumber !== 0 && !r.isExtra)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const minutes = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 0;
  };

  // Every break, with the last teaching period that precedes it. A break before
  // any teaching period (a pre-assembly gap) has nothing before it and cannot
  // be a lunch boundary — there is no "before lunch" to speak of.
  const breaks: Array<{ after: number; length: number; named: boolean; index: number }> = [];
  let lastPeriod: number | null = null;
  let teachingSeen = 0;
  day.forEach((r) => {
    if (r.isBreak) {
      if (lastPeriod !== null) {
        breaks.push({
          after: lastPeriod,
          length: Math.max(0, minutes(r.endTime) - minutes(r.startTime)),
          named: /lunch|tiffin|recess|midday|mid-day/i.test(r.breakName ?? ""),
          index: teachingSeen,
        });
      }
    } else if (r.periodNumber !== null) {
      lastPeriod = r.periodNumber;
      teachingSeen += 1;
    }
  });
  if (breaks.length === 0) return null;

  const named = breaks.filter((b) => b.named);
  if (named.length > 0) {
    // Several named ones (a school with both "Recess" and "Lunch") — the long
    // one is lunch.
    return named.reduce((a, b) => (b.length > a.length ? b : a)).after;
  }

  const longest = breaks.reduce((a, b) => (b.length > a.length ? b : a));
  if (breaks.some((b) => b.length !== longest.length)) return longest.after;

  // All the same length: take the one closest to the middle of the teaching day.
  const middle = teachingSeen / 2;
  return breaks.reduce((a, b) =>
    Math.abs(b.index - middle) < Math.abs(a.index - middle) ? b : a,
  ).after;
}
