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
}

export interface PeriodRow {
  sortOrder: number;
  periodNumber: number | null;
  startTime: string;
  endTime: string;
  isBreak: boolean;
  breakName: string | null;
}

const toMins = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const toHHMM = (mins: number) =>
  `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

export function buildPeriodRows(spec: StructureSpec): { rows: PeriodRow[]; endTime: string } {
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
        breakName: brk.name,
      });
      clock += brk.durationMins;
    }
  }

  return { rows, endTime: toHHMM(clock) };
}

/** Contiguous teaching-run lengths between breaks (zero period excluded) — feeds §4.8. */
export function daySegmentsFromRows(rows: PeriodRow[]): number[] {
  const segments: number[] = [];
  let run = 0;
  for (const r of rows.filter((x) => x.periodNumber !== 0)) {
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
