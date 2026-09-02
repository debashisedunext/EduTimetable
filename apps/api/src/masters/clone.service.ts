/**
 * §3.12 Phase 19 Step 2 — clone a timetable into a new academic session.
 *
 * A school does not rebuild its timetable from nothing every April. Next
 * session has the same classes, the same syllabus and very nearly the same
 * staffing as this one; what changes is a handful of rows. Retyping 600 of
 * them to change 20 is the single biggest piece of pointless work the app
 * currently asks for.
 *
 * The rule that shapes everything here: **copy the inputs, never the outputs.**
 * Config settings, periods, class-sections, curriculum, mappings, merged groups
 * and elective blocks are copied. `timetable_slots`, drafts and publications
 * are not — the admin adjusts and presses Generate, which is what they were
 * going to do anyway. That also keeps this code entirely clear of the
 * `draft_scope` unique-key machinery (§22), which is where the risk would be.
 *
 * The whole algorithm is one map. `class_sections` is keyed
 * (class, section, academic_year), so cloning into a NEW year mints new section
 * rows; build `oldSectionId → newSectionId` once and every dependent table is a
 * straight re-point. Teachers, subjects and rooms are school-wide and carry
 * over unchanged, which is why this is tractable at all.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { runFeasibility } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { buildFeasibilitySnapshot } from "../solver/input";

/** One thing the admin should see before pressing the button. */
export interface CloneNote {
  code: string;
  /** what is true */
  message: string;
  /** what to do about it */
  fix: string;
  /** the exact rows, so this is never a vague warning */
  rows: string[];
}

export interface ClonePlan {
  source: { id: number; name: string; academicYear: string };
  target: { academicYearId: number; academicYear: string; name: string };
  counts: {
    periods: number;
    classSectionsNew: number;
    classSectionsReused: number;
    classTeachers: number;
    curriculum: number;
    mappings: number;
    mergedGroups: number;
    electiveBlocks: number;
    electiveOptions: number;
  };
  /** rows that already exist in the target session and will be left alone */
  skipped: { curriculum: number; mappings: number };
  /** things that stop the clone entirely */
  blockers: CloneNote[];
  /** things that will not stop it, but the admin must know */
  warnings: CloneNote[];
  /** what the source timetable reads today — the clone reproduces its structure */
  sourceReadiness: number | null;
}

export interface CloneRequest {
  name: string;
  academicYearId?: unknown;
  newYear?: { name?: unknown; startDate?: unknown; endDate?: unknown };
}

const label = (cs: { class: { name: string }; section: { name: string } }) =>
  `${cs.class.name}-${cs.section.name}`;

@Injectable()
export class CloneService {
  private readonly logger = new Logger(CloneService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  // ------------------------------------------------------------------ preview

  /**
   * Everything the clone would do, without doing any of it. The commit path
   * re-derives this from scratch rather than trusting a client-held plan, so
   * the preview is advice and never authority (§16's rule for the importer).
   */
  async plan(schoolId: number, sourceId: number, req: CloneRequest): Promise<ClonePlan> {
    const src = await this.loadSource(sourceId);
    const targetYear = await this.resolveTargetYear(schoolId, src.config.academicYearId, req, false);

    const blockers: CloneNote[] = [];
    const warnings: CloneNote[] = [];

    // ---- the name has to be free in the target session (uq schoolId+name+year)
    const nameTaken = await this.prisma.timetableConfig.findFirst({
      where: { name: req.name, academicYearId: targetYear.id },
      select: { id: true },
    });
    if (nameTaken) {
      blockers.push({
        code: "NAME_TAKEN",
        message: `${targetYear.name} already has a timetable called "${req.name}".`,
        fix: "Give the clone a different name.",
        rows: [req.name],
      });
    }

    // ---- class-sections: mint the missing ones, reuse free ones, refuse claimed ones
    const existing = await this.prisma.classSection.findMany({
      where: {
        academicYearId: targetYear.id,
        classId: { in: [...new Set(src.sections.map((s) => s.classId))] },
      },
      include: { class: true, section: true, timetableConfig: true },
    });
    const existingBy = new Map(existing.map((cs) => [`${cs.classId}:${cs.sectionId}`, cs]));

    const claimed = src.sections
      .map((s) => existingBy.get(`${s.classId}:${s.sectionId}`))
      .filter((cs): cs is NonNullable<typeof cs> => Boolean(cs))
      .filter((cs) => cs.timetableConfigId !== null);
    if (claimed.length > 0) {
      blockers.push({
        code: "SECTION_CLAIMED",
        message: `${claimed.length} class-section(s) already exist in ${targetYear.name} and belong to another timetable.`,
        fix: "A class-section belongs to exactly one timetable (§3.10). Release them from that timetable, or clone into a session that does not have them yet.",
        rows: claimed.map((cs) => `${label(cs)} → ${cs.timetableConfig!.name}`),
      });
    }

    const reused = src.sections.filter((s) => existingBy.has(`${s.classId}:${s.sectionId}`)).length;

    // ---- staffing that will not survive the move
    const dropped = this.staffingNotes(src);
    warnings.push(...dropped.notes);

    // ---- rows the target session already has, which are never overwritten
    const [curriculumHave, mappingHave] = await Promise.all([
      this.prisma.classSubject.findMany({
        where: { academicYearId: targetYear.id, classId: { in: src.curriculum.map((c) => c.classId) } },
        select: { classId: true, subjectId: true },
      }),
      existing.length === 0
        ? Promise.resolve([])
        : this.prisma.teacherSubjectClassSection.findMany({
            where: { classSectionId: { in: existing.map((cs) => cs.id) } },
            select: { classSectionId: true, subjectId: true },
          }),
    ]);
    const curriculumSeen = new Set(curriculumHave.map((c) => `${c.classId}:${c.subjectId}`));
    const mappingSeen = new Set(
      mappingHave.map((m) => {
        const cs = existing.find((e) => e.id === m.classSectionId)!;
        return `${cs.classId}:${cs.sectionId}:${m.subjectId}`;
      }),
    );

    const curriculumNew = src.curriculum.filter((c) => !curriculumSeen.has(`${c.classId}:${c.subjectId}`));
    const mappingsKept = src.mappings.filter((m) => !dropped.mappingIds.has(m.id));
    const mappingsNew = mappingsKept.filter(
      (m) => !mappingSeen.has(`${m.classSection.classId}:${m.classSection.sectionId}:${m.subjectId}`),
    );

    // ---- groups and blocks that reach outside this timetable
    const partial = [...src.mergedGroups, ...src.electiveBlocks].filter((g) =>
      g.members.some((m: { classSectionId: number }) => !src.sectionIds.has(m.classSectionId)),
    );
    if (partial.length > 0) {
      warnings.push({
        code: "SPANS_TIMETABLES",
        message: `${partial.length} group(s) include class-sections from another timetable and will not be copied.`,
        fix: "Rebuild them in the new session once its other wing exists — a group can only be copied when this timetable owns every member.",
        rows: partial.map((g) => ("name" in g && g.name ? String(g.name) : `Merged group ${g.id}`)),
      });
    }
    const mergedWhole = src.mergedGroups.filter((g) => !partial.includes(g as never));
    const electivesWhole = src.electiveBlocks.filter((b) => !partial.includes(b as never));

    // ---- what the source reads today; the clone reproduces its structure
    let sourceReadiness: number | null = null;
    try {
      sourceReadiness = runFeasibility(await buildFeasibilitySnapshot(this.prisma, sourceId)).score;
    } catch {
      // A source that cannot be snapshotted is still cloneable — the number is
      // a courtesy, not a gate.
      sourceReadiness = null;
    }

    return {
      source: { id: src.config.id, name: src.config.name, academicYear: src.config.academicYear.name },
      target: { academicYearId: targetYear.id, academicYear: targetYear.name, name: req.name },
      counts: {
        periods: src.config.periods.length,
        classSectionsNew: src.sections.length - reused,
        classSectionsReused: reused,
        classTeachers: src.sections.filter(
          (s) => s.classTeacherId !== null && !dropped.teacherIds.has(s.classTeacherId),
        ).length,
        curriculum: curriculumNew.length,
        mappings: mappingsNew.length,
        mergedGroups: mergedWhole.length,
        electiveBlocks: electivesWhole.length,
        electiveOptions: electivesWhole.reduce((n, b) => n + b.options.length, 0),
      },
      skipped: {
        curriculum: src.curriculum.length - curriculumNew.length,
        mappings: mappingsKept.length - mappingsNew.length,
      },
      blockers,
      warnings,
      sourceReadiness,
    };
  }

  // ------------------------------------------------------------------- commit

  /**
   * The plan is recomputed here, from the database, and only its own findings
   * are acted on. The request says *what to clone into what*, never *what to
   * write* — the same rule §21's auto-resolve follows.
   */
  async commit(schoolId: number, sourceId: number, req: CloneRequest) {
    const preflight = await this.plan(schoolId, sourceId, req);
    if (preflight.blockers.length > 0) {
      throw new BadRequestException(
        `Cannot clone: ${preflight.blockers.map((b) => b.message).join(" ")}`,
      );
    }

    const src = await this.loadSource(sourceId);
    const targetYear = await this.resolveTargetYear(schoolId, src.config.academicYearId, req, true);
    const dropped = this.staffingNotes(src);

    const created = await this.prisma.$transaction(async (tx) => {
      const c = src.config;
      const config = await tx.timetableConfig.create({
        data: {
          schoolId,
          academicYearId: targetYear.id,
          name: req.name,
          description: c.description,
          workingDays: c.workingDays as never,
          periodsPerDay: c.periodsPerDay,
          periodDurationMins: c.periodDurationMins,
          hasZeroPeriod: c.hasZeroPeriod,
          zeroPeriodDurationMins: c.zeroPeriodDurationMins,
          allowConsecutivePeriods: c.allowConsecutivePeriods,
          classTeacherGetsFirstPeriod: c.classTeacherGetsFirstPeriod,
          startTime: c.startTime,
          endTime: c.endTime,
          // §18: the extra-class WINDOW is part of the day's shape, so it comes
          // across. The extra classes booked into it deliberately do not — a
          // revision class runs on dates, and next session's are not this
          // session's.
          extraPeriodsPerDay: c.extraPeriodsPerDay,
          extraPeriodDurationMins: c.extraPeriodDurationMins,
          extraDays: (c.extraDays ?? undefined) as never,
          // Always a draft: a clone has not been generated yet, let alone
          // checked, so it must not arrive wearing the source's `active` badge.
          status: "draft",
        },
      });

      await tx.period.createMany({
        data: c.periods.map((p) => ({
          schoolId,
          timetableConfigId: config.id,
          sortOrder: p.sortOrder,
          periodNumber: p.periodNumber,
          startTime: p.startTime,
          endTime: p.endTime,
          isBreak: p.isBreak,
          isExtra: p.isExtra,
          breakName: p.breakName,
        })),
      });

      // ---- the one map everything else hangs off
      const sectionMap = new Map<number, number>();
      for (const s of src.sections) {
        const already = await tx.classSection.findFirst({
          where: { classId: s.classId, sectionId: s.sectionId, academicYearId: targetYear.id },
        });
        const keepTeacher = s.classTeacherId !== null && !dropped.teacherIds.has(s.classTeacherId);
        const row = already
          ? await tx.classSection.update({
              where: { id: already.id },
              data: {
                timetableConfigId: config.id,
                strength: already.strength ?? s.strength,
                homeRoomId: already.homeRoomId ?? s.homeRoomId,
                classTeacherId: already.classTeacherId ?? (keepTeacher ? s.classTeacherId : null),
              },
            })
          : await tx.classSection.create({
              data: {
                schoolId,
                classId: s.classId,
                sectionId: s.sectionId,
                academicYearId: targetYear.id,
                timetableConfigId: config.id,
                strength: s.strength,
                homeRoomId: s.homeRoomId,
                classTeacherId: keepTeacher ? s.classTeacherId : null,
              },
            });
        sectionMap.set(s.id, row.id);
      }

      // ---- curriculum (§3.11: per session, so this is a real copy not a share)
      let curriculum = 0;
      for (const r of src.curriculum) {
        const exists = await tx.classSubject.findFirst({
          where: { classId: r.classId, subjectId: r.subjectId, academicYearId: targetYear.id },
          select: { id: true },
        });
        if (exists) continue;
        await tx.classSubject.create({
          data: {
            schoolId,
            classId: r.classId,
            academicYearId: targetYear.id,
            subjectId: r.subjectId,
            periodsPerWeek: r.periodsPerWeek,
            maxPeriodsPerDay: r.maxPeriodsPerDay,
            samePeriodAcrossWeek: r.samePeriodAcrossWeek,
            consecutiveBlockSize: r.consecutiveBlockSize,
            consecutiveBlocksPerWeek: r.consecutiveBlocksPerWeek,
          },
        });
        curriculum++;
      }

      // ---- mappings: the bulk of the typing this whole feature exists to save
      let mappings = 0;
      for (const m of src.mappings) {
        if (dropped.mappingIds.has(m.id)) continue;
        const target = sectionMap.get(m.classSectionId);
        if (target === undefined) continue;
        const exists = await tx.teacherSubjectClassSection.findFirst({
          where: { subjectId: m.subjectId, classSectionId: target },
          select: { id: true },
        });
        if (exists) continue;
        await tx.teacherSubjectClassSection.create({
          data: {
            schoolId,
            teacherId: m.teacherId,
            subjectId: m.subjectId,
            classSectionId: target,
            periodsPerWeek: m.periodsPerWeek,
            preferredRoomId: m.preferredRoomId,
          },
        });
        mappings++;
      }

      // ---- merged groups: only those this timetable owns outright
      let mergedGroups = 0;
      for (const g of src.mergedGroups) {
        if (g.members.some((m) => !sectionMap.has(m.classSectionId))) continue;
        if (dropped.teacherIds.has(g.teacherId)) continue;
        await tx.mergedTeachingGroup.create({
          data: {
            schoolId,
            subjectId: g.subjectId,
            teacherId: g.teacherId,
            periodsPerWeek: g.periodsPerWeek,
            roomId: g.roomId,
            consecutiveBlockSize: g.consecutiveBlockSize,
            members: {
              create: g.members.map((m) => ({ schoolId, classSectionId: sectionMap.get(m.classSectionId)! })),
            },
          },
        });
        mergedGroups++;
      }

      // ---- §4.9 split electives, options and all
      let electiveBlocks = 0;
      let electiveOptions = 0;
      for (const b of src.electiveBlocks) {
        if (b.members.some((m) => !sectionMap.has(m.classSectionId))) continue;
        const options = b.options.filter((o) => !dropped.teacherIds.has(o.teacherId));
        if (options.length === 0) continue;
        await tx.electiveBlock.create({
          data: {
            schoolId,
            name: b.name,
            periodsPerWeek: b.periodsPerWeek,
            maxPeriodsPerDay: b.maxPeriodsPerDay,
            // §4.9 Phase 15: `fixed` pins exact cells, and those cells are a
            // property of the week's shape, which came across with the periods.
            placement: b.placement,
            fixedSlots: (b.fixedSlots ?? undefined) as never,
            members: {
              create: b.members.map((m) => ({ schoolId, classSectionId: sectionMap.get(m.classSectionId)! })),
            },
            options: {
              create: options.map((o) => ({
                schoolId,
                subjectId: o.subjectId,
                teacherId: o.teacherId,
                roomId: o.roomId,
              })),
            },
          },
        });
        electiveBlocks++;
        electiveOptions += options.length;
      }

      return {
        id: config.id,
        name: config.name,
        counts: {
          periods: c.periods.length,
          classSections: sectionMap.size,
          curriculum,
          mappings,
          mergedGroups,
          electiveBlocks,
          electiveOptions,
        },
      };
    }, { timeout: 120_000 });

    await this.readiness.invalidate(schoolId);

    // What it actually reads, not what we predicted it would.
    let readiness: number | null = null;
    try {
      readiness = runFeasibility(await buildFeasibilitySnapshot(this.prisma, created.id)).score;
    } catch {
      readiness = null;
    }

    this.logger.log(
      `Cloned timetable ${sourceId} → ${created.id} into ${targetYear.name}: ` +
        `${created.counts.classSections} class-sections, ${created.counts.mappings} mappings, ` +
        `${created.counts.curriculum} curriculum rows`,
    );

    return {
      ...created,
      academicYearId: targetYear.id,
      academicYear: targetYear.name,
      readiness,
      warnings: preflight.warnings,
    };
  }

  // ------------------------------------------------------------------ helpers

  /**
   * The source graph. Read through the scoped client, so another school's
   * config is simply not found — a 404, never a successful clone of nothing.
   */
  private async loadSource(sourceId: number) {
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: sourceId },
      include: { periods: { orderBy: { sortOrder: "asc" } }, academicYear: true },
    });
    if (!config) throw new NotFoundException("Timetable config not found");

    const sections = await this.prisma.classSection.findMany({
      where: { timetableConfigId: sourceId },
      include: { class: true, section: true, classTeacher: true },
    });
    if (sections.length === 0) {
      throw new BadRequestException(
        `"${config.name}" has no class-sections, so there is nothing to clone — assign its classes first (Setup → Classes & Sections).`,
      );
    }
    const sectionIds = new Set(sections.map((s) => s.id));
    const classIds = [...new Set(sections.map((s) => s.classId))];

    const [curriculum, mappings, mergedGroups, electiveBlocks] = await Promise.all([
      // §3.11: this session's syllabus, not every session's.
      this.prisma.classSubject.findMany({
        where: { classId: { in: classIds }, academicYearId: config.academicYearId },
      }),
      this.prisma.teacherSubjectClassSection.findMany({
        where: { classSectionId: { in: [...sectionIds] } },
        // §18 eligibility comes along so the preview can check it without a
        // second pass over every teacher.
        include: {
          teacher: { include: { eligibility: true } },
          subject: true,
          classSection: { include: { class: true, section: true } },
        },
      }),
      this.prisma.mergedTeachingGroup.findMany({
        where: { members: { some: { classSectionId: { in: [...sectionIds] } } } },
        include: { members: true, teacher: true, subject: true },
      }),
      this.prisma.electiveBlock.findMany({
        where: { members: { some: { classSectionId: { in: [...sectionIds] } } } },
        include: { members: true, options: { include: { teacher: true, subject: true } } },
      }),
    ]);

    return { config, sections, sectionIds, curriculum, mappings, mergedGroups, electiveBlocks };
  }

  /**
   * Which session to clone into. Either an existing year or one created on the
   * spot — a school that has never run a second session has no year to pick,
   * and sending them to another screen to make one is how a clone becomes a
   * three-screen errand.
   */
  private async resolveTargetYear(
    schoolId: number,
    sourceYearId: number,
    req: CloneRequest,
    write: boolean,
  ) {
    if (req.academicYearId !== undefined && req.academicYearId !== null && req.academicYearId !== "") {
      const id = Number(req.academicYearId);
      if (!Number.isInteger(id)) throw new BadRequestException("academicYearId must be an integer");
      const year = await this.prisma.academicYear.findFirst({ where: { id } });
      if (!year) throw new NotFoundException("Academic year not found");
      this.assertDifferentSession(year.id, sourceYearId);
      return year;
    }

    const spec = req.newYear;
    if (!spec?.name || !spec.startDate || !spec.endDate) {
      throw new BadRequestException(
        "Choose the session to clone into: either academicYearId, or newYear { name, startDate, endDate }.",
      );
    }
    const existing = await this.prisma.academicYear.findFirst({ where: { name: String(spec.name) } });
    if (existing) {
      this.assertDifferentSession(existing.id, sourceYearId);
      return existing;
    }
    if (!write) {
      // Preview must not create anything. Report the year it *would* make, with
      // id 0 — the commit path is the only thing that mints one.
      return { id: 0, name: String(spec.name) };
    }
    return this.prisma.academicYear.create({
      data: {
        schoolId,
        name: String(spec.name),
        startDate: new Date(String(spec.startDate)),
        endDate: new Date(String(spec.endDate)),
        // The new session is not the live one until somebody says so; flipping
        // `is_active` is what tells the rest of the school the year has turned.
        isActive: false,
      },
    });
  }

  private assertDifferentSession(targetYearId: number, sourceYearId: number) {
    if (targetYearId !== sourceYearId) return;
    throw new BadRequestException(
      "A timetable can only be cloned into a DIFFERENT academic session. " +
        "A class-section belongs to one session and one timetable (§3.10), so the same session cannot hold two copies of it — " +
        "to try alternative placements within this session, use named drafts on the Board instead (§22).",
    );
  }

  /**
   * Staffing that must not come across, and why.
   *
   * Dropped rather than copied on purpose: a mapping to a teacher who has left
   * produces a timetable that cannot be generated. The curriculum row still
   * records that Class 5-A needs six periods of English, so Readiness will say
   * "no teacher for English in 5-A" — which is the actionable sentence. Copying
   * the dead mapping would instead say nothing until Generate failed.
   */
  private staffingNotes(src: Awaited<ReturnType<CloneService["loadSource"]>>) {
    const teacherIds = new Set<number>();
    const mappingIds = new Set<number>();
    const inactive: string[] = [];
    const guests: string[] = [];
    const ineligible: string[] = [];

    const seen = new Map<number, { name: string; isActive: boolean; employmentType: string }>();
    for (const m of src.mappings) seen.set(m.teacherId, m.teacher);
    for (const g of src.mergedGroups) seen.set(g.teacherId, g.teacher);
    for (const b of src.electiveBlocks) for (const o of b.options) seen.set(o.teacherId, o.teacher);
    for (const s of src.sections) if (s.classTeacher) seen.set(s.classTeacher.id, s.classTeacher);

    for (const [id, t] of seen) {
      if (!t.isActive) {
        teacherIds.add(id);
        inactive.push(t.name);
      } else if (t.employmentType === "guest") {
        // §18: a guest is refused the regular curriculum entirely, so a guest
        // holding one is data that predates the rule. Do not carry it forward.
        teacherIds.add(id);
        guests.push(t.name);
      }
    }

    for (const m of src.mappings) {
      if (teacherIds.has(m.teacherId)) mappingIds.add(m.id);
    }

    // §18 — a *declared* scope. An empty one means "not stated", never "no
    // classes", so only a teacher who has named their classes can be outside
    // them. Warned rather than dropped: unlike a teacher who has left, this is
    // a rule the admin can simply widen, and dropping would silently lose a
    // real teaching assignment they probably want to keep.
    for (const m of src.mappings) {
      if (teacherIds.has(m.teacherId)) continue;
      const scope = m.teacher.eligibility;
      if (scope.length === 0) continue;
      if (scope.some((e) => e.classId === m.classSection.classId)) continue;
      ineligible.push(`${m.teacher.name} → ${label(m.classSection)} (${m.subject.name})`);
    }

    const notes: CloneNote[] = [];
    if (inactive.length > 0) {
      notes.push({
        code: "INACTIVE_TEACHER",
        message: `${inactive.length} teacher(s) are no longer active, so their lessons will not be copied.`,
        fix: "Assign someone else on the Teacher Mapping screen after cloning — the curriculum still records the periods, so Readiness will name each gap.",
        rows: inactive.sort(),
      });
    }
    if (guests.length > 0) {
      notes.push({
        code: "GUEST_TEACHER",
        message: `${guests.length} guest teacher(s) hold regular lessons, which §18 does not allow.`,
        fix: "Guests take extra classes only. Their lessons are left out of the clone; give them to a permanent teacher.",
        rows: guests.sort(),
      });
    }
    if (ineligible.length > 0) {
      notes.push({
        code: "NOT_ELIGIBLE",
        message: `${ineligible.length} mapping(s) name a teacher who is not eligible for that class (§18). They will be copied as they are.`,
        fix: "Widen the teacher's classes on the Teachers screen, or map somebody else — Feasibility Check 8 will keep reporting these until one or the other is done.",
        rows: ineligible.sort(),
      });
    }
    return { teacherIds, mappingIds, notes };
  }
}
