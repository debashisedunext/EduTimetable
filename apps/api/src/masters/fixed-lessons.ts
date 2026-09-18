/**
 * §36 — what a fixed lesson has to satisfy before it is stored.
 *
 * ## Why this is a module rather than a controller method
 *
 * A fixed lesson is a **hard constraint the school writes by hand**, and the
 * product's own rule is that a hard constraint with no feasibility check is a
 * generation that fails. So the same facts are needed twice: once to refuse a
 * bad row while somebody is looking at it, and again by Check 14, which has to
 * say the same thing about rows already stored. Two derivations of "is this pin
 * legal?" would be two chances to disagree, and the disagreement would show up
 * as a screen that saved something Readiness then refuses to generate.
 *
 * ## What is checked HERE and what is checked by the engine
 *
 * Everything local and exact is here: the cell exists, the subject is taught to
 * the class, the curriculum has room for another pin, nobody is in two places.
 * Each one names its row, because the school is looking at that row.
 *
 * What is *not* here is the aggregate — twenty sections pinning four teachers
 * into Monday period 1 is twenty legal rows and one impossible week. That is
 * Check 14's job, because it can only be judged against the whole snapshot.
 */
import { BadRequestException } from "@nestjs/common";
import type { PrismaClient } from "@prisma/client";

/** One pin, as the screen sends it. */
export interface FixedLessonInput {
  classSectionId: number;
  subjectId: number;
  teacherId: number;
  /** §19 — absent means "the solver chooses", which is every lesson today. */
  roomId?: number | null;
  dayOfWeek: number;
  periodNumber: number;
}

const label = (cs: { class: { name: string }; section: { name: string } }) =>
  `${cs.class.name}-${cs.section.name}`;

const DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const dayName = (d: number) => DAYS[d] ?? `day ${d}`;

/**
 * Check a whole proposed set, and throw on the first thing that is wrong.
 *
 * **The whole set, not one row.** The Save button replaces everything, so two
 * pins that are each fine alone and collide with each other have to be caught
 * here — and a row-at-a-time API could not see that at all.
 */
export async function assertFixedLessonsValid(
  prisma: PrismaClient,
  configId: number,
  rows: FixedLessonInput[],
): Promise<void> {
  const config = await prisma.timetableConfig.findFirst({
    where: { id: configId },
    select: {
      id: true, name: true, academicYearId: true,
      periodsPerDay: true, workingDays: true, extraPeriodsPerDay: true,
    },
  });
  if (!config) throw new BadRequestException("Timetable config not found");

  if (rows.length === 0) return;

  const sectionIds = [...new Set(rows.map((r) => r.classSectionId))];
  /*
    Awaited on its own rather than inside the `Promise.all` below.
    Four heterogeneous selects in one `Promise.all` widened this one's inferred
    element type to `{}`, and every `label(cs)` in the loop then failed to
    compile — a real type, lost to inference rather than to a mistake. One
    round trip is not worth arguing with the compiler about.
  */
  const sections = await prisma.classSection.findMany({
    where: { id: { in: sectionIds }, timetableConfigId: configId },
    select: {
      id: true,
      classId: true,
      class: { select: { id: true, name: true } },
      section: { select: { name: true } },
    },
  });
  /*
    The period ROWS, not `periodsPerDay`.
    A break and a §28 activity both occupy a row and neither is a teaching cell
    — `domainFor` cannot reach them, so a pin there is a constraint the solver
    could never satisfy. Reading the rows is also what makes the §18 extra
    window unreachable without a second rule about it.
  */
  const periods = await prisma.period.findMany({
    where: { timetableConfigId: configId },
    select: { periodNumber: true, isBreak: true, isExtra: true, isActivity: true },
  });
  // §34 — a short Saturday has fewer cells than the rest of the week.
  const dayShapes = await prisma.timetableDayShape.findMany({
    where: { timetableConfigId: configId },
    select: { dayOfWeek: true, periodsPerDay: true },
  });
  // §31.19 — a subject an elective block already teaches to this class. Its
  // periods belong to the block, which has its own pinning (§4.9).
  const blockOptions = await prisma.electiveOption.findMany({
    where: { electiveBlock: { members: { some: { classSectionId: { in: sectionIds } } } } },
    select: {
      subjectId: true,
      electiveBlock: {
        select: {
          name: true,
          members: { select: { classSectionId: true } },
        },
      },
    },
  });

  const sectionById = new Map(sections.map((s) => [s.id, s]));
  const working = new Set(
    Array.isArray(config.workingDays) ? (config.workingDays as number[]) : [1, 2, 3, 4, 5],
  );
  const reachOn = new Map(dayShapes.map((d) => [d.dayOfWeek, d.periodsPerDay]));
  const teachable = new Set(
    periods.filter((p) => !p.isBreak && !p.isExtra && !p.isActivity).map((p) => p.periodNumber),
  );
  const ownedByBlock = new Map<string, string>();
  for (const o of blockOptions) {
    for (const m of o.electiveBlock.members) {
      ownedByBlock.set(`${m.classSectionId}:${o.subjectId}`, o.electiveBlock.name);
    }
  }

  const subjects = new Map(
    (await prisma.subject.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.subjectId))] } },
      select: { id: true, name: true, classes: { select: { class: { select: { id: true, name: true } } } } },
    })).map((s) => [s.id, s]),
  );
  const teachers = new Map(
    (await prisma.teacher.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.teacherId))] } },
      select: { id: true, name: true, isActive: true, employmentType: true },
    })).map((t) => [t.id, t]),
  );
  const rooms = new Map(
    (await prisma.room.findMany({
      where: { id: { in: rows.map((r) => r.roomId).filter((x): x is number => !!x) } },
      select: { id: true, name: true },
    })).map((r) => [r.id, r]),
  );

  /*
    The curriculum, by CLASS — because periods are a class fact (§27).
    So Class 1's six Mathematics is the cap for 1-A, for 1-B and for 1-C
    separately: each section gets six, and each can pin up to six.
  */
  const classIds = [...new Set(sections.map((s) => s.classId))];
  const curriculumRows = await prisma.classSubject.findMany({
    where: { classId: { in: classIds }, academicYearId: config.academicYearId },
    select: { classId: true, subjectId: true, periodsPerWeek: true, consecutiveBlockSize: true },
  });
  const curriculum = new Map(curriculumRows.map((c) => [`${c.classId}:${c.subjectId}`, c.periodsPerWeek]));
  const blockSizeOf = new Map(
    curriculumRows.map((c) => [`${c.classId}:${c.subjectId}`, c.consecutiveBlockSize ?? 1]),
  );

  /*
    §36 — a pin has to attach to a lesson somebody is assigned to teach.

    `variables.ts` matches a pin to its variable by (section, subject, teacher),
    which is the same key locked cells use. A pin naming a teacher with no
    mapping for that section and subject would therefore match no variable and
    be silently ignored — a hard constraint the school can see on screen and the
    solver never hears about, which is the worst kind of bug this feature could
    have. Refused here, where it can name the row.
  */
  const mappingKeys = new Set(
    (await prisma.teacherSubjectClassSection.findMany({
      where: { classSectionId: { in: sectionIds } },
      select: { classSectionId: true, subjectId: true, teacherId: true },
    })).map((m) => `${m.classSectionId}:${m.subjectId}:${m.teacherId}`),
  );

  // §4.7a — a teacher who is not there cannot be pinned there.
  const unavailable = await prisma.teacherUnavailability.findMany({
    where: { teacherId: { in: [...new Set(rows.map((r) => r.teacherId))] } },
    select: { teacherId: true, dayOfWeek: true, periodNumber: true },
  });
  const offKey = new Set(
    unavailable.map((u) => `${u.teacherId}:${u.dayOfWeek}:${u.periodNumber ?? "*"}`),
  );

  const perSectionSubject = new Map<string, number>();
  const cellBySection = new Set<string>();
  const cellByTeacher = new Map<string, string>();
  const cellByRoom = new Map<string, string>();

  for (const r of rows) {
    const cs = sectionById.get(r.classSectionId);
    if (!cs) {
      throw new BadRequestException(
        `A pinned class-section does not belong to ${config.name}. Refresh the page and try again.`,
      );
    }
    const where = `${label(cs)} on ${dayName(r.dayOfWeek)} period ${r.periodNumber}`;
    const subject = subjects.get(r.subjectId);
    const teacher = teachers.get(r.teacherId);
    if (!subject) throw new BadRequestException(`That subject no longer exists (${where}).`);
    if (!teacher) throw new BadRequestException(`That teacher no longer exists (${where}).`);

    // ── the cell has to be a cell
    if (!working.has(r.dayOfWeek)) {
      throw new BadRequestException(
        `${config.name} does not work on ${dayName(r.dayOfWeek)}, so nothing can be fixed there.`,
      );
    }
    const reach = reachOn.get(r.dayOfWeek) ?? config.periodsPerDay;
    if (r.periodNumber < 1 || r.periodNumber > reach) {
      throw new BadRequestException(
        `${dayName(r.dayOfWeek)} runs ${reach} period(s), so period ${r.periodNumber} does not exist (${label(cs)}).`,
      );
    }
    if (teachable.size > 0 && !teachable.has(r.periodNumber)) {
      throw new BadRequestException(
        `Period ${r.periodNumber} is a break or an activity, not a lesson — nothing can be fixed there (${label(cs)}).`,
      );
    }

    // ── §27.16: the subject has to be taught to this class
    const declared = subject.classes.map((c) => c.class);
    if (declared.length > 0 && !declared.some((c) => c.id === cs.classId)) {
      throw new BadRequestException(
        `${subject.name} is not taught in ${cs.class.name}. It is set for `
        + `${declared.map((c) => c.name).join(", ")} on the Subjects screen.`,
      );
    }

    // ── §31.19: an elective owns its option subjects
    const block = ownedByBlock.get(`${r.classSectionId}:${r.subjectId}`);
    if (block) {
      throw new BadRequestException(
        `${subject.name} is taught inside "${block}" for ${label(cs)}. Pin the block on the `
        + `Split Electives screen instead — its periods are set there, not here.`,
      );
    }

    // ── §18: a guest teacher is refused the regular curriculum outright
    if (!teacher.isActive) {
      throw new BadRequestException(`${teacher.name} is no longer active (${where}).`);
    }
    if (teacher.employmentType === "guest") {
      throw new BadRequestException(
        `${teacher.name} is a guest teacher, who cannot take the regular curriculum (§18). `
        + `Pick somebody else for ${where}.`,
      );
    }

    // ── §4.7a: and has to be there
    if (offKey.has(`${r.teacherId}:${r.dayOfWeek}:*`)
      || offKey.has(`${r.teacherId}:${r.dayOfWeek}:${r.periodNumber}`)) {
      throw new BadRequestException(
        `${teacher.name} is not available on ${dayName(r.dayOfWeek)} period ${r.periodNumber}. `
        + `Change it on the Time off screen, or pick another cell.`,
      );
    }

    // ── the curriculum cap, which is the school's own request
    const capKey = `${cs.classId}:${r.subjectId}`;
    const cap = curriculum.get(capKey) ?? 0;
    if (cap <= 0) {
      throw new BadRequestException(
        `${cs.class.name} has no ${subject.name} in its lesson plan, so none of it can be fixed. `
        + `Give it periods on the Lesson grid first.`,
      );
    }
    /*
      §4.8 — a row taught as double periods has no single occurrences to pin.

      `variables.ts` turns such a row entirely into span-2 variables, so there
      is nothing for a one-cell pin to attach to. Refused by name rather than
      accepted and dropped: pinning a whole double period is a real feature and
      this is not it, and the school should hear that rather than watch a pin
      disappear at generation.
    */
    const blockSize = blockSizeOf.get(capKey) ?? 1;
    if (blockSize > 1) {
      throw new BadRequestException(
        `${cs.class.name} takes ${subject.name} as ${blockSize}-period blocks (§4.8), so a single `
        + `lesson of it cannot be fixed. Set it to single periods on the Lesson grid first.`,
      );
    }

    if (!mappingKeys.has(`${r.classSectionId}:${r.subjectId}:${r.teacherId}`)) {
      throw new BadRequestException(
        `${teacher.name} does not teach ${subject.name} to ${label(cs)}. Assign them on the `
        + `Lesson grid first — a fixed lesson has to belong to a lesson somebody teaches.`,
      );
    }

    const used = (perSectionSubject.get(`${r.classSectionId}:${r.subjectId}`) ?? 0) + 1;
    perSectionSubject.set(`${r.classSectionId}:${r.subjectId}`, used);
    if (used > cap) {
      throw new BadRequestException(
        `${label(cs)} is taught ${cap} period(s) of ${subject.name} a week, so only ${cap} can be `
        + `fixed. Remove one, or raise the number on the Lesson grid.`,
      );
    }

    // ── nobody in two places at once
    const cell = `${r.dayOfWeek}:${r.periodNumber}`;
    const sectionCell = `${r.classSectionId}@${cell}`;
    if (cellBySection.has(sectionCell)) {
      throw new BadRequestException(`${label(cs)} has two fixed lessons on ${dayName(r.dayOfWeek)} period ${r.periodNumber}.`);
    }
    cellBySection.add(sectionCell);

    const teacherCell = `${r.teacherId}@${cell}`;
    const held = cellByTeacher.get(teacherCell);
    if (held) {
      throw new BadRequestException(
        `${teacher.name} is fixed in ${held} and ${label(cs)} at the same time — `
        + `${dayName(r.dayOfWeek)} period ${r.periodNumber}.`,
      );
    }
    cellByTeacher.set(teacherCell, label(cs));

    if (r.roomId) {
      const room = rooms.get(r.roomId);
      if (!room) throw new BadRequestException(`That room no longer exists (${where}).`);
      const roomCell = `${r.roomId}@${cell}`;
      const inRoom = cellByRoom.get(roomCell);
      if (inRoom) {
        throw new BadRequestException(
          `${room.name} is fixed for ${inRoom} and ${label(cs)} at the same time — `
          + `${dayName(r.dayOfWeek)} period ${r.periodNumber}.`,
        );
      }
      cellByRoom.set(roomCell, label(cs));
    }
  }
}

/**
 * §36 — the pins that stand in the way of changing a lesson plan.
 *
 * The school's rule: *"if fixed allocation is done, then the user should not be
 * able to change the lesson plan — prompt to remove the fixed entry first."*
 *
 * Asked by CLASS and subject rather than by section, and that is not a
 * shortcut: `class_subjects.periods_per_week` is one number for the whole class
 * (§27), so pinning a lesson in 1-A locks Class 1's Mathematics for 1-B and 1-C
 * too. It is the same number; there is no version of this that locks it for one
 * section and not the others.
 *
 * Returns the pins rather than a boolean, so the refusal can say how many there
 * are and where — a "you cannot do that" with no count is a dead end.
 */
export async function fixedLessonsForClassSubject(
  prisma: PrismaClient,
  classId: number,
  subjectId: number,
  academicYearId: number,
): Promise<Array<{ label: string; day: number; period: number; timetable: string }>> {
  const rows = await prisma.timetableFixedLesson.findMany({
    where: {
      subjectId,
      classSection: { classId, academicYearId },
    },
    select: {
      dayOfWeek: true, periodNumber: true,
      timetableConfig: { select: { name: true } },
      classSection: { select: { class: { select: { name: true } }, section: { select: { name: true } } } },
    },
    orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
  });
  return rows.map((r) => ({
    label: label(r.classSection),
    day: r.dayOfWeek,
    period: r.periodNumber,
    timetable: r.timetableConfig.name,
  }));
}

/**
 * Refuse a lesson-plan change while any of its lessons are pinned.
 *
 * On the SERVER, and called from every door that writes a curriculum row — the
 * Lesson grid, the §16 importer and the guided setup's commit all reach the
 * same table, and a rule kept in one screen is a rule the other two break.
 */
export async function assertNotPinned(
  prisma: PrismaClient,
  classId: number,
  subjectId: number,
  academicYearId: number,
  what: string,
): Promise<void> {
  const pins = await fixedLessonsForClassSubject(prisma, classId, subjectId, academicYearId);
  if (pins.length === 0) return;
  const where = pins.slice(0, 3).map((p) => `${p.label} ${dayName(p.day)} P${p.period}`).join(", ");
  throw new BadRequestException(
    `${pins.length} lesson(s) of this subject are fixed to a day and period (${where}`
    + `${pins.length > 3 ? ", …" : ""}), so ${what} cannot change. Remove them on the `
    + `Master Grid's Whole tab first.`,
  );
}
