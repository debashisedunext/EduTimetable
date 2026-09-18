/**
 * §29.8b — masters may grow, never shrink out from under a live week.
 *
 * *"Only masters can be change for new timetable but no deletion of master
 * which are used in generated timetable."*
 *
 * ## Why the database cannot do this
 *
 * §23 already recorded the fact and it is the whole reason this file exists:
 * **`timetable_slots` has no foreign keys to the masters.** Deleting a teacher
 * is therefore invisible to MySQL, and what it leaves is a published week
 * pointing at an id that no longer names anybody — a wall chart the app can
 * still draw and no longer explain. That is also why `sync/dependencies.ts`
 * hand-writes the ERP cascade rather than leaning on `ON DELETE`.
 *
 * ## What "live" means, and what it deliberately excludes
 *
 * A row is protected when it is referenced by `timetable_slots` belonging to a
 * config with an **un-withdrawn publication**. Two exclusions, both deliberate:
 *
 * - **Drafts are not protected.** The next Generate rewrites drafts wholesale,
 *   so refusing there would leave a school unable to tidy master data it is
 *   still editing — which is most of the time it spends in this product.
 * - **§18 extras are not protected.** Next week's revision class is not the
 *   week on the wall, and a school whose only published rows are extras has not
 *   published a timetable (§29.6 makes the same exclusion for the same reason).
 *
 * ## An entity unlock does not open this
 *
 * The refusal is not about authority, it is about the rows. Deleting a teacher
 * removes them from every class at once, which is the opposite of a scoped
 * change — and once their lessons have been moved to somebody else the same
 * delete succeeds with no unlock at all. The way out is §29.3, not a grant.
 *
 * ## Count and refuse in one object
 *
 * §27.11's rule, turned around: there the count and the delete are declared
 * together so a confirmation cannot under-report; here the count and the
 * refusal are, so the message cannot claim less than it is protecting.
 */
import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/** What is holding a master row, in the words the refusal prints. */
export interface InUse {
  /** Published, non-extra lessons referencing the row. */
  lessons: number;
  /** The timetables they sit in, named. */
  timetables: string[];
  /** Up to a few class-sections, so the message can point somewhere. */
  where: string[];
}

@Injectable()
export class InUseService {
  constructor(private readonly prisma: PrismaService) {}

  /** Configs with a publication that has not been withdrawn. */
  private async liveConfigIds(): Promise<number[]> {
    const rows = await this.prisma.timetablePublication.findMany({
      where: { withdrawnAt: null },
      select: { timetableConfigId: true },
      distinct: ["timetableConfigId"],
    });
    return rows.map((r) => r.timetableConfigId);
  }

  /**
   * Is this master row in a live week, and where?
   *
   * `slotWhere` is the one field that differs per master — `{ teacherId: 7 }`,
   * `{ roomId: 3 }`, `{ classSectionId: { in: [...] } }` — so there is one
   * query here rather than five that could drift.
   */
  async check(slotWhere: Record<string, unknown>): Promise<InUse | null> {
    const configIds = await this.liveConfigIds();
    if (configIds.length === 0) return null;

    const rows = await this.prisma.timetableSlot.findMany({
      where: {
        timetableConfigId: { in: configIds },
        status: "published",
        source: { not: "extra" },
        ...slotWhere,
      },
      select: {
        timetableConfigId: true,
        classSectionId: true,
      },
      // A published week is thousands of rows and the message names three of
      // them. Capped rather than counted exactly, and the count below says
      // "at least" when it hits the cap — see `describe`.
      take: 2000,
    });
    if (rows.length === 0) return null;

    const configNames = await this.prisma.timetableConfig.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.timetableConfigId))] } },
      select: { name: true },
      orderBy: { name: "asc" },
    });
    const sectionIds = [
      ...new Set(rows.map((r) => r.classSectionId).filter((x): x is number => x !== null)),
    ].slice(0, 4);
    const sections = await this.prisma.classSection.findMany({
      where: { id: { in: sectionIds } },
      select: { class: { select: { name: true } }, section: { select: { name: true } } },
    });

    return {
      lessons: rows.length,
      timetables: configNames.map((c) => c.name),
      where: sections.map((s) => `${s.class.name}-${s.section.name}`),
    };
  }

  /**
   * Refuse, naming the count and where to look.
   *
   * `what` is the thing being deleted as the school would say it — "Ajay
   * Verma", "Physics", "Lab 2" — because a refusal that says "this row" makes
   * somebody check which row they clicked.
   */
  async assertNotInUse(what: string, slotWhere: Record<string, unknown>): Promise<void> {
    const use = await this.check(slotWhere);
    if (!use) return;
    const where =
      use.where.length > 0
        ? ` (${use.where.join(", ")}${use.lessons > use.where.length ? " and others" : ""})`
        : "";
    throw new BadRequestException(
      `${what} is used by ${use.lessons} published lesson${use.lessons === 1 ? "" : "s"} in ` +
        `${use.timetables.join(", ")}${where}, so it cannot be deleted. ` +
        `Move those lessons first — deleting it would leave the printed timetable naming ` +
        `something that no longer exists.`,
    );
  }

  /** The sections of a class, for the two masters that reach slots through one. */
  async sectionIdsOfClass(classId: number): Promise<number[]> {
    const rows = await this.prisma.classSection.findMany({
      where: { classId },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
