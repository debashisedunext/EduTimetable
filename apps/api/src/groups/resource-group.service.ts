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
