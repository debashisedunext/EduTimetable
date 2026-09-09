/**
 * §27.16 — which classes a subject may be given.
 *
 * The exact shape of `teacher-scope.util.ts`, one table across: a school says
 * once, on the subject, which classes take it, and every path that writes a
 * curriculum row asks here rather than carrying its own copy of the rule.
 *
 * Three things it deliberately is:
 *
 *  1. **A statement, not the ladder.** §27.15's `CLASS_LADDER` ranges guess from
 *     a subject's NAME and so may only shape a proposal. This is the school's
 *     own answer, so it may refuse — the same promotion §18 made when it
 *     replaced a teaching band derived from existing mappings with a declared
 *     one.
 *  2. **Empty means "not stated".** No rows is every school that predates the
 *     table, and refusing all of them would be a cure far worse than the
 *     disease (invariant 7).
 *  3. **The early, specific refusal — not the authority.** Rows written before
 *     a declaration existed, or through the §16 importer, never passed here;
 *     Feasibility Check 13 is the backstop that names those. Same division of
 *     labour as `capacity.util.ts` and `teacher-scope.util.ts`.
 */
import { BadRequestException } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";

/**
 * Refuse a curriculum row for a class this subject is not taught to.
 *
 * Reads through the scoped client, so a subject or class belonging to another
 * school is simply not found — and the honest answer either way is that the
 * caller may not write this row (§17).
 */
export async function assertSubjectApplies(
  prisma: PrismaClient,
  subjectId: number,
  classId: number,
): Promise<void> {
  const subject = await prisma.subject.findFirst({
    where: { id: subjectId },
    include: { classes: { include: { class: true }, orderBy: { class: { sequence: "asc" } } } },
  });
  if (!subject) throw new BadRequestException(`Subject ${subjectId} not found`);

  // Nobody has narrowed this subject, so it is taught wherever it is asked for.
  if (subject.classes.length === 0) return;
  if (subject.classes.some((c) => c.classId === classId)) return;

  const target = await prisma.schoolClass.findFirst({ where: { id: classId }, select: { name: true } });
  const scope = subject.classes.map((c) => c.class.name).join(", ");
  throw new BadRequestException(
    `${subject.name} is not taught in ${target?.name ?? `class ${classId}`}. ` +
      `It is set for ${scope} on the Subjects screen — add the class there if that has changed.`,
  );
}
