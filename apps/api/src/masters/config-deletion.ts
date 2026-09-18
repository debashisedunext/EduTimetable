/**
 * §3.13 — deleting a whole timetable, and everything that hangs off it.
 *
 * `DELETE /timetable-configs/:id` used to be one line: detach the class-sections
 * and delete the row. That is wrong for the same reason §23.7 is a whole module
 * rather than a `deleteMany` — **`timetable_slots` has no foreign key to
 * `timetable_config`.** MySQL raises nothing when the config goes, and 2,000
 * generated rows are left pointing at a timetable that no longer exists: they
 * appear on no screen, are counted by nothing, and can never be reached again.
 * `timetable_publications` is the same shape. So the cascade is written by hand.
 *
 * Three rules shape it, and each one is a decision rather than an accident:
 *
 *  1. **A dangling row is never an acceptable end state.** Everything keyed to
 *     this config goes: every draft's slots, the draft registry, the extra-class
 *     rows (§18), the periods and breaks, the auto-fix history, the publication
 *     log. Deleting slots BEFORE drafts is required, not tidiness — `draft_id`
 *     is the base column of the generated `draft_scope`, so its FK is RESTRICT
 *     and MySQL refuses to remove a draft that still has rows.
 *  2. **The school's own data is not the timetable's.** Class-sections are
 *     *detached*, never deleted, and neither are classes, subjects, teachers,
 *     rooms or the curriculum. Deleting a wing must not delete the children in
 *     it. That is the difference between removing a timetable and removing a
 *     school, and it is the line a person pressing "Delete" is expecting.
 *  3. **A published timetable is refused, by name.** A school is teaching from
 *     it; a substitution log points into its rows (`substitution_log` has no FK
 *     to `timetable_slots` either, and substitutes are only ever assigned
 *     against published slots — so refusing here is also what keeps that table
 *     from being orphaned). The refusal names the fix rather than greying a
 *     button out with no explanation.
 *
 * Every step declares its **count and its delete in one object**, the §23.7
 * rule: two separate lists are free to disagree, and the day they did, the
 * confirmation would under-report a destructive write.
 */

import { NotFoundException } from "@nestjs/common";

/** What happens to a dependent row. */
export type DeletionEffect = "deleted" | "detached";

export interface DeletionLine {
  /** the table as a person reads it, e.g. "timetable rows across all drafts" */
  label: string;
  count: number;
  effect: DeletionEffect;
}

export interface DeletionPlan {
  configId: number;
  name: string;
  academicYear: string;
  lines: DeletionLine[];
  /** non-null means the delete is refused, and this is the reason to show */
  blocked: string | null;
}

interface Step {
  label: string;
  effect: DeletionEffect;
  count(tx: any, configId: number): Promise<number>;
  remove(tx: any, configId: number): Promise<void>;
}

const step = (
  label: string,
  effect: DeletionEffect,
  count: Step["count"],
  remove: Step["remove"],
): Step => ({ label, effect, count, remove });

/**
 * In dependency order — the order they are counted is the order they run.
 *
 * Slots first (see rule 1), then the registry that owns them, then everything
 * whose FK to the config would have cascaded anyway. The cascading ones are
 * listed explicitly rather than left to MySQL because the confirmation has to
 * be able to say "and its 40 periods and breaks"; a silent cascade is a
 * destructive write nobody was shown.
 */
export const DELETION_STEPS: Step[] = [
  step(
    "timetable rows, across every draft and the published set",
    "deleted",
    (tx, id) => tx.timetableSlot.count({ where: { timetableConfigId: id } }),
    async (tx, id) => { await tx.timetableSlot.deleteMany({ where: { timetableConfigId: id } }); },
  ),
  step(
    "named drafts (§22)",
    "deleted",
    (tx, id) => tx.timetableDraft.count({ where: { timetableConfigId: id } }),
    async (tx, id) => { await tx.timetableDraft.deleteMany({ where: { timetableConfigId: id } }); },
  ),
  step(
    "extra and guest classes (§18)",
    "deleted",
    (tx, id) => tx.extraClass.count({ where: { timetableConfigId: id } }),
    async (tx, id) => { await tx.extraClass.deleteMany({ where: { timetableConfigId: id } }); },
  ),
  step(
    "periods and breaks",
    "deleted",
    (tx, id) => tx.period.count({ where: { timetableConfigId: id } }),
    async (tx, id) => { await tx.period.deleteMany({ where: { timetableConfigId: id } }); },
  ),
  // §32 — which subjects this timetable declared. Counted rather than left to
  // the FK cascade, for this file's stated reason: every step declares its
  // count and its delete in one object so the confirmation cannot under-report
  // the write.
  // §34 — the weekdays given a shape of their own. Counted rather than left to
  // the FK, for this file's stated reason.
  step(
    "weekday shapes (§34)",
    "deleted",
    (tx, id) => tx.timetableDayShape.count({ where: { timetableConfigId: id } }),
    async (tx, id) => { await tx.timetableDayShape.deleteMany({ where: { timetableConfigId: id } }); },
  ),
  // §33 — the per-class lesson lengths this timetable set. Counted rather than
  // left to the FK, for this file's stated reason: every step declares its
  // count and its delete in one object so the confirmation cannot under-report.
  step(
    "per-class lesson lengths (§33)",
    "deleted",
    (tx, id) => tx.timetableClassSpan.count({ where: { timetableConfigId: id } }),
    async (tx, id) => { await tx.timetableClassSpan.deleteMany({ where: { timetableConfigId: id } }); },
  ),
  step(
    "declared subjects (§32)",
    "deleted",
    (tx, id) => tx.timetableSubject.count({ where: { timetableConfigId: id } }),
    async (tx, id) => { await tx.timetableSubject.deleteMany({ where: { timetableConfigId: id } }); },
  ),
  step(
    "auto-resolve history (§21)",
    "deleted",
    (tx, id) => tx.autoFixRun.count({ where: { timetableConfigId: id } }),
    async (tx, id) => { await tx.autoFixRun.deleteMany({ where: { timetableConfigId: id } }); },
  ),
  step(
    "publication history",
    "deleted",
    (tx, id) => tx.timetablePublication.count({ where: { timetableConfigId: id } }),
    async (tx, id) => { await tx.timetablePublication.deleteMany({ where: { timetableConfigId: id } }); },
  ),
  /**
   * Last, and the only one that is not a deletion.
   *
   * The class-sections themselves survive with their strength, home room, class
   * teacher and curriculum intact — they simply stop belonging to a timetable,
   * which is the state a newly created section is in anyway. Attaching them to
   * another one is a screen that already exists.
   */
  step(
    "class-sections, which keep everything else and are freed for another timetable",
    "detached",
    (tx, id) => tx.classSection.count({ where: { timetableConfigId: id } }),
    async (tx, id) => {
      await tx.classSection.updateMany({
        where: { timetableConfigId: id },
        data: { timetableConfigId: null },
      });
    },
  ),
];

/**
 * What deleting this timetable would do — counted, not estimated.
 *
 * Runs against the same client the delete runs against, so the numbers shown to
 * the admin and the rows removed a moment later come from one source.
 */
export async function planDeletion(tx: any, configId: number): Promise<DeletionPlan> {
  // Another school's id is a 404, never an empty plan (§17): the scoped client
  // finds nothing, and answering "nothing would be deleted" would be a report
  // about a timetable the caller cannot see.
  const config = await tx.timetableConfig.findFirst({
    where: { id: configId },
    include: { academicYear: { select: { name: true } } },
  });
  if (!config) throw new NotFoundException("Timetable config not found");

  const lines: DeletionLine[] = [];
  for (const s of DELETION_STEPS) {
    lines.push({ label: s.label, count: await s.count(tx, configId), effect: s.effect });
  }

  const published = lines.find((l) => l.label === "publication history")?.count ?? 0;
  return {
    configId,
    name: config.name,
    academicYear: config.academicYear.name,
    lines,
    blocked: published > 0
      ? `"${config.name}" has been published ${published === 1 ? "once" : `${published} times`}, ` +
        "so a school may be teaching from it and substitutions may point at its rows. " +
        "Deleting a published timetable is not something this screen will do — " +
        "unassign its class-sections if it is no longer in use, or clone it into a new session and delete the copy."
      : null,
  };
}

/** Run every step, in the order they were counted. The caller owns the transaction. */
export async function runDeletion(tx: any, configId: number): Promise<void> {
  for (const s of DELETION_STEPS) await s.remove(tx, configId);
  await tx.timetableConfig.delete({ where: { id: configId } });
}
