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
  categoryFromLabel,
  categoryToLabel,
  dayNumber,
  defaultsFor,
  LUNCH_LABEL,
  lunchRuleFromLabel,
  formatPins,
  parsePins,
  parsePinText,
  placementFromLabel,
  placementToLabel,
  runFeasibility,
  validateWorkbook,
  type RawSheet,
  type ExistingData,
  type ImportPlan,
  type ValidatedRow,
} from "@edutimetable/shared";
import { Prisma } from "@prisma/client";

/**
 * §4.9 Phase 15 — the Electives sheet's two placement columns, turned into the
 * pair of database fields.
 *
 * Deliberately forgiving: a `Fixed slots` row whose slot list cannot be read
 * falls back to letting the solver choose rather than importing a half-pinned
 * block. A file that pins nothing produces a school that generates; a file
 * that pins the wrong cells produces one that does not, and the person who
 * typed it is not in the room to be asked.
 */
function electivePlacement(data: Record<string, unknown>): {
  placement: "solver" | "same_period" | "fixed";
  fixedSlots: Prisma.InputJsonValue | typeof Prisma.DbNull;
} {
  const placement = placementFromLabel(data.placement);
  if (placement !== "fixed") return { placement, fixedSlots: Prisma.DbNull };
  const { pins, bad } = parsePinText(String(data.fixedSlots ?? ""));
  if (bad.length > 0 || pins.length === 0) return { placement: "solver", fixedSlots: Prisma.DbNull };
  return { placement, fixedSlots: pins.map((p) => ({ day: p.day, period: p.period })) };
}
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { ResourceGroupService } from "../groups/resource-group.service";
import { buildFeasibilitySnapshot } from "../solver/input";
import { classSequence } from "../masters/class-sequence";
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
    private readonly groups: ResourceGroupService,
  ) {}

  // ---------------------------------------------------------------- snapshot

  private label(cs: { class: { name: string }; section: { name: string } }) {
    return `${cs.class.name}-${cs.section.name}`;
  }

  async existingData(schoolId: number): Promise<ExistingData> {
    // §30 — the shared pool of each session, so a sheet row that names no
    // timetable can still resolve to one.
    const pools = new Map(
      (await this.prisma.timetableGroup.findMany({ where: { schoolId, mode: "grouped" }, orderBy: { id: "asc" } }))
        .map((g) => [g.academicYearId, g.id] as const),
    );
    const [years, classes, sections, rooms, subjects, teachers, curriculum, mappings, configs, blocks] =
      await Promise.all([
        this.prisma.academicYear.findMany({ where: { schoolId } }),
        this.prisma.schoolClass.findMany({ where: { schoolId } }),
        this.prisma.classSection.findMany({
          where: { class: { schoolId } },
          include: { class: true, section: true, academicYear: true, timetableConfig: true },
        }),
        this.prisma.room.findMany({ where: { schoolId } }),
        this.prisma.subject.findMany({ where: { schoolId } }),
        this.prisma.teacher.findMany({ where: { schoolId } }),
        this.prisma.classSubject.findMany({ where: { class: { schoolId } }, include: { class: true, subject: true, academicYear: true } }),
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
    // Phase 19: keyed "year||label". The same "Class 5-A" exists once per
    // session it has run, so a bare label let the last one loaded win.
    const capacityByClassSection: Record<string, { cap: number; timetable: string }> = {};
    for (const cs of sections) {
      if (!cs.timetableConfig) continue;
      capacityByClassSection[`${cs.academicYear.name}||${this.label(cs)}`] = {
        cap: capacityByTimetable[cs.timetableConfig.name] ?? 0,
        timetable: cs.timetableConfig.name,
      };
    }

    return {
      academicYears: years.map((y) => y.name),
      classes: classes.map((c) => c.name),
      // Plain labels: this list is also what every other sheet's `Class Section`
      // column is checked against, and what the template offers as a reference.
      classSections: sections.map((cs) => this.label(cs)),
      /*
        §30 — the same rows, qualified by pool, for the one question that needs
        it: does THIS row already exist? Class 1-A exists once per pool, so the
        label alone would tell an individual timetable that the main wing's
        Class 1-A is its own — and it would open with no classes and no error.
      */
      classSectionsInPool: sections.map((cs) => `${this.label(cs)}||${cs.resourceGroupId}`),
      rooms: rooms.map((r) => r.name),
      subjects: subjects.map((s) => s.name),
      teacherCodes: teachers.map((t) => t.employeeCode),
      activeTeacherCodes: teachers.filter((t) => t.isActive).map((t) => t.employeeCode),
      curriculum: curriculum.map((r) => `${r.class.name}||${r.subject.name}||${r.academicYear.name}`),
      mappings: mappings.map((m) => `${m.subject.name}||${this.label(m.classSection)}`),
      classTeacherAssigned: sections.filter((cs) => cs.classTeacherId !== null).map((cs) => this.label(cs)),
      electiveBlocks: blocks.map((b) => b.name),
      timetables: configs.map((c) => c.name),
      // §30 — how a sheet row resolves to a pool: its timetable's, or its
      // session's when it names none. The same rule
      // `ResourceGroupService.forSection` applies on the write.
      poolByTimetable: Object.fromEntries(configs.map((c) => [c.name.trim().toLowerCase(), c.resourceGroupId])),
      poolByYear: Object.fromEntries(
        years.map((y) => [y.name.trim().toLowerCase(), pools.get(y.id) ?? 0]),
      ),
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
        this.prisma.room.findMany({
          where: { schoolId },
          include: { subjects: { include: { subject: true } }, homeRoomOf: { include: { class: true, section: true } } },
          orderBy: { name: "asc" },
        }),
        this.prisma.subject.findMany({
          where: { schoolId },
          // §27.16 — ordered by the ladder, so the exported cell reads
          // "Class 1, Class 2, Class 10" rather than alphabetically, where
          // "Class 10" sorts between 1 and 2.
          include: { classes: { include: { class: true }, orderBy: { class: { sequence: "asc" } } } },
          orderBy: { name: "asc" },
        }),
        this.prisma.teacher.findMany({
          where: { schoolId },
          include: {
            eligibility: { include: { class: true }, orderBy: { class: { sequence: "asc" } } },
            teacherSubjects: { include: { subject: true }, orderBy: { subject: { name: "asc" } } },
          },
          orderBy: { name: "asc" },
        }),
        this.prisma.teacherUnavailability.findMany({ where: { teacher: { schoolId } }, include: { teacher: true } }),
        this.prisma.classSubject.findMany({ where: { class: { schoolId } }, include: { class: true, subject: true, academicYear: true } }),
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
        Rooms: rooms.map((r) => ({
          name: r.name, roomType: r.roomType, capacity: r.capacity, isShared: r.isShared,
          homeFor: r.homeRoomOf[0] ? this.label(r.homeRoomOf[0]) : null,
          subjectNames: r.subjects.map((x) => x.subject.name),
        })),
        // §26.2 — the placement columns ride the round trip. Without them an
        // export→import loses every rule the school set, which is exactly the
        // no-op the export is supposed to be.
        Subjects: subjects.map((s) => ({
          name: s.name, code: s.code, isLab: s.isLab, requiresDoublePeriod: s.requiresDoublePeriod,
          // §19.1 — the flag rides the round trip too. WHERE it is taught is
          // already on the Rooms sheet, so the pair survives an export/import.
          taughtInOwnRoom: s.taughtInOwnRoom,
          category: categoryToLabel(s.category),
          priority: s.priority,
          lunchRule: LUNCH_LABEL[s.lunchRule],
          gapAfterLunch: s.gapAfterLunch,
          // §27.16 — so a downloaded workbook round-trips what it was given.
          classNames: s.classes.map((x) => x.class.name),
        })),
        Teachers: teachers.map((t) => ({
          employeeCode: t.employeeCode, name: t.name, maxPeriodsPerDay: t.maxPeriodsPerDay,
          minPeriodsPerDay: t.minPeriodsPerDay, maxPeriodsPerWeek: t.maxPeriodsPerWeek,
          classTeacherPeriodRule: t.classTeacherPeriodRule, periodPattern: t.periodPattern,
          alternateDaySet: Array.isArray(t.alternateDaySet) ? (t.alternateDaySet as number[]).map((d) => DAYS[d]) : [],
          classNames: t.eligibility.map((e) => e.class.name),
          // §27.13 — so a downloaded workbook round-trips what it was given.
          subjectNames: t.teacherSubjects.map((x) => x.subject.name),
          employmentType: t.employmentType,
          isActive: t.isActive,
          initials: t.initials,
          gender: t.gender,
          email: t.email,
          maxConsecutivePeriodsPerDay: t.maxConsecutivePeriodsPerDay,
          canSubstitute: t.canSubstitute,
        })),
        "Teacher Unavailability": unavailability.map((u) => ({
          employeeCode: u.teacher.employeeCode, day: DAYS[u.dayOfWeek], period: u.periodNumber, reason: u.reason,
        })),
        Curriculum: curriculum.map((r) => ({
          className: r.class.name, academicYear: r.academicYear.name,
          subjectName: r.subject.name, periodsPerWeek: r.periodsPerWeek,
          maxPeriodsPerDay: r.maxPeriodsPerDay, samePeriodAcrossWeek: r.samePeriodAcrossWeek,
          consecutiveBlockSize: r.consecutiveBlockSize, consecutiveBlocksPerWeek: r.consecutiveBlocksPerWeek,
          blockMayCrossBreak: r.blockMayCrossBreak,
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
            // §4.9 Phase 15: repeated on every option row like the block's
            // other columns, so an export re-imports to the same block.
            placement: placementToLabel(b.placement),
            fixedSlots: b.placement === "fixed" ? formatPins(parsePins(b.fixedSlots)) : "",
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
    return this.dryRunSheets(schoolId, parsed.sheets, parsed.unknownSheets, parsed.truncated);
  }

  /**
   * The dry run, from rows rather than from a file (§13.5).
   *
   * `validateWorkbook` was always written to take plain rows — that is what let
   * the §23 ERP sync reuse it instead of growing a second validator. The AI
   * data-entry path is the third source into the same pipe, so a proposal the
   * assistant drafts is checked by exactly the same rules an upload is: the
   * duplicate detection, the cross-sheet reference resolution, the §4.8 block
   * rule, the weekly-capacity guard. A separate validator for the AI would
   * eventually disagree with this one, and the disagreement would be silent.
   */
  async dryRunSheets(
    schoolId: number,
    sheets: RawSheet[],
    unknownSheets: string[] = [],
    truncated: string[] = [],
  ): Promise<DryRunResult & { rows: Record<string, ValidatedRow[]> }> {
    const parsed = { sheets, unknownSheets, truncated };
    const existing = await this.existingData(schoolId);
    const { plan, rows } = validateWorkbook(parsed.sheets, existing);
    this.checkElectiveRowsAgree(rows, plan);
    this.checkElectivePlacement(rows, plan);

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

  /**
   * §4.9 Phase 15 — the `When` / `Fixed Slots` pair.
   *
   * Pinning removes cells from the solver rather than nudging it, so a file
   * that names them wrongly must be refused here, at the cell, not quietly
   * downgraded to "solver chooses" at commit time. The person who typed
   * "Mondey P4" needs to be told; a school that silently loses its language
   * slot finds out weeks later.
   */
  private checkElectivePlacement(rows: Record<string, ValidatedRow[]>, plan: ImportPlan) {
    const firstOf = new Map<string, { row: number; placement: string }>();
    for (const r of rows["Electives"] ?? []) {
      const key = String(r.data.blockName).toLowerCase();
      const placement = placementFromLabel(r.data.placement);
      const text = String(r.data.fixedSlots ?? "").trim();

      const first = firstOf.get(key);
      if (!first) firstOf.set(key, { row: r.row, placement });
      else if (first.placement !== placement) {
        this.addIssue(plan, r, "placement",
          `${r.data.blockName} says '${placementToLabel(placement)}' here but '${placementToLabel(first.placement)}' on row ${first.row} — when a block runs belongs to the block, not to one option.`,
          `Make this row's When match row ${first.row}.`);
      }

      if (placement !== "fixed") {
        if (text) {
          this.addIssue(plan, r, "fixedSlots",
            `${r.data.blockName} lists fixed slots but When is '${placementToLabel(placement)}', so they would be ignored.`,
            `Set When to 'Fixed slots' to use them, or clear the Fixed Slots cell.`,
            "ELECTIVE_PIN_IGNORED");
        }
        continue;
      }

      const { pins, bad } = parsePinText(text);
      if (bad.length > 0) {
        this.addIssue(plan, r, "fixedSlots",
          `Could not read ${bad.map((b) => `'${b}'`).join(", ")} as a slot.`,
          `Write each slot as a day and a period, e.g. Mon P4, Wed P4.`,
          "ELECTIVE_PIN_UNREADABLE");
        continue;
      }
      const wanted = r.data.periodsPerWeek as number;
      if (pins.length !== wanted) {
        this.addIssue(plan, r, "fixedSlots",
          pins.length === 0
            ? `${r.data.blockName} is set to fixed slots but none are listed.`
            : `${r.data.blockName} needs ${wanted} periods/week but ${pins.length} slot(s) are fixed.`,
          `List exactly ${wanted} slot(s), e.g. ${Array.from({ length: Math.min(wanted, 3) }, (_, i) => `${["Mon", "Wed", "Fri"][i]} P4`).join(", ")}${wanted > 3 ? ", …" : ""}.`,
          "ELECTIVE_PIN_COUNT");
      }
      const seen = new Set<string>();
      for (const pin of pins) {
        const k = `${pin.day}:${pin.period}`;
        if (seen.has(k)) {
          this.addIssue(plan, r, "fixedSlots",
            `${formatPins([pin])} is listed twice — one slot can only hold this block once.`,
            `Remove the repeat, or move it to another day or period.`,
            "ELECTIVE_PIN_DUPLICATE");
          break;
        }
        seen.add(k);
      }
    }
  }

  private addIssue(plan: ImportPlan, r: ValidatedRow, column: string, message: string, fix: string, code = "ELECTIVE_ROWS_DISAGREE") {
    plan.issues.push({ severity: "error", sheet: "Electives", row: r.row, column, code, message, fix });
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
    return this.applyValidated(schoolId, plan, rows);
  }

  /**
   * Commit rows that did not come from a file (§13.5).
   *
   * Re-validates here rather than accepting a caller's plan — the same rule the
   * file path holds to. The AI proposal is re-read from its server-side stash
   * and checked again at the moment of the write, so a preview taken minutes
   * ago cannot become the list of writes.
   */
  async commitSheets(schoolId: number, sheets: RawSheet[]) {
    const { plan, rows } = await this.dryRunSheets(schoolId, sheets);
    return this.applyValidated(schoolId, plan, rows);
  }

  private async applyValidated(
    schoolId: number,
    plan: DryRunResult["plan"],
    rows: Record<string, ValidatedRow[]>,
  ) {
    if (!plan.ok) {
      throw new BadRequestException(
        `There ${plan.totals.errors === 1 ? "is" : "are"} still ${plan.totals.errors} error(s) — nothing was written. Run the preview to see them.`,
      );
    }
    /*
      §16.1 — no longer an early return, and that is the point.

      This used to answer "everything here already exists — nothing to add" the
      moment `create === 0`, and skip the whole transaction. Creating is not the
      only thing a commit does: it also links rows that exist to each other — a
      section to its timetable, a lab to its subjects, a teacher to what they
      teach — and those links are not part of any natural key, so a row can
      exist with a link missing and no amount of pressing Next would ever fill
      it in. That is precisely what a school hit: every class entered, every
      wing created, `timetable_config_id` NULL on all 32 sections, and Readiness
      reporting 0% for a timetable with no classes.

      The pass below is safe to run with nothing new: every create loop filters
      on `isNew` and does nothing, and the linking steps are written to be
      idempotent because they already ran on every commit that had any create
      at all. What changes is only that "nothing new" no longer means "do
      nothing" — it means "nothing new to create", and the message says so.
    */

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
        // The first free number past the ladder, for a class name the ladder
        // does not know. Counted up as rows are created so two off-ladder
        // classes in one sheet do not both land on it.
        let nextOffLadder = (await tx.schoolClass.aggregate({
          where: { schoolId }, _max: { sequence: true },
        }))._max.sequence ?? 0;
        for (const r of at("Classes").filter(isNew)) {
          // Never 0 — see `classSequence`. A blank Sequence column used to put
          // the row above the whole school rather than at the end of it.
          const sequence = classSequence(r.data.name, r.data.sequence, nextOffLadder + 1);
          nextOffLadder = Math.max(nextOffLadder, sequence);
          await tx.schoolClass.create({ data: { schoolId, name: r.data.name, sequence } });
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

        // §19: which subjects each lab teaches. Written after both rooms and
        // subjects exist. Home rooms are set later, once class-sections do.
        const subjectIdByName0 = new Map(
          (await tx.subject.findMany({ where: { schoolId } })).map((s) => [lc(s.name), s.id]),
        );
        for (const r of at("Rooms")) {
          const names = (r.data.subjectNames as string[] | undefined) ?? [];
          if (names.length === 0) continue;
          const roomId = rooms.get(lc(r.data.name));
          if (!roomId) continue;
          const ids = [...new Set(names.map((n) => subjectIdByName0.get(lc(n))).filter((x): x is number => !!x))];
          if (ids.length === 0) continue;
          await tx.roomSubject.deleteMany({ where: { roomId } });
          await tx.roomSubject.createMany({ data: ids.map((subjectId) => ({ roomId, subjectId, schoolId })) });
          bump("roomSubjects", ids.length);
        }

        // ---- 4. subjects ----
        // Read BEFORE the creates, so the update loop below can only ever match
        // a subject that already existed — a row created a moment ago has
        // nothing to update and its columns were just written in full.
        const existingSubjects = new Map(
          (await tx.subject.findMany({ where: { schoolId }, select: { id: true, name: true } }))
            .map((x: { id: number; name: string }) => [lc(x.name), x.id]),
        );
        for (const r of at("Subjects").filter(isNew)) {
          // §26.2 — a blank placement column is filled from the subject's NAME
          // by the same classifier the screens use. A school uploading last
          // year's sheet has none of these columns, and "Games" arriving
          // unclassified would be a worse answer than the one its name gives.
          const d = defaultsFor(r.data.name);
          await tx.subject.create({
            data: {
              schoolId, name: r.data.name, code: r.data.code ?? null,
              isLab: r.data.isLab ?? false, requiresDoublePeriod: r.data.requiresDoublePeriod ?? false,
              // §19.1. Blank is false, not `defaultsFor`: the classifier has no
              // opinion about whether a school HAS a music room, and guessing
              // Yes would send every music lesson to a room that may not exist.
              taughtInOwnRoom: r.data.taughtInOwnRoom ?? false,
              // An enum column validates to its LABEL ("Any time"), not the
              // stored value — hence the conversion, which also accepts the
              // raw value so a hand-edited sheet still imports.
              category: categoryFromLabel(r.data.category) ?? d.category,
              priority: r.data.priority ?? d.priority,
              lunchRule: lunchRuleFromLabel(r.data.lunchRule) ?? d.lunchRule,
              gapAfterLunch: r.data.gapAfterLunch ?? d.gapAfterLunch,
            },
          });
          bump("subjects");
        }

        /**
         * §16.2 — an EXISTING subject's settings are updated, not skipped.
         *
         * A school changed Physical Education from "after lunch" to "any time"
         * on the guided setup's Subjects step, pressed Next, and the master was
         * untouched: the loop above is `filter(isNew)`, so every column on this
         * sheet was create-only. The screen said one thing, `subjects` said
         * another, and the solver — which reads the master — went on confining
         * PE to one period a day (§26.4).
         *
         * This is §16.1's lesson on a different column set. A commit is not
         * only a create: the guided setup and the Subjects master are two doors
         * onto one row, and a door that can only ever add is a door that lies
         * the second time somebody walks through it.
         *
         * **Only the fields the sheet actually states.** `validate` leaves a
         * blank cell `undefined` — it is the committer above that applies
         * `defaultsFor` — so an absent value is "not decided", never a
         * decision. Without that, a school re-uploading a workbook exported
         * before these columns existed would have every placement rule it had
         * set quietly replaced by the classifier's guess. Same rule as the
         * `Classes` and `Teaching Scope` columns below, and it exists for the
         * same reason.
         *
         * The NAME is never written: it is the natural key, and a changed key
         * is a new subject rather than a rename (§13.5's rule).
         */
        for (const r of at("Subjects").filter((x) => !isNew(x))) {
          /*
            `!= null`, deliberately loose: `validate` gives a blank cell **null**,
            not `undefined`. Guarding only `undefined` let those nulls through
            and Prisma refused the write — which the CBSE catalogue smoke caught
            on its second Create. Worth stating because the strict check would
            have been the dangerous kind of wrong if the columns had been
            nullable: every blank cell writing a null is exactly the "re-upload
            an old workbook and lose your settings" failure this guard exists to
            prevent, and it would have looked like it was preventing it.
          */
          const patch: Record<string, unknown> = {};
          if (r.data.code != null) patch.code = r.data.code;
          if (r.data.isLab != null) patch.isLab = r.data.isLab;
          if (r.data.requiresDoublePeriod != null) patch.requiresDoublePeriod = r.data.requiresDoublePeriod;
          if (r.data.taughtInOwnRoom != null) patch.taughtInOwnRoom = r.data.taughtInOwnRoom;
          const category = categoryFromLabel(r.data.category);
          if (category != null) patch.category = category;
          if (r.data.priority != null) patch.priority = r.data.priority;
          const lunchRule = lunchRuleFromLabel(r.data.lunchRule);
          if (lunchRule != null) patch.lunchRule = lunchRule;
          if (r.data.gapAfterLunch != null) patch.gapAfterLunch = r.data.gapAfterLunch;
          if (Object.keys(patch).length === 0) continue;

          const id = existingSubjects.get(lc(r.data.name));
          if (id === undefined) continue;
          const before = await tx.subject.findFirst({ where: { id } });
          /*
            `updateMany`, not `update`, and not by choice: §17's scope extension
            adds the ambient `schoolId` to every `where`, and `update` requires
            a where that Prisma knows is UNIQUE — `{ id, schoolId }` is not a
            declared unique key, so it throws a validation error rather than
            scoping the write. The first version of this loop did exactly that
            and turned a repeat catalogue import into a 500.

            Safe here for the reason CLAUDE.md attaches to the rule: a scoped
            `updateMany` that matches nothing must never be reported as a
            successful write — and this one cannot match nothing, because `id`
            came from a scoped read of this same table a few lines above.
          */
          await tx.subject.updateMany({ where: { id }, data: patch });
          /*
            Counted only when something actually CHANGED, not on every pass.
            "12 subjects updated" on a Next that altered nothing is the message
            §16.1 replaced — a number that reads as work having been done.
          */
          if (before && Object.entries(patch).some(([k, v]) => (before as never as Record<string, unknown>)[k] !== v)) {
            bump("subjectsUpdated");
          }
        }

        const subjects = new Map((await tx.subject.findMany({ where: { schoolId } })).map((s) => [lc(s.name), s.id]));

        // ---- 5. teachers ----
        for (const r of at("Teachers").filter(isNew)) {
          const days: string[] = r.data.alternateDaySet ?? [];
          await tx.teacher.create({
            data: {
              schoolId, employeeCode: r.data.employeeCode, name: r.data.name,
              maxPeriodsPerDay: r.data.maxPeriodsPerDay ?? 6,
              minPeriodsPerDay: r.data.minPeriodsPerDay ?? 3,
              maxPeriodsPerWeek: r.data.maxPeriodsPerWeek ?? 30,
              classTeacherPeriodRule: (r.data.classTeacherPeriodRule ?? "none") as never,
              periodPattern: (r.data.periodPattern ?? "every_period") as never,
              alternateDaySet: days.length > 0 ? days.map((d) => dayNumber(d)!) : undefined,
              employmentType: (r.data.employmentType ?? "permanent") as never,
              isActive: r.data.isActive ?? true,
              // §15.3 Phase 25.4. Blank means "not stated" for all five, which
              // is exactly what every teacher predating these columns has:
              // no initials, no gender, no consecutive limit, and covering as
              // they always did.
              initials: r.data.initials ?? null,
              gender: (r.data.gender ?? null) as never,
              email: r.data.email ?? null,
              maxConsecutivePeriodsPerDay: r.data.maxConsecutivePeriodsPerDay ?? null,
              canSubstitute: r.data.canSubstitute ?? true,
              // §26.5 — stored, never evaluated here. A spreadsheet upload is
              // not the moment to spend a model call per row, so it arrives as
              // "not checked yet" and is turned into rules deliberately from
              // the Teachers screen.
              ...(r.data.specialInstruction
                ? {
                  specialInstruction: String(r.data.specialInstruction),
                  instructionStatus: "pending" as const,
                  instructionNote: "Imported — not checked yet. Open the teacher to apply it.",
                }
                : {}),
            },
          });
          bump("teachers");
        }
        const teachers = new Map((await tx.teacher.findMany({ where: { schoolId } })).map((t) => [lc(t.employeeCode), t.id]));

        // §18 teaching scope. Written after both teachers and classes exist,
        // and only for rows that named one — a blank column means "not decided
        // yet", not "no classes", so it must not clear an existing scope.
        const classIdByName = new Map(
          (await tx.schoolClass.findMany({ where: { schoolId } })).map((c) => [lc(c.name), c.id]),
        );
        for (const r of at("Teachers")) {
          const names = (r.data.classNames as string[] | undefined) ?? [];
          if (names.length === 0) continue;
          const teacherId = teachers.get(lc(r.data.employeeCode));
          if (!teacherId) continue;
          const classIds = [...new Set(names.map((n) => classIdByName.get(lc(n))).filter((x): x is number => !!x))];
          if (classIds.length === 0) continue;
          await tx.teacherClassEligibility.deleteMany({ where: { teacherId } });
          await tx.teacherClassEligibility.createMany({
            data: classIds.map((classId) => ({ teacherId, classId, schoolId })),
          });
          bump("teachingScope", classIds.length);
        }

        /**
         * §27.13 — what each teacher teaches, recorded about the teacher.
         *
         * Same shape and the same rule as the teaching scope above: written
         * only for rows that named subjects, because a blank column means "not
         * stated", not "teaches nothing". A commit that cleared it would wipe a
         * teacher's subjects the first time anybody uploaded a sheet with the
         * column empty — which is every sheet exported before this existed.
         */
        const subjectIdByName = new Map(
          (await tx.subject.findMany({ where: { schoolId } })).map((x) => [lc(x.name), x.id]),
        );
        for (const r of at("Teachers")) {
          const names = (r.data.subjectNames as string[] | undefined) ?? [];
          if (names.length === 0) continue;
          const teacherId = teachers.get(lc(r.data.employeeCode));
          if (!teacherId) continue;
          const subjectIds = [...new Set(
            names.map((n) => subjectIdByName.get(lc(n))).filter((x): x is number => !!x),
          )];
          if (subjectIds.length === 0) continue;
          await tx.teacherSubject.deleteMany({ where: { teacherId } });
          await tx.teacherSubject.createMany({
            data: subjectIds.map((subjectId) => ({ teacherId, subjectId, schoolId })),
          });
          bump("teacherSubjects", subjectIds.length);
        }

        /**
         * §27.16 — which classes each subject is taught to.
         *
         * The third pass with this exact shape, and the third with the same
         * rule: written only for rows that named classes, because a blank
         * column is "not decided yet" and clearing on blank would wipe a
         * school's declarations the first time anybody re-uploaded a sheet
         * exported before the column existed.
         *
         * A name that matches no class is dropped rather than failing the
         * commit — the workbook's `refSheet` already offers the real list, and
         * a typo in one cell should not cost the other thirty subjects.
         */
        for (const r of at("Subjects")) {
          const names = (r.data.classNames as string[] | undefined) ?? [];
          if (names.length === 0) continue;
          const subjectId = subjects.get(lc(r.data.name));
          if (!subjectId) continue;
          const classIds = [...new Set(
            names.map((n) => classIdByName.get(lc(n))).filter((x): x is number => !!x),
          )];
          if (classIds.length === 0) continue;
          await tx.subjectClass.deleteMany({ where: { subjectId } });
          await tx.subjectClass.createMany({
            data: classIds.map((classId) => ({ subjectId, classId, schoolId })),
          });
          bump("subjectClasses", classIds.length);
        }

        // ---- 6. class-sections (creates the Section row too) ----
        const configs = new Map((await tx.timetableConfig.findMany({ where: { schoolId } })).map((c) => [lc(c.name), c.id]));
        for (const r of at("Class Sections").filter(isNew)) {
          const classId = classes.get(lc(r.data.className))!;
          const section =
            (await tx.section.findFirst({ where: { classId, name: r.data.sectionName } })) ??
            (await tx.section.create({ data: { schoolId, classId, name: r.data.sectionName } }));
          const yearId = years.get(lc(r.data.academicYear))!;
          const attachTo = r.data.timetable ? (configs.get(lc(r.data.timetable)) ?? null) : null;
          await tx.classSection.create({
            data: {
              schoolId,
              classId,
              sectionId: section.id,
              academicYearId: yearId,
              // §30 — the sheet's own `Timetable` column decides the pool: a row
              // naming a timetable joins that timetable's pool, one that names
              // none joins the session's. The natural key this importer skips by
              // is now (class, section, year, POOL), which is what will let an
              // individual timetable import its own Class 1-A in stage 4.
              resourceGroupId: await this.groups.forSection(yearId, attachTo),
              strength: r.data.strength ?? null,
              homeRoomId: r.data.homeRoom ? (rooms.get(lc(r.data.homeRoom)) ?? null) : null,
              timetableConfigId: attachTo,
            },
          });
          bump("classSections");
        }
        const sectionRows = await tx.classSection.findMany({
          where: { class: { schoolId } },
          include: { class: true, section: true },
        });
        const sections = new Map(sectionRows.map((cs) => [lc(`${cs.class.name}-${cs.section.name}`), cs.id]));

        /*
          §16.1 — an existing section that belongs to NO timetable gets attached.

          The importer skips by natural key, and the key here is
          `(class, section, year)` — the timetable is not part of it. So a
          section created before its wing existed was skipped for ever after,
          and no amount of re-running the guided setup would attach it: the rows
          were there, the wings were there, and `timetable_config_id` stayed
          NULL. Readiness then reported 0% for a timetable with no classes on a
          school that had entered every class it has, which is what this was
          reported as.

          Deliberately narrow, and it is the §21 `complete` shape rather than an
          update: **only a NULL is filled in**. A section already assigned to
          another wing is left alone — a class-section belongs to exactly one
          timetable (invariant 11) and moving it between wings is a real
          decision somebody makes on purpose, not something a re-import does on
          their behalf. Nothing else on the row is touched, so "the importer
          does not change existing rows" still holds for every field that has an
          answer.
        */
        const byNatural = new Map(
          sectionRows.map((cs) => [`${cs.classId}:${lc(cs.section.name)}:${cs.academicYearId}`, cs]),
        );
        const toAttach = new Map<number, number[]>();
        for (const r of at("Class Sections")) {
          if (!r.data.timetable) continue;
          const configId = configs.get(lc(r.data.timetable));
          const classId = classes.get(lc(r.data.className));
          const yearId = years.get(lc(r.data.academicYear));
          if (!configId || !classId || !yearId) continue;
          const cs = byNatural.get(`${classId}:${lc(r.data.sectionName)}:${yearId}`);
          if (!cs || cs.timetableConfigId !== null) continue;
          toAttach.set(configId, [...(toAttach.get(configId) ?? []), cs.id]);
        }
        for (const [configId, ids] of toAttach) {
          const done = await tx.classSection.updateMany({
            // `timetableConfigId: null` in the WHERE as well as the check above:
            // the read happened before this transaction's own writes, and a
            // filled link must never be overwritten by a race with itself.
            where: { id: { in: ids }, timetableConfigId: null },
            data: { timetableConfigId: configId },
          });
          bump("classSectionsAttached", done.count);
        }

        // §19 home rooms, written from the Rooms sheet's own column. The Class
        // Sections sheet can also set it; this is the same fact from the other
        // side, which is how a school that thinks in rooms fills the file in.
        for (const r of at("Rooms")) {
          const label = r.data.homeFor as string | undefined;
          if (!label) continue;
          const roomId = rooms.get(lc(r.data.name));
          const csId = sections.get(lc(label));
          if (!roomId || !csId) continue;
          await tx.classSection.update({ where: { id: csId }, data: { homeRoomId: roomId } });
          bump("homeRooms");
        }


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
              // Phase 19: the sheet names the session, never the active year.
              academicYearId: years.get(lc(r.data.academicYear))!,
              subjectId: subjects.get(lc(r.data.subjectName))!,
              periodsPerWeek: r.data.periodsPerWeek,
              maxPeriodsPerDay: r.data.maxPeriodsPerDay ?? 1,
              samePeriodAcrossWeek: r.data.samePeriodAcrossWeek ?? false,
              consecutiveBlockSize: blockSize,
              consecutiveBlocksPerWeek: blockSize > 1 ? (r.data.consecutiveBlocksPerWeek ?? null) : null,
              // §31.10 — cleared with the block, for the same reason the API
              // clears it: a row with no block has no answer to give, and a
              // stale `true` would reappear the day somebody sets a size again.
              blockMayCrossBreak: blockSize > 1 ? Boolean(r.data.blockMayCrossBreak) : false,
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
              ...electivePlacement(head.data),
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
    /*
      The message tells the truth about the three outcomes, which are different
      things to a person pressing Next: rows were added, nothing was added but
      something was repaired, or genuinely nothing happened. The old wording
      ("everything here already exists") covered the last two and was wrong
      about the middle one.
    */
    const total = Object.values(created).reduce((n, x) => n + x, 0);
    return {
      ok: true,
      created,
      plan,
      message: total === 0
        ? "Everything here already exists — nothing to add."
        : created.classSectionsAttached && Object.keys(created).length === 1
          ? `Everything already existed; ${created.classSectionsAttached} class-section(s) were added to their timetable.`
          : "Import complete.",
    };
  }
}
