/**
 * §30 — the one place a row is told which resource pool it belongs to.
 *
 * Two columns carry the pool: `timetable_config.resource_group_id` and
 * `class_sections.resource_group_id`. They are not independent facts — a
 * cohort row belongs to the pool of the timetable that teaches it — but MySQL
 * cannot express that, because a generated column may only read its own row and
 * this value lives in another table. §22's `draft_scope` had the luxury of being
 * computed by the database; this one does not.
 *
 * So it is maintained by code, and this is the code. One resolver, injected
 * everywhere a config or a class-section is created, for the reason
 * `FreezeService` is: **the failure mode is a new write path that never asks**,
 * and a value written in six places will eventually be written differently in
 * one of them. `pnpm test:groups` asserts the two columns never disagree.
 *
 * The rule it implements, stated once:
 *
 *   - a class-section attached to a timetable takes THAT timetable's pool;
 *   - an unattached one takes its session's default pool — it is available to
 *     the pool, not to the school, which is what makes "not attached yet" mean
 *     something narrower than it used to.
 */
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";


/** Where a timetable is being moved to. */
export type MoveTarget =
  | { mode: "individual" }
  | { mode: "grouped"; resourceGroupId?: number };

export interface MovePlan {
  from: { id: number; name: string; mode: string };
  /** Null when the destination does not exist yet — an individual pool is made on apply. */
  to: { id: number; name: string; mode: string } | null;
  /** How many cohort rows travel with the timetable. Declared beside the write. */
  classSections: number;
  /** Cohort rows the destination already holds, by name. Non-empty means refused. */
  collisions: string[];
  /**
   * §21 — what CHANGES about the calculation, not a predicted score.
   *
   * The teachers whose weekly load is summed with a different set of timetables
   * after the move, with the exact before/after numbers. A predicted Readiness
   * score would mean simulating the whole engine against a pool that does not
   * exist yet; these numbers are the ones Check 2 will actually use, so they
   * are checkable rather than a guess that could be wrong in either direction.
   */
  loadChanges: Array<{ teacher: string; before: number; after: number; cap: number; over: boolean }>;
  blocked: boolean;
  /** Present when blocked — the sentence to show, already written. */
  reason?: string;
}

/** What the migration named the pool every existing school was folded into. */
export const DEFAULT_GROUP_NAME = "Main";

@Injectable()
export class ResourceGroupService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The session's shared pool, created if this session has none.
   *
   * Create-if-missing rather than a separate "make a pool" step when a session
   * is created: an academic year that somehow reached the database without one
   * would otherwise refuse every timetable and every class-section with a
   * foreign-key error naming a column nobody has heard of. The migration gave
   * every existing session a pool; this is what keeps that true for sessions
   * created afterwards, from any of the three doors that create one (the
   * masters screen, the §16 importer, the guided setup).
   */
  async defaultFor(academicYearId: number): Promise<number> {
    const found = await this.prisma.timetableGroup.findFirst({
      where: { academicYearId, mode: "grouped" },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    if (found) return found.id;

    const year = await this.prisma.academicYear.findUnique({
      where: { id: academicYearId },
      select: { id: true, schoolId: true },
    });
    if (!year) throw new NotFoundException(`Academic year ${academicYearId} not found`);
    const made = await this.prisma.timetableGroup.create({
      data: {
        schoolId: year.schoolId,
        academicYearId: year.id,
        name: DEFAULT_GROUP_NAME,
        mode: "grouped",
      },
      select: { id: true },
    });
    return made.id;
  }

  /**
   * §30.1 — a pool of one, for a timetable that stands alone.
   *
   * Named after the timetable, because that is what a school will look for when
   * one turns up in a list; suffixed on collision rather than refused, since a
   * pool's name is a label and a timetable's is the real identity.
   */
  async createIndividual(academicYearId: number, timetableName: string): Promise<number> {
    const year = await this.prisma.academicYear.findUnique({
      where: { id: academicYearId },
      select: { id: true, schoolId: true },
    });
    if (!year) throw new NotFoundException(`Academic year ${academicYearId} not found`);
    const base = timetableName.trim().slice(0, 50) || "Individual";
    for (let n = 0; n < 50; n++) {
      const name = n === 0 ? base : `${base} (${n + 1})`;
      const clash = await this.prisma.timetableGroup.findFirst({
        where: { academicYearId, name }, select: { id: true },
      });
      if (clash) continue;
      const made = await this.prisma.timetableGroup.create({
        data: { schoolId: year.schoolId, academicYearId: year.id, name, mode: "individual" },
        select: { id: true },
      });
      return made.id;
    }
    throw new BadRequestException(`Too many timetables named "${base}" — give this one a different name.`);
  }

  /**
   * May this pool take another timetable?
   *
   * **This refusal IS "an individual timetable cannot have more than one
   * wing".** Expressed as a property of the pool rather than a rule the Wings
   * step remembers, so every door that creates a timetable is covered by
   * writing it once — including the ones that do not exist yet.
   */
  async assertAdmits(resourceGroupId: number) {
    const group = await this.prisma.timetableGroup.findUnique({
      where: { id: resourceGroupId },
      select: { id: true, name: true, mode: true, configs: { select: { name: true }, take: 2 } },
    });
    if (!group || group.mode !== "individual" || group.configs.length === 0) return;
    throw new BadRequestException(
      `"${group.configs[0].name}" is an individual timetable — it stands on its own and covers one wing, ` +
        `so a second timetable cannot join it. Create a grouped timetable instead, or make another individual one.`,
    );
  }


  /**
   * §30 stage 5 — what moving this timetable to another pool would do.
   *
   * Shaped the way §3.13's config deletion is: **the count and the write are
   * declared in one object**, so a confirmation cannot under-report what it is
   * about to do. And computed on the server at apply as well as at preview
   * (§21's rule: a preview is not the list of writes) — the request names a
   * destination, never a set of rows.
   *
   * Grouped → individual is always safe: a brand-new pool has nothing to
   * collide with. It LOOSENS — fewer timetables competing for the same
   * cohorts and staff — so it is never automatic and the screen says so.
   * Individual → grouped is the direction that can refuse.
   */
  async planMove(configId: number, target: MoveTarget): Promise<MovePlan> {
    const cfg = await this.prisma.timetableConfig.findUnique({
      where: { id: configId },
      select: {
        id: true, name: true, academicYearId: true,
        resourceGroup: { select: { id: true, name: true, mode: true } },
      },
    });
    if (!cfg) throw new NotFoundException(`Timetable ${configId} not found`);
    const from = cfg.resourceGroup;

    let to: { id: number; name: string; mode: string } | null = null;
    if (target.mode === "grouped") {
      const id = target.resourceGroupId ?? (await this.defaultFor(cfg.academicYearId));
      const pool = await this.prisma.timetableGroup.findUnique({
        where: { id }, select: { id: true, name: true, mode: true, academicYearId: true },
      });
      if (!pool || pool.academicYearId !== cfg.academicYearId) {
        throw new BadRequestException("That resource group does not belong to this session.");
      }
      to = { id: pool.id, name: pool.name, mode: pool.mode };
    }
    // `to === null` means "a new individual pool", which is made on apply.

    const mine = await this.prisma.classSection.findMany({
      where: { timetableConfigId: configId },
      select: { id: true, classId: true, sectionId: true, class: { select: { name: true } }, section: { select: { name: true } } },
    });

    const collisions: string[] = [];
    if (to && to.id !== from.id) {
      const theirs = await this.prisma.classSection.findMany({
        where: { resourceGroupId: to.id, academicYearId: cfg.academicYearId },
        select: { classId: true, sectionId: true },
      });
      const held = new Set(theirs.map((r) => `${r.classId}:${r.sectionId}`));
      for (const cs of mine) {
        if (held.has(`${cs.classId}:${cs.sectionId}`)) {
          collisions.push(`${cs.class.name}-${cs.section.name}`);
        }
      }
    }

    const loadChanges = to && to.id !== from.id
      ? await this.loadDelta(configId, cfg.academicYearId, from.id, to.id)
      : [];

    const blocked = collisions.length > 0;
    return {
      from: { id: from.id, name: from.name, mode: from.mode },
      to,
      classSections: mine.length,
      collisions,
      loadChanges,
      blocked,
      reason: blocked
        ? `${to!.name} already has ${collisions.join(", ")} — a class-section belongs to one ` +
          `timetable within a group, so these would be two rows for the same children in one pool. ` +
          `Move or delete them there first, or make this an individual timetable instead.`
        : undefined,
    };
  }

  /**
   * The teachers whose weekly load is summed with a different set of timetables
   * after the move — the half of "what Readiness will say" that can be answered
   * exactly, because it is the number Check 2 itself uses.
   */
  private async loadDelta(configId: number, academicYearId: number, fromPool: number, toPool: number) {
    const mineRows = await this.prisma.teacherSubjectClassSection.findMany({
      where: { classSection: { timetableConfigId: configId } },
      select: { teacherId: true },
      distinct: ["teacherId"],
    });
    const ids = mineRows.map((r) => r.teacherId);
    if (ids.length === 0) return [];

    const sumFor = async (pool: number) => {
      const rows = await this.prisma.teacherSubjectClassSection.findMany({
        where: {
          teacherId: { in: ids },
          classSection: {
            timetableConfigId: { not: configId },
            resourceGroupId: pool,
            academicYearId,
          },
        },
        select: { teacherId: true, periodsPerWeek: true },
      });
      const by = new Map<number, number>();
      for (const r of rows) by.set(r.teacherId, (by.get(r.teacherId) ?? 0) + r.periodsPerWeek);
      return by;
    };
    const [before, after] = await Promise.all([sumFor(fromPool), sumFor(toPool)]);

    const own = await this.prisma.teacherSubjectClassSection.findMany({
      where: { teacherId: { in: ids }, classSection: { timetableConfigId: configId } },
      select: { teacherId: true, periodsPerWeek: true },
    });
    const here = new Map<number, number>();
    for (const r of own) here.set(r.teacherId, (here.get(r.teacherId) ?? 0) + r.periodsPerWeek);

    const teachers = await this.prisma.teacher.findMany({
      where: { id: { in: ids } }, select: { id: true, name: true, maxPeriodsPerWeek: true },
    });
    return teachers
      .map((t) => {
        const b = (before.get(t.id) ?? 0) + (here.get(t.id) ?? 0);
        const a = (after.get(t.id) ?? 0) + (here.get(t.id) ?? 0);
        return { teacher: t.name, before: b, after: a, cap: t.maxPeriodsPerWeek, over: a > t.maxPeriodsPerWeek };
      })
      // Only the ones that actually move, so the screen shows a short list of
      // real changes rather than every teacher in the wing.
      .filter((x) => x.before !== x.after)
      .sort((x, y) => Number(y.over) - Number(x.over) || y.after - x.after);
  }

  /**
   * Move it. The plan is recomputed here, never taken from the request.
   *
   * Both columns are written in one transaction — the config's pool and every
   * one of its cohort rows' — because they are the same fact stored twice and a
   * half-applied move is precisely the drift `pnpm test:groups` exists to catch.
   */
  async applyMove(configId: number, userId: number, target: MoveTarget): Promise<MovePlan & { movedTo: number }> {
    const plan = await this.planMove(configId, target);
    if (plan.blocked) throw new BadRequestException(plan.reason);

    const cfg = await this.prisma.timetableConfig.findUnique({
      where: { id: configId },
      select: { id: true, name: true, schoolId: true, academicYearId: true },
    });
    if (!cfg) throw new NotFoundException(`Timetable ${configId} not found`);

    const toId = plan.to?.id ?? (await this.createIndividual(cfg.academicYearId, cfg.name));
    await this.assertAdmits(toId);

    if (toId !== plan.from.id) {
      await this.prisma.$transaction([
        this.prisma.timetableConfig.update({ where: { id: configId }, data: { resourceGroupId: toId } }),
        this.prisma.classSection.updateMany({
          where: { timetableConfigId: configId }, data: { resourceGroupId: toId },
        }),
      ]);

      /*
        An emptied INDIVIDUAL pool is litter: it was named after this timetable
        and nothing can be in it again that would make the name true. Removed
        only when it holds neither a timetable nor an unattached cohort row —
        a grouped pool is the session's own and is never removed here.
      */
      const left = await this.prisma.timetableGroup.findUnique({
        where: { id: plan.from.id },
        select: { mode: true, configs: { select: { id: true }, take: 1 }, classSections: { select: { id: true }, take: 1 } },
      });
      if (left && left.mode === "individual" && left.configs.length === 0 && left.classSections.length === 0) {
        await this.prisma.timetableGroup.delete({ where: { id: plan.from.id } });
      }
    }

    /*
      Recorded, and Readiness dropped immediately.

      A pool change is allowed on a frozen or published timetable (§30 decision
      4) on the grounds that it changes what is VALIDATED and never what is
      placed. That was accepted knowing it might bite, so the deferral has to
      stay answerable: the change is written down, and the new blockers appear
      at once rather than at the next Generate, weeks later, with nobody
      remembering what changed.
    */
    await this.prisma.auditLog.create({
      data: {
        schoolId: cfg.schoolId,
        userId: userId ?? 0,
        action: "timetable.resource-group.move",
        detail: {
          timetable: cfg.name, configId,
          from: plan.from, to: toId,
          classSections: plan.classSections,
          loadChanges: plan.loadChanges,
        } as never,
      },
    });

    return { ...plan, movedTo: toId };
  }

  /**
   * The pool a timetable competes in.
   *
   * Read from the config rather than re-derived from its year, because those
   * two answers are the same only while every session has one pool — which is
   * exactly the assumption §30 exists to remove.
   */
  async forConfig(timetableConfigId: number): Promise<number> {
    const cfg = await this.prisma.timetableConfig.findUnique({
      where: { id: timetableConfigId },
      select: { resourceGroupId: true },
    });
    if (!cfg) throw new NotFoundException(`Timetable ${timetableConfigId} not found`);
    return cfg.resourceGroupId;
  }

  /**
   * The pool a class-section should be created in: its timetable's, or its
   * session's.
   *
   * Both arguments rather than a caller deciding, so the "attached takes its
   * timetable's pool" rule has one implementation. A caller that already knows
   * the config would otherwise be free to pass the year's pool by mistake, and
   * the row would land in a pool its own timetable is not in — the exact drift
   * this service exists to prevent, arrived at politely.
   */
  async forSection(academicYearId: number, timetableConfigId: number | null | undefined): Promise<number> {
    return timetableConfigId != null
      ? this.forConfig(timetableConfigId)
      : this.defaultFor(academicYearId);
  }
}
