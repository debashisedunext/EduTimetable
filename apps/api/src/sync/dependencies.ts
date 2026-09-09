/**
 * §23.7 — what else goes when a master row goes.
 *
 * "Delete the old data and insert fresh" is one sentence and about fifteen
 * tables. This module is the whole of that arithmetic, and it exists because of
 * one fact about the schema: **`timetable_slots` has no foreign keys to the
 * masters.** Only `school_id` and `draft_id` are constrained. Delete a teacher
 * and MySQL raises nothing, says nothing, and every generated and published
 * timetable quietly becomes rows pointing at a teacher that no longer exists —
 * blank cells on the Board with no error anywhere to explain them.
 *
 * So the cascade is written by hand, and two rules shape it:
 *
 *  1. **A dangling reference is never an acceptable end state.** If a master row
 *     goes, everything pointing at it goes with it — including the slot rows the
 *     database would have let us abandon. That is why deleting teachers deletes
 *     timetable rows, and why the confirmation has to say so.
 *  2. **The sync never deletes a timetable itself.** A `timetable_config`, its
 *     periods, its draft registry and its publication history are not master
 *     data and were not what the admin pressed a button about. Where a removal
 *     would require deleting one, the sync REFUSES and names it (`blocked`).
 *
 * Every step below declares its count and its delete together, in one object.
 * Two separate lists would be free to disagree, and the day they did, the
 * confirmation dialog would under-report a destructive write — which is the one
 * failure this feature cannot have.
 */
import type { SyncSheet } from "@edutimetable/shared";

/** What happens to a dependent row. */
export type ImpactEffect = "deleted" | "cleared";

export interface ImpactLine {
  /** the table as a person reads it, e.g. "subject mappings" */
  label: string;
  count: number;
  effect: ImpactEffect;
}

export interface Impact {
  /** the master rows themselves */
  rows: number;
  lines: ImpactLine[];
  /** non-null means the sync refuses, and this is the reason to show */
  blocked: string | null;
  /** published timetables that would lose rows — the loudest number here */
  publishedSlots: number;
}

/** A dependent table: how many, and how to remove them. Declared once, together. */
interface CascadeStep {
  label: string;
  effect: ImpactEffect;
  count(tx: any, ids: number[]): Promise<number>;
  remove(tx: any, ids: number[]): Promise<void>;
}

const step = (
  label: string,
  effect: ImpactEffect,
  count: CascadeStep["count"],
  remove: CascadeStep["remove"],
): CascadeStep => ({ label, effect, count, remove });

/** Ids of the merged groups / elective blocks a set of class-sections belongs to. */
async function groupsOfSections(tx: any, sectionIds: number[]) {
  const merged = await tx.mergedTeachingGroupMember.findMany({
    where: { classSectionId: { in: sectionIds } },
    select: { mergedGroupId: true },
  });
  const elective = await tx.electiveBlockMember.findMany({
    where: { classSectionId: { in: sectionIds } },
    select: { electiveBlockId: true },
  });
  return {
    mergedIds: [...new Set(merged.map((m: any) => m.mergedGroupId as number))],
    blockIds: [...new Set(elective.map((m: any) => m.electiveBlockId as number))],
  };
}

/**
 * The steps for one master.
 *
 * Order is the delete order and it is load-bearing: children before parents, or
 * MySQL refuses. It is also the order the confirmation reads in, which happens
 * to be the order a person cares about — the timetable first.
 */
function stepsFor(sheet: SyncSheet): CascadeStep[] {
  switch (sheet) {
    // ---------------------------------------------------------------- Teachers
    case "Teachers":
      return [
        step(
          "timetable slots (draft and published)",
          "deleted",
          (tx, ids) => tx.timetableSlot.count({ where: { teacherId: { in: ids } } }),
          async (tx, ids) => { await tx.timetableSlot.deleteMany({ where: { teacherId: { in: ids } } }); },
        ),
        step(
          "substitutions they gave or received",
          "deleted",
          (tx, ids) =>
            tx.substitutionLog.count({
              where: { OR: [{ originalTeacherId: { in: ids } }, { substituteTeacherId: { in: ids } }] },
            }),
          async (tx, ids) => {
            // Neither column has a foreign key, so neither would have stopped us
            // — and a substitution naming a teacher who no longer exists is a
            // report that cannot be read.
            await tx.substitutionLog.deleteMany({
              where: { OR: [{ originalTeacherId: { in: ids } }, { substituteTeacherId: { in: ids } }] },
            });
          },
        ),
        step(
          "absence records",
          "deleted",
          (tx, ids) => tx.teacherAbsence.count({ where: { teacherId: { in: ids } } }),
          async (tx, ids) => { await tx.teacherAbsence.deleteMany({ where: { teacherId: { in: ids } } }); },
        ),
        step(
          "subject mappings",
          "deleted",
          (tx, ids) => tx.teacherSubjectClassSection.count({ where: { teacherId: { in: ids } } }),
          async (tx, ids) => { await tx.teacherSubjectClassSection.deleteMany({ where: { teacherId: { in: ids } } }); },
        ),
        step(
          "merged teaching groups they teach",
          "deleted",
          (tx, ids) => tx.mergedTeachingGroup.count({ where: { teacherId: { in: ids } } }),
          async (tx, ids) => {
            const gs = await tx.mergedTeachingGroup.findMany({ where: { teacherId: { in: ids } }, select: { id: true } });
            const gids = gs.map((g: any) => g.id as number);
            if (gids.length === 0) return;
            await tx.timetableSlot.deleteMany({ where: { mergedGroupId: { in: gids } } });
            await tx.mergedTeachingGroup.deleteMany({ where: { id: { in: gids } } });
          },
        ),
        step(
          "elective options they run",
          "deleted",
          (tx, ids) => tx.electiveOption.count({ where: { teacherId: { in: ids } } }),
          async (tx, ids) => {
            const os = await tx.electiveOption.findMany({ where: { teacherId: { in: ids } }, select: { id: true } });
            const oids = os.map((o: any) => o.id as number);
            if (oids.length === 0) return;
            await tx.timetableSlot.deleteMany({ where: { electiveOptionId: { in: oids } } });
            await tx.electiveOption.deleteMany({ where: { id: { in: oids } } });
          },
        ),
        step(
          "extra and guest classes",
          "deleted",
          (tx, ids) => tx.extraClass.count({ where: { teacherId: { in: ids } } }),
          async (tx, ids) => { await tx.extraClass.deleteMany({ where: { teacherId: { in: ids } } }); },
        ),
        step(
          "class-teacher assignments",
          "cleared",
          (tx, ids) => tx.classSection.count({ where: { classTeacherId: { in: ids } } }),
          async (tx, ids) => {
            await tx.classSection.updateMany({
              where: { classTeacherId: { in: ids } },
              data: { classTeacherId: null },
            });
          },
        ),
        step(
          "teacher logins linked to these records",
          "cleared",
          (tx, ids) => tx.user.count({ where: { teacherId: { in: ids } } }),
          async (tx, ids) => {
            // `users.teacher_id` is a plain column with no foreign key, set from
            // the SSO token. Leaving it pointing at a deleted teacher gives that
            // person somebody else's timetable the moment the id is reused.
            await tx.user.updateMany({ where: { teacherId: { in: ids } }, data: { teacherId: null } });
          },
        ),
        step(
          // §27.13 added the third: the FK cascades, so the rows go either
          // way — and a cascade nobody was shown is a destructive write
          // nobody agreed to, which is the one thing §23's contract forbids.
          "unavailability, class eligibility and declared subjects",
          "deleted",
          async (tx, ids) =>
            (await tx.teacherUnavailability.count({ where: { teacherId: { in: ids } } })) +
            (await tx.teacherClassEligibility.count({ where: { teacherId: { in: ids } } })) +
            (await tx.teacherSubject.count({ where: { teacherId: { in: ids } } })),
          async (tx, ids) => {
            await tx.teacherUnavailability.deleteMany({ where: { teacherId: { in: ids } } });
            await tx.teacherClassEligibility.deleteMany({ where: { teacherId: { in: ids } } });
            await tx.teacherSubject.deleteMany({ where: { teacherId: { in: ids } } });
          },
        ),
      ];

    // ---------------------------------------------------------------- Subjects
    case "Subjects":
      return [
        step(
          "timetable slots (draft and published)",
          "deleted",
          (tx, ids) => tx.timetableSlot.count({ where: { subjectId: { in: ids } } }),
          async (tx, ids) => { await tx.timetableSlot.deleteMany({ where: { subjectId: { in: ids } } }); },
        ),
        step(
          "curriculum rows (periods per week)",
          "deleted",
          (tx, ids) => tx.classSubject.count({ where: { subjectId: { in: ids } } }),
          async (tx, ids) => { await tx.classSubject.deleteMany({ where: { subjectId: { in: ids } } }); },
        ),
        step(
          "subject mappings",
          "deleted",
          (tx, ids) => tx.teacherSubjectClassSection.count({ where: { subjectId: { in: ids } } }),
          async (tx, ids) => { await tx.teacherSubjectClassSection.deleteMany({ where: { subjectId: { in: ids } } }); },
        ),
        /**
         * §27.13 — declared "this teacher teaches X".
         *
         * The FK cascades, so the rows would go whether or not this step
         * existed — which is exactly why it has to: a silent cascade is a
         * destructive write nobody was shown, and §23's whole contract is that
         * the confirmation cannot under-report.
         */
        step(
          "teachers' declared subjects",
          "deleted",
          (tx, ids) => tx.teacherSubject.count({ where: { subjectId: { in: ids } } }),
          async (tx, ids) => { await tx.teacherSubject.deleteMany({ where: { subjectId: { in: ids } } }); },
        ),
        // §27.16 — declared "this subject is taught to class X". Named for the
        // same reason as the row above it: the FK cascades either way, and a
        // cascade nobody was shown is exactly what §23's confirmation exists to
        // prevent.
        step(
          "subjects' declared classes",
          "deleted",
          (tx, ids) => tx.subjectClass.count({ where: { subjectId: { in: ids } } }),
          async (tx, ids) => { await tx.subjectClass.deleteMany({ where: { subjectId: { in: ids } } }); },
        ),
        step(
          "merged teaching groups",
          "deleted",
          (tx, ids) => tx.mergedTeachingGroup.count({ where: { subjectId: { in: ids } } }),
          async (tx, ids) => {
            const gs = await tx.mergedTeachingGroup.findMany({ where: { subjectId: { in: ids } }, select: { id: true } });
            const gids = gs.map((g: any) => g.id as number);
            if (gids.length === 0) return;
            await tx.timetableSlot.deleteMany({ where: { mergedGroupId: { in: gids } } });
            await tx.mergedTeachingGroup.deleteMany({ where: { id: { in: gids } } });
          },
        ),
        step(
          "elective options",
          "deleted",
          (tx, ids) => tx.electiveOption.count({ where: { subjectId: { in: ids } } }),
          async (tx, ids) => {
            const os = await tx.electiveOption.findMany({ where: { subjectId: { in: ids } }, select: { id: true } });
            const oids = os.map((o: any) => o.id as number);
            if (oids.length === 0) return;
            await tx.timetableSlot.deleteMany({ where: { electiveOptionId: { in: oids } } });
            await tx.electiveOption.deleteMany({ where: { id: { in: oids } } });
          },
        ),
        step(
          "extra and guest classes",
          "deleted",
          (tx, ids) => tx.extraClass.count({ where: { subjectId: { in: ids } } }),
          async (tx, ids) => { await tx.extraClass.deleteMany({ where: { subjectId: { in: ids } } }); },
        ),
        step(
          "lab-room subject links",
          "deleted",
          (tx, ids) => tx.roomSubject.count({ where: { subjectId: { in: ids } } }),
          async (tx, ids) => { await tx.roomSubject.deleteMany({ where: { subjectId: { in: ids } } }); },
        ),
      ];

    // ---------------------------------------------------------- Class Sections
    case "Class Sections":
      return [
        step(
          "timetable slots (draft and published)",
          "deleted",
          (tx, ids) => tx.timetableSlot.count({ where: { classSectionId: { in: ids } } }),
          async (tx, ids) => { await tx.timetableSlot.deleteMany({ where: { classSectionId: { in: ids } } }); },
        ),
        step(
          "subject mappings",
          "deleted",
          (tx, ids) => tx.teacherSubjectClassSection.count({ where: { classSectionId: { in: ids } } }),
          async (tx, ids) => { await tx.teacherSubjectClassSection.deleteMany({ where: { classSectionId: { in: ids } } }); },
        ),
        step(
          "merged groups and elective blocks the section is in",
          "deleted",
          async (tx, ids) => {
            const { mergedIds, blockIds } = await groupsOfSections(tx, ids);
            return mergedIds.length + blockIds.length;
          },
          async (tx, ids) => {
            // A merged group or an elective block IS its member set — dropping
            // one section does not shrink it, it changes what it means. The
            // whole construct goes, and the admin rebuilds it.
            const { mergedIds, blockIds } = await groupsOfSections(tx, ids);
            if (mergedIds.length > 0) {
              await tx.timetableSlot.deleteMany({ where: { mergedGroupId: { in: mergedIds } } });
              await tx.mergedTeachingGroup.deleteMany({ where: { id: { in: mergedIds } } });
            }
            if (blockIds.length > 0) {
              await tx.timetableSlot.deleteMany({ where: { electiveBlockId: { in: blockIds } } });
              await tx.electiveBlock.deleteMany({ where: { id: { in: blockIds } } });
            }
          },
        ),
        step(
          "extra and guest classes",
          "deleted",
          (tx, ids) => tx.extraClass.count({ where: { classSectionId: { in: ids } } }),
          async (tx, ids) => { await tx.extraClass.deleteMany({ where: { classSectionId: { in: ids } } }); },
        ),
      ];

    // ----------------------------------------------------------------- Classes
    //
    // The class-sections beneath these classes are handled by `subSections`
    // below, which runs the Class Sections steps over them so their slots,
    // mappings and blocks are COUNTED as well as deleted. Doing it inside a
    // single step here would delete four things and report one.
    case "Classes":
      return [
        step(
          "class-sections",
          "deleted",
          (tx, ids) => tx.classSection.count({ where: { classId: { in: ids } } }),
          async (tx, ids) => {
            await tx.classSection.deleteMany({ where: { classId: { in: ids } } });
            await tx.section.deleteMany({ where: { classId: { in: ids } } });
          },
        ),
        step(
          "curriculum rows (periods per week)",
          "deleted",
          (tx, ids) => tx.classSubject.count({ where: { classId: { in: ids } } }),
          async (tx, ids) => { await tx.classSubject.deleteMany({ where: { classId: { in: ids } } }); },
        ),
        step(
          "teacher class eligibility",
          "deleted",
          (tx, ids) => tx.teacherClassEligibility.count({ where: { classId: { in: ids } } }),
          async (tx, ids) => { await tx.teacherClassEligibility.deleteMany({ where: { classId: { in: ids } } }); },
        ),
        // §27.16 — the other end of the same table: a class going away takes
        // its name off every subject that named it.
        step(
          "subjects' declared classes",
          "deleted",
          (tx, ids) => tx.subjectClass.count({ where: { classId: { in: ids } } }),
          async (tx, ids) => { await tx.subjectClass.deleteMany({ where: { classId: { in: ids } } }); },
        ),
      ];

    // ---------------------------------------------------------- Academic Years
    case "Academic Years":
      return [
        step(
          "class-sections in these sessions",
          "deleted",
          (tx, ids) => tx.classSection.count({ where: { academicYearId: { in: ids } } }),
          async (tx, ids) => { await tx.classSection.deleteMany({ where: { academicYearId: { in: ids } } }); },
        ),
        step(
          "curriculum rows for these sessions",
          "deleted",
          (tx, ids) => tx.classSubject.count({ where: { academicYearId: { in: ids } } }),
          async (tx, ids) => { await tx.classSubject.deleteMany({ where: { academicYearId: { in: ids } } }); },
        ),
        step(
          "holidays",
          "deleted",
          (tx, ids) => tx.holiday.count({ where: { academicYearId: { in: ids } } }),
          async (tx, ids) => { await tx.holiday.deleteMany({ where: { academicYearId: { in: ids } } }); },
        ),
      ];
  }
}

/**
 * The class-sections that sit beneath the rows being removed.
 *
 * Deleting a class or a session deletes its sections, and a section carries a
 * timetable. Those consequences have to be counted at their own depth rather
 * than folded into one "class-sections" line, or the confirmation says "12
 * class-sections" for a write that also removes 2,240 timetable rows.
 */
async function subSections(tx: any, sheet: SyncSheet, ids: number[]): Promise<number[]> {
  if (sheet !== "Classes" && sheet !== "Academic Years") return [];
  const where = sheet === "Classes" ? { classId: { in: ids } } : { academicYearId: { in: ids } };
  const rows = await tx.classSection.findMany({ where, select: { id: true } });
  return rows.map((r: any) => r.id as number);
}

/**
 * Would removing these rows require deleting a timetable? Then it does not
 * happen — it is reported.
 *
 * Rule 2 at the top of this file. A `timetable_config` carries the school's
 * period structure, its breaks, its draft history and its publications. None of
 * that is master data, none of it came from the ERP, and a masters-sync button
 * is not consent to delete it.
 */
async function blockedBy(tx: any, sheet: SyncSheet, ids: number[]): Promise<string | null> {
  if (sheet !== "Academic Years" || ids.length === 0) return null;
  const configs = await tx.timetableConfig.findMany({
    where: { academicYearId: { in: ids } },
    select: { name: true },
    take: 5,
  });
  if (configs.length === 0) return null;
  const names = configs.map((c: any) => `"${c.name}"`).join(", ");
  return (
    `${configs.length === 5 ? "5 or more timetables" : `${configs.length} timetable(s)`} belong to the sessions ` +
    `being removed (${names}). A session cannot be deleted while a timetable is filed against it, and this sync ` +
    `will not delete a timetable. Delete the timetable first, or keep the session.`
  );
}

/**
 * Everything that would go, counted, before anything goes.
 *
 * This is what the confirmation dialog is built from. It runs the same step
 * objects `cascadeDelete` runs, so the number a person agrees to and the number
 * of rows actually removed come from one definition.
 */
export async function countImpact(tx: any, sheet: SyncSheet, ids: number[]): Promise<Impact> {
  const empty: Impact = { rows: ids.length, lines: [], blocked: null, publishedSlots: 0 };
  if (ids.length === 0) return empty;

  const lines: ImpactLine[] = [];
  // The depth first: what hangs off the class-sections that hang off these rows.
  const nested = await subSections(tx, sheet, ids);
  if (nested.length > 0) {
    for (const s of stepsFor("Class Sections")) {
      const count = await s.count(tx, nested);
      if (count > 0) lines.push({ label: s.label, count, effect: s.effect });
    }
  }
  for (const s of stepsFor(sheet)) {
    const count = await s.count(tx, ids);
    if (count > 0) lines.push({ label: s.label, count, effect: s.effect });
  }

  // Counted separately and reported on its own, because "some slots" and "the
  // timetable the school is running on today" are not the same warning.
  //
  // Written as a plain id list, NOT `{ classSection: { classId: ... } }` — the
  // whole premise of this file is that `timetable_slots` has no relation to the
  // masters, so there is no nested filter to traverse. Prisma rejects one
  // outright, which is at least honest.
  const slotWhere =
    sheet === "Teachers" ? { teacherId: { in: ids } }
    : sheet === "Subjects" ? { subjectId: { in: ids } }
    : sheet === "Class Sections" ? { classSectionId: { in: ids } }
    : { classSectionId: { in: nested } };
  const publishedSlots =
    sheet !== "Teachers" && sheet !== "Subjects" && sheet !== "Class Sections" && nested.length === 0
      ? 0
      : await tx.timetableSlot.count({ where: { status: "published", ...slotWhere } });

  return { rows: ids.length, lines, blocked: await blockedBy(tx, sheet, ids), publishedSlots };
}

/**
 * Remove the dependents, in order. The caller deletes the master rows after.
 *
 * Refuses rather than half-deleting when something is blocked — the whole apply
 * runs in one transaction, so a throw here leaves the school exactly as it was.
 */
export async function cascadeDelete(tx: any, sheet: SyncSheet, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const blocked = await blockedBy(tx, sheet, ids);
  if (blocked) throw new Error(blocked);
  // Same order `countImpact` counts in: nested first, then this sheet's own.
  const nested = await subSections(tx, sheet, ids);
  if (nested.length > 0) {
    for (const s of stepsFor("Class Sections")) await s.remove(tx, nested);
  }
  for (const s of stepsFor(sheet)) await s.remove(tx, ids);
}

/** One sentence for the log and the alert: "486 subject mappings, 41 absence records". */
export function describeImpact(impact: Impact): string {
  if (impact.lines.length === 0) return "nothing else refers to these rows";
  return impact.lines.map((l) => `${l.count} ${l.label}${l.effect === "cleared" ? " (cleared)" : ""}`).join(", ");
}
