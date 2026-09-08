/**
 * §27.11 — clearing the Allocation page, and everything it wrote.
 *
 * §27.10 gave the page a way back to the *suggestion*, which rebuilds the draft
 * and leaves the database alone. That is the right tool while a school is still
 * setting itself up, and it is the wrong one afterwards: the §16 importer skips
 * rows that already exist by natural key, so a mapping already committed for
 * `(subject, class-section)` keeps the teacher it was committed with however
 * many times the draft is re-proposed. Somebody who has pressed Next once and
 * wants to start the allocation over needs the rows gone.
 *
 * So this is a real deletion, and it is built the way §3.13's is:
 *
 *  - **Every step declares its count and its delete in one object**, so the
 *    confirmation can never under-report the write. That is the §23 rule, and
 *    it exists because a count and a delete written apart drift, and the drift
 *    is only ever discovered by a school that agreed to something else.
 *  - **The plan is recomputed server-side before the write**, never taken from
 *    the request. A preview held for five minutes is not what is true now, and
 *    it is never the list of writes.
 *  - **A published timetable refuses it.** Its slots name subjects and teachers
 *    that this would delete the *reasons* for: the grid on the wall would keep
 *    working while Readiness reported a school that teaches nothing. Two
 *    answers to "what is Class 5 taught?" is worse than either.
 *
 * What it deliberately does NOT touch: subjects, teachers, rooms, classes,
 * sections, the timetable's own week, and §4.9 elective blocks — those are the
 * Electives screen's, built and deleted there. The reset is scoped to what the
 * Allocation page itself can write.
 */

export interface ResetLine {
  /** the rows as a person reads them */
  label: string;
  count: number;
  effect: "deleted" | "cleared";
}

export interface ResetPlan {
  configId: number;
  name: string;
  academicYear: string;
  lines: ResetLine[];
  /** Nothing here is destructive if every count is zero. */
  total: number;
  /** Non-null means it is refused, and this is the reason to show. */
  blocked: string | null;
  /**
   * Things this will NOT remove, that somebody might expect it to.
   *
   * Named because a reset that quietly leaves elective blocks standing looks
   * like it half-worked; told in advance, it reads as a boundary.
   */
  keeps: string[];
}

interface Step {
  label: string;
  effect: ResetLine["effect"];
  count(tx: any, ids: Ids): Promise<number>;
  run(tx: any, ids: Ids): Promise<void>;
}

/** The rows this config owns, resolved once and shared by count and delete. */
interface Ids {
  configId: number;
  academicYearId: number;
  classIds: number[];
  sectionIds: number[];
}

const step = (label: string, effect: ResetLine["effect"], count: Step["count"], run: Step["run"]): Step =>
  ({ label, effect, count, run });

/**
 * In dependency order, and each one counted and removed by the same object.
 *
 * Merged groups before mappings: a merged group's members reference the same
 * class-sections, and removing the group first keeps the counts a person reads
 * in the order the writes happen.
 */
export const RESET_STEPS: Step[] = [
  step(
    "merged teaching groups (§4.10) and their member sections",
    "deleted",
    async (tx, ids) => (await mergedGroupsIn(tx, ids)).length,
    async (tx, ids) => {
      const groupIds = await mergedGroupsIn(tx, ids);
      if (groupIds.length === 0) return;
      await tx.mergedTeachingGroupMember.deleteMany({ where: { mergedGroupId: { in: groupIds } } });
      await tx.mergedTeachingGroup.deleteMany({ where: { id: { in: groupIds } } });
    },
  ),
  step(
    "subject mappings — who teaches what, in every section of this timetable",
    "deleted",
    (tx, ids) => tx.teacherSubjectClassSection.count({ where: { classSectionId: { in: ids.sectionIds } } }),
    async (tx, ids) => {
      await tx.teacherSubjectClassSection.deleteMany({ where: { classSectionId: { in: ids.sectionIds } } });
    },
  ),
  step(
    "curriculum rows — how many periods a week each subject gets",
    "deleted",
    /**
     * Scoped by CLASS **and** academic year (§3.11), never by class alone.
     *
     * `class_subjects` is keyed `(class_id, subject_id, academic_year_id)`, and
     * a class has rows in every session it has ever run. Clearing this
     * timetable's allocation must not take next year's planning with it.
     */
    (tx, ids) => tx.classSubject.count({
      where: { classId: { in: ids.classIds }, academicYearId: ids.academicYearId },
    }),
    async (tx, ids) => {
      await tx.classSubject.deleteMany({
        where: { classId: { in: ids.classIds }, academicYearId: ids.academicYearId },
      });
    },
  ),
  step(
    "class teachers — the section keeps everything else",
    "cleared",
    (tx, ids) => tx.classSection.count({
      where: { id: { in: ids.sectionIds }, classTeacherId: { not: null } },
    }),
    async (tx, ids) => {
      await tx.classSection.updateMany({
        where: { id: { in: ids.sectionIds } },
        data: { classTeacherId: null },
      });
    },
  ),
  /**
   * Last, and the reason the whole thing is worth doing.
   *
   * A draft generated from a curriculum that no longer exists is a timetable of
   * lessons the school does not teach. Leaving it would put a stale grid on the
   * Board and the Matrix beside a Readiness score of zero.
   *
   * Published sets are not here: a published timetable REFUSES this outright
   * (see `planReset`), so by the time this runs there are none.
   */
  step(
    "draft timetable rows generated from it",
    "deleted",
    (tx, ids) => tx.timetableSlot.count({
      where: { timetableConfigId: ids.configId, status: "draft" },
    }),
    async (tx, ids) => {
      await tx.timetableSlot.deleteMany({
        where: { timetableConfigId: ids.configId, status: "draft" },
      });
    },
  ),
];

/**
 * The merged groups that belong ENTIRELY to this timetable.
 *
 * `merged_teaching_groups` has no FK to a config — it is scoped through its
 * members' class-sections, and a class-section belongs to exactly one config
 * (invariant 11). So a group is this timetable's only when every member is.
 * One that straddles two wings belongs to neither alone, and deleting it while
 * clearing one would silently take teaching out of the other.
 */
async function mergedGroupsIn(tx: any, ids: Ids): Promise<number[]> {
  const mine = new Set(ids.sectionIds);
  const members = await tx.mergedTeachingGroupMember.findMany({
    where: { mergedGroupId: { in: (await tx.mergedTeachingGroupMember.findMany({
      where: { classSectionId: { in: ids.sectionIds } }, select: { mergedGroupId: true },
    })).map((m: { mergedGroupId: number }) => m.mergedGroupId) } },
    select: { mergedGroupId: true, classSectionId: true },
  });
  const byGroup = new Map<number, number[]>();
  for (const m of members) {
    if (!byGroup.has(m.mergedGroupId)) byGroup.set(m.mergedGroupId, []);
    byGroup.get(m.mergedGroupId)!.push(m.classSectionId);
  }
  return [...byGroup]
    .filter(([, sections]) => sections.every((id) => mine.has(id)))
    .map(([groupId]) => groupId);
}

async function idsFor(tx: any, configId: number): Promise<Ids | null> {
  const config = await tx.timetableConfig.findFirst({ where: { id: configId } });
  if (!config) return null;
  const sections = await tx.classSection.findMany({
    where: { timetableConfigId: configId },
    select: { id: true, classId: true },
  });
  return {
    configId,
    academicYearId: config.academicYearId,
    classIds: [...new Set(sections.map((s: { classId: number }) => s.classId))] as number[],
    sectionIds: sections.map((s: { id: number }) => s.id) as number[],
  };
}

/** What clearing this timetable's allocation would do — counted, not estimated. */
export async function planReset(tx: any, configId: number): Promise<ResetPlan | null> {
  const ids = await idsFor(tx, configId);
  if (!ids) return null;
  const config = await tx.timetableConfig.findFirst({
    where: { id: configId },
    include: { academicYear: true },
  });

  const lines: ResetLine[] = [];
  for (const s of RESET_STEPS) {
    lines.push({ label: s.label, count: await s.count(tx, ids), effect: s.effect });
  }

  const published = await tx.timetableSlot.count({
    where: { timetableConfigId: configId, status: "published" },
  });
  // §4.9 blocks are scoped through their members too, for the same reason.
  const electives = new Set(
    (await tx.electiveBlockMember.findMany({
      where: { classSectionId: { in: ids.sectionIds } }, select: { electiveBlockId: true },
    })).map((m: { electiveBlockId: number }) => m.electiveBlockId),
  ).size;

  return {
    configId,
    name: config.name,
    academicYear: config.academicYear?.name ?? "",
    lines,
    total: lines.reduce((n, l) => n + l.count, 0),
    blocked: published > 0
      ? `${config.name} has a published timetable with ${published} lessons in it. ` +
        `Clearing the allocation would delete the curriculum and mappings those lessons are built on, ` +
        `leaving the timetable on the wall describing a school that teaches nothing. ` +
        `Withdraw it on the Publish screen first (§3.14) if that is really what you want.`
      : null,
    keeps: [
      "your subjects, teachers, rooms, classes and sections",
      "this timetable's week — its periods, breaks and activities",
      ...(electives > 0
        ? [`${electives} split elective block(s) (§4.9) — those are built and removed on the Electives screen`]
        : []),
    ],
  };
}

/**
 * Do it. Caller must have checked `blocked` — and does, by recomputing the plan
 * rather than trusting the one the screen showed.
 */
export async function runReset(tx: any, configId: number): Promise<void> {
  const ids = await idsFor(tx, configId);
  if (!ids) return;
  for (const s of RESET_STEPS) await s.run(tx, ids);
}
