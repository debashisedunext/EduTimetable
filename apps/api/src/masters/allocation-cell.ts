/**
 * §27.15 — "this subject is not taught in this class", as a deletion.
 *
 * The Allocation grid proposes every subject to every class, so a school with
 * Biology in its subject list met Biology in Pre-Nursery. Half of the answer is
 * the ladder in `suggest.ts`, which stops proposing it. The other half is this:
 * a way to say so about the cases the ladder will never know — a school that
 * does not teach Sanskrit in Class 6, or drops Computer Science in Class 12.
 *
 * **Why a server call at all, from a wizard that is otherwise draft-only.**
 * Clearing the cell in the draft is enough right up until the step has been
 * committed once. From then on the §16 importer skips rows that already exist
 * by natural key and never removes any, so a curriculum row that has reached
 * the database survives every re-import: the grid would show an empty cell, and
 * Readiness would go on demanding four periods of Biology a week for a class of
 * four-year-olds. An empty cell that does not mean "not taught" is worse than
 * no delete button, because it is believed.
 *
 * Built exactly like §27.11's reset, and for the same reasons:
 *
 *  - **Count and delete are declared in one object**, so the confirmation can
 *    never under-report the write.
 *  - **The plan is recomputed server-side before the write**, never taken from
 *    the request.
 *  - **A published timetable refuses it** — but narrowly. §27.11 blocks on any
 *    published slot because it deletes everything; this deletes one class's one
 *    subject, so the question is only whether the wall chart teaches THAT. If
 *    it does not, there is nothing to contradict.
 */

export interface CellLine {
  label: string;
  count: number;
}

export interface CellPlan {
  configId: number;
  className: string;
  subjectName: string;
  academicYear: string;
  lines: CellLine[];
  total: number;
  /** Non-null means it is refused, and this is the reason to show. */
  blocked: string | null;
  /** Things this will NOT remove that somebody might expect it to. */
  keeps: string[];
}

/** Resolved once and shared by every count and every delete. */
interface Ids {
  configId: number;
  academicYearId: number;
  classId: number;
  subjectId: number;
  /** The sections of THIS class that belong to THIS timetable. */
  sectionIds: number[];
}

interface Step {
  label: string;
  count(tx: any, ids: Ids): Promise<number>;
  run(tx: any, ids: Ids): Promise<void>;
}

const step = (label: string, count: Step["count"], run: Step["run"]): Step => ({ label, count, run });

/**
 * In dependency order. Merged groups first, for the reason §27.11 gives: their
 * members point at the same class-sections, and removing the group first keeps
 * the counts a person reads in the order the writes happen.
 */
export const CELL_STEPS: Step[] = [
  step(
    "merged teaching groups (§4.10) that teach it to this class",
    async (tx, ids) => (await mergedGroupIds(tx, ids)).length,
    async (tx, ids) => {
      const groupIds = await mergedGroupIds(tx, ids);
      if (groupIds.length === 0) return;
      /*
        By the PAIR, not by a row id: `merged_teaching_group_members` is keyed
        `(merged_group_id, class_section_id)` and has no `id` column at all.
        This is the set of members that teach this subject to this class.
      */
      await tx.mergedTeachingGroupMember.deleteMany({
        where: { mergedGroupId: { in: groupIds }, classSectionId: { in: ids.sectionIds } },
      });
      // A group that has lost every member is not a group. One that still has
      // members in ANOTHER class is left standing, minus this class's sections
      // — a §4.10 group may span classes, and deleting it whole would take
      // teaching out of a class nobody asked about.
      const empty = await tx.mergedTeachingGroup.findMany({
        where: { id: { in: groupIds } },
        select: { id: true, _count: { select: { members: true } } },
      });
      const gone = empty.filter((g: { _count: { members: number } }) => g._count.members === 0)
        .map((g: { id: number }) => g.id);
      if (gone.length > 0) await tx.mergedTeachingGroup.deleteMany({ where: { id: { in: gone } } });
    },
  ),
  step(
    "subject mappings — who teaches it, in every section of this class",
    (tx, ids) => tx.teacherSubjectClassSection.count({
      where: { subjectId: ids.subjectId, classSectionId: { in: ids.sectionIds } },
    }),
    async (tx, ids) => {
      await tx.teacherSubjectClassSection.deleteMany({
        where: { subjectId: ids.subjectId, classSectionId: { in: ids.sectionIds } },
      });
    },
  ),
  step(
    "the curriculum row — the periods a week this class was given",
    /**
     * Scoped by class, subject **and academic year** (§3.11).
     *
     * `class_subjects` is keyed `(class_id, subject_id, academic_year_id)` and a
     * class has rows in every session it has ever run. Saying "Pre-Nursery does
     * not take Biology" about this year must not reach into last year's record
     * of what it did take.
     */
    (tx, ids) => tx.classSubject.count({
      where: { classId: ids.classId, subjectId: ids.subjectId, academicYearId: ids.academicYearId },
    }),
    async (tx, ids) => {
      await tx.classSubject.deleteMany({
        where: { classId: ids.classId, subjectId: ids.subjectId, academicYearId: ids.academicYearId },
      });
    },
  ),
  step(
    "draft lessons already placed for it",
    /**
     * Draft slots only — a published one refuses the whole operation before it
     * gets here. A draft that teaches a subject the class no longer takes is a
     * board showing lessons with no curriculum behind them, and the next
     * Generate would not remove them either: it fills a NEW draft.
     */
    (tx, ids) => tx.timetableSlot.count({
      where: {
        timetableConfigId: ids.configId, subjectId: ids.subjectId,
        classSectionId: { in: ids.sectionIds }, status: "draft",
      },
    }),
    async (tx, ids) => {
      await tx.timetableSlot.deleteMany({
        where: {
          timetableConfigId: ids.configId, subjectId: ids.subjectId,
          classSectionId: { in: ids.sectionIds }, status: "draft",
        },
      });
    },
  ),
];

/** The merged groups (§4.10) that teach this subject to a section of this class. */
async function mergedGroupIds(tx: any, ids: Ids): Promise<number[]> {
  const members = await tx.mergedTeachingGroupMember.findMany({
    where: {
      classSectionId: { in: ids.sectionIds },
      mergedGroup: { subjectId: ids.subjectId },
    },
    select: { mergedGroupId: true },
  });
  return [...new Set(members.map((m: { mergedGroupId: number }) => m.mergedGroupId))] as number[];
}

async function idsFor(tx: any, configId: number, className: string, subjectName: string): Promise<Ids | null> {
  const config = await tx.timetableConfig.findFirst({ where: { id: configId } });
  if (!config) return null;
  const klass = await tx.schoolClass.findFirst({ where: { name: className } });
  const subject = await tx.subject.findFirst({ where: { name: subjectName } });
  if (!klass || !subject) return null;
  const sections = await tx.classSection.findMany({
    where: { timetableConfigId: configId, classId: klass.id },
    select: { id: true },
  });
  return {
    configId,
    academicYearId: config.academicYearId,
    classId: klass.id,
    subjectId: subject.id,
    sectionIds: sections.map((s: { id: number }) => s.id) as number[],
  };
}

/** What removing this subject from this class would delete — counted, not estimated. */
export async function planCellDelete(
  tx: any, configId: number, className: string, subjectName: string,
): Promise<CellPlan | null> {
  const ids = await idsFor(tx, configId, className, subjectName);
  if (!ids) return null;
  const config = await tx.timetableConfig.findFirst({
    where: { id: configId },
    include: { academicYear: true },
  });

  const lines: CellLine[] = [];
  for (const s of CELL_STEPS) lines.push({ label: s.label, count: await s.count(tx, ids) });

  const published = await tx.timetableSlot.count({
    where: {
      timetableConfigId: configId, subjectId: ids.subjectId,
      classSectionId: { in: ids.sectionIds }, status: "published",
    },
  });
  /**
   * §4.9 blocks are named, never removed — the Electives screen builds them and
   * is where they are taken apart. A block that runs this subject inside a
   * shared period is not the class's own curriculum row, and deleting one from
   * under the block would leave the block teaching a subject with no plan.
   */
  const electives = await tx.electiveOption.count({
    where: {
      subjectId: ids.subjectId,
      electiveBlock: { members: { some: { classSectionId: { in: ids.sectionIds } } } },
    },
  });

  /**
   * §36 — lessons of this subject pinned to a cell.
   *
   * Deleting the curriculum row would leave a hard constraint with nothing
   * behind it: the pin names a lesson that no longer exists, `variables.ts`
   * would build no variable for it, and Check 14 would then refuse the whole
   * school for a row nobody can find. Counted by SECTION, which is what a pin
   * is keyed by.
   */
  const pinned = await tx.timetableFixedLesson.count({
    where: { timetableConfigId: configId, subjectId: ids.subjectId, classSectionId: { in: ids.sectionIds } },
  });

  return {
    configId,
    className,
    subjectName,
    academicYear: config.academicYear?.name ?? "",
    lines,
    total: lines.reduce((n, l) => n + l.count, 0),
    blocked: published > 0
      ? `The published timetable teaches ${subjectName} to ${className} in ${published} period(s). ` +
        `Removing the subject would leave those lessons on the wall with nothing behind them. ` +
        `Withdraw it on the Publish screen (§3.14), or take those lessons off the board first.`
      : pinned > 0
        ? `${pinned} lesson(s) of ${subjectName} are fixed to a day and period for ${className}. ` +
          `Remove them on the Master Grid's Whole tab first — a fixed lesson has to belong to ` +
          `a subject the class is still taught.`
        : null,
    keeps: [
      `${subjectName} itself, and every other class that takes it`,
      ...(electives > 0
        ? [`${electives} split elective option(s) (§4.9) running ${subjectName} — those belong to the Electives screen`]
        : []),
    ],
  };
}

/** Do it. The caller checks `blocked` by recomputing the plan, never by trusting one. */
export async function runCellDelete(
  tx: any, configId: number, className: string, subjectName: string,
): Promise<void> {
  const ids = await idsFor(tx, configId, className, subjectName);
  if (!ids) return;
  for (const s of CELL_STEPS) await s.run(tx, ids);
}
