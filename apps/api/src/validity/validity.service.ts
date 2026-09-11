/**
 * §30.5 — when a timetable applies, and the one rule that follows from it.
 *
 * **Two published timetables whose windows overlap may not share a class.**
 *
 * That rule is what makes individual timetables (§30.1) safe rather than a
 * hole. Pools let two timetables cover Class 1; this stops both of them being
 * live for those children at once, which is the thing a school can never be
 * allowed to do by accident.
 *
 * Three things about its shape are load-bearing:
 *
 *  - **By CLASS, not by class-section.** With pools, "Class 1-A" is a different
 *    row in each pool for the same children. Comparing rows would find no
 *    overlap at all and the rule would never fire.
 *  - **Against CURRENTLY LIVE publications only.** §3.14 keeps a withdrawn
 *    publication row and marks it, because deleting it would renumber the next
 *    publish and rewrite the school's own record. So "live" is
 *    `withdrawnAt: null`, and withdrawing genuinely frees the window — which is
 *    what makes "withdraw this one, publish that one" an ordinary Tuesday.
 *  - **Never retroactive.** A window ending does not unpublish anything.
 *    Publication is a decision (§3.14), not a lease; a timetable that went dark
 *    overnight is exactly what §29.2 refused when it made a staffing change a
 *    record rather than a mode.
 */
import { BadRequestException, Injectable } from "@nestjs/common";
import {
  findClashes, groupClashes, minutesOf,
  type FeasibilityIssue, type Occupancy,
} from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { breaksFromRows, clockForDay } from "../masters/structure.util";

const DAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Half-open at neither end: a window includes both its dates. */
export interface Window {
  from: Date | null;
  to: Date | null;
}

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Do two windows share a day? `null` is unbounded, so a window that is null at
 * both ends overlaps everything — which is why two undated timetables over the
 * same class can never both be published, and is the right default.
 */
export function windowsOverlap(a: Window, b: Window): boolean {
  if (a.to && b.from && a.to < b.from) return false;
  if (b.to && a.from && b.to < a.from) return false;
  return true;
}

/** "1 Apr 2026 – 30 Jun 2026", or null for a window that is the whole session. */
export function describeWindow(w: Window): string | null {
  if (!w.from && !w.to) return null;
  const fmt = (d: Date | null) =>
    d ? d.toISOString().slice(0, 10) : "…";
  return `${fmt(w.from)} to ${fmt(w.to)}`;
}

@Injectable()
export class ValidityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The window itself has to make sense, and has to sit inside its session.
   *
   * Checked on write rather than only at publish: a window that ends before it
   * starts is a typing mistake, and telling somebody about it two screens later
   * is the §4 "name the row and the fix" contract broken for the sake of one
   * fewer query.
   */
  async assertWindowValid(academicYearId: number, w: Window) {
    if (w.from && w.to && w.from > w.to) {
      throw new BadRequestException(
        `This timetable would end (${day(w.to)}) before it starts (${day(w.from)}).`,
      );
    }
    if (!w.from && !w.to) return;
    const year = await this.prisma.academicYear.findUnique({
      where: { id: academicYearId },
      select: { name: true, startDate: true, endDate: true },
    });
    if (!year) return;
    if ((w.from && w.from < year.startDate) || (w.to && w.to > year.endDate)) {
      throw new BadRequestException(
        `A timetable's dates must sit inside its session. ${year.name} runs ` +
          `${day(year.startDate)} to ${day(year.endDate)}, and this asks for ` +
          `${day(w.from) ?? "its start"} to ${day(w.to) ?? "its end"}.`,
      );
    }
  }

  /**
   * The configs that currently have something on the wall.
   *
   * Two queries, not a nested relation filter: `timetable_publications` carries
   * `timetable_config_id` and no Prisma relation to the config — the same shape
   * §23 records for `timetable_slots` and the masters. A `publications: { some }`
   * filter compiles as a type error rather than a wrong answer, which is the
   * lucky version of that trap.
   */
  private async liveConfigIds(): Promise<number[]> {
    const rows = await this.prisma.timetablePublication.findMany({
      where: { withdrawnAt: null },
      select: { timetableConfigId: true },
      distinct: ["timetableConfigId"],
    });
    return rows.map((r) => r.timetableConfigId);
  }

  /**
   * The classes a timetable teaches — by class, because that is what the rule
   * compares. A timetable with no class-sections yet teaches nobody and can
   * therefore never clash.
   */
  private async classesOf(configId: number): Promise<Map<number, string>> {
    const rows = await this.prisma.classSection.findMany({
      where: { timetableConfigId: configId },
      select: { classId: true, class: { select: { name: true } } },
    });
    return new Map(rows.map((r) => [r.classId, r.class.name]));
  }

  /**
   * Refuse if publishing this timetable would make two live for one class.
   *
   * Called at publish AND when a published timetable is re-dated, because
   * re-dating can create exactly the overlap publishing prevented — the same
   * two-call-sites shape §29.1's freeze needed for the same reason.
   */
  async assertPublishable(configId: number, proposed?: Window) {
    const me = await this.prisma.timetableConfig.findUnique({
      where: { id: configId },
      select: { id: true, name: true, resourceGroupId: true, academicYearId: true, effectiveFrom: true, effectiveTo: true },
    });
    if (!me) return;
    /*
      `proposed` is how re-dating asks the question BEFORE it writes. Without it
      the only way to check a new window would be to store it, ask, and roll
      back on refusal — three writes to answer a question, and a window briefly
      applied that the school was about to be told it could not have.
    */
    const window: Window = proposed ?? { from: me.effectiveFrom, to: me.effectiveTo };
    const mine = await this.classesOf(configId);
    if (mine.size === 0) return;

    /*
      §30.11 — candidates are every other LIVE timetable **in the same pool**.

      This filter used to be argued against, in this comment, on the grounds
      that two pools can hold the same class and a pool filter would exclude
      exactly the case worth catching. That was written before the product
      decided what an individual timetable IS: a timetable that shares nothing —
      no class, no room, no teacher's capacity — and is built without reference
      to any other. A rule that blocks it on account of a timetable it cannot
      see is that decision not being kept.

      `resourceGroupId` is the whole predicate, and it needs no mode check: an
      individual pool holds exactly one timetable (`assertAdmits`), so "same
      pool" is already false for an individual one against anything else. Within
      a pool the rule is untouched — two wings of the main school still cannot
      both publish Class 6 over the same dates.
    */
    const live = (await this.liveConfigIds()).filter((id) => id !== configId);
    if (live.length === 0) return;
    const others = await this.prisma.timetableConfig.findMany({
      where: {
        id: { in: live },
        academicYearId: me.academicYearId,
        resourceGroupId: me.resourceGroupId,
      },
      select: { id: true, name: true, effectiveFrom: true, effectiveTo: true },
    });

    const clashes: string[] = [];
    for (const other of others) {
      if (!windowsOverlap(window, { from: other.effectiveFrom, to: other.effectiveTo })) continue;
      const theirs = await this.classesOf(other.id);
      const shared = [...mine.entries()].filter(([id]) => theirs.has(id)).map(([, name]) => name);
      if (shared.length === 0) continue;
      const when = describeWindow({ from: other.effectiveFrom, to: other.effectiveTo });
      clashes.push(
        `${shared.join(", ")} — already live in ${other.name}` +
          (when ? ` (${when})` : " (the whole session)"),
      );
    }
    if (clashes.length === 0) return;

    const mineWhen = describeWindow(window);
    throw new BadRequestException(
      `A class can only be in one live timetable at a time, and these overlap: ${clashes.join("; ")}. ` +
        `${me.name} covers ${mineWhen ?? "the whole session"}. ` +
        `Give the two timetables different date ranges, or withdraw the other one first.`,
    );
  }

  /**
   * §30.7 — a teacher or a room engaged by two LIVE timetables at once.
   *
   * §30.5 already makes the case that matters impossible: a class cannot be in
   * two live timetables at a time. What is left is two timetables over
   * *different* classes that share staff or rooms — Primary and Senior, all
   * year, both with Mrs Rao. That is a real-world collision the app has never
   * reported, and it exists in schools' data today with nothing to do with
   * individual timetables.
   *
   * A **warning**, never a blocker, and returned rather than thrown: whether
   * two timetables genuinely run at the same time is a fact only the school
   * has. Compared by wall clock rather than by period number, because Junior's
   * P3 and Senior's P2 both start 09:14 (§28.5).
   */
  async clashesFor(configId: number): Promise<FeasibilityIssue[]> {
    const me = await this.prisma.timetableConfig.findUnique({
      where: { id: configId },
      select: {
        id: true, name: true, academicYearId: true, resourceGroupId: true,
        effectiveFrom: true, effectiveTo: true,
      },
    });
    if (!me) return [];

    /*
      Only against timetables that are LIVE, **in the same pool**, and whose
      window overlaps mine.

      §30.11 — the pool filter is the one that matters here. This is the check
      that reports a teacher or a room engaged by two timetables at the same
      wall-clock time, and an individual timetable does not check occupancy
      against anything: it is built on its own, with every asset free. Within a
      pool the warning is unchanged, which is the case it was written for —
      Primary and Senior, all year, both with Mrs Rao.

      A draft still cannot collide with anything (nobody is in a room because of
      one), and two timetables that never run together are not in conflict
      however much they share.
    */
    const live = (await this.liveConfigIds()).filter((id) => id !== configId);
    if (live.length === 0) return [];
    const others = (await this.prisma.timetableConfig.findMany({
      where: {
        id: { in: live },
        academicYearId: me.academicYearId,
        resourceGroupId: me.resourceGroupId,
      },
      select: { id: true, name: true, effectiveFrom: true, effectiveTo: true },
    })).filter((o) => windowsOverlap(
      { from: me.effectiveFrom, to: me.effectiveTo },
      { from: o.effectiveFrom, to: o.effectiveTo },
    ));
    if (others.length === 0) return [];

    const mine = await this.occupancyOf([configId]);
    if (mine.length === 0) return [];

    const issues: FeasibilityIssue[] = [];
    for (const other of others) {
      const theirs = await this.occupancyOf([other.id]);
      if (theirs.length === 0) continue;
      const groups = groupClashes(findClashes(mine, theirs));
      for (const g of groups) {
        const [kind, id] = g.key.split(":");
        const name = this.nameCache.get(g.key) ?? g.key;
        const when = g.samples
          .map((c) => `${DAY[c.a.day] ?? `day ${c.a.day}`} ${c.a.label} / ${c.b.label}`)
          .join("; ");
        issues.push({
          code: "CROSS_TIMETABLE_CLASH",
          severity: "warning",
          message:
            `${name} is in two live timetables at the same time: ${me.name} and ${other.name} ` +
            `overlap on ${g.count} period${g.count === 1 ? "" : "s"} a week. ${when}` +
            (g.count > g.samples.length ? ` (+${g.count - g.samples.length} more)` : ""),
          entity: { type: kind === "t" ? "teacher" : "room", id: Number(id), label: name },
          fix:
            `Give ${me.name} and ${other.name} date ranges that do not overlap if they run at ` +
            `different times of year, or move one of these lessons. Nothing is blocked — this is ` +
            `only a clash if both timetables really run at once.`,
          key: `CROSS_TIMETABLE_CLASH:${other.id}:${g.key}`,
        });
      }
    }
    return issues;
  }

  /** Names for the message, filled while building occupancy. */
  private nameCache = new Map<string, string>();

  /**
   * Published engagements, flattened to wall-clock minutes.
   *
   * Two things it must get right, both of them §4.9 and §4.10 one level out:
   *
   *  - **Elective option rows carry a teacher and a room and no class-section**
   *    (invariant 9). Querying by section would find none of them, and a
   *    language teacher taken by two wings would go unreported.
   *  - **A merged group is one occupancy however many sections attend** (§4.10).
   *    Its rows share a day and period, so without deduplication one clash is
   *    reported once per member section.
   */
  private async occupancyOf(configIds: number[]): Promise<Occupancy[]> {
    const slots = await this.prisma.timetableSlot.findMany({
      where: { timetableConfigId: { in: configIds }, status: "published" },
      select: {
        timetableConfigId: true, dayOfWeek: true, periodNumber: true,
        teacherId: true, roomId: true,
      },
    });
    if (slots.length === 0) return [];

    /*
      §34.5 — the clock is keyed by DAY as well as period.

      `periods` has no day column: it is the shape of a day, stored once per
      timetable. That was complete while every working day ran the same shape,
      and §34 made it possible for one not to — so a Saturday running four
      thirty-minute periods was being compared using Monday's forty-minute
      times. This check exists precisely because period NUMBERS are not
      comparable across timetables, so a wrong clock here does not degrade it,
      it inverts it: a real overlap can be missed and an imaginary one
      reported.

      Built with the same `buildPeriodRows` the stored rows were written by, so
      a shaped day and an ordinary one cannot disagree about how a clock is
      derived. A config with no day shapes pays one Map lookup and reuses the
      stored rows unchanged.
    */
    const [periods, shapes, configs] = await Promise.all([
      this.prisma.period.findMany({
        where: { timetableConfigId: { in: configIds } },
        orderBy: { sortOrder: "asc" },
      }),
      this.prisma.timetableDayShape.findMany({
        where: { timetableConfigId: { in: configIds } },
      }),
      this.prisma.timetableConfig.findMany({
        where: { id: { in: configIds } },
        select: {
          id: true, startTime: true, periodsPerDay: true, periodDurationMins: true,
          hasZeroPeriod: true, workingDays: true,
        },
      }),
    ]);

    const clock = new Map<string, { startTime: string; endTime: string }>();
    for (const cfg of configs) {
      const stored = periods
        .filter((p) => p.timetableConfigId === cfg.id)
        .map((p) => ({
          sortOrder: p.sortOrder, periodNumber: p.periodNumber,
          startTime: p.startTime, endTime: p.endTime,
          isBreak: p.isBreak, isExtra: p.isExtra, isActivity: p.isActivity,
          activityId: p.activityId, breakName: p.breakName,
        }));
      const spec = {
        startTime: cfg.startTime,
        periodsPerDay: cfg.periodsPerDay,
        periodDurationMins: cfg.periodDurationMins,
        hasZeroPeriod: cfg.hasZeroPeriod,
        breaks: breaksFromRows(stored),
      };
      for (const day of ((cfg.workingDays as number[]) ?? [])) {
        const shape = shapes.find((r) => r.timetableConfigId === cfg.id && r.dayOfWeek === day);
        for (const r of clockForDay(stored, spec, shape)) {
          if (r.isBreak || r.periodNumber === null) continue;
          clock.set(`${cfg.id}:${day}:${r.periodNumber}`, { startTime: r.startTime, endTime: r.endTime });
        }
      }
    }

    const teacherIds = [...new Set(slots.map((s) => s.teacherId).filter((x): x is number => x !== null))];
    const roomIds = [...new Set(slots.map((s) => s.roomId).filter((x): x is number => x !== null))];
    for (const t of await this.prisma.teacher.findMany({ where: { id: { in: teacherIds } }, select: { id: true, name: true } })) {
      this.nameCache.set(`t:${t.id}`, t.name);
    }
    for (const r of await this.prisma.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, name: true } })) {
      this.nameCache.set(`r:${r.id}`, r.name);
    }

    const out: Occupancy[] = [];
    const seen = new Set<string>();
    for (const s of slots) {
      const p = clock.get(`${s.timetableConfigId}:${s.dayOfWeek}:${s.periodNumber}`);
      if (!p) continue;
      const startMin = minutesOf(p.startTime);
      const endMin = minutesOf(p.endTime);
      if (startMin === null || endMin === null || endMin <= startMin) continue;
      const label = `P${s.periodNumber} ${p.startTime}–${p.endTime}`;
      for (const [kind, id] of [["t", s.teacherId], ["r", s.roomId]] as const) {
        if (id === null) continue;
        const key = `${kind}:${id}`;
        // §4.10 — one occupancy per cell, however many sections attend.
        const dedupe = `${key}|${s.dayOfWeek}|${s.timetableConfigId}|${s.periodNumber}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        out.push({ key, day: s.dayOfWeek, startMin, endMin, label });
      }
    }
    return out;
  }

  /**
   * Which timetable is live for a class on a date — §25.2's resolver shape,
   * reused rather than reinvented.
   *
   * Order: the window containing the date, else the one with no window at all
   * (the whole session), else nothing. Used from stage 4, when two timetables
   * can genuinely cover one class; until then there is only ever one candidate
   * and every caller already knows it, so nothing reads this yet. It is here
   * because the rule and its resolver are one idea, and splitting them across
   * two stages is how they come to disagree.
   */
  async currentFor(classId: number, on: Date): Promise<{ id: number; name: string } | null> {
    const liveIds = await this.liveConfigIds();
    if (liveIds.length === 0) return null;
    const live = await this.prisma.timetableConfig.findMany({
      where: { id: { in: liveIds }, classSections: { some: { classId } } },
      select: { id: true, name: true, effectiveFrom: true, effectiveTo: true },
      orderBy: { id: "asc" },
    });
    const dated = live.filter((c) => c.effectiveFrom || c.effectiveTo);
    const hit = dated.find((c) =>
      (!c.effectiveFrom || c.effectiveFrom <= on) && (!c.effectiveTo || c.effectiveTo >= on));
    if (hit) return { id: hit.id, name: hit.name };
    const undated = live.find((c) => !c.effectiveFrom && !c.effectiveTo);
    return undated ? { id: undated.id, name: undated.name } : null;
  }
}
