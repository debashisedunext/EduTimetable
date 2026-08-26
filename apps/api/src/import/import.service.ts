/**
 * §16 — import orchestration. Loads what the school already has, runs the pure
 * validator, and (only when the plan is clean) writes everything in ONE
 * transaction in dependency order.
 *
 * Two guarantees the rest of the app relies on:
 *  - nothing is written unless every row of every sheet validated, and
 *  - a row that already exists is never touched, so re-uploading is a no-op.
 */
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import {
  dayNumber,
  runFeasibility,
  validateWorkbook,
  type ExistingData,
  type ImportPlan,
  type ValidatedRow,
} from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { buildFeasibilitySnapshot } from "../solver/input";
import { annotateWorkbook, buildWorkbook, parseWorkbook } from "./workbook";

export interface DryRunResult {
  plan: ImportPlan;
  unknownSheets: string[];
  truncated: string[];
  /** what the Readiness score would be after importing, when it can be computed */
  readinessPreview: { timetable: string; before: number; note: string } | null;
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  // ---------------------------------------------------------------- snapshot

  private label(cs: { class: { name: string }; section: { name: string } }) {
    return `${cs.class.name}-${cs.section.name}`;
  }

  async existingData(schoolId: number): Promise<ExistingData> {
    const [years, classes, sections, rooms, subjects, teachers, curriculum, mappings, configs, blocks] =
      await Promise.all([
        this.prisma.academicYear.findMany({ where: { schoolId } }),
        this.prisma.schoolClass.findMany({ where: { schoolId } }),
        this.prisma.classSection.findMany({
          where: { class: { schoolId } },
          include: { class: true, section: true, timetableConfig: true },
        }),
        this.prisma.room.findMany({ where: { schoolId } }),
        this.prisma.subject.findMany({ where: { schoolId } }),
        this.prisma.teacher.findMany({ where: { schoolId } }),
        this.prisma.classSubject.findMany({ where: { class: { schoolId } }, include: { class: true, subject: true } }),
        this.prisma.teacherSubjectClassSection.findMany({
          where: { classSection: { class: { schoolId } } },
          include: { subject: true, classSection: { include: { class: true, section: true } } },
        }),
        this.prisma.timetableConfig.findMany({ where: { schoolId } }),
        this.prisma.electiveBlock.findMany({ where: { schoolId }, select: { name: true } }),
      ]);

    const capacityByTimetable: Record<string, number> = {};
    for (const c of configs) {
      const days = Array.isArray(c.workingDays) ? (c.workingDays as number[]).length : 5;
      capacityByTimetable[c.name] = c.periodsPerDay * days;
    }
    const capacityByClassSection: Record<string, { cap: number; timetable: string }> = {};
    for (const cs of sections) {
      if (!cs.timetableConfig) continue;
      capacityByClassSection[this.label(cs)] = {
        cap: capacityByTimetable[cs.timetableConfig.name] ?? 0,
        timetable: cs.timetableConfig.name,
      };
    }

    return {
      academicYears: years.map((y) => y.name),
      classes: classes.map((c) => c.name),
      classSections: sections.map((cs) => this.label(cs)),
      rooms: rooms.map((r) => r.name),
      subjects: subjects.map((s) => s.name),
      teacherCodes: teachers.map((t) => t.employeeCode),
      activeTeacherCodes: teachers.filter((t) => t.isActive).map((t) => t.employeeCode),
      curriculum: curriculum.map((r) => `${r.class.name}||${r.subject.name}`),
      mappings: mappings.map((m) => `${m.subject.name}||${this.label(m.classSection)}`),
      classTeacherAssigned: sections.filter((cs) => cs.classTeacherId !== null).map((cs) => this.label(cs)),
      electiveBlocks: blocks.map((b) => b.name),
      timetables: configs.map((c) => c.name),
      capacityByTimetable,
      capacityByClassSection,
    };
  }

  // ------------------------------------------------------------- template/export

  async template(schoolId: number): Promise<Buffer> {
    const e = await this.existingData(schoolId);
    return buildWorkbook({
      existing: {
        "Academic Years": e.academicYears,
        Classes: e.classes,
        "Class-Sections": e.classSections,
        Rooms: e.rooms,
        Subjects: e.subjects,
        "Teacher Codes": e.teacherCodes,
        Timetables: e.timetables,
      },
    });
  }

  /** The same workbook, filled with the school's current masters (round-trip). */
  async exportCurrent(schoolId: number): Promise<Buffer> {
    const e = await this.existingData(schoolId);
    const [years, classes, sections, rooms, subjects, teachers, unavailability, curriculum, mappings, merged, blocks] =
      await Promise.all([
        this.prisma.academicYear.findMany({ where: { schoolId }, orderBy: { name: "asc" } }),
        this.prisma.schoolClass.findMany({ where: { schoolId }, orderBy: { sequence: "asc" } }),
        this.prisma.classSection.findMany({
          where: { class: { schoolId } },
          include: { class: true, section: true, academicYear: true, homeRoom: true, timetableConfig: true, classTeacher: true },
          orderBy: [{ class: { sequence: "asc" } }, { section: { name: "asc" } }],
        }),
        this.prisma.room.findMany({ where: { schoolId }, orderBy: { name: "asc" } }),
        this.prisma.subject.findMany({ where: { schoolId }, orderBy: { name: "asc" } }),
        this.prisma.teacher.findMany({ where: { schoolId }, orderBy: { name: "asc" } }),
        this.prisma.teacherUnavailability.findMany({ where: { teacher: { schoolId } }, include: { teacher: true } }),
        this.prisma.classSubject.findMany({ where: { class: { schoolId } }, include: { class: true, subject: true } }),
        this.prisma.teacherSubjectClassSection.findMany({
          where: { classSection: { class: { schoolId } } },
          include: { teacher: true, subject: true, classSection: { include: { class: true, section: true } }, preferredRoom: true },
        }),
        this.prisma.mergedTeachingGroup.findMany({
          where: { schoolId },
          include: { teacher: true, subject: true, room: true, members: { include: { classSection: { include: { class: true, section: true } } } } },
        }),
        this.prisma.electiveBlock.findMany({
          where: { schoolId },
          include: {
            members: { include: { classSection: { include: { class: true, section: true } } } },
            options: { include: { subject: true, teacher: true, room: true } },
          },
          orderBy: { name: "asc" },
        }),
      ]);

    const DAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return buildWorkbook({
      existing: {
        "Academic Years": e.academicYears,
        Classes: e.classes,
        "Class-Sections": e.classSections,
        Rooms: e.rooms,
        Subjects: e.subjects,
        "Teacher Codes": e.teacherCodes,
        Timetables: e.timetables,
      },
      data: {
        "Academic Years": years.map((y) => ({ name: y.name, startDate: y.startDate, endDate: y.endDate, isActive: y.isActive })),
        Classes: classes.map((c) => ({ name: c.name, sequence: c.sequence })),
        "Class Sections": sections.map((cs) => ({
          className: cs.class.name, sectionName: cs.section.name, academicYear: cs.academicYear.name,
          strength: cs.strength, homeRoom: cs.homeRoom?.name ?? null, timetable: cs.timetableConfig?.name ?? null,
        })),
        Rooms: rooms.map((r) => ({ name: r.name, roomType: r.roomType, capacity: r.capacity, isShared: r.isShared })),
        Subjects: subjects.map((s) => ({ name: s.name, code: s.code, isLab: s.isLab, requiresDoublePeriod: s.requiresDoublePeriod })),
        Teachers: teachers.map((t) => ({
          employeeCode: t.employeeCode, name: t.name, maxPeriodsPerDay: t.maxPeriodsPerDay, maxPeriodsPerWeek: t.maxPeriodsPerWeek,
          classTeacherPeriodRule: t.classTeacherPeriodRule, periodPattern: t.periodPattern,
          alternateDaySet: Array.isArray(t.alternateDaySet) ? (t.alternateDaySet as number[]).map((d) => DAYS[d]) : [],
          isActive: t.isActive,
        })),
        "Teacher Unavailability": unavailability.map((u) => ({
          employeeCode: u.teacher.employeeCode, day: DAYS[u.dayOfWeek], period: u.periodNumber, reason: u.reason,
        })),
        Curriculum: curriculum.map((r) => ({
          className: r.class.name, subjectName: r.subject.name, periodsPerWeek: r.periodsPerWeek,
          maxPeriodsPerDay: r.maxPeriodsPerDay, samePeriodAcrossWeek: r.samePeriodAcrossWeek,
          consecutiveBlockSize: r.consecutiveBlockSize, consecutiveBlocksPerWeek: r.consecutiveBlocksPerWeek,
        })),
        "Class Teachers": sections
          .filter((cs) => cs.classTeacher)
          .map((cs) => ({ classSection: this.label(cs), employeeCode: cs.classTeacher!.employeeCode })),
        "Subject Mapping": [
          ...mappings.map((m) => ({
            employeeCode: m.teacher.employeeCode, subjectName: m.subject.name,
            classSections: [this.label(m.classSection)], periodsPerWeek: m.periodsPerWeek,
            room: m.preferredRoom?.name ?? null, merged: false,
          })),
          ...merged.map((g) => ({
            employeeCode: g.teacher.employeeCode, subjectName: g.subject.name,
            classSections: g.members.map((mm) => this.label(mm.classSection)),
            periodsPerWeek: g.periodsPerWeek, room: g.room?.name ?? null, merged: true,
          })),
        ],
        // One row per option, with the block's own columns repeated — the shape
        // a person would fill in by hand, and the shape the importer reads back.
        Electives: blocks.flatMap((b) =>
          b.options.map((o) => ({
            blockName: b.name,
            classSections: b.members.map((mm) => this.label(mm.classSection)),
            periodsPerWeek: b.periodsPerWeek,
            maxPeriodsPerDay: b.maxPeriodsPerDay,
            subjectName: o.subject.name,
            employeeCode: o.teacher.employeeCode,
            room: o.room.name,
          })),
        ),
      },
    });
  }

  // ------------------------------------------------------------------ dry run

  async dryRun(schoolId: number, file: Buffer): Promise<DryRunResult & { rows: Record<string, ValidatedRow[]> }> {
    let parsed;
    try {
      parsed = await parseWorkbook(file);
    } catch (e) {
      throw new BadRequestException(
        `That file could not be opened as an Excel workbook (${(e as Error).message}). Save it as .xlsx and try again.`,
      );
    }
    const existing = await this.existingData(schoolId);
    const { plan, rows } = validateWorkbook(parsed.sheets, existing);
    this.checkElectiveRowsAgree(rows, plan);

    // readiness today, so the preview can say what the import is working toward
    let readinessPreview: DryRunResult["readinessPreview"] = null;
    const configs = await this.prisma.timetableConfig.findMany({ where: { schoolId }, take: 1 });
    if (configs[0]) {
      try {
        const snap = await buildFeasibilitySnapshot(this.prisma, configs[0].id);
        const before = runFeasibility(snap);
        readinessPreview = {
          timetable: configs[0].name,
          before: before.score,
          note: plan.ok
            ? "Import first, then open the Readiness dashboard to see the new score."
            : "Fix the errors below before this can be imported.",
        };
      } catch {
        readinessPreview = null;
      }
    }

    return { plan, rows, unknownSheets: parsed.unknownSheets, truncated: parsed.truncated, readinessPreview };
  }

  /**
   * The Electives sheet is one row per *option*, so a block's own columns —
   * which sections attend and how many periods — are repeated down its rows.
   * The committer takes the first row's values, which is only safe if they all
   * agree. Rather than silently picking one, say which row disagrees.
   *
   * This lives here rather than in the shared validator because it is the one
   * rule in the contract that spans rows; everything else is per-cell.
   */
  private checkElectiveRowsAgree(rows: Record<string, ValidatedRow[]>, plan: ImportPlan) {
    const seen = new Map<string, { row: number; sections: string; periods: number }>();
    for (const r of rows["Electives"] ?? []) {
      const key = String(r.data.blockName).toLowerCase();
      const sections = ((r.data.classSections as string[]) ?? [])
        .map((x) => x.toLowerCase().trim())
        .sort()
        .join(", ");
      const periods = r.data.periodsPerWeek as number;
      const first = seen.get(key);
      if (!first) {
        seen.set(key, { row: r.row, sections, periods });
        continue;
      }
      if (first.sections !== sections) {
        this.addIssue(plan, r, "classSections",
          `${r.data.blockName} lists different class-sections here than on row ${first.row} — every option of a block is taught to the same students at the same time.`,
          `Make this row's Class-Sections match row ${first.row}.`);
      }
      if (first.periods !== periods) {
        this.addIssue(plan, r, "periodsPerWeek",
          `${r.data.blockName} says ${periods} periods/week here but ${first.periods} on row ${first.row} — the figure belongs to the block, not to one option.`,
          `Make this row's Periods/Week ${first.periods}, or correct row ${first.row}.`);
      }
    }
  }

  private addIssue(plan: ImportPlan, r: ValidatedRow, column: string, message: string, fix: string) {
    plan.issues.push({ severity: "error", sheet: "Electives", row: r.row, column, code: "ELECTIVE_ROWS_DISAGREE", message, fix });
    const sheet = plan.sheets.find((s) => s.sheet === "Electives");
    if (sheet) {
      sheet.errors += 1;
      if (sheet.create > 0) sheet.create -= 1;
    }
    plan.totals.errors += 1;
    if (plan.totals.create > 0) plan.totals.create -= 1;
    plan.ok = false;
  }

  async annotate(file: Buffer, schoolId: number): Promise<Buffer> {
    const { plan } = await this.dryRun(schoolId, file);
    return annotateWorkbook(file, plan.issues);
  }

  // ------------------------------------------------------------------- commit

  async commit(schoolId: number, file: Buffer) {
    // re-validate from the file itself — never trust a plan handed back by a client
    const { plan, rows } = await this.dryRun(schoolId, file);
    if (!plan.ok) {
      throw new BadRequestException(
        `This file still has ${plan.totals.errors} error(s) — nothing was imported. Run the preview to see them.`,
      );
    }
    if (plan.totals.create === 0) {
      return { ok: true, created: {}, message: "Everything in this file already exists — nothing to import.", plan };
    }

    const created: Record<string, number> = {};
    const bump = (k: string, n = 1) => { created[k] = (created[k] ?? 0) + n; };
    const isNew = (r: ValidatedRow) => !r.existing;
    const at = (name: string) => rows[name] ?? [];

    await this.prisma.$transaction(
      async (tx) => {
        const lc = (s: string) => s.toLowerCase();

        // ---- 1. academic years ----
        for (const r of at("Academic Years").filter(isNew)) {
          await tx.academicYear.create({
            data: {
              schoolId, name: r.data.name,
              startDate: new Date(`${r.data.startDate}T00:00:00.000Z`),
              endDate: new Date(`${r.data.endDate}T00:00:00.000Z`),
              isActive: r.data.isActive ?? true,
            },
          });
          bump("academicYears");
        }
        const years = new Map((await tx.academicYear.findMany({ where: { schoolId } })).map((y) => [lc(y.name), y.id]));

        // ---- 2. classes ----
        for (const r of at("Classes").filter(isNew)) {
          await tx.schoolClass.create({ data: { schoolId, name: r.data.name, sequence: r.data.sequence ?? 0 } });
          bump("classes");
        }
        const classes = new Map((await tx.schoolClass.findMany({ where: { schoolId } })).map((c) => [lc(c.name), c.id]));

        // ---- 3. rooms ----
        for (const r of at("Rooms").filter(isNew)) {
          await tx.room.create({
            data: {
              schoolId, name: r.data.name,
              roomType: (r.data.roomType ?? "classroom") as never,
              capacity: r.data.capacity ?? null,
              isShared: r.data.isShared ?? r.data.roomType === "lab",
            },
          });
          bump("rooms");
        }
        const rooms = new Map((await tx.room.findMany({ where: { schoolId } })).map((x) => [lc(x.name), x.id]));

        // ---- 4. subjects ----
        for (const r of at("Subjects").filter(isNew)) {
          await tx.subject.create({
            data: {
              schoolId, name: r.data.name, code: r.data.code ?? null,
              isLab: r.data.isLab ?? false, requiresDoublePeriod: r.data.requiresDoublePeriod ?? false,
            },
          });
          bump("subjects");
        }
        const subjects = new Map((await tx.subject.findMany({ where: { schoolId } })).map((s) => [lc(s.name), s.id]));

        // ---- 5. teachers ----
        for (const r of at("Teachers").filter(isNew)) {
          const days: string[] = r.data.alternateDaySet ?? [];
          await tx.teacher.create({
            data: {
              schoolId, employeeCode: r.data.employeeCode, name: r.data.name,
              maxPeriodsPerDay: r.data.maxPeriodsPerDay ?? 6,
              maxPeriodsPerWeek: r.data.maxPeriodsPerWeek ?? 30,
              classTeacherPeriodRule: (r.data.classTeacherPeriodRule ?? "none") as never,
              periodPattern: (r.data.periodPattern ?? "every_period") as never,
              alternateDaySet: days.length > 0 ? days.map((d) => dayNumber(d)!) : undefined,
              isActive: r.data.isActive ?? true,
            },
          });
          bump("teachers");
        }
        const teachers = new Map((await tx.teacher.findMany({ where: { schoolId } })).map((t) => [lc(t.employeeCode), t.id]));

        // ---- 6. class-sections (creates the Section row too) ----
        const configs = new Map((await tx.timetableConfig.findMany({ where: { schoolId } })).map((c) => [lc(c.name), c.id]));
        for (const r of at("Class Sections").filter(isNew)) {
          const classId = classes.get(lc(r.data.className))!;
          const section =
            (await tx.section.findFirst({ where: { classId, name: r.data.sectionName } })) ??
            (await tx.section.create({ data: { schoolId, classId, name: r.data.sectionName } }));
          await tx.classSection.create({
            data: {
              schoolId,
              classId,
              sectionId: section.id,
              academicYearId: years.get(lc(r.data.academicYear))!,
              strength: r.data.strength ?? null,
              homeRoomId: r.data.homeRoom ? (rooms.get(lc(r.data.homeRoom)) ?? null) : null,
              timetableConfigId: r.data.timetable ? (configs.get(lc(r.data.timetable)) ?? null) : null,
            },
          });
          bump("classSections");
        }
        const sectionRows = await tx.classSection.findMany({
          where: { class: { schoolId } },
          include: { class: true, section: true },
        });
        const sections = new Map(sectionRows.map((cs) => [lc(`${cs.class.name}-${cs.section.name}`), cs.id]));

        // ---- 7. teacher unavailability (no DB unique key — dedupe here) ----
        const existingUnavail = new Set(
          (await tx.teacherUnavailability.findMany({ where: { teacher: { schoolId } } })).map(
            (u) => `${u.teacherId}|${u.dayOfWeek}|${u.periodNumber ?? ""}`,
          ),
        );
        for (const r of at("Teacher Unavailability")) {
          const teacherId = teachers.get(lc(r.data.employeeCode));
          if (!teacherId) continue;
          const key = `${teacherId}|${dayNumber(r.data.day)}|${r.data.period ?? ""}`;
          if (existingUnavail.has(key)) continue;
          existingUnavail.add(key);
          await tx.teacherUnavailability.create({
            data: {
              schoolId,
              teacherId,
              dayOfWeek: dayNumber(r.data.day)!,
              periodNumber: r.data.period ?? null,
              reason: r.data.reason ?? null,
            },
          });
          bump("teacherUnavailability");
        }

        // ---- 8. curriculum ----
        for (const r of at("Curriculum").filter(isNew)) {
          const blockSize = r.data.consecutiveBlockSize ?? 1;
          await tx.classSubject.create({
            data: {
              schoolId,
              classId: classes.get(lc(r.data.className))!,
              subjectId: subjects.get(lc(r.data.subjectName))!,
              periodsPerWeek: r.data.periodsPerWeek,
              maxPeriodsPerDay: r.data.maxPeriodsPerDay ?? 1,
              samePeriodAcrossWeek: r.data.samePeriodAcrossWeek ?? false,
              consecutiveBlockSize: blockSize,
              consecutiveBlocksPerWeek: blockSize > 1 ? (r.data.consecutiveBlocksPerWeek ?? null) : null,
            },
          });
          bump("curriculum");
        }

        // ---- 9. class teachers ----
        for (const r of at("Class Teachers").filter(isNew)) {
          const csId = sections.get(lc(r.data.classSection));
          const teacherId = teachers.get(lc(r.data.employeeCode));
          if (!csId || !teacherId) continue;
          await tx.classSection.update({ where: { id: csId }, data: { classTeacherId: teacherId } });
          bump("classTeachers");
        }

        // ---- 10. subject mapping + merged groups ----
        const mappedAlready = new Set(
          (
            await tx.teacherSubjectClassSection.findMany({
              where: { classSection: { class: { schoolId } } },
              include: { subject: true, classSection: { include: { class: true, section: true } } },
            })
          ).map((m) => `${lc(m.subject.name)}||${lc(`${m.classSection.class.name}-${m.classSection.section.name}`)}`),
        );
        const mergedKeys = new Set(
          (
            await tx.mergedTeachingGroup.findMany({ where: { schoolId }, include: { members: true, subject: true } })
          ).map((g) => `${lc(g.subject.name)}|${g.teacherId}|${g.members.map((m) => m.classSectionId).sort().join(",")}`),
        );

        for (const r of at("Subject Mapping")) {
          const teacherId = teachers.get(lc(r.data.employeeCode));
          const subjectId = subjects.get(lc(r.data.subjectName));
          const roomId = r.data.room ? (rooms.get(lc(r.data.room)) ?? null) : null;
          const ids = (r.data.classSections as string[]).map((s) => sections.get(lc(s))).filter((x): x is number => !!x);
          if (!teacherId || !subjectId || ids.length === 0) continue;

          if (r.data.merged === true) {
            const key = `${lc(r.data.subjectName)}|${teacherId}|${[...ids].sort().join(",")}`;
            if (mergedKeys.has(key)) continue;
            mergedKeys.add(key);
            await tx.mergedTeachingGroup.create({
              data: {
                schoolId, teacherId, subjectId, periodsPerWeek: r.data.periodsPerWeek, roomId,
                members: { create: ids.map((classSectionId) => ({ classSectionId, schoolId })) },
              },
            });
            bump("mergedGroups");
            continue;
          }

          for (const classSectionId of ids) {
            const label = sectionRows.find((cs) => cs.id === classSectionId)!;
            const key = `${lc(r.data.subjectName)}||${lc(`${label.class.name}-${label.section.name}`)}`;
            if (mappedAlready.has(key)) continue;
            mappedAlready.add(key);
            await tx.teacherSubjectClassSection.create({
              data: {
                schoolId, teacherId, subjectId, classSectionId,
                periodsPerWeek: r.data.periodsPerWeek, preferredRoomId: roomId,
              },
            });
            bump("mappings");
          }
        }

        // ---- 11. split electives (§4.9) ----
        // One row per option, so rows are grouped by block name first. The
        // block's own columns (sections, periods) are repeated on every row of
        // a block; the first row wins, and `dryRun` has already refused a file
        // where they disagree rather than silently picking one.
        const blockKeys = new Set(
          (await tx.electiveBlock.findMany({ where: { schoolId } })).map((b) => lc(b.name)),
        );
        const rowsForElectives = at("Electives");
        const byBlock = new Map<string, typeof rowsForElectives>();
        for (const r of rowsForElectives) {
          const key = lc(r.data.blockName);
          const list = byBlock.get(key) ?? [];
          list.push(r);
          byBlock.set(key, list);
        }
        for (const [key, optionRows] of byBlock) {
          if (blockKeys.has(key)) continue; // skip-existing, like every other sheet
          const head = optionRows[0];
          const memberIds = (head.data.classSections as string[])
            .map((x) => sections.get(lc(x)))
            .filter((x): x is number => !!x);
          const options = optionRows
            .map((r) => ({
              subjectId: subjects.get(lc(r.data.subjectName)),
              teacherId: teachers.get(lc(r.data.employeeCode)),
              roomId: rooms.get(lc(r.data.room)),
            }))
            .filter(
              (o): o is { subjectId: number; teacherId: number; roomId: number } =>
                !!o.subjectId && !!o.teacherId && !!o.roomId,
            );
          if (memberIds.length === 0 || options.length < 2) continue;
          await tx.electiveBlock.create({
            data: {
              schoolId,
              name: String(head.data.blockName),
              periodsPerWeek: head.data.periodsPerWeek as number,
              maxPeriodsPerDay: (head.data.maxPeriodsPerDay as number | null) ?? 1,
              members: { create: memberIds.map((classSectionId) => ({ classSectionId, schoolId })) },
              options: { create: options.map((o) => ({ ...o, schoolId })) },
            },
          });
          bump("electiveBlocks");
        }
      },
      { timeout: 120_000, maxWait: 20_000 },
    );

    await this.readiness.invalidate(schoolId);
    this.logger.log(`import committed for school ${schoolId}: ${JSON.stringify(created)}`);
    return { ok: true, created, plan, message: "Import complete." };
  }
}
