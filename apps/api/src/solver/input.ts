/**
 * Snapshot/input builders shared by the Nest API (ReadinessService) and the
 * BullMQ worker process — one query layer, one truth (CLAUDE.md invariant).
 * Plain functions over PrismaClient so the worker needs no Nest context.
 */
import type { PrismaClient } from "@prisma/client";
import type { FeasibilitySnapshot, SolverInput } from "@edutimetable/shared";
import { parsePins } from "@edutimetable/shared";
import { daySegmentsFromRows, lunchAfterPeriodFromRows } from "../masters/structure.util";
import { subjectSelectionFor } from "../masters/timetable-subjects.util";

export async function buildFeasibilitySnapshot(
  prisma: PrismaClient,
  configId: number,
): Promise<FeasibilitySnapshot> {
  const config = await prisma.timetableConfig.findUnique({
    where: { id: configId },
    include: { periods: { orderBy: { sortOrder: "asc" } } },
  });
  if (!config) throw new Error("Timetable config not found");

  const classSections = await prisma.classSection.findMany({
    where: { timetableConfigId: configId },
    include: { class: true, section: true },
  });
  const classIds = [...new Set(classSections.map((c) => c.classId))];
  const sectionIds = classSections.map((c) => c.id);

  /*
    §32 — which subjects THIS timetable teaches, or null if it has not said.

    Read here, once, because this snapshot is what the solver, the Feasibility
    Engine, Readiness and the Master Grid's strip all read (CLAUDE.md: "read off
    `buildFeasibilitySnapshot` so the strip cannot disagree with the solver or
    Readiness"). Filtering anywhere else would be a second answer to "does this
    timetable teach Chemistry?", free to disagree with this one.
  */
  const subjectSelection = await subjectSelectionFor(prisma, configId);

  /*
    §33 — how many BASE periods one of each class's lessons occupies.

    A school running Class 1 at 30 minutes and Class 10 at 60, same start and
    same finish, is ONE grid of eight 30-minute periods on which Class 10's
    lessons are **double periods**. This map is that multiplier, and applying
    it here — where the curriculum becomes the solver's requirements — is what
    makes every downstream consumer agree: the solver places the block
    atomically, `writer.ts` emits one slot row per period in it, and
    `uq_teacher_slot` therefore refuses a teacher who is in Class 10's hour and
    Class 1's second half-hour at once.

    Absent means span 1 (invariant 7), which is every class in every school
    today.
  */
  /*
    §34 — the weekdays that run a shape of their own (a short Saturday).

    Loaded into the snapshot rather than read at each consumer, because the
    consumers are the solver's domain construction AND the Feasibility Engine's
    capacity arithmetic, and those two disagreeing is the shape of a school
    that passes Readiness and then cannot be generated.
  */
  const dayShapeRows = await prisma.timetableDayShape.findMany({
    where: { timetableConfigId: configId },
    select: { dayOfWeek: true, periodsPerDay: true, periodDurationMins: true },
    orderBy: { dayOfWeek: "asc" },
  });

  const spanRows = await prisma.timetableClassSpan.findMany({
    where: { timetableConfigId: configId, classId: { in: classIds } },
    select: { classId: true, span: true },
  });
  const spanByClass = new Map(spanRows.map((r) => [r.classId, Math.max(1, r.span)]));

  const [classSubjects, mappings, teachers, mergedGroups, electiveBlocks, labRooms, labSubjects, allSubjects] =
    await Promise.all([
      // Phase 19: the curriculum is year-scoped, and this filter is what keeps
      // it so. `variables.ts` keys requirements by `classId:subjectId` in a
      // plain Map — two years' rows reaching the snapshot would collapse to
      // whichever loaded last, silently timetabling the wrong syllabus.
      /*
        §32 — and narrowed to the subjects this timetable teaches.

        Applied to the CURRICULUM rather than to the subject list: the
        curriculum is what states demand, so a subject this timetable does not
        teach simply has no demand here — the solver never sees it, Check 1
        never counts its periods, and Readiness never reports it missing. The
        rows themselves are untouched, because another timetable may teach the
        same class the same subject and deselecting is not a deletion.

        `undefined` when nothing has been stated, which Prisma drops: that is
        the "not stated means all" rule (invariant 7) expressed as a query
        rather than as a branch somebody has to remember.
      */
      prisma.classSubject.findMany({
        where: {
          classId: { in: classIds },
          academicYearId: config.academicYearId,
          ...(subjectSelection ? { subjectId: { in: [...subjectSelection] } } : {}),
        },
        include: { subject: true },
      }),
      /*
        §32 — the MAPPINGS have to be narrowed too, and this is the half that
        is easy to miss.

        Filtering the curriculum alone looked complete — `/context` dropped the
        column, Readiness dropped the demand — and generation went on placing
        the subject anyway. `solver/variables.ts` builds one variable per
        MAPPING and takes the period count from `m.periodsPerWeek`; the
        curriculum row only supplies the block size and the per-day cap. So a
        mapping is a statement of demand in its own right, and a subject this
        timetable does not teach must not have one here.
      */
      prisma.teacherSubjectClassSection.findMany({
        where: {
          classSectionId: { in: sectionIds },
          ...(subjectSelection ? { subjectId: { in: [...subjectSelection] } } : {}),
        },
        include: { teacher: true, subject: true, classSection: { include: { class: true, section: true } } },
      }),
      prisma.teacher.findMany({
        where: { schoolId: config.schoolId, isActive: true },
        include: { unavailability: true, eligibility: true },
      }),
      // §4.10 — a merged group carries its own `periodsPerWeek` as well, so it
      // is demand on the same footing as a mapping.
      prisma.mergedTeachingGroup.findMany({
        where: {
          members: { some: { classSectionId: { in: sectionIds } } },
          ...(subjectSelection ? { subjectId: { in: [...subjectSelection] } } : {}),
        },
        include: { members: true, subject: true },
      }),
      // §4.9 split electives: any block one of this config's sections attends.
      /*
        §4.9 — and the OPTIONS inside an elective block.

        Filtered at the option rather than at the block: a language block whose
        school has taken German out of one wing still runs, with French and
        Sanskrit. `options: { where }` narrows the include, so a block left
        with none comes back with an empty `options` array — dropped below,
        where the block would otherwise be a macro-variable with nothing to
        place.
      */
      prisma.electiveBlock.findMany({
        where: { members: { some: { classSectionId: { in: sectionIds } } } },
        include: {
          members: { include: { classSection: { include: { class: true, section: true } } } },
          options: {
            where: subjectSelection ? { subjectId: { in: [...subjectSelection] } } : undefined,
            include: { subject: true, teacher: true, room: true },
          },
        },
      }),
      prisma.room.count({ where: { schoolId: config.schoolId, roomType: "lab" } }),
      prisma.subject.findMany({ where: { schoolId: config.schoolId, isLab: true } }),
      // §26 — every subject's placement rules. The whole school's, not just the
      // ones on this config's curriculum: an elective option's subject is not a
      // `class_subjects` row, and its rules apply just the same.
      prisma.subject.findMany({
        where: { schoolId: config.schoolId },
        select: {
          id: true, name: true, category: true, priority: true,
          lunchRule: true, gapAfterLunch: true, taughtInOwnRoom: true,
          // §27.16 — the classes each subject is declared for, for Check 13.
          classes: { select: { classId: true } },
        },
      }),
    ]);

    // §19 rooms. `homeRoomBySection` is what makes a recorded home room
    // actually appear on the timetable; `labRoomsBySubject` is what stops a
    // biology period being sent to the physics lab because it was free.
    const allRooms = await prisma.room.findMany({
      where: { schoolId: config.schoolId },
      include: { subjects: true },
    });
    const labRoomsBySubject: Record<number, number[]> = {};
    const generalLabs = allRooms.filter((r) => r.roomType === "lab" && r.subjects.length === 0).map((r) => r.id);
    for (const s of labSubjects) {
      const dedicated = allRooms.filter((r) => r.subjects.some((x) => x.subjectId === s.id)).map((r) => r.id);
      // A lab with no subjects listed is a general lab and serves everything,
      // which is exactly what every school had before this existed.
      labRoomsBySubject[s.id] = [...dedicated, ...generalLabs];
    }

    /*
      §19.1 — the rooms a subject taught in its OWN room may use.

      The same `room_subjects` table the labs read, and no general fallback:
      "always in its own room" with no room named is not "anywhere", it is
      unstated, and the solver takes the home room while Check 5b says the flag
      is doing nothing. The alternative — treating an empty pool as every room
      in the school — would scatter Music across whichever classrooms happened
      to be free, which is the opposite of what ticking the box asked for.
    */
    /*
      §4.7b — the three time-off tables beside the teachers'.

      Read for the whole school rather than for this config's sections: a
      subject's and a room's time off are school-wide facts, and a section is
      filtered by the config below anyway. Scoped by the §17 extension, as
      every query here is.
    */
    const [sectionOff, subjectOff, roomOff] = await Promise.all([
      prisma.classSectionUnavailability.findMany({
        where: { classSectionId: { in: sectionIds } },
        select: { classSectionId: true, dayOfWeek: true, periodNumber: true },
      }),
      prisma.subjectUnavailability.findMany({
        where: { schoolId: config.schoolId },
        select: { subjectId: true, dayOfWeek: true, periodNumber: true },
      }),
      prisma.roomUnavailability.findMany({
        where: { schoolId: config.schoolId },
        select: { roomId: true, dayOfWeek: true, periodNumber: true },
      }),
    ]);

    /*
      §36 — the pins, for Check 14.

      Read into the SNAPSHOT as well as into `SolverInput` — the same rows, but
      the engine and the solver are different readers: the solver prunes the
      domain, and the engine has to be able to say *before* Generate that the
      pruning will leave nothing. Queried once here, so a pin the engine passes
      and the solver refuses is not expressible.
    */
    const pinned = await prisma.timetableFixedLesson.findMany({
      where: { timetableConfigId: configId },
      select: {
        classSectionId: true, subjectId: true, teacherId: true,
        dayOfWeek: true, periodNumber: true,
      },
      orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
    });

    const ownRoomSubjectIds = allSubjects.filter((s) => s.taughtInOwnRoom).map((s) => s.id);
    const ownRoomsBySubject: Record<number, number[]> = {};
    for (const id of ownRoomSubjectIds) {
      ownRoomsBySubject[id] = allRooms.filter((r) => r.subjects.some((x) => x.subjectId === id)).map((r) => r.id);
    }

  /*
    §3.10: a teacher's load in OTHER configs counts toward their capacity here.

    Phase 19 narrowed this to other configs *in the same academic year*: next
    year's teaching does not consume this year's capacity, and without that
    filter rolling a school into a new session double-counted every teacher —
    Check 2 failed across the board and a freshly cloned timetable read as
    hopelessly overloaded before anyone had touched it.

    §30 narrows it once more, to other configs *in the same resource pool*, and
    it is the same argument one level in: an individual timetable is a separate
    plan for the same staff, so counting its periods against the main one would
    make a school unable to sketch an alternative without its real timetable
    reporting everybody overloaded. A pool belongs to exactly one session, so
    this filter subsumes the year filter rather than sitting beside it — two
    filters that must agree are two filters that can come to disagree.

    **This is the only cross-timetable calculation in the codebase**, which is
    why §30 stage 2 is one query. §29.3's reassignment engine reads the very
    same `crossConfigTeacherLoad` field off the very same snapshot, so it is
    corrected here too rather than anywhere near the restaff code.
  */
  const crossRows = await prisma.teacherSubjectClassSection.findMany({
    where: {
      teacherId: { in: teachers.map((t) => t.id) },
      classSection: {
        timetableConfigId: { not: configId },
        resourceGroupId: config.resourceGroupId,
      },
    },
    include: { classSection: { include: { timetableConfig: true } } },
  });
  const crossConfigTeacherLoad: FeasibilitySnapshot["crossConfigTeacherLoad"] = {};
  for (const row of crossRows) {
    if (row.classSection.timetableConfigId === configId) continue;
    const entry = (crossConfigTeacherLoad[row.teacherId] ??= { periods: 0, otherConfigNames: [] });
    entry.periods += row.periodsPerWeek;
    const name = row.classSection.timetableConfig?.name ?? "another timetable";
    if (!entry.otherConfigNames.includes(name)) entry.otherConfigNames.push(name);
  }

  const label = (cs: (typeof classSections)[number]) => `${cs.class.name}-${cs.section.name}`;

  // Built once: both `daySegments` and the lunch boundary read the same rows,
  // and mapping them twice is how the two answers come to disagree.
  const periodRows = config.periods.map((p) => ({
    sortOrder: p.sortOrder,
    periodNumber: p.periodNumber,
    startTime: p.startTime,
    endTime: p.endTime,
    isBreak: p.isBreak,
    isExtra: p.isExtra,
    // §28.3 — carried so `daySegmentsFromRows` can EXCLUDE it. An activity row
    // is not a break, so without the flag the run counter would read an
    // assembly as a teaching period and tell the solver the day has a longer
    // unbroken run than it has.
    isActivity: p.isActivity,
    activityId: p.activityId,
    breakName: p.breakName,
  }));

  return {
    config: {
      id: config.id,
      name: config.name,
      workingDays: (config.workingDays as number[]) ?? [1, 2, 3, 4, 5],
      periodsPerDay: config.periodsPerDay,
      // §34 — read through `periodsOn`/`weekPeriods`, never indexed directly.
      dayShapes: dayShapeRows.map((r) => ({
        day: r.dayOfWeek,
        periodsPerDay: r.periodsPerDay,
        periodDurationMins: r.periodDurationMins,
      })),
      daySegments: daySegmentsFromRows(periodRows),
      // §26.3 — which break was lunch. Null when the day has no break, which
      // switches the lunch rules off rather than attaching them to a guess.
      lunchAfterPeriod: lunchAfterPeriodFromRows(periodRows),
      // §28.1 — the school's own "getting full" line, for Check 12.
      loadAlertPct: config.loadAlertPct,
    },
    classSections: classSections.map((cs) => ({
      id: cs.id,
      label: label(cs),
      classId: cs.classId,
      classTeacherId: cs.classTeacherId,
    })),
    subjectRequirements: classSubjects.map((r) => ({
      id: r.id,
      classId: r.classId,
      subjectId: r.subjectId,
      subjectName: r.subject.name,
      periodsPerWeek: r.periodsPerWeek,
      maxPeriodsPerDay: r.maxPeriodsPerDay,
      samePeriodAcrossWeek: r.samePeriodAcrossWeek,
      /*
        §33 — the class's own lesson length, unless this row asks for more.

        `max`, not "override": a class on 60-minute periods whose Science is a
        double LAB wants two hours, which is four base periods, and the
        curriculum row already says 2 in the class's own units. Taking the
        larger keeps both statements true and keeps span 1 (every school today)
        reading exactly as it does now.

        Deliberately not multiplied. A curriculum row's block size is already
        in BASE periods — it is what `writer.ts` counts — so multiplying here
        would turn a school's existing double period into a quadruple the first
        time anybody set a class span.
      */
      consecutiveBlockSize: Math.max(r.consecutiveBlockSize, spanByClass.get(r.classId) ?? 1),
      consecutiveBlocksPerWeek: r.consecutiveBlocksPerWeek,
      blockMayCrossBreak: r.blockMayCrossBreak,
    })),
    teachers: teachers.map((t) => ({
      id: t.id,
      name: t.name,
      maxPeriodsPerDay: t.maxPeriodsPerDay,
      minPeriodsPerDay: t.minPeriodsPerDay,
      maxConsecutivePeriodsPerDay: t.maxConsecutivePeriodsPerDay,
      canSubstitute: t.canSubstitute,
      maxPeriodsPerWeek: t.maxPeriodsPerWeek,
      classTeacherPeriodRule: t.classTeacherPeriodRule,
      periodPattern: t.periodPattern,
      alternateDaySet: (t.alternateDaySet as number[] | null) ?? null,
      eligibleClassIds: t.eligibility.map((e) => e.classId),
      employmentType: t.employmentType,
      unavailableFullDays: t.unavailability
        .filter((u) => u.periodNumber === null)
        .map((u) => u.dayOfWeek),
      unavailablePeriodCount: t.unavailability.filter((u) => u.periodNumber !== null).length,
    })),
    mappings: mappings.map((m) => ({
      id: m.id,
      teacherId: m.teacherId,
      teacherName: m.teacher.name,
      subjectId: m.subjectId,
      subjectName: m.subject.name,
      classSectionId: m.classSectionId,
      classSectionLabel: `${m.classSection.class.name}-${m.classSection.section.name}`,
      periodsPerWeek: m.periodsPerWeek,
    })),
    mergedGroups: mergedGroups.map((g) => ({
      id: g.id,
      teacherId: g.teacherId,
      subjectId: g.subjectId,
      subjectName: g.subject.name,
      periodsPerWeek: g.periodsPerWeek,
      memberClassSectionIds: g.members.map((m) => m.classSectionId),
    })),
    // §32 — a block whose every option belongs to a subject this timetable
    // does not teach is not a block any more. Dropped rather than emitted
    // empty: the solver would otherwise hold a macro-variable it can never
    // satisfy, and Readiness would report a block that cannot be filled.
    electiveBlocks: electiveBlocks.filter((b) => b.options.length > 0).map((b) => ({
      id: b.id,
      name: b.name,
      periodsPerWeek: b.periodsPerWeek,
      maxPeriodsPerDay: b.maxPeriodsPerDay,
      placement: b.placement,
      // Only meaningful under `fixed`; carrying it regardless would let a
      // stale pin quietly narrow a block the school has since set free.
      fixedSlots: b.placement === "fixed" ? parsePins(b.fixedSlots) : [],
      memberClassSectionIds: b.members.map((m) => m.classSectionId),
      memberLabels: b.members.map(
        (m) => `${m.classSection.class.name}-${m.classSection.section.name}`,
      ),
      options: b.options.map((o) => ({
        id: o.id,
        subjectId: o.subjectId,
        subjectName: o.subject.name,
        teacherId: o.teacherId,
        teacherName: o.teacher.name,
        roomId: o.roomId,
        roomName: o.room.name,
      })),
    })),
    crossConfigTeacherLoad,
    labRoomCount: labRooms,
    labSubjectIds: labSubjects.map((s) => s.id),
    subjectPlacement: Object.fromEntries(allSubjects.map((s) => [s.id, {
      subjectName: s.name,
      category: s.category,
      priority: s.priority,
      lunchRule: s.lunchRule,
      gapAfterLunch: s.gapAfterLunch,
    }])),
    // §27.16 — only the subjects that actually declared something. A subject
    // with no rows stays out of the map entirely, so "not stated" and "stated
    // as nothing" cannot be told apart by accident downstream: there is only
    // one of them.
    subjectClasses: Object.fromEntries(
      allSubjects.filter((s) => s.classes.length > 0).map((s) => [s.id, s.classes.map((c) => c.classId)]),
    ),
    homeRoomBySection: Object.fromEntries(classSections.map((cs) => [cs.id, cs.homeRoomId])),
    // §4.7b — the engine needs the counts (Check 1 subtracts them from the
    // week, Check 1b intersects them with a subject's); the solver takes the
    // cells from `SolverInput`. Same rows, read once here.
    classSectionTimeOff: sectionOff.map((r) => ({ id: r.classSectionId, dayOfWeek: r.dayOfWeek, periodNumber: r.periodNumber })),
    subjectTimeOff: subjectOff.map((r) => ({ id: r.subjectId, dayOfWeek: r.dayOfWeek, periodNumber: r.periodNumber })),
    // §36 — what Check 14 reads. Empty for every school that has pinned nothing.
    fixedLessons: pinned,
    roomTimeOff: roomOff.map((r) => ({ id: r.roomId, dayOfWeek: r.dayOfWeek, periodNumber: r.periodNumber })),
    labRoomsBySubject,
    // §19.1 — whether, and where. See the note by their construction above.
    ownRoomSubjectIds,
    ownRoomsBySubject,
    roomNames: Object.fromEntries(allRooms.map((r) => [r.id, r.name])),
    // §21: a remedy that hands a class-section a free room has to be able to
    // tell a classroom from a lab, which `roomNames` cannot.
    rooms: allRooms.map((r) => ({
      id: r.id,
      name: r.name,
      roomType: r.roomType,
      capacity: r.capacity,
      isShared: r.isShared,
      subjectIds: r.subjects.map((x) => x.subjectId),
    })),
  };
}

export async function buildSolverInput(
  prisma: PrismaClient,
  configId: number,
  /**
   * §22 — which draft's locked cells count as fixed. Omitted means every one,
   * which is only correct for a config that has no named drafts at all.
   */
  draftId?: number | null,
): Promise<SolverInput> {
  const snapshot = await buildFeasibilitySnapshot(prisma, configId);
  const sectionIds = snapshot.classSections.map((c) => c.id);
  const [unavail, labRooms, mappingsWithRooms, groups, locked, fixed] = await Promise.all([
    prisma.teacherUnavailability.findMany({
      where: { teacher: { isActive: true } },
    }),
    prisma.room.findMany({ where: { roomType: "lab" }, select: { id: true } }),
    prisma.teacherSubjectClassSection.findMany({
      where: { classSectionId: { in: sectionIds }, preferredRoomId: { not: null } },
      select: { id: true, preferredRoomId: true },
    }),
    prisma.mergedTeachingGroup.findMany({
      where: { members: { some: { classSectionId: { in: sectionIds } } } },
      select: { id: true, roomId: true },
    }),
    // §22: locked cells belong to ONE draft. Unscoped, generating Draft #4
    // would treat Draft #2's pinned cells as fixed — invariant 13 applied
    // across a boundary it was never meant to cross.
    prisma.timetableSlot.findMany({
      where: {
        timetableConfigId: configId,
        status: "draft",
        isLocked: true,
        ...(draftId !== undefined && draftId !== null ? { draftId } : {}),
      },
    }),
    // §36 — no draft filter, deliberately: see the note where they are mapped.
    prisma.timetableFixedLesson.findMany({
      where: { timetableConfigId: configId },
      select: {
        classSectionId: true, subjectId: true, teacherId: true,
        dayOfWeek: true, periodNumber: true, roomId: true,
      },
      orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
    }),
  ]);
  return {
    snapshot,
    teacherUnavailability: unavail.map((u) => ({
      teacherId: u.teacherId,
      dayOfWeek: u.dayOfWeek,
      periodNumber: u.periodNumber,
    })),
    /*
      §4.7b — re-read from the snapshot rather than queried again.

      `buildFeasibilitySnapshot` has already fetched exactly these rows, and the
      solver and Readiness must prune the same cells: two queries would be two
      chances to filter differently, and the disagreement would show up as a
      timetable that breaks a rule Readiness had just passed.
    */
    classSectionUnavailability: snapshot.classSectionTimeOff ?? [],
    subjectUnavailability: snapshot.subjectTimeOff ?? [],
    roomUnavailability: snapshot.roomTimeOff ?? [],
    labRoomIds: labRooms.map((r) => r.id),
    preferredRoomByMapping: Object.fromEntries(
      mappingsWithRooms.map((m) => [m.id, m.preferredRoomId as number]),
    ),
    mergedGroupRooms: Object.fromEntries(groups.map((g) => [g.id, g.roomId])),
    /*
      §36 — the lessons this timetable has pinned to a cell.

      By CONFIG, not by draft: unlike `lockedSlots` above, a fixed lesson is the
      school's standing intention and has to be honoured whichever draft is
      being generated. That difference is the whole reason it is its own table.
    */
    fixedLessons: fixed.map((f) => ({
      classSectionId: f.classSectionId,
      subjectId: f.subjectId,
      teacherId: f.teacherId,
      dayOfWeek: f.dayOfWeek,
      periodNumber: f.periodNumber,
      roomId: f.roomId,
    })),
    lockedSlots: locked
      // A locked cell is something a person pinned in a section's grid, so it
      // always has a section. An elective *option* row has none (§4.9) — it is
      // the lesson under a block, not a cell — and the block's own member rows
      // carry the lock.
      .filter((l) => l.classSectionId !== null && l.subjectId !== null && l.teacherId !== null)
      .map((l) => ({
        classSectionId: l.classSectionId as number,
        dayOfWeek: l.dayOfWeek,
        periodNumber: l.periodNumber,
        subjectId: l.subjectId as number,
        teacherId: l.teacherId as number,
        roomId: l.roomId,
      })),
    seed: configId,
  };
}
