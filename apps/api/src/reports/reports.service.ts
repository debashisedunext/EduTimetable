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

/**
 * §10.6 — one row of a card's week.
 *
 * `key` exists because a period NUMBER is not an identity once a card can span
 * more than one wing (§3.10). Primary's P3 and Senior's P3 are different rows
 * at different times, and `grid` is a flat map — keyed by number, one of them
 * silently wins. The key is uniformly `c{configId}p{periodNumber}`: never
 * "sometimes the number, sometimes this", because a two-mode key is a bug
 * waiting for the first school that has two wings.
 *
 * Rows are NOT merged across wings even when their times match. A card shows
 * what is true of one entity; making 09:35 a single shared row is a property of
 * a WALL of cards, which is where the merge belongs — here it would have to
 * pick one of two period numbers and be wrong about the other.
 */
export interface GridRow {
  key: string;
  configId: number;
  /** The wing this row's clock comes from. Renderers show it only when a card spans several. */
  wing: string;
  periodNumber: number | null;
  startTime: string;
  endTime: string | null;
  isBreak: boolean;
  breakName: string | null;
  isActivity?: boolean;
  activityTeacher?: string | null;
  activityRoom?: string | null;
}

/** The one place a row key is built, so the grid writer and the grid reader cannot disagree. */
export const rowKey = (configId: number, periodNumber: number | null) => `c${configId}p${periodNumber}`;
/** And the one place a grid key is built. */
export const cellKey = (day: number, key: string) => `${day}:${key}`;

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
   * §10.6 — the slot rows this cell is drawn from.
   *
   * Carried so a wall of cards can highlight one lesson everywhere it appears:
   * a teacher's card, their class's card and their room's card are three
   * projections of the same `timetable_slot`, and this is what says so. Sent as
   * strings because slot ids are BigInt.
   */
  slotIds?: string[];
  /**
   * §10.6 — a subject card's cell is a COUNT, not a lesson. Maths runs in eight
   * sections at Monday P1; a cell that named one of them would discard seven.
   */
  count?: number;
  sections?: string[];
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

/** The four things a §10.6 wall card can be bound to. */
export const WALL_KINDS = ["teacher", "class-section", "room", "subject"] as const;
export type WallKind = (typeof WALL_KINDS)[number];

/**
 * How many cards one wall request will serve.
 *
 * A number rather than "as many as you like": each card is a handful of
 * queries, and the §14 budget is 300 ms for the request as a whole. 24 is four
 * rows of six, which is more than fits legibly on a screen anyway.
 */
export const WALL_MAX = 24;

/** `t:1,cs:44,r:7,sub:3` — the §29.3 `units=` idiom, so a heterogeneous id list
 *  has ONE shape in this codebase rather than two. */
const WALL_PREFIX: Record<string, WallKind> = {
  t: "teacher", cs: "class-section", r: "room", sub: "subject",
};

export function parseWallCards(raw: string | undefined): Array<{ kind: WallKind; id: number }> {
  if (!raw) return [];
  const out: Array<{ kind: WallKind; id: number }> = [];
  for (const part of raw.split(",")) {
    const [p, rawId] = part.trim().split(":");
    const kind = WALL_PREFIX[p];
    const id = Number(rawId);
    // An unknown prefix is SKIPPED, not refused. A wall is a saved layout that
    // outlives the things on it, and a stale entry must not make the other
    // eleven cards unreachable — §21's "an unknown key is ignored, the screen
    // may be stale" applied to the same shape of problem.
    if (!kind || !Number.isInteger(id) || id <= 0) continue;
    if (!out.some((c) => c.kind === kind && c.id === id)) out.push({ kind, id });
  }
  return out;
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

  /**
   * §10.6 — the rows for a card that may span several wings.
   *
   * This replaces a real defect rather than adding a feature. `teacherTimetable`
   * took its day shape from `slots[0].timetableConfigId` — whichever row the
   * database happened to return first — and then the renderer iterated THAT
   * wing's periods. A teacher working in a 6-period wing and an 8-period wing
   * got one of the two: lessons at a period number the chosen wing does not
   * have were **not drawn at all**, and lessons at a shared number were drawn on
   * the wrong clock row. §3.10 makes cross-wing teachers ordinary, so this was
   * wrong for every school that has one.
   *
   * Rows are the UNION, ordered by real time, each carrying the wing it came
   * from. Two wings whose periods interleave therefore interleave here, which is
   * what is actually true of that person's morning.
   */
  private async shapeFor(configIds: number[]) {
    const ids = [...new Set(configIds)].filter((id): id is number => typeof id === "number");
    if (ids.length === 0) {
      return {
        rows: [] as GridRow[], workingDays: [1, 2, 3, 4, 5],
        wings: [] as Array<{ id: number; name: string; effectiveFrom: string | null; effectiveTo: string | null }>,
      };
    }
    const configs = await this.prisma.timetableConfig.findMany({
      where: { id: { in: ids } },
      orderBy: { id: "asc" },
      include: {
        periods: {
          orderBy: { sortOrder: "asc" },
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
    if (configs.length === 0) throw new NotFoundException("Timetable config not found");

    const rows: GridRow[] = [];
    // A day is a working day of the card if ANY of its wings teaches then —
    // intersecting would hide a Saturday that one wing really does run.
    const days = new Set<number>();
    for (const cfg of configs) {
      for (const d of ((cfg.workingDays as number[]) ?? [1, 2, 3, 4, 5])) days.add(d);
      for (const p of cfg.periods) {
        rows.push({
          key: rowKey(cfg.id, p.periodNumber),
          configId: cfg.id,
          wing: cfg.name,
          periodNumber: p.periodNumber,
          startTime: p.startTime,
          endTime: p.endTime,
          isBreak: p.isBreak,
          breakName: p.breakName,
          isActivity: p.isActivity,
          activityTeacher: p.activity?.teacher?.initials ?? p.activity?.teacher?.name ?? null,
          activityRoom: p.activity?.room?.name ?? null,
        });
      }
    }
    // By clock, then by wing, so a single-wing card keeps exactly the order it
    // has always had and a two-wing card reads down the morning.
    rows.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.configId - b.configId);
    return {
      rows,
      workingDays: [...days].sort((a, b) => a - b),
      /*
        §30.5 — the window travels with the WING, not with the card. A card can
        span two wings (§10.6), and those wings may apply over different dates;
        one window on the card would have to pick one of them and be wrong about
        the other.
      */
      wings: configs.map((c) => ({
        id: c.id,
        name: c.name,
        effectiveFrom: c.effectiveFrom ? c.effectiveFrom.toISOString().slice(0, 10) : null,
        effectiveTo: c.effectiveTo ? c.effectiveTo.toISOString().slice(0, 10) : null,
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
      // Exactly one config, by invariant 11 — so this card's rows can never be
      // the union of two wings, and it keeps the shape it has always had.
      const shape = await this.shapeFor([cs.timetableConfigId]);
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
          const optRows = optionsAt.get(`${s.electiveBlockId}:${s.dayOfWeek}:${s.periodNumber}`) ?? [];
          grid[cellKey(s.dayOfWeek, rowKey(s.timetableConfigId, s.periodNumber))] = {
            period: s.periodNumber,
            slotIds: [s.id.toString(), ...optRows.map((o) => o.id.toString())],
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
        grid[cellKey(s.dayOfWeek, rowKey(s.timetableConfigId, s.periodNumber))] = {
          period: s.periodNumber,
          slotIds: [s.id.toString()],
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
        periods: shape.rows,
        wings: shape.wings,
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

      /*
        §10.6 — EVERY wing this teacher appears in, not `slots[0]`'s.

        The old line took the day shape from whichever slot row came back first
        and drew the whole week against it. §3.10 makes a cross-wing teacher
        ordinary — the art teacher who also covers Class 6 — so for those
        teachers the grid was wrong twice over: a lesson at a period number the
        chosen wing does not have was dropped entirely by the renderer, and one
        at a shared number was drawn at the other wing's clock time.
      */
      const shape = await this.shapeFor(
        [...slots, ...dutySlots].map((s) => s.timetableConfigId),
      );

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
        grid[cellKey(s.dayOfWeek, rowKey(s.timetableConfigId, s.periodNumber))] = {
          period: s.periodNumber,
          slotIds: [s.id.toString()],
          subject: s.subjectId !== null ? (subjects.get(s.subjectId) ?? null) : null,
          teacher: null,
          room: s.roomId !== null ? (rooms.get(s.roomId) ?? null) : null,
          classSection: whereTaught(s),
          substituted: false,
        };
      }
      for (const s of dutySlots) {
        grid[cellKey(s.dayOfWeek, rowKey(s.timetableConfigId, s.periodNumber))] = {
          period: s.periodNumber,
          slotIds: [s.id.toString()],
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
        periods: shape.rows,
        wings: shape.wings,
        grid,
      };
    });
  }

  /**
   * §10.6 report 5 — one ROOM's week.
   *
   * Needs `view.all`, deliberately, and this is the one place the §10.6 plan was
   * corrected while building it. Scope elsewhere in this module is a row-level
   * *filter* — a class-scoped teacher sees their own sections and nothing else.
   * Filtering a room's occupancy that way produces a grid that says **"Lab 2 is
   * free on Monday P3"** when another class is in it, which is worse than
   * refusing: it is a wrong answer to the exact question the screen exists for.
   * Room utilisation already required `view.all` for the same reason.
   *
   * Option rows (§4.9, `class_section_id = NULL`) arrive naturally here because
   * the query is by room rather than by section — but they are the invariant-9
   * trap one level out, so they are labelled by their block rather than left
   * with a blank class.
   */
  async roomTimetable(scope: ViewScope, roomId: number, date: string | null) {
    if (scope.level !== "all") {
      throw new ForbiddenException("A room's week needs view.all — a partly-filtered one would show occupied rooms as free (§15.3)");
    }
    return this.cached(`room:${roomId}:${date ?? "base"}`, async () => {
      const room = await this.prisma.room.findUnique({ where: { id: roomId } });
      if (!room) throw new NotFoundException("Room not found");
      const slots = await this.prisma.timetableSlot.findMany({
        where: { roomId, status: "published" },
      });
      const shape = await this.shapeFor(slots.map((s) => s.timetableConfigId));
      const subs = await this.subsFor(date, slots.map((s) => s.id));
      const teacherNames = await this.names([
        ...new Set([...slots.map((s) => s.teacherId).filter((x): x is number => x !== null), ...subs.values()]),
      ]);
      const subjects = new Map(
        (await this.prisma.subject.findMany({ where: { id: { in: slots.map((s) => s.subjectId).filter((x): x is number => x !== null) } } })).map((s) => [s.id, s.name]),
      );
      const sectionRows = await this.prisma.classSection.findMany({
        where: { id: { in: [...new Set(slots.map((s) => s.classSectionId).filter((x): x is number => x !== null))] } },
        include: { class: true, section: true },
      });
      const sectionLabel = new Map(sectionRows.map((cs) => [cs.id, `${cs.class.name}-${cs.section.name}`]));
      const blockRows = await this.prisma.electiveBlock.findMany({
        where: { id: { in: [...new Set(slots.map((s) => s.electiveBlockId).filter((x): x is number => x !== null))] } },
        select: { id: true, name: true },
      });
      const blockName = new Map(blockRows.map((b) => [b.id, b.name]));

      const grid: Record<string, GridCell> = {};
      for (const s of slots) {
        const sub = subs.get(s.id.toString());
        grid[cellKey(s.dayOfWeek, rowKey(s.timetableConfigId, s.periodNumber))] = {
          period: s.periodNumber,
          slotIds: [s.id.toString()],
          subject: s.subjectId !== null ? (subjects.get(s.subjectId) ?? null) : null,
          teacher: teacherNames.get(sub ?? s.teacherId ?? -1) ?? null,
          room: null,
          classSection:
            s.classSectionId !== null
              ? (sectionLabel.get(s.classSectionId) ?? null)
              : s.electiveBlockId !== null
                ? (blockName.get(s.electiveBlockId) ?? null)
                : null,
          substituted: sub !== undefined,
        };
      }
      return {
        kind: "room" as const,
        label: room.name,
        roomType: room.roomType,
        date,
        workingDays: shape.workingDays,
        dayNames: shape.workingDays.map((d) => DAY_NAMES[d]),
        periods: shape.rows,
        wings: shape.wings,
        grid,
      };
    });
  }

  /**
   * §10.6 report 6 — one SUBJECT's week, as density.
   *
   * A subject is not one lesson. Maths runs in eight sections at Monday P1, so a
   * cell drawn like a teacher's would name one of them and quietly discard
   * seven. The cell is therefore a count plus the sections behind it, which
   * answers the question the card is actually for: *when is this taught, and is
   * it stacked where the school said it should be* (§26's priority and lunch
   * rules, audited after the fact rather than asserted).
   *
   * `view.all` for the same reason as the room card: a filtered count is a
   * wrong number, not a smaller one.
   */
  async subjectTimetable(scope: ViewScope, subjectId: number, date: string | null) {
    if (scope.level !== "all") {
      throw new ForbiddenException("A subject's week needs view.all — a filtered count would be a wrong number, not a smaller one (§15.3)");
    }
    return this.cached(`subj:${subjectId}:${date ?? "base"}`, async () => {
      const subject = await this.prisma.subject.findUnique({ where: { id: subjectId } });
      if (!subject) throw new NotFoundException("Subject not found");
      const slots = await this.prisma.timetableSlot.findMany({
        where: { subjectId, status: "published" },
      });
      const shape = await this.shapeFor(slots.map((s) => s.timetableConfigId));
      const subs = await this.subsFor(date, slots.map((s) => s.id));
      const sectionRows = await this.prisma.classSection.findMany({
        where: { id: { in: [...new Set(slots.map((s) => s.classSectionId).filter((x): x is number => x !== null))] } },
        include: { class: true, section: true },
      });
      const sectionLabel = new Map(sectionRows.map((cs) => [cs.id, `${cs.class.name}-${cs.section.name}`]));
      const blockRows = await this.prisma.electiveBlock.findMany({
        where: { id: { in: [...new Set(slots.map((s) => s.electiveBlockId).filter((x): x is number => x !== null))] } },
        select: { id: true, name: true },
      });
      const blockName = new Map(blockRows.map((b) => [b.id, b.name]));
      const whereTaught = (s: { classSectionId: number | null; electiveBlockId: number | null }) =>
        s.classSectionId !== null
          ? (sectionLabel.get(s.classSectionId) ?? null)
          : s.electiveBlockId !== null
            ? (blockName.get(s.electiveBlockId) ?? null)
            : null;

      const grid: Record<string, GridCell> = {};
      let busiest = 0;
      for (const s of slots) {
        const k = cellKey(s.dayOfWeek, rowKey(s.timetableConfigId, s.periodNumber));
        const at = grid[k];
        const where = whereTaught(s);
        if (at) {
          at.count = (at.count ?? 0) + 1;
          if (where) at.sections!.push(where);
          at.slotIds!.push(s.id.toString());
          at.substituted = at.substituted || subs.has(s.id.toString());
        } else {
          grid[k] = {
            period: s.periodNumber,
            slotIds: [s.id.toString()],
            subject: subject.name,
            teacher: null,
            room: null,
            classSection: null,
            substituted: subs.has(s.id.toString()),
            count: 1,
            sections: where ? [where] : [],
          };
        }
        busiest = Math.max(busiest, grid[k].count ?? 1);
      }
      for (const cell of Object.values(grid)) cell.sections?.sort((a, b) => a.localeCompare(b));
      return {
        kind: "subject" as const,
        label: subject.name,
        /** The scale the heat tint is drawn against — sent, never guessed at render time. */
        busiest,
        weeklyLessons: slots.length,
        date,
        workingDays: shape.workingDays,
        dayNames: shape.workingDays.map((d) => DAY_NAMES[d]),
        periods: shape.rows,
        wings: shape.wings,
        grid,
      };
    });
  }

  /**
   * §10.6 — many cards, one request.
   *
   * A wall of twelve grids is twelve round trips otherwise, against a 300 ms
   * budget (§14). Each card still goes through its own function, so a card on
   * the wall and the same card on the Reports screen cannot come out different —
   * the saving is the round trips and the shared Redis reads, not a second
   * query path.
   *
   * **A refused card is data, not an error.** One card outside the caller's
   * scope must not blank the other eleven: a wall is often shared, and the
   * viewer who cannot see one room should still see the ten teachers. So each
   * card resolves independently and a refusal comes back as `{ denied, reason }`
   * in its own place on the wall.
   *
   * The cap is stated in the response rather than applied silently — §10.6's own
   * rule, and the one the codebase keeps having to relearn: a truncation nobody
   * is told about reads as "that is everything".
   */
  async wall(
    scope: ViewScope,
    cards: Array<{ kind: WallKind; id: number }>,
    date: string | null,
  ) {
    const taken = cards.slice(0, WALL_MAX);
    const results = await Promise.all(
      taken.map(async (c) => {
        try {
          switch (c.kind) {
            case "teacher": return { ...c, card: await this.teacherTimetable(scope, c.id, date) };
            case "class-section": return { ...c, card: await this.classSectionTimetable(scope, c.id, date) };
            case "room": return { ...c, card: await this.roomTimetable(scope, c.id, date) };
            case "subject": return { ...c, card: await this.subjectTimetable(scope, c.id, date) };
          }
        } catch (e) {
          /*
            Only the two refusals a wall can legitimately meet are swallowed.
            Anything else — a broken query, a bad migration — must still be a
            500, or the wall becomes the one screen in the app where a real
            fault renders as a tidy grey card saying "not available".
          */
          if (e instanceof ForbiddenException || e instanceof NotFoundException) {
            return { ...c, denied: true, reason: (e.getResponse() as any)?.message ?? e.message };
          }
          throw e;
        }
      }),
    );
    return {
      date,
      max: WALL_MAX,
      dropped: cards.length - taken.length,
      cards: results,
    };
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
