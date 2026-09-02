/**
 * §13.1 — the whitelisted read-only tool registry. The model never sees SQL or
 * a table dump: it can only call these functions, which wrap the SAME query
 * layer the Reports module uses (§10), and the gateway stamps school + view
 * scope into every execution server-side. A prompt cannot widen that scope,
 * because the scope is never part of the tool arguments.
 */
import { Injectable } from "@nestjs/common";
import type { ViewScope } from "@edutimetable/shared";
import { AI_ENTRY_SHEETS, allSheetGuides, type DraftSheet } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { AiDataEntryService } from "./data-entry.service";
import { ReportsService } from "../reports/reports.service";

export interface ToolContext {
  schoolId: number;
  scope: ViewScope;
  /** whether this user may trigger generateReport (§13.3 ai.reports) */
  canReport: boolean;
  /**
   * §13.5 — whether this user may DRAFT master data. Not a new permission:
   * the authority to add a teacher is `masters.manage`, the same one the
   * Setup Wizard and the Excel import require. The assistant never gets an
   * authority its user does not already have on a screen.
   */
  canWrite: boolean;
  /** who is asking, for the audit trail on an applied proposal */
  userId: number | null;
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const DAY_ENUM = {
  type: "integer",
  minimum: 1,
  maximum: 7,
  description: "day of week, 1 = Monday … 7 = Sunday",
};

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "getTimetableConfigs",
    description:
      "List the school's timetables (wings): id, name, working days, periods per day, start time, status, and which class-sections belong to each. Use this first when the user names a wing or asks what timetables exist.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "listTeachers",
    description:
      "List teachers visible to this user with their id, name, employee code, weekly capacity and placement rules. Use it to resolve a person's name to a teacher_id before calling other tools.",
    input_schema: {
      type: "object",
      properties: { search: { type: "string", description: "optional case-insensitive name filter" } },
    },
  },
  {
    name: "listClassSections",
    description: "List class-sections visible to this user (id and label such as 'Class 5-A'), to resolve a class name to a class_section_id.",
    input_schema: {
      type: "object",
      properties: { search: { type: "string", description: "optional case-insensitive label filter" } },
    },
  },
  {
    name: "listSubjectMappings",
    description:
      "Who teaches what: the current subject mappings (teacher, subject, class-section, periods/week, room), merged teaching groups, and each class-section's class teacher. " +
      "Read this BEFORE drafting a change to a mapping — Periods/Week is a required column, so changing only the teacher still means sending the periods/week that is already stored, and inventing it would silently rewrite it.",
    input_schema: {
      type: "object",
      properties: {
        class_section: { type: "string", description: "optional label filter, e.g. 'Class 5-A'" },
        subject: { type: "string", description: "optional subject-name filter" },
        employee_code: { type: "string", description: "optional teacher employee-code filter" },
      },
    },
  },
  {
    name: "getClassSectionTimetable",
    description:
      "The published weekly grid for one class-section: every day/period cell with its subject, teacher and room. Optionally overlay a date's substitutions.",
    input_schema: {
      type: "object",
      properties: {
        class_section_id: { type: "integer" },
        date: { type: "string", description: "optional YYYY-MM-DD to overlay that day's substitutions" },
      },
      required: ["class_section_id"],
    },
  },
  {
    name: "getTeacherTimetable",
    description:
      "The published weekly grid for one teacher: which class-section/subject/room each period, with free periods absent from the grid. Optionally overlay a date's substitutions.",
    input_schema: {
      type: "object",
      properties: {
        teacher_id: { type: "integer" },
        date: { type: "string", description: "optional YYYY-MM-DD" },
      },
      required: ["teacher_id"],
    },
  },
  {
    name: "getTeacherLoadSummary",
    description:
      "Per-teacher weekly load vs capacity, number of distinct class-sections, and gap-period count for one timetable config. The go-to tool for workload questions.",
    input_schema: {
      type: "object",
      properties: {
        timetable_config_id: { type: "integer", description: "omit to use the conversation's current timetable" },
      },
    },
  },
  {
    name: "getRoomUtilization",
    description: "Room occupancy across the week for one timetable config: periods used, capacity, and utilization percentage. Use for 'which lab is underused' style questions.",
    input_schema: {
      type: "object",
      properties: { timetable_config_id: { type: "integer", description: "omit to use the conversation's current timetable" } },
    },
  },
  {
    name: "getFreeTeachers",
    description:
      "Which teachers are free at a specific day and period in the published timetable (optionally on a date, accounting for that date's substitutions and absences). Use for cover/availability questions.",
    input_schema: {
      type: "object",
      properties: {
        day_of_week: DAY_ENUM,
        period_number: { type: "integer", minimum: 1 },
        date: { type: "string", description: "optional YYYY-MM-DD; also excludes teachers absent that day" },
      },
      required: ["day_of_week", "period_number"],
    },
  },
  {
    name: "getReadinessStatus",
    description:
      "The current feasibility result (§4) for a timetable: score, ready flag, and every blocker/warning with its exact suggested fix. Use when asked why generation is blocked or what needs fixing.",
    input_schema: {
      type: "object",
      properties: { timetable_config_id: { type: "integer", description: "omit to use the conversation's current timetable" } },
    },
  },
  {
    name: "getSubstitutionHistory",
    description: "Absences and confirmed substitutions in a date range: who was out, who covered which period, and anything left uncovered.",
    input_schema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "YYYY-MM-DD" },
        date_to: { type: "string", description: "YYYY-MM-DD" },
        teacher_id: { type: "integer", description: "optional — restrict to one teacher" },
      },
      required: ["date_from", "date_to"],
    },
  },
  {
    name: "generateReport",
    description:
      "Render one of the standard reports as a downloadable file. Only call this when the user explicitly asks for a report, export, PDF or spreadsheet — normal questions should be answered from the query tools above.",
    input_schema: {
      type: "object",
      properties: {
        report_type: {
          type: "string",
          enum: ["class-section", "teacher", "rooms", "teacher-load"],
        },
        class_section_id: { type: "integer", description: "required for report_type 'class-section'" },
        teacher_id: { type: "integer", description: "required for report_type 'teacher'" },
        timetable_config_id: { type: "integer", description: "for 'rooms' and 'teacher-load'" },
        format: { type: "string", enum: ["csv", "pdf"], description: "csv opens in Excel; pdf is print-styled" },
      },
      required: ["report_type"],
    },
  },
  {
    name: "draftMasterData",
    description:
      "Draft master-data rows for the admin to review. This does NOT write anything: it validates the rows and returns a preview — what would be added, what would CHANGE on rows that already exist, and what is wrong — which the admin then applies with a button. " +
      "Use it when the user asks to add OR change classes, sections, subjects, teachers, curriculum, class teachers or subject mappings. " +
      "To change something that exists, send its natural key plus only the fields to change: {employeeCode:'EDX-1042', maxPeriodsPerWeek:24} changes that teacher's weekly cap and nothing else. A field you omit is left alone, so never send a whole record to change one value. " +
      "The natural key itself can never be changed — renaming a class is not an edit, it is a different class, and the tool will treat it as a new row. " +
      "Subject Mapping is keyed by (subject, class-section), so the TEACHER is a changeable value there: to move Class 5-A maths to another teacher, send that one row with the new employeeCode. " +
      "But Periods/Week is a required column, so call listSubjectMappings FIRST and send back the periods/week already stored — do not guess it, or you will change it as well. " +
      "Two things on that sheet cannot be changed: a merged group's teacher and its member sections are part of what identifies it (send merged rows only to create a new group), and a class-section that has no mapping for that subject yet is an addition, not a change. " +
      "Send every related sheet in ONE call (adding a class and its sections is one draft), because rows are checked against each other. " +
      "Never invent a required value: if periods per week, an employee code or a timetable is not stated, ask the user first.\n\n" +
      "COLUMNS (use these exact field names):\n" + allSheetGuides(),
    input_schema: {
      type: "object",
      properties: {
        sheets: {
          type: "array",
          description: "one entry per master being added",
          items: {
            type: "object",
            properties: {
              sheet: { type: "string", enum: [...AI_ENTRY_SHEETS] },
              rows: {
                type: "array",
                description: "the rows to add, each an object of column name → value",
                items: { type: "object" },
              },
            },
            required: ["sheet", "rows"],
          },
        },
      },
      required: ["sheets"],
    },
  },
];

@Injectable()
export class AiToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly readiness: ReadinessService,
    private readonly dataEntry: AiDataEntryService,
  ) {}

  /** Sections this user may see at all — the hard boundary for every tool. */
  private allowedSectionIds(scope: ViewScope): number[] | "all" {
    if (scope.level === "all") return "all";
    if (scope.level === "class") return scope.classSectionIds;
    return [];
  }

  async execute(
    name: string,
    args: Record<string, any>,
    ctx: ToolContext,
    currentConfigId: number | null,
  ): Promise<unknown> {
    const configId = Number(args.timetable_config_id) || currentConfigId;
    switch (name) {
      // ── §13.5 the one tool that proposes a write ───────────────────────
      case "draftMasterData": {
        // Belt and braces on top of the tool-list filter in chat.service: if
        // this ever ran for a user without `masters.manage`, it stops here.
        if (!ctx.canWrite) {
          return { error: "You do not have permission to add master data. Ask an administrator." };
        }
        const sheets = Array.isArray(args.sheets) ? (args.sheets as DraftSheet[]) : [];
        return this.dataEntry.propose(ctx.schoolId, sheets, ctx.userId);
      }
      case "getTimetableConfigs": {
        const rows = await this.prisma.timetableConfig.findMany({
          where: { schoolId: ctx.schoolId },
          include: { classSections: { include: { class: true, section: true } } },
        });
        const allowed = this.allowedSectionIds(ctx.scope);
        return rows.map((c) => ({
          id: c.id,
          name: c.name,
          workingDays: c.workingDays,
          periodsPerDay: c.periodsPerDay,
          startTime: c.startTime,
          status: c.status,
          classSections: c.classSections
            .filter((cs) => allowed === "all" || allowed.includes(cs.id))
            .map((cs) => ({ id: cs.id, label: `${cs.class.name}-${cs.section.name}` })),
        }));
      }

      case "listTeachers": {
        const search = typeof args.search === "string" ? args.search : undefined;
        const where: any = { schoolId: ctx.schoolId, isActive: true };
        if (search) where.name = { contains: search };
        // own/class scope: a teacher may only resolve themselves
        if (ctx.scope.level === "own" || ctx.scope.level === "class") where.id = ctx.scope.teacherId;
        if (ctx.scope.level === "none") return [];
        const rows = await this.prisma.teacher.findMany({ where, orderBy: { name: "asc" }, take: 200 });
        return rows.map((t) => ({
          id: t.id,
          name: t.name,
          employeeCode: t.employeeCode,
          maxPeriodsPerDay: t.maxPeriodsPerDay,
          minPeriodsPerDay: t.minPeriodsPerDay,
          maxPeriodsPerWeek: t.maxPeriodsPerWeek,
          classTeacherPeriodRule: t.classTeacherPeriodRule,
          periodPattern: t.periodPattern,
        }));
      }

      case "listClassSections": {
        const allowed = this.allowedSectionIds(ctx.scope);
        if (allowed !== "all" && allowed.length === 0) return [];
        const rows = await this.prisma.classSection.findMany({
          where: {
            class: { schoolId: ctx.schoolId },
            ...(allowed === "all" ? {} : { id: { in: allowed } }),
          },
          include: { class: true, section: true, classTeacher: true },
          orderBy: [{ class: { sequence: "asc" } }, { section: { name: "asc" } }],
        });
        const search = typeof args.search === "string" ? args.search.toLowerCase() : null;
        return rows
          .map((cs) => ({
            id: cs.id,
            label: `${cs.class.name}-${cs.section.name}`,
            timetableConfigId: cs.timetableConfigId,
            classTeacher: cs.classTeacher?.name ?? null,
            strength: cs.strength,
          }))
          .filter((r) => !search || r.label.toLowerCase().includes(search));
      }

      /**
       * §13.5 Phase C — the read that makes a mapping change possible.
       *
       * Without it the assistant could be *asked* to move a subject to another
       * teacher but could not draft it correctly: Periods/Week is a required
       * column on that sheet, so a change of teacher alone still has to carry
       * the periods already stored, and a guess would quietly rewrite them.
       * Scoped like every other read — a teacher sees their own sections only.
       */
      case "listSubjectMappings": {
        const allowed = this.allowedSectionIds(ctx.scope);
        if (allowed !== "all" && allowed.length === 0) return { mappings: [], mergedGroups: [], classTeachers: [] };
        const within = allowed === "all" ? {} : { classSectionId: { in: allowed } };
        const [rows, groups, sections] = await Promise.all([
          this.prisma.teacherSubjectClassSection.findMany({
            where: { schoolId: ctx.schoolId, ...within },
            include: {
              teacher: true,
              subject: true,
              preferredRoom: true,
              classSection: { include: { class: true, section: true } },
            },
          }),
          this.prisma.mergedTeachingGroup.findMany({
            where: {
              schoolId: ctx.schoolId,
              ...(allowed === "all" ? {} : { members: { some: { classSectionId: { in: allowed } } } }),
            },
            include: {
              teacher: true, subject: true, room: true,
              members: { include: { classSection: { include: { class: true, section: true } } } },
            },
          }),
          this.prisma.classSection.findMany({
            where: {
              schoolId: ctx.schoolId,
              classTeacherId: { not: null },
              ...(allowed === "all" ? {} : { id: { in: allowed } }),
            },
            include: { class: true, section: true, classTeacher: true },
          }),
        ]);
        const label = (cs: { class: { name: string }; section: { name: string } }) =>
          `${cs.class.name}-${cs.section.name}`;
        const wantSection = typeof args.class_section === "string" ? args.class_section.toLowerCase() : null;
        const wantSubject = typeof args.subject === "string" ? args.subject.toLowerCase() : null;
        const wantCode = typeof args.employee_code === "string" ? args.employee_code.toLowerCase() : null;
        const keep = (sectionLabels: string[], subject: string, code: string) =>
          (!wantSection || sectionLabels.some((l) => l.toLowerCase().includes(wantSection))) &&
          (!wantSubject || subject.toLowerCase().includes(wantSubject)) &&
          (!wantCode || code.toLowerCase() === wantCode);
        return {
          mappings: rows
            .map((m) => ({
              classSection: label(m.classSection),
              subjectName: m.subject.name,
              employeeCode: m.teacher.employeeCode,
              teacherName: m.teacher.name,
              periodsPerWeek: m.periodsPerWeek,
              room: m.preferredRoom?.name ?? null,
            }))
            .filter((m) => keep([m.classSection], m.subjectName, m.employeeCode)),
          mergedGroups: groups
            .map((g) => ({
              classSections: g.members.map((x) => label(x.classSection)),
              subjectName: g.subject.name,
              employeeCode: g.teacher.employeeCode,
              teacherName: g.teacher.name,
              periodsPerWeek: g.periodsPerWeek,
              room: g.room?.name ?? null,
              merged: true,
            }))
            .filter((g) => keep(g.classSections, g.subjectName, g.employeeCode)),
          classTeachers: sections
            .map((cs) => ({
              classSection: label(cs),
              employeeCode: cs.classTeacher!.employeeCode,
              teacherName: cs.classTeacher!.name,
            }))
            .filter((c) => keep([c.classSection], "", c.employeeCode) && !wantSubject),
        };
      }

      case "getClassSectionTimetable":
        return this.reports.classSectionTimetable(
          ctx.scope,
          Number(args.class_section_id),
          typeof args.date === "string" ? args.date : null,
        );

      case "getTeacherTimetable":
        return this.reports.teacherTimetable(
          ctx.scope,
          Number(args.teacher_id),
          typeof args.date === "string" ? args.date : null,
        );

      case "getTeacherLoadSummary": {
        if (!configId) throw new Error("No timetable selected — ask the user which wing they mean");
        return this.reports.teacherLoadSummary(ctx.scope, configId);
      }

      case "getRoomUtilization": {
        if (!configId) throw new Error("No timetable selected — ask the user which wing they mean");
        return this.reports.roomUtilization(ctx.scope, configId);
      }

      case "getReadinessStatus": {
        if (!configId) throw new Error("No timetable selected — ask the user which wing they mean");
        if (ctx.scope.level !== "all") throw new Error("Readiness is only visible to users with full timetable view access");
        const r = await this.readiness.getReadiness(configId);
        return {
          timetableConfigId: configId,
          score: r.score,
          ready: r.ready,
          blockers: r.blockers.map((b) => ({ code: b.code, message: b.message })),
          warnings: r.warnings.map((w) => ({ code: w.code, message: w.message })),
        };
      }

      case "getFreeTeachers": {
        if (ctx.scope.level !== "all") throw new Error("Cross-teacher availability needs full timetable view access");
        const day = Number(args.day_of_week);
        const period = Number(args.period_number);
        const date = typeof args.date === "string" ? args.date : null;
        const [teachers, busy, unavailable, absences, subs] = await Promise.all([
          this.prisma.teacher.findMany({ where: { schoolId: ctx.schoolId, isActive: true } }),
          this.prisma.timetableSlot.findMany({
            where: { status: "published", dayOfWeek: day, periodNumber: period, teacherOccupancyKey: { not: null } },
            select: { teacherId: true },
          }),
          this.prisma.teacherUnavailability.findMany({
            where: { dayOfWeek: day, OR: [{ periodNumber: period }, { periodNumber: null }] },
            select: { teacherId: true },
          }),
          date
            ? this.prisma.teacherAbsence.findMany({ where: { date: new Date(`${date}T00:00:00.000Z`) }, select: { teacherId: true } })
            : Promise.resolve([]),
          date
            ? this.prisma.substitutionLog.findMany({ where: { date: new Date(`${date}T00:00:00.000Z`) } })
            : Promise.resolve([]),
        ]);
        const subSlotIds = subs.map((s) => s.timetableSlotId);
        const subSlots = subSlotIds.length
          ? await this.prisma.timetableSlot.findMany({ where: { id: { in: subSlotIds }, dayOfWeek: day, periodNumber: period } })
          : [];
        const coveringNow = new Set(
          subs
            .filter((s) => subSlots.some((sl) => sl.id === s.timetableSlotId))
            .map((s) => s.substituteTeacherId),
        );
        const blocked = new Set<number>([
          ...busy.map((b) => b.teacherId).filter((x): x is number => x !== null),
          ...unavailable.map((u) => u.teacherId),
          ...absences.map((a) => a.teacherId),
          ...coveringNow,
        ]);
        return {
          dayOfWeek: day,
          periodNumber: period,
          date,
          free: teachers.filter((t) => !blocked.has(t.id)).map((t) => ({ id: t.id, name: t.name })),
          busyCount: blocked.size,
        };
      }

      case "getSubstitutionHistory": {
        if (ctx.scope.level === "none") return { absences: [], substitutions: [] };
        // `required` in the schema is a request, not a guarantee — a model can
        // still omit or malform these, and `new Date("undefinedT00:00…")`
        // reaches Prisma as an Invalid Date and comes back as a 500 the model
        // cannot act on. Say what is wrong instead, so it can retry.
        const from = new Date(`${String(args.date_from)}T00:00:00.000Z`);
        const to = new Date(`${String(args.date_to)}T00:00:00.000Z`);
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
          return { error: "date_from and date_to are required, as YYYY-MM-DD." };
        }
        const teacherFilter =
          ctx.scope.level === "all"
            ? args.teacher_id
              ? { teacherId: Number(args.teacher_id) }
              : {}
            : { teacherId: ctx.scope.teacherId };
        const absences = await this.prisma.teacherAbsence.findMany({
          where: { date: { gte: from, lte: to }, teacher: { schoolId: ctx.schoolId }, ...teacherFilter },
          include: { teacher: true, substitutions: true },
          take: 200,
        });
        const teacherNames = new Map(
          (await this.prisma.teacher.findMany({ where: { schoolId: ctx.schoolId } })).map((t) => [t.id, t.name]),
        );
        return {
          absences: absences.map((a) => ({
            date: a.date.toISOString().slice(0, 10),
            teacher: a.teacher.name,
            reason: a.reason,
            status: a.status,
            covers: a.substitutions.map((s) => ({
              substitute: teacherNames.get(s.substituteTeacherId) ?? `#${s.substituteTeacherId}`,
            })),
          })),
        };
      }

      case "generateReport": {
        if (!ctx.canReport) {
          throw new Error("This user does not have the ai.reports permission — offer the answer in chat instead");
        }
        const type = String(args.report_type);
        const format = args.format === "pdf" ? "pdf" : "csv";
        // validate by actually running the underlying report through the scope
        let title: string;
        if (type === "class-section") {
          const r = (await this.reports.classSectionTimetable(ctx.scope, Number(args.class_section_id), null)) as any;
          title = `${r.label} weekly timetable`;
        } else if (type === "teacher") {
          const r = (await this.reports.teacherTimetable(ctx.scope, Number(args.teacher_id), null)) as any;
          title = `${r.label} weekly timetable`;
        } else if (type === "rooms") {
          if (!configId) throw new Error("No timetable selected");
          await this.reports.roomUtilization(ctx.scope, configId);
          title = "Room utilization";
        } else {
          if (!configId) throw new Error("No timetable selected");
          await this.reports.teacherLoadSummary(ctx.scope, configId);
          title = "Teacher load summary";
        }
        // the file itself is rendered by the existing Reports screen pipeline;
        // the chat returns a deep link so the download uses one code path (§10)
        // the Reports screen names the load report "load"; keep the tool's
        // vocabulary readable for the model and translate here
        const params = new URLSearchParams({ kind: type === "teacher-load" ? "load" : type, format });
        if (args.class_section_id) params.set("sectionId", String(args.class_section_id));
        if (args.teacher_id) params.set("teacherId", String(args.teacher_id));
        return {
          reportCard: true,
          title,
          reportType: type,
          format,
          downloadPath: `/reports?${params.toString()}`,
          note: "Rendered by the standard Reports pipeline — open the card to download.",
        };
      }

      default:
        throw new Error(`Unknown tool ${name}`);
    }
  }
}
