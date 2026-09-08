/**
 * §10 Reports — one shared query shape over PUBLISHED slots. These functions
 * are deliberately the future AI tool layer (§13.1): each takes plain-JSON
 * filters plus a server-resolved ViewScope, and returns compact render-ready
 * rows (no ORM graphs). Redis-cached under the slots:* sweep so every slot or
 * master-data write invalidates them (§14).
 */
import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type Redis from "ioredis";
import type { ViewScope } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { REDIS } from "../redis/redis.module";
import { CacheKeysService } from "../redis/cache-keys.service";

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface GridCell {
  period: number;
  subject: string | null;
  teacher: string | null;
  room: string | null;
  classSection: string | null;
  substituted: boolean;
  isBreak?: boolean;
  breakName?: string | null;
  /**
   * §4.9 — a split-elective cell. The section's own row carries no subject,
   * teacher or room by design (invariant 9): the lessons are the block's
   * option rows, which belong to no section. Without these two fields the
   * cell reads as a free period on every screen that shows a class's week —
   * the report, My Classes, the printed timetable and the AI assistant.
   */
  blockName?: string | null;
  electiveOptions?: Array<{ subject: string | null; teacher: string | null; room: string | null; substituted: boolean }>;
}

function scopedSectionIds(scope: ViewScope): number[] | "all" | "none" {
  if (scope.level === "all") return "all";
  if (scope.level === "class") return scope.classSectionIds;
  return "none";
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: CacheKeysService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** `name` identifies the report and its arguments; the school namespace is
   *  added here so no report call site can forget it (9.1 / §17). */
  private async cached<T>(name: string, compute: () => Promise<T>): Promise<T> {
    const key = this.keys.report(name);
    const hit = await this.redis.get(key);
    if (hit) return JSON.parse(hit);
    const value = await compute();
    await this.redis.set(key, JSON.stringify(value), "EX", 3600);
    return value;
  }

  private async dayShape(configId: number) {
    const config = await this.prisma.timetableConfig.findUnique({
      where: { id: configId },
      include: {
        periods: {
          orderBy: { sortOrder: "asc" },
          // §28.3 — the duty teacher travels with the band, so a printed
          // timetable can say who takes assembly without a second query.
          include: {
            activity: {
              include: {
                teacher: { select: { name: true, initials: true } },
                room: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    if (!config) throw new NotFoundException("Timetable config not found");
    return {
      config,
      workingDays: (config.workingDays as number[]) ?? [1, 2, 3, 4, 5],
      periods: config.periods.map((p) => ({
        periodNumber: p.periodNumber,
        startTime: p.startTime,
        endTime: p.endTime,
        isBreak: p.isBreak,
        breakName: p.breakName,
        isActivity: p.isActivity,
        activityTeacher: p.activity?.teacher?.initials ?? p.activity?.teacher?.name ?? null,
        activityRoom: p.activity?.room?.name ?? null,
      })),
    };
  }

  private async subsFor(date: string | null, slotIds: bigint[]) {
    if (!date || slotIds.length === 0) return new Map<string, number>();
    const rows = await this.prisma.substitutionLog.findMany({
      where: { date: new Date(`${date}T00:00:00.000Z`), timetableSlotId: { in: slotIds } },
    });
    return new Map(rows.map((r) => [r.timetableSlotId.toString(), r.substituteTeacherId]));
  }

  private async names(teacherIds: number[]) {
    const rows = await this.prisma.teacher.findMany({ where: { id: { in: teacherIds } } });
    return new Map(rows.map((t) => [t.id, t.name]));
  }

  /** §10 report 1 — Class-Section Weekly Timetable (also the AI's tool). */
  async classSectionTimetable(scope: ViewScope, classSectionId: number, date: string | null) {
    const allowed = scopedSectionIds(scope);
    if (allowed === "none" || (allowed !== "all" && !allowed.includes(classSectionId))) {
      throw new ForbiddenException("This class-section is outside your view scope (§15.3)");
    }
    return this.cached(`cs:${classSectionId}:${date ?? "base"}`, async () => {
      const cs = await this.prisma.classSection.findUnique({
        where: { id: classSectionId },
        include: { class: true, section: true, classTeacher: true },
      });
      if (!cs || cs.timetableConfigId === null) throw new NotFoundException("Class-section not found or not in a timetable");
      const shape = await this.dayShape(cs.timetableConfigId);
      const slots = await this.prisma.timetableSlot.findMany({
        where: { classSectionId, status: "published" },
      });
      // §4.9: the section's elective rows are placeholders holding the slot
      // open. The lessons running inside it are the block's option rows, which
      // carry `class_section_id = NULL` and so are not in `slots` at all. Read
      // the real rows rather than the block's configured options, so a covered
      // option shows its substitute and a moved option its actual room.
      const blockIds = [...new Set(slots.map((s) => s.electiveBlockId).filter((x): x is number => x !== null))];
      const optionSlots = blockIds.length
        ? await this.prisma.timetableSlot.findMany({
            where: { electiveBlockId: { in: blockIds }, classSectionId: null, status: "published" },
          })
        : [];
      const blockNames = new Map(
        blockIds.length
          ? (await this.prisma.electiveBlock.findMany({ where: { id: { in: blockIds } }, select: { id: true, name: true } })).map((b) => [b.id, b.name])
          : [],
      );
      const all = [...slots, ...optionSlots];
      const subs = await this.subsFor(date, all.map((s) => s.id));
      const teacherNames = await this.names([
        ...new Set([...all.map((s) => s.teacherId).filter((x): x is number => x !== null), ...subs.values()]),
      ]);
      const subjects = new Map(
        (await this.prisma.subject.findMany({ where: { id: { in: all.map((s) => s.subjectId).filter((x): x is number => x !== null) } } })).map((s) => [s.id, s.name]),
      );
      const rooms = new Map(
        (await this.prisma.room.findMany({ where: { id: { in: all.map((s) => s.roomId).filter((x): x is number => x !== null) } } })).map((r) => [r.id, r.name]),
      );
      const optionsAt = new Map<string, typeof optionSlots>();
      for (const o of optionSlots) {
        const k = `${o.electiveBlockId}:${o.dayOfWeek}:${o.periodNumber}`;
        const at = optionsAt.get(k);
        if (at) at.push(o);
        else optionsAt.set(k, [o]);
      }
      const grid: Record<string, GridCell> = {};
      for (const s of slots) {
        const sub = subs.get(s.id.toString());
        if (s.electiveBlockId !== null) {
          const opts = (optionsAt.get(`${s.electiveBlockId}:${s.dayOfWeek}:${s.periodNumber}`) ?? [])
            .map((o) => {
              const oSub = subs.get(o.id.toString());
              return {
                subject: o.subjectId !== null ? (subjects.get(o.subjectId) ?? null) : null,
                teacher: teacherNames.get(oSub ?? o.teacherId ?? -1) ?? null,
                room: o.roomId !== null ? (rooms.get(o.roomId) ?? null) : null,
                substituted: oSub !== undefined,
              };
            })
            .sort((a, b) => (a.subject ?? "").localeCompare(b.subject ?? ""));
          const blockName = blockNames.get(s.electiveBlockId) ?? "Elective";
          grid[`${s.dayOfWeek}:${s.periodNumber}`] = {
            period: s.periodNumber,
            // `subject` carries the block name so every existing consumer —
            // exports, the AI assistant, anything reading the flat cell —
            // says "Third Language" instead of nothing.
            subject: blockName,
            teacher: null,
            room: null,
            classSection: null,
            substituted: opts.some((o) => o.substituted),
            blockName,
            electiveOptions: opts,
          };
          continue;
        }
        grid[`${s.dayOfWeek}:${s.periodNumber}`] = {
          period: s.periodNumber,
          subject: s.subjectId !== null ? (subjects.get(s.subjectId) ?? null) : null,
          teacher: teacherNames.get(sub ?? s.teacherId ?? -1) ?? null,
          room: s.roomId !== null ? (rooms.get(s.roomId) ?? null) : null,
          classSection: null,
          substituted: sub !== undefined,
        };
      }
      return {
        kind: "class-section" as const,
        label: `${cs.class.name}-${cs.section.name}`,
        classTeacher: cs.classTeacher?.name ?? null,
        date,
        workingDays: shape.workingDays,
        dayNames: shape.workingDays.map((d) => DAY_NAMES[d]),
        periods: shape.periods,
        grid,
      };
    });
  }

  /** §10 report 2 — Teacher Weekly Timetable, free periods marked. */
  async teacherTimetable(scope: ViewScope, teacherId: number, date: string | null) {
    if (scope.level === "none") throw new ForbiddenException("No view scope");
    if (scope.level === "own" && scope.teacherId !== teacherId) {
      throw new ForbiddenException("You can only view your own timetable (§15.3)");
    }
    if (scope.level === "class" && scope.teacherId !== teacherId) {
      throw new ForbiddenException("Class-scope users can view class grids, not other teachers (§15.3)");
    }
    return this.cached(`t:${teacherId}:${date ?? "base"}`, async () => {
      const teacher = await this.prisma.teacher.findUnique({ where: { id: teacherId } });
      if (!teacher) throw new NotFoundException("Teacher not found");
      // own primary occupancies across all configs
      const slots = await this.prisma.timetableSlot.findMany({
        where: { teacherId, status: "published", teacherOccupancyKey: { not: null } },
      });
      // duties they picked up as substitute on the date
      const duties = date
        ? await this.prisma.substitutionLog.findMany({
            where: { substituteTeacherId: teacherId, date: new Date(`${date}T00:00:00.000Z`) },
          })
        : [];
      const dutySlots = duties.length
        ? await this.prisma.timetableSlot.findMany({ where: { id: { in: duties.map((d) => d.timetableSlotId) } } })
        : [];
      // slots someone else covers FOR them on the date (shown as released)
      const covered = await this.subsFor(date, slots.map((s) => s.id));

      const configId = slots[0]?.timetableConfigId ?? dutySlots[0]?.timetableConfigId;
      const shape = configId
        ? await this.dayShape(configId)
        : {
            workingDays: [1, 2, 3, 4, 5],
            periods: [] as Array<{
              periodNumber: number | null; startTime: string; endTime: string | null;
              isBreak: boolean; breakName: string | null;
              isActivity?: boolean; activityTeacher?: string | null; activityRoom?: string | null;
            }>,
          };

      const all = [...slots, ...dutySlots];
      const sectionRows = await this.prisma.classSection.findMany({
        where: { id: { in: [...new Set(all.map((s) => s.classSectionId).filter((x): x is number => x !== null))] } },
        include: { class: true, section: true },
      });
      const sectionLabel = new Map(sectionRows.map((cs) => [cs.id, `${cs.class.name}-${cs.section.name}`]));
      // A §4.9 elective option is a real lesson for the teacher taking it, and
      // it belongs to a block rather than to any one section — so it is named
      // by its block ("Class 5 Third Language") rather than left blank.
      const blockRows = await this.prisma.electiveBlock.findMany({
        where: { id: { in: [...new Set(all.map((s) => s.electiveBlockId).filter((x): x is number => x !== null))] } },
        select: { id: true, name: true },
      });
      const blockName = new Map(blockRows.map((b) => [b.id, b.name]));
      const whereTaught = (s: { classSectionId: number | null; electiveBlockId: number | null }) =>
        s.classSectionId !== null
          ? (sectionLabel.get(s.classSectionId) ?? null)
          : s.electiveBlockId !== null
            ? (blockName.get(s.electiveBlockId) ?? null)
            : null;
      const subjects = new Map(
        (await this.prisma.subject.findMany({ where: { id: { in: all.map((s) => s.subjectId).filter((x): x is number => x !== null) } } })).map((s) => [s.id, s.name]),
      );
      const rooms = new Map(
        (await this.prisma.room.findMany({ where: { id: { in: all.map((s) => s.roomId).filter((x): x is number => x !== null) } } })).map((r) => [r.id, r.name]),
      );

      const grid: Record<string, GridCell & { released?: boolean; duty?: boolean }> = {};
      for (const s of slots) {
        if (covered.has(s.id.toString())) continue; // released to a substitute that day
        grid[`${s.dayOfWeek}:${s.periodNumber}`] = {
          period: s.periodNumber,
          subject: s.subjectId !== null ? (subjects.get(s.subjectId) ?? null) : null,
          teacher: null,
          room: s.roomId !== null ? (rooms.get(s.roomId) ?? null) : null,
          classSection: whereTaught(s),
          substituted: false,
        };
      }
      for (const s of dutySlots) {
        grid[`${s.dayOfWeek}:${s.periodNumber}`] = {
          period: s.periodNumber,
          subject: s.subjectId !== null ? (subjects.get(s.subjectId) ?? null) : null,
          teacher: null,
          room: s.roomId !== null ? (rooms.get(s.roomId) ?? null) : null,
          classSection: whereTaught(s),
          substituted: true,
          duty: true,
        };
      }
      const weeklyLoad = slots.length;
      return {
        kind: "teacher" as const,
        label: teacher.name,
        maxPeriodsPerWeek: teacher.maxPeriodsPerWeek,
        weeklyLoad,
        date,
        workingDays: shape.workingDays,
        dayNames: shape.workingDays.map((d) => DAY_NAMES[d]),
        periods: shape.periods,
        grid,
      };
    });
  }

  /** §10 report 3 — Room Utilization across the week. */
  async roomUtilization(scope: ViewScope, configId: number) {
    if (scope.level !== "all") throw new ForbiddenException("Room utilization needs view.all (§15.3)");
    return this.cached(`rooms:${configId}`, async () => {
      const shape = await this.dayShape(configId);
      const teaching = shape.periods.filter((p) => !p.isBreak && p.periodNumber !== 0 && p.periodNumber !== null).length;
      const capacity = shape.workingDays.length * teaching;
      const rooms = await this.prisma.room.findMany({ where: { schoolId: shape.config.schoolId } });
      const slots = await this.prisma.timetableSlot.findMany({
        where: { timetableConfigId: configId, status: "published", roomId: { not: null } },
      });
      const usage = new Map<number, number>();
      for (const s of slots) usage.set(s.roomId as number, (usage.get(s.roomId as number) ?? 0) + 1);
      return {
        kind: "rooms" as const,
        capacityPerRoom: capacity,
        rows: rooms
          .map((r) => ({
            roomId: r.id,
            name: r.name,
            type: r.roomType,
            used: usage.get(r.id) ?? 0,
            pct: capacity > 0 ? Math.round(((usage.get(r.id) ?? 0) / capacity) * 100) : 0,
          }))
          .sort((a, b) => b.used - a.used),
      };
    });
  }

  /** §10 report 4 — Teacher Load Summary (doubles as feasibility health). */
  async teacherLoadSummary(scope: ViewScope, configId: number) {
    if (scope.level !== "all") throw new ForbiddenException("Load summary needs view.all (§15.3)");
    return this.cached(`load:${configId}`, async () => {
      const shape = await this.dayShape(configId);
      const teachers = await this.prisma.teacher.findMany({ where: { isActive: true } });
      const slots = await this.prisma.timetableSlot.findMany({
        where: { status: "published", teacherOccupancyKey: { not: null } },
      });
      const teaching = shape.periods.filter((p) => !p.isBreak && p.periodNumber !== 0 && p.periodNumber !== null).length;
      const rows = teachers.map((t) => {
        const mine = slots.filter((s) => s.teacherId === t.id);
        const sections = new Set(mine.map((s) => s.classSectionId));
        // gap count: free periods between first and last engagement per day
        let gaps = 0;
        for (const d of shape.workingDays) {
          const periods = mine.filter((s) => s.dayOfWeek === d).map((s) => s.periodNumber).sort((a, b) => a - b);
          if (periods.length >= 2) {
            gaps += periods[periods.length - 1] - periods[0] + 1 - periods.length;
          }
        }
        return {
          teacherId: t.id,
          name: t.name,
          assigned: mine.length,
          capacity: t.maxPeriodsPerWeek,
          weekCapacity: teaching * shape.workingDays.length,
          sections: sections.size,
          gaps,
          over: mine.length > t.maxPeriodsPerWeek,
        };
      });
      return { kind: "load" as const, rows: rows.sort((a, b) => b.assigned - a.assigned) };
    });
  }
}
