/**
 * §20 — minimum periods per day.
 *
 * `max_periods_per_day` has always bounded the top of a teacher's day. Nothing
 * bounded the bottom, so a light load could be smeared one period at a time
 * across the whole week and a teacher could travel in to teach a single
 * period. The rule that fixes it is deliberately **"zero or at least N"**, not
 * "at least N every day": a teacher with 8 periods in the week cannot have 3
 * on each of 5 days, and pretending otherwise would make every part-time
 * teacher an unsolvable timetable. Concentrating those 8 periods into two or
 * three proper days is exactly the thing the school wants.
 *
 * This module is the single place that turns a teacher's declared minimum into
 * the number the rest of the system uses, so the Feasibility Engine, the CSP
 * search, the CP-SAT payload and the drag-drop board cannot disagree about
 * what the rule means for a given teacher.
 */
import type { FeasibilitySnapshot, SnapshotTeacher } from "./types";

/**
 * The most periods a teacher could possibly take on one day, given *what they
 * teach* rather than what they are allowed to teach.
 *
 * This is the bound that is easy to miss and expensive to get wrong. A French
 * teacher who runs a single class's third-language block — 5 periods a week,
 * capped at one a day so a student never has two language periods in a day —
 * can never have more than **one** period on any day, whatever their personal
 * daily maximum says. Judging their minimum against `maxPeriodsPerDay` would
 * demand three, and no timetable could ever deliver it.
 *
 * Each (section, subject) pair a teacher holds contributes at most its own
 * per-day cap; a merged group and an elective block each count once, because
 * each is one lesson however many sections attend.
 */
export function teacherDailyReach(snap: FeasibilitySnapshot): Map<number, number> {
  const classOf = new Map(snap.classSections.map((cs) => [cs.id, cs.classId]));
  const capOf = new Map(
    snap.subjectRequirements.map((r) => [`${r.classId}:${r.subjectId}`, r.maxPeriodsPerDay]),
  );
  const perDay = snap.config.periodsPerDay;
  const out = new Map<number, number>();
  const add = (id: number, n: number) => out.set(id, (out.get(id) ?? 0) + n);
  const capFor = (sectionId: number | undefined, subjectId: number) =>
    capOf.get(`${classOf.get(sectionId ?? -1)}:${subjectId}`) ?? perDay;

  for (const m of snap.mappings) {
    add(m.teacherId, Math.min(capFor(m.classSectionId, m.subjectId), m.periodsPerWeek));
  }
  for (const g of snap.mergedGroups) {
    add(g.teacherId, Math.min(capFor(g.memberClassSectionIds[0], g.subjectId), g.periodsPerWeek));
  }
  for (const b of snap.electiveBlocks) {
    for (const o of b.options) add(o.teacherId, Math.min(b.maxPeriodsPerDay, b.periodsPerWeek));
  }
  return out;
}

/**
 * The most periods this teacher can take on one day: their own cap, the
 * every-other-period limit an alternate-period teacher lives under, and — when
 * known — the reach of what they actually teach (see `teacherDailyReach`).
 */
export function teacherDailyCap(t: SnapshotTeacher, periodsPerDay: number, reach?: number): number {
  const patternCap =
    t.periodPattern === "alternate_period" ? Math.floor((periodsPerDay + 1) / 2) : periodsPerDay;
  return Math.max(0, Math.min(patternCap, t.maxPeriodsPerDay, reach ?? Infinity));
}

/** The days this teacher can be scheduled at all (§4.7 pattern + weekly offs). */
export function teacherAvailableDays(t: SnapshotTeacher, workingDays: number[]): number[] {
  let days = workingDays;
  if (t.periodPattern === "alternate_day") {
    days =
      t.alternateDaySet && t.alternateDaySet.length > 0
        ? workingDays.filter((d) => t.alternateDaySet!.includes(d))
        : workingDays.filter((_, i) => i % 2 === 0); // auto-pick, same rule as the solver
  }
  const off = new Set(t.unavailableFullDays);
  return days.filter((d) => !off.has(d));
}

export interface MinDayPlan {
  /** what the teacher record asks for */
  declared: number;
  /**
   * What is actually achievable, and therefore what gets enforced: the
   * declared minimum, clipped by the teacher's own weekly load and daily cap.
   * A teacher with 2 periods in the week has an effective minimum of 2 — one
   * 2-period day, rather than two 1-period days.
   */
  effectiveMin: number;
  /** why `effectiveMin` fell short of `declared`, when it did */
  relaxedBy: "weekly-load" | "daily-cap" | null;
  /** fewest days this load can occupy, given the daily cap */
  minDays: number;
  /** most days it can occupy while every day still meets `effectiveMin` */
  maxDays: number;
  /**
   * Is there any way to split this load into days of [effectiveMin, dailyCap]
   * that fits the days available? False means no timetable can satisfy the
   * rule for this teacher — Check 10 names the row and the fix.
   */
  feasible: boolean;
}

/**
 * Work out how a teacher's week has to be shaped to honour their minimum.
 *
 * The whole rule reduces to one question: can `load` be written as a sum of
 * `k` day-totals, each between the effective minimum and the daily cap, for
 * some `k` no larger than the days available? That is possible exactly when
 * `ceil(load/cap) <= floor(load/min)` — the fewest days the cap allows must
 * not exceed the most days the minimum allows.
 */
export function minDayPlan(
  declaredMin: number,
  weeklyLoad: number,
  dailyCap: number,
  availableDays: number,
): MinDayPlan {
  const declared = Math.max(0, Math.floor(declaredMin));
  if (weeklyLoad <= 0 || declared <= 1) {
    // No load, or no minimum worth enforcing — every schedule satisfies it.
    return {
      declared,
      effectiveMin: Math.min(declared, Math.max(0, weeklyLoad)),
      relaxedBy: null,
      minDays: dailyCap > 0 ? Math.ceil(Math.max(0, weeklyLoad) / dailyCap) : 0,
      maxDays: availableDays,
      feasible: true,
    };
  }
  const cap = Math.max(1, dailyCap);
  const effectiveMin = Math.min(declared, weeklyLoad, cap);
  // Name the bound that actually binds, not merely one that is below the
  // declared value: a teacher with 2 periods a week AND a one-a-day subject
  // cap is held to 1 by the cap, and saying "only 2 periods a week" would send
  // the admin to fix the wrong number.
  const relaxedBy =
    effectiveMin === declared ? null : effectiveMin === cap && cap < weeklyLoad ? "daily-cap" : "weekly-load";
  const minDays = Math.ceil(weeklyLoad / cap);
  const maxDays = Math.floor(weeklyLoad / effectiveMin);
  return {
    declared,
    effectiveMin,
    relaxedBy,
    minDays,
    maxDays,
    feasible: minDays <= maxDays && minDays <= availableDays,
  };
}

/**
 * §21 — the largest minimum at or below `upTo` that this load can actually
 * honour, or 0 if even 1 cannot work.
 *
 * Searched rather than computed: the printed fix suggests "one less than the
 * effective minimum", which is usually right and occasionally is not — a load
 * of 7 with a cap of 4 fails at a minimum of 4 (ceil 2 > floor 1) and works at
 * 3, but a load of 5 with a cap of 3 fails at 3 *and* at 2, and only 1 is
 * feasible. A remedy that leaves the issue standing is not a remedy, so the
 * answer is looked up rather than guessed.
 */
export function largestFeasibleMin(
  weeklyLoad: number,
  dailyCap: number,
  availableDays: number,
  upTo: number,
): number {
  for (let m = Math.min(upTo, dailyCap, weeklyLoad); m >= 1; m--) {
    if (minDayPlan(m, weeklyLoad, dailyCap, availableDays).feasible) return m;
  }
  return 0;
}

/** The effective minimum for every teacher in a snapshot, keyed by id. */
export function effectiveMinByTeacher(snap: FeasibilitySnapshot): Map<number, number> {
  const loadByTeacher = teacherWeeklyLoad(snap);
  const reach = teacherDailyReach(snap);
  const { workingDays, periodsPerDay } = snap.config;
  const out = new Map<number, number>();
  for (const t of snap.teachers) {
    const load = loadByTeacher.get(t.id) ?? 0;
    const plan = minDayPlan(
      t.minPeriodsPerDay,
      load,
      teacherDailyCap(t, periodsPerDay, reach.get(t.id)),
      teacherAvailableDays(t, workingDays).length,
    );
    if (plan.feasible) {
      out.set(t.id, plan.effectiveMin);
      continue;
    }
    // An impossible minimum is reported by Check 10, never enforced: refusing
    // to place lessons would turn a data problem into a blank timetable. Fall
    // back to the best the load can actually manage — spread over the fewest
    // days the daily cap allows — so the search still concentrates the week as
    // far as the numbers let it.
    out.set(t.id, plan.minDays > 0 ? Math.min(plan.effectiveMin, Math.floor(load / plan.minDays)) : 0);
  }
  return out;
}

/**
 * The weekly teacher-periods a snapshot asks of each teacher.
 *
 * Shared by Check 2, Check 10 and the solver so a merged group is counted once
 * in all three — it is one lesson however many sections attend it.
 */
export function teacherWeeklyLoad(snap: {
  mappings: Array<{ teacherId: number; periodsPerWeek: number }>;
  mergedGroups: Array<{ teacherId: number; periodsPerWeek: number }>;
  electiveBlocks: Array<{ periodsPerWeek: number; options: Array<{ teacherId: number }> }>;
}): Map<number, number> {
  const out = new Map<number, number>();
  const add = (id: number, n: number) => out.set(id, (out.get(id) ?? 0) + n);
  for (const m of snap.mappings) add(m.teacherId, m.periodsPerWeek);
  for (const g of snap.mergedGroups) add(g.teacherId, g.periodsPerWeek);
  for (const b of snap.electiveBlocks) for (const o of b.options) add(o.teacherId, b.periodsPerWeek);
  return out;
}
