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
  /**
   * §28.6 — minutes of changeover between one period and the next.
   *
   * A school that wants five minutes for children and teachers to move rooms
   * writes it here rather than padding every period's duration, which is the
   * workaround it replaces: a 30-minute lesson taught in a 35-minute slot is a
   * lie told to the curriculum, to the load arithmetic and to the wall.
   *
   * **Not applied where a break already follows.** A break IS the changeover —
   * adding five minutes in front of a twenty-minute lunch buys nothing and
   * moves the whole afternoon — and not after the last period either, where
   * there is nothing to change over to.
   */
  periodGapMins?: number;
  extraPeriodsPerDay?: number;
  extraPeriodDurationMins?: number | null;
  /** Minutes between the last regular period and the first extra one. */
  extraGapMins?: number;
  /**
   * §28.3/28.4 — assembly, attendance, dispersal. Bands at either end of the
   * day, each with a duration and (elsewhere) a teacher on duty.
   *
   * They sit OUTSIDE `1..periodsPerDay`, which is the whole reason the solver
   * needs no new rule: `domainFor` cannot reach a period with no number, just
   * as it cannot reach the §18 extra window.
   */
  activities?: ActivitySpec[];
}

export interface ActivitySpec {
  /** Only needed so the emitted row can point back at the row that made it. */
  id?: number;
  name: string;
  placement: "before_first" | "after_last";
  durationMins: number;
  sortOrder?: number;
}

export interface PeriodRow {
  sortOrder: number;
  periodNumber: number | null;
  startTime: string;
  endTime: string;
  isBreak: boolean;
  /** §18: part of the extra-class window rather than the teaching day. */
  isExtra: boolean;
  /** §28.3: an assembly or a dispersal — a staffed band, not a break. */
  isActivity: boolean;
  activityId: number | null;
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
  if (spec.periodGapMins !== undefined && (spec.periodGapMins < 0 || spec.periodGapMins > 30)) {
    throw new Error("periodGapMins must be between 0 and 30");
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

  const activities = (spec.activities ?? []).slice().sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name),
  );
  for (const a of activities) {
    if (a.durationMins < 1 || a.durationMins > 120) {
      throw new Error(`${a.name} must be between 1 and 120 minutes`);
    }
  }

  /**
   * §28.3 — anything that happens before the first period.
   *
   * It runs BEFORE `startTime` rather than pushing period 1 later, and that is
   * the decision in this function.
   *
   * `startTime` is the time a school says its day starts, and every screen,
   * every printed timetable and every parent means "when does teaching begin"
   * by it. Laying an assembly on top of it would move period 1 to 08:20 the
   * moment somebody recorded a fact that was already true — the assembly was
   * always happening, nobody had written it down — and every published time on
   * the wall would silently be twenty minutes late.
   *
   * So the day grows EARLIER at the front. `endTime` is untouched.
   */
  const before = activities.filter((a) => a.placement === "before_first");
  let clockBefore = clock - before.reduce((n, a) => n + a.durationMins, 0);
  for (const a of before) {
    rows.push({
      sortOrder: sortOrder++,
      // No period number, which is what takes it out of the solver's reach —
      // the same device breaks and the §18 window already use.
      periodNumber: null,
      startTime: toHHMM(clockBefore),
      endTime: toHHMM(clockBefore + a.durationMins),
      isBreak: false,
      isExtra: false,
      isActivity: true,
      activityId: a.id ?? null,
      breakName: a.name,
    });
    clockBefore += a.durationMins;
  }

  if (spec.hasZeroPeriod) {
    const dur = spec.zeroPeriodDurationMins ?? spec.periodDurationMins;
    rows.push({
      sortOrder: sortOrder++,
      periodNumber: 0,
      startTime: toHHMM(clock),
      endTime: toHHMM(clock + dur),
      isBreak: false,
      isExtra: false,
      isActivity: false,
      activityId: null,
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
      isActivity: false,
      activityId: null,
      breakName: null,
    });
    clock += spec.periodDurationMins;
    const brk = breaksAfter.get(p);
    /*
      §28.6 — the changeover, and the two places it does NOT go.

      Not before a break, because a break already is one; and not after the
      last period, where there is nothing to change over to and the only effect
      would be to tell the school it closes five minutes later than it does.

      It is added to the CLOCK and to no row: nothing occupies it, so no grid
      has a cell to draw and the solver — which places into period numbers — is
      untouched. That is the same device §28.3 activities and the §18 window
      use, and it is why this costs the rest of the system nothing.
    */
    const gap = spec.periodGapMins ?? 0;
    if (gap > 0 && !brk && p < spec.periodsPerDay) clock += gap;
    if (brk) {
      rows.push({
        sortOrder: sortOrder++,
        periodNumber: null,
        startTime: toHHMM(clock),
        endTime: toHHMM(clock + brk.durationMins),
        isBreak: true,
        isExtra: false,
        isActivity: false,
        activityId: null,
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
        isActivity: false,
        activityId: null,
        breakName: null,
      });
      clock += dur;
    }
  }

  const extraEndTime = extraCount > 0 ? toHHMM(clock) : null;

  /**
   * §28.4 — after the last period.
   *
   * After the §18 extra window as well, not just after the teaching day: a
   * dispersal is the last thing that happens, and a school running revision
   * classes disperses after those. Putting it before them would print a bus
   * departure in the middle of a lesson.
   */
  for (const a of activities.filter((x) => x.placement === "after_last")) {
    rows.push({
      sortOrder: sortOrder++,
      periodNumber: null,
      startTime: toHHMM(clock),
      endTime: toHHMM(clock + a.durationMins),
      isBreak: false,
      isExtra: false,
      isActivity: true,
      activityId: a.id ?? null,
      breakName: a.name,
    });
    clock += a.durationMins;
  }

  // `endTime` stays the end of the *teaching* day: it is what the school day
  // is, and what the Setup screen shows. The extra window and the §28.4
  // activities are opt-in and sit after it.
  return { rows, endTime: endOfDay, extraEndTime };
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
  // `isActivity` matters as much as `isExtra` here, and for a sharper reason:
  // an activity row is not a break, so without this filter the run counter
  // would count an assembly as a TEACHING period — telling the solver the day
  // has a longer unbroken run than it does, and letting a double period be
  // placed across a boundary that does not exist.
  for (const r of rows.filter((x) => x.periodNumber !== 0 && !x.isExtra && !x.isActivity)) {
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
    .filter((r) => r.periodNumber !== 0 && !r.isExtra && !r.isActivity)
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

/**
 * The breaks a stored period grid describes.
 *
 * `PUT /:id/structure` rebuilds the rows wholesale from a spec, so anything
 * that wants to rebuild them for a different shape — §34.5's per-day clock, or
 * the controller re-saving after an activity changes — has to recover the
 * breaks that are only recorded in the rows themselves.
 *
 * Extracted so there is one definition: the controller had this inline, and a
 * second copy in `clockForDay` would have been free to disagree about which
 * rows count as a break and which period each follows.
 */
export function breaksFromRows(rows: PeriodRow[]): BreakSpec[] {
  const out: BreakSpec[] = [];
  let lastNumbered = 0;
  for (const p of rows) {
    if (p.isActivity || p.isExtra) continue;
    if (p.periodNumber !== null && p.periodNumber > 0) { lastNumbered = p.periodNumber; continue; }
    if (!p.isBreak) continue;
    out.push({
      afterPeriod: lastNumbered,
      name: p.breakName ?? "Break",
      durationMins: toMins(p.endTime) - toMins(p.startTime),
    });
  }
  return out;
}

/**
 * §34.5 — what the clock says on ONE day.
 *
 * The `periods` rows have no day column: they are the shape of a day, written
 * once per timetable. That was complete while every working day ran the same
 * shape — and §34 made it possible for one not to, which left every reader of
 * those times describing Saturday with Monday's clock.
 *
 * It is not only a printing problem. §30.7 compares two live timetables by
 * **wall clock** rather than by period number, precisely because Junior's P3
 * and Senior's P2 can start at the same minute; it keyed its clock by
 * `(config, period)`, so on a day with its own shape it was comparing the
 * wrong minutes and could both miss a real clash and invent one.
 *
 * **Built with `buildPeriodRows`, not a second algorithm.** That function is
 * what `PUT /:id/structure` uses to write the stored rows, so a day with its
 * own shape gets its times the same way every other day got theirs — which is
 * the only reason the two can be trusted to agree.
 *
 * A day with no shape of its own returns the stored rows untouched, which is
 * every day of every school that has not said otherwise: same objects, same
 * times, no arithmetic repeated.
 */
export function clockForDay(
  stored: PeriodRow[],
  spec: StructureSpec,
  shape: { periodsPerDay: number; periodDurationMins: number } | undefined,
): PeriodRow[] {
  if (!shape) return stored;
  if (shape.periodsPerDay === spec.periodsPerDay && shape.periodDurationMins === spec.periodDurationMins) {
    return stored;
  }
  try {
    return buildPeriodRows({
      ...spec,
      periodsPerDay: shape.periodsPerDay,
      periodDurationMins: shape.periodDurationMins,
      /*
        A break is kept only while the day still reaches the period it follows.
        A lunch after period 6 on a four-period Saturday is not a late lunch,
        it is a break at the end of the day — and `buildPeriodRows` would emit
        it as one, which is worse than dropping it because it prints a lunch
        nobody takes.
      */
      breaks: (spec.breaks ?? []).filter((b) => b.afterPeriod < shape.periodsPerDay),
    }).rows;
  } catch {
    // A shape the builder refuses (out of its own bounds) falls back to the
    // stored rows rather than throwing: a wrong clock on one day is a smaller
    // failure than a report that will not render at all.
    return stored;
  }
}
