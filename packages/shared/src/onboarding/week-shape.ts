/**
 * §34 — a weekday may have a shape of its own.
 *
 * Schools run a short Saturday. Six periods of thirty minutes where the rest of
 * the week has eight of forty is not an exception to be worked around; it is
 * what the day is, and until now the model could not say it: `periods_per_day`,
 * `period_duration_mins` and `start_time` all belonged to the
 * `timetable_config` and therefore to every working day at once.
 *
 * ## Why this is safe where §28.5 is not
 *
 * §28.5 refuses two period *lengths* inside one day, because `uq_teacher_slot`
 * compares period NUMBERS: on a 30-minute grid and a 40-minute one, Class 9 P3
 * and Class 11 P2 overlap in wall clock while the database sees 3 against 2 and
 * accepts it. The guard inverts.
 *
 * **`day_of_week` is already part of that unique key.** Saturday's period 3 and
 * Monday's period 3 are different cells today, and nobody can be in two days at
 * once, so a different shape per day creates no collision the index cannot see.
 * The constraint §28.5 protects is *within* a day, and this never crosses one.
 *
 * ## What a day shape does and does not change
 *
 * `periodsPerDay` is a **solver** fact: it is the count of cells that exist on
 * that day, so a short Saturday must prune periods 7 and 8 from every domain
 * and must not be counted as capacity by the Feasibility Engine.
 *
 * `periodDurationMins` is **not** a solver fact. The solver places into period
 * numbers; a duration only decides what is printed against them. It is here
 * because a short day is usually short in both senses, and a school that says
 * "half day" means both.
 *
 * ## The rule these functions exist to hold
 *
 * "Periods a week" stopped being `periodsPerDay × days` the moment one day
 * could differ, and that product appears in Check 1, in three branches of the
 * teacher-capacity arithmetic, in the guided setup's ceiling and on screen. Six
 * places multiplying is six places to forget; `weekPeriods` is the sum, and it
 * is the only one.
 */

/** One weekday that differs from the rest of the week. */
export interface DayShape {
  /** ISO day number, 1 = Monday. */
  day: number;
  periodsPerDay: number;
  periodDurationMins: number;
}

/** Just enough of a config to answer "how long is this day?". */
export interface WeekShapeConfig {
  periodsPerDay: number;
  periodDurationMins?: number;
  /** Days that differ. Absent or empty means every day is the same. */
  dayShapes?: DayShape[] | null;
}

const shapeFor = (cfg: WeekShapeConfig, day: number): DayShape | undefined =>
  (cfg.dayShapes ?? []).find((d) => d.day === day);

/**
 * How many teaching periods this day has.
 *
 * Falls back to the config's own count, which is every day of every school that
 * has not said otherwise — "not stated" is the whole week's shape (invariant 7),
 * never zero. A day with a stated shape of 0 periods would be a day the school
 * does not work, and that is what `workingDays` is for.
 */
export function periodsOn(cfg: WeekShapeConfig, day: number): number {
  const own = shapeFor(cfg, day)?.periodsPerDay;
  return Math.max(1, Math.floor(own && own > 0 ? own : cfg.periodsPerDay));
}

/** How long one period is on this day. */
export function durationOn(cfg: WeekShapeConfig, day: number): number {
  const own = shapeFor(cfg, day)?.periodDurationMins;
  return Math.max(1, Math.floor(own && own > 0 ? own : (cfg.periodDurationMins ?? 40)));
}

/**
 * Teaching cells in a week — the SUM over the working days, never a product.
 *
 * This is the number every later periods-per-week entry is checked against, so
 * being wrong here is not a display bug: it is a school told its curriculum
 * fits when it does not, discovered when the solver cannot place the last two
 * lessons of the week.
 */
export function weekPeriods(cfg: WeekShapeConfig, workingDays: number[]): number {
  return (workingDays ?? []).reduce((n, d) => n + periodsOn(cfg, d), 0);
}

/**
 * The longest day in the week, which is what a *per-day* cap has to be read
 * against.
 *
 * A rule like "at most 2 periods of this subject a day" is satisfiable on the
 * longest day even when a short Saturday could not hold it, so a check that
 * used the short day would refuse a school that is perfectly feasible.
 */
export function longestDay(cfg: WeekShapeConfig, workingDays: number[]): number {
  return (workingDays ?? []).reduce((n, d) => Math.max(n, periodsOn(cfg, d)), 0);
}

/**
 * What a half day defaults to: half the week's periods, rounded UP.
 *
 * Up rather than down because a school that runs eight periods and asks for a
 * half Saturday means four; one that runs seven means four rather than three —
 * the extra period is easier to remove than to discover is missing. It is a
 * starting point in a field somebody can change, never a rule.
 */
export function halfDayPeriods(periodsPerDay: number): number {
  return Math.max(1, Math.ceil(Math.max(1, Math.floor(periodsPerDay || 1)) / 2));
}
