/**
 * §18 — who a teacher may be given.
 *
 * Two rules, one place, called from every path that attaches a teacher to a
 * class: subject mappings, merged groups, elective options, class-teacher
 * assignment, and the importer.
 *
 *   1. **Teaching scope.** A teacher may only take classes they are eligible
 *      for. Before this existed, the grade band was *derived* from the
 *      mappings a teacher already had — which describes the data but cannot
 *      constrain it, so nothing stopped a Nursery teacher being given Class 12.
 *   2. **Guests take extra classes only.** A guest teacher is not part of the
 *      regular curriculum; they are engaged for a lecture or a revision
 *      series, and the timetable should not quietly depend on them.
 *
 * The Feasibility Engine re-checks both (§4, Check 8). This is the early,
 * specific refusal at the point of the mistake, not the authority — the same
 * division of labour as `capacity.util.ts`.
 */
import { BadRequestException } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";

export interface ScopeOptions {
  /** Extra classes are exactly what a guest is for, so they skip rule 2. */
  allowGuest?: boolean;
  /** What to call the thing being created, for the message. */
  what?: string;
}

/**
 * Refuse a teacher who may not take these class-sections.
 *
 * Reads through the scoped client, so a teacher or class-section belonging to
 * another school is simply not found — and reports as "not eligible", which is
 * the truthful answer either way (§17).
 */
export async function assertCanTeach(
  prisma: PrismaClient,
  teacherId: number,
  classSectionIds: number[],
  opts: ScopeOptions = {},
): Promise<void> {
  if (classSectionIds.length === 0) return;

  const teacher = await prisma.teacher.findFirst({
    where: { id: teacherId },
    include: { eligibility: true },
  });
  if (!teacher) throw new BadRequestException(`Teacher ${teacherId} not found`);

  if (!opts.allowGuest && teacher.employmentType === "guest") {
    throw new BadRequestException(
      `${teacher.name} is a guest teacher, so they can only take extra classes — not the regular timetable. ` +
        `Change their engagement type on the Teachers screen, or schedule this on the Extra Classes screen instead.`,
    );
  }

  // No rows means nobody has said what this teacher covers. Treated as "not
  // stated yet" rather than "nothing", because refusing every mapping for a
  // teacher created before their scope was filled in would be a cure worse
  // than the disease — the Feasibility Engine surfaces it as a warning.
  if (teacher.eligibility.length === 0) return;

  const allowed = new Set(teacher.eligibility.map((e) => e.classId));
  const sections = await prisma.classSection.findMany({
    where: { id: { in: classSectionIds } },
    include: { class: true, section: true },
  });
  const rejected = sections.filter((cs) => !allowed.has(cs.classId));
  if (rejected.length === 0) return;

  const classes = [...new Set(rejected.map((cs) => cs.class.name))];
  const scope = await prisma.schoolClass.findMany({
    where: { id: { in: [...allowed] } },
    orderBy: { sequence: "asc" },
    select: { name: true },
  });
  throw new BadRequestException(
    `${teacher.name} does not teach ${classes.join(", ")}. ` +
      `Their teaching scope is ${scope.map((c) => c.name).join(", ") || "empty"} — ` +
      `widen it on the Teachers screen, or give ${opts.what ?? "this"} to a teacher who covers ${classes.join(", ")}.`,
  );
}

/** The same check for a class-section's own class teacher. */
export async function assertCanOwnClass(
  prisma: PrismaClient,
  teacherId: number,
  classSectionId: number,
): Promise<void> {
  await assertCanTeach(prisma, teacherId, [classSectionId], { what: "this class" });
}
