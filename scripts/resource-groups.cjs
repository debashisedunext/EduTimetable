/**
 * §30 — the session's shared resource pool, for scripts that write with a RAW
 * `PrismaClient`.
 *
 * Inside the app, `ResourceGroupService` answers this and every create goes
 * through it. These scripts deliberately bypass the app to build fixtures, so
 * nothing resolves the pool for them — and `class_sections.resource_group_id`
 * is NOT NULL, because a nullable one would put NULLs inside
 * `uq_section_in_group`, where MySQL treats them as distinct and the key would
 * stop guarding anything.
 *
 * One helper rather than the same three lines in thirteen files, for the reason
 * the service exists at all: a value written in thirteen places is written
 * differently in one of them.
 *
 * The migration gave every existing session a pool; this only creates one for a
 * session a script made by hand.
 */
async function groupFor(prisma, academicYearId) {
  const found = await prisma.timetableGroup.findFirst({
    where: { academicYearId, mode: "grouped" },
    orderBy: { id: "asc" },
  });
  if (found) return found.id;
  const year = await prisma.academicYear.findUnique({ where: { id: academicYearId } });
  if (!year) throw new Error(`§30 groupFor: academic year ${academicYearId} not found`);
  const made = await prisma.timetableGroup.create({
    data: { schoolId: year.schoolId, academicYearId, name: "Main", mode: "grouped" },
  });
  return made.id;
}

module.exports = { groupFor };
