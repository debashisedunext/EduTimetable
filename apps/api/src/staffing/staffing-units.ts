/**
 * §29.2 — what a teacher carries in one timetable.
 *
 * The vacancy, enumerated. Four things hold "who teaches", and a release that
 * covered only the first would leave a resigned teacher still running a merged
 * group and still named as somebody's class teacher:
 *
 *   1. **mappings** — `teacher_subject_class_section`, the ordinary case;
 *   2. **merged groups** (§4.10) — one teacher, several sections at once;
 *   3. **elective options** (§4.9) — a lesson under a block, with no section of
 *      its own, which is exactly why it is easy to miss;
 *   4. **class teacher** — not a lesson at all, but it drives the
 *      `always_first_period` rule and it is the thing a school notices first.
 *
 * ## The unit is a mapping, not a period (§29.0)
 *
 * `teacher_subject_class_section` is unique on `(subject, class_section)`: one
 * teacher owns Class 5-A Maths, all six periods, and that is what a school
 * means. Five sections of a leaver's Maths may go to five different teachers;
 * one section's Maths is never split between two. So a unit is the thing that
 * gets reassigned, and its `cells` are what the assignment must be checked
 * against — assignment at mapping granularity, validation at slot granularity.
 *
 * ## Pure, and reading only
 *
 * No writes, and no opinion about who should take anything: that is §29.3's
 * engine. This module answers "what is on the table?", which the preview shows
 * and the plan consumes.
 */
import type { PrismaClient } from "@prisma/client";

export type UnitType = "mapping" | "merged_group" | "elective_option" | "class_teacher";

/** One cell of the published week — the grain the assignment is checked at. */
export interface UnitCell {
  slotId: string;
  dayOfWeek: number;
  periodNumber: number;
  classSectionId: number | null;
  roomId: number | null;
}

export interface StaffingUnit {
  type: UnitType;
  /** The row that carries the teacher: a mapping, a group, an option, a section. */
  id: number;
  /** Frozen at read time, and stored verbatim on the undo record (§29.2). */
  label: string;
  teacherId: number;
  teacherName: string;
  subjectId: number | null;
  subjectName: string | null;
  /** Every section this unit teaches — one for a mapping, several for a group. */
  classSectionIds: number[];
  classIds: number[];
  periodsPerWeek: number;
  /**
   * The published cells this unit occupies.
   *
   * Empty is not an error and is worth distinguishing rather than filtering
   * out: a mapping with no published lessons is real (it was added after the
   * last publish), and a class-teacher role has no lessons by nature. §29.3
   * validates a candidate against these cells, so an empty list means "nothing
   * to clash with", not "nothing to move".
   */
  cells: UnitCell[];
}

/**
 * Everything the given teachers hold in this timetable.
 *
 * Scoped to the config throughout, because a teacher may work in two wings and
 * a change is made against one of them: releasing them from Primary must not
 * silently vacate their Secondary classes.
 */
export async function unitsFor(
  prisma: PrismaClient,
  configId: number,
  teacherIds: number[],
): Promise<StaffingUnit[]> {
  const ids = [...new Set(teacherIds.filter((n) => Number.isInteger(n)))];
  if (ids.length === 0) return [];

  const sections = await prisma.classSection.findMany({
    where: { timetableConfigId: configId },
    include: { class: true, section: true },
  });
  if (sections.length === 0) return [];
  const sectionIds = sections.map((cs) => cs.id);
  const label = new Map(sections.map((cs) => [cs.id, `${cs.class.name}-${cs.section.name}`]));
  const classOf = new Map(sections.map((cs) => [cs.id, cs.classId]));

  /*
    Published rows only.

    A staffing change is about the week that is on the wall — draft rows belong
    to a working copy nobody is teaching from, and counting them would report a
    leaver as carrying lessons that do not exist. `status: "published"` is also
    what makes the counts add up against what a teacher sees in My Timetable.
  */
  const slots = await prisma.timetableSlot.findMany({
    where: { timetableConfigId: configId, status: "published", teacherId: { in: ids } },
    select: {
      id: true, dayOfWeek: true, periodNumber: true, classSectionId: true, roomId: true,
      subjectId: true, teacherId: true, mergedGroupId: true, electiveOptionId: true,
    },
  });
  const cellOf = (s: (typeof slots)[number]): UnitCell => ({
    slotId: String(s.id),
    dayOfWeek: s.dayOfWeek,
    periodNumber: s.periodNumber,
    classSectionId: s.classSectionId,
    roomId: s.roomId,
  });

  const out: StaffingUnit[] = [];

  // ---- 1. ordinary mappings ----
  const mappings = await prisma.teacherSubjectClassSection.findMany({
    where: { teacherId: { in: ids }, classSectionId: { in: sectionIds } },
    include: { teacher: true, subject: true },
    orderBy: [{ subject: { name: "asc" } }, { classSectionId: "asc" }],
  });
  for (const m of mappings) {
    out.push({
      type: "mapping",
      id: m.id,
      label: `${label.get(m.classSectionId) ?? `section ${m.classSectionId}`} · ${m.subject.name}`,
      teacherId: m.teacherId,
      teacherName: m.teacher.name,
      subjectId: m.subjectId,
      subjectName: m.subject.name,
      classSectionIds: [m.classSectionId],
      classIds: [classOf.get(m.classSectionId)].filter((n): n is number => n !== undefined),
      periodsPerWeek: m.periodsPerWeek,
      // A merged group's lessons carry BOTH a mergedGroupId and a subject, so a
      // plain subject+section match would claim them for the mapping as well.
      cells: slots
        .filter((s) => s.mergedGroupId === null && s.electiveOptionId === null
          && s.teacherId === m.teacherId && s.subjectId === m.subjectId
          && s.classSectionId === m.classSectionId)
        .map(cellOf),
    });
  }

  // ---- 2. merged teaching groups (§4.10) ----
  const groups = await prisma.mergedTeachingGroup.findMany({
    where: { teacherId: { in: ids }, members: { some: { classSectionId: { in: sectionIds } } } },
    include: { teacher: true, subject: true, members: true },
    orderBy: { id: "asc" },
  });
  for (const g of groups) {
    const members = g.members.map((x) => x.classSectionId);
    out.push({
      type: "merged_group",
      id: g.id,
      // Named by its members, because a group has no section of its own and
      // "merged group 41" tells a reader nothing.
      label: `${members.map((cs) => label.get(cs) ?? `#${cs}`).join(" + ")} · ${g.subject.name}`,
      teacherId: g.teacherId,
      teacherName: g.teacher.name,
      subjectId: g.subjectId,
      subjectName: g.subject.name,
      classSectionIds: members,
      classIds: [...new Set(members.map((cs) => classOf.get(cs)).filter((n): n is number => n !== undefined))],
      periodsPerWeek: g.periodsPerWeek,
      // §4.10 — one occupancy event however many sections attend, so the cells
      // are deduplicated by day/period rather than counted per member.
      cells: dedupeCells(slots.filter((s) => s.mergedGroupId === g.id).map(cellOf)),
    });
  }

  // ---- 3. elective options (§4.9) ----
  //
  // The one that is easy to miss. An option row carries `class_section_id =
  // NULL` — that NULL is what takes it out of `uq_class_slot` — so anything
  // that looks for a teacher's work by section finds none of it.
  const options = await prisma.electiveOption.findMany({
    where: {
      teacherId: { in: ids },
      electiveBlock: { members: { some: { classSectionId: { in: sectionIds } } } },
    },
    include: {
      teacher: true,
      subject: true,
      electiveBlock: { include: { members: true } },
    },
    orderBy: { id: "asc" },
  });
  for (const o of options) {
    const members = o.electiveBlock.members.map((x) => x.classSectionId);
    out.push({
      type: "elective_option",
      id: o.id,
      label: `${o.electiveBlock.name} · ${o.subject.name}`,
      teacherId: o.teacherId,
      teacherName: o.teacher.name,
      subjectId: o.subjectId,
      subjectName: o.subject.name,
      classSectionIds: members,
      classIds: [...new Set(members.map((cs) => classOf.get(cs)).filter((n): n is number => n !== undefined))],
      periodsPerWeek: o.electiveBlock.periodsPerWeek,
      cells: slots.filter((s) => s.electiveOptionId === o.id).map(cellOf),
    });
  }

  // ---- 4. class teacher ----
  //
  // Not a lesson, which is why it has no cells and no subject — and exactly why
  // it must be listed anyway. It is the thing a school notices first when
  // somebody leaves, and `always_first_period` makes it a placement rule as
  // well as a title.
  const owned = sections.filter((cs) => cs.classTeacherId !== null && ids.includes(cs.classTeacherId));
  const teachers = new Map(
    (await prisma.teacher.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }))
      .map((t) => [t.id, t.name]),
  );
  for (const cs of owned) {
    out.push({
      type: "class_teacher",
      id: cs.id,
      label: `${label.get(cs.id)} · class teacher`,
      teacherId: cs.classTeacherId as number,
      teacherName: teachers.get(cs.classTeacherId as number) ?? `teacher ${cs.classTeacherId}`,
      subjectId: null,
      subjectName: null,
      classSectionIds: [cs.id],
      classIds: [cs.classId],
      periodsPerWeek: 0,
      cells: [],
    });
  }

  return out;
}

/** One cell per day/period — §4.10 places a group once, not once per section. */
function dedupeCells(cells: UnitCell[]): UnitCell[] {
  const seen = new Set<string>();
  const out: UnitCell[] = [];
  for (const c of cells) {
    const key = `${c.dayOfWeek}:${c.periodNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
