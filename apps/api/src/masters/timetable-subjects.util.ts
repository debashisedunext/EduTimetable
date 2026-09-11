import type { PrismaClient } from "@prisma/client";

/**
 * §32 — which subjects a timetable teaches.
 *
 * ## Why a set-or-null and not a set
 *
 * `null` means **"not stated"**, and it is not the same as the empty set
 * (invariant 7). Every timetable that existed before this table has no rows and
 * must keep seeing every subject the school has; a school that has never opened
 * the screen has not said "this timetable teaches nothing". Returning an empty
 * `Set` for that case would narrow every existing school to zero subjects on
 * deploy — the loudest possible version of this bug, and the easiest to write.
 *
 * So every caller has exactly two branches, and the shape forces them to write
 * both: `null` → no filter at all; a set → filter by it. `allows` below is that
 * rule written once, because a call site is free to get the `null` case
 * backwards and nothing would tell it.
 *
 * ## Why per config rather than per §30 pool
 *
 * Two grouped wings share a resource pool and are precisely the case this
 * exists for: Junior and Senior are one pool and teach different subjects. A
 * pool-level answer could not say that. It also means an individual timetable
 * gets its own list for free, since its pool holds exactly one timetable.
 *
 * ## What it does NOT cover
 *
 * Selection only. A subject's code, category, priority, placement, lab flag,
 * own-room flag and double-period flag are one answer per subject, school-wide
 * — they describe the subject, not the week. A subject that is a lab is a lab
 * in every timetable that teaches it.
 */
export type SubjectSelection = Set<number> | null;

/** The subjects this timetable has declared, or `null` if it has not. */
export async function subjectSelectionFor(
  prisma: Pick<PrismaClient, "timetableSubject">,
  timetableConfigId: number,
): Promise<SubjectSelection> {
  const rows = await prisma.timetableSubject.findMany({
    where: { timetableConfigId },
    select: { subjectId: true },
  });
  return rows.length === 0 ? null : new Set(rows.map((r) => r.subjectId));
}

/**
 * Whether this timetable teaches that subject.
 *
 * One definition because the `null` branch is the one a call site gets wrong,
 * and getting it wrong in the permissive direction is invisible (the feature
 * simply does nothing) while getting it wrong in the strict direction empties
 * a school's timetable.
 */
export const allows = (selection: SubjectSelection, subjectId: number): boolean =>
  selection === null || selection.has(subjectId);
