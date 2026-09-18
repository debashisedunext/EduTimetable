/**
 * §29.8 — opening, reading and closing an unlock grant.
 *
 * `FreezeService` decides what a grant *admits*. This decides what a grant
 * *is*, and it is the only writer of the three `timetable_unlock*` tables — the
 * same rule §30's `ResourceGroupService` needed, and for the same reason: the
 * invariant here (exactly one of `teacher_id` / `class_section_id` is set) is
 * one MySQL cannot state, so it has to live in one place rather than at every
 * call site that might one day insert a row.
 *
 * ## A grant is ONE decision
 *
 * Ticking four classes and two teachers is a single act with a single reason,
 * a single author and a single moment. Six independent unlock rows would store
 * six copies of that sentence — free to disagree — and leave nothing to close
 * as a unit. So the grant is the header and the entities hang off it.
 *
 * ## The price is part of the decision
 *
 * `options()` returns, for every class-section and teacher in the timetable,
 * how many published lessons unlocking it would open. §21 made this call for
 * relax remedies and it is the same argument: a number in front of a decision
 * is what stops "select all" being the reflex. A school that can see "this
 * opens 147 lessons" ticks differently from one that cannot.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CacheKeysService } from "../redis/cache-keys.service";
import { FreezeService } from "./freeze.service";

/** How long a grant lasts when the caller does not say. */
export const DEFAULT_UNLOCK_MINUTES = 240;
/** Beyond this, an "unlock" is just an unfrozen timetable with extra steps. */
export const MAX_UNLOCK_MINUTES = 60 * 24 * 14;

export interface OpenGrantInput {
  reason: string;
  classSectionIds: number[];
  teacherIds: number[];
  /** Null means "until somebody closes it" — an explicit choice, never a default. */
  expiresInMinutes: number | null;
}

@Injectable()
export class UnlockService {
  private readonly logger = new Logger(UnlockService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: CacheKeysService,
    private readonly freeze: FreezeService,
  ) {}

  /** 404 for another school's id — never an empty list that reads as "no grants". */
  private async ownConfig(configId: number) {
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId },
      select: { id: true, name: true, schoolId: true, frozenAt: true },
    });
    if (!config) throw new NotFoundException(`Timetable ${configId} not found`);
    return config;
  }

  /**
   * What this timetable's grants look like right now.
   *
   * Live grants first, then recently closed ones — the record is only useful if
   * it is where somebody already is, which is why this feeds the Timetables
   * card rather than a screen of its own.
   */
  async list(configId: number) {
    const config = await this.ownConfig(configId);
    const rows = await this.prisma.timetableUnlock.findMany({
      where: { timetableConfigId: configId },
      orderBy: [{ closedAt: "asc" }, { unlockedAt: "desc" }],
      take: 50,
      include: {
        entities: {
          include: {
            teacher: { select: { id: true, name: true } },
            classSection: {
              select: {
                id: true,
                class: { select: { name: true } },
                section: { select: { name: true } },
              },
            },
          },
        },
        _count: { select: { events: true } },
      },
    });

    const now = Date.now();
    return {
      configId: config.id,
      name: config.name,
      locked: config.frozenAt !== null,
      frozenAt: config.frozenAt,
      unlocks: rows.map((r) => {
        const expired = r.expiresAt !== null && r.expiresAt.getTime() <= now;
        return {
          id: r.id,
          reason: r.reason,
          unlockedById: r.unlockedById,
          unlockedAt: r.unlockedAt,
          expiresAt: r.expiresAt,
          closedAt: r.closedAt,
          closedById: r.closedById,
          /* One word for three database states, because the screen asks one
             question: is this grant admitting writes? */
          state: r.closedAt !== null ? "closed" : expired ? "expired" : "live",
          writes: r._count.events,
          entities: r.entities
            .filter((e) => e.releasedAt === null)
            .map((e) =>
              e.teacher
                ? { kind: "teacher" as const, id: e.teacher.id, label: e.teacher.name }
                : {
                    kind: "class_section" as const,
                    id: e.classSection?.id ?? 0,
                    label: e.classSection
                      ? `${e.classSection.class.name}-${e.classSection.section.name}`
                      : "—",
                  },
            ),
        };
      }),
    };
  }

  /**
   * What may be unlocked, and what each one costs.
   *
   * Counted from the PUBLISHED week, which for a locked timetable is the only
   * week there is — §29.1 refuses to freeze a timetable with nothing published,
   * so there is no draft case to handle here.
   *
   * §4.9 option rows carry `class_section_id = NULL` by design, so a
   * section-keyed count misses them entirely while a teacher-keyed one does
   * not. That asymmetry is correct rather than a bug: an elective option really
   * does belong to no section, and the teacher count really does include it.
   */
  async options(configId: number) {
    const config = await this.ownConfig(configId);

    const [sections, slots, teachers] = await Promise.all([
      this.prisma.classSection.findMany({
        where: { timetableConfigId: configId },
        select: {
          id: true,
          class: { select: { name: true, sequence: true } },
          section: { select: { name: true } },
        },
      }),
      this.prisma.timetableSlot.findMany({
        where: {
          timetableConfigId: configId,
          status: "published",
          source: { not: "extra" },
        },
        select: { classSectionId: true, teacherId: true },
      }),
      this.prisma.teacher.findMany({
        where: { schoolId: config.schoolId, isActive: true },
        select: { id: true, name: true, initials: true },
        orderBy: { name: "asc" },
      }),
    ]);

    const bySection = new Map<number, number>();
    const byTeacher = new Map<number, number>();
    for (const s of slots) {
      if (s.classSectionId !== null) {
        bySection.set(s.classSectionId, (bySection.get(s.classSectionId) ?? 0) + 1);
      }
      if (s.teacherId !== null) {
        byTeacher.set(s.teacherId, (byTeacher.get(s.teacherId) ?? 0) + 1);
      }
    }

    return {
      id: config.id,
      name: config.name,
      locked: config.frozenAt !== null,
      classSections: sections
        .map((cs) => ({
          id: cs.id,
          label: `${cs.class.name}-${cs.section.name}`,
          sequence: cs.class.sequence,
          lessons: bySection.get(cs.id) ?? 0,
        }))
        .sort((a, b) => a.sequence - b.sequence || a.label.localeCompare(b.label)),
      /* Teachers who hold nothing in this week are still offered — a school may
         be unlocking somebody in order to give them lessons. They are simply
         priced at 0, which is the truth rather than a reason to hide them. */
      teachers: teachers.map((t) => ({
        id: t.id,
        label: t.name,
        initials: t.initials,
        lessons: byTeacher.get(t.id) ?? 0,
      })),
    };
  }

  /**
   * Open a grant.
   *
   * Refuses on a timetable that is not locked — not because it would be unsafe,
   * but because it would be a record of permission nobody needed, and a live
   * grant on an unlocked timetable is a thing somebody would later have to
   * explain.
   */
  async open(configId: number, actorId: number | null, input: OpenGrantInput) {
    const config = await this.ownConfig(configId);
    if (config.frozenAt === null) {
      throw new BadRequestException(
        `${config.name} is not locked, so nothing needs unlocking. ` +
          `Grants exist to open part of a settled week.`,
      );
    }

    const reason = (input.reason ?? "").trim();
    if (reason.length < 4) {
      throw new BadRequestException(
        "Say why this is being unlocked — the reason is recorded against every change the grant admits.",
      );
    }

    const sectionIds = [...new Set(input.classSectionIds.filter(Number.isInteger))];
    const teacherIds = [...new Set(input.teacherIds.filter(Number.isInteger))];
    if (sectionIds.length === 0 && teacherIds.length === 0) {
      throw new BadRequestException("Pick at least one class-section or teacher to unlock.");
    }

    /*
      A class-section must belong to THIS timetable. Not a formality: the grant
      is keyed by config, and a section from another wing would sit in the
      entity table looking authoritative while opening nothing — a permission
      that silently does not work is worse than one that is refused.
    */
    const sections = await this.prisma.classSection.findMany({
      where: { id: { in: sectionIds } },
      select: {
        id: true,
        timetableConfigId: true,
        class: { select: { name: true } },
        section: { select: { name: true } },
      },
    });
    const foreign = sections.filter((s) => s.timetableConfigId !== configId);
    if (sections.length !== sectionIds.length || foreign.length > 0) {
      const named = foreign.map((s) => `${s.class.name}-${s.section.name}`).join(", ");
      throw new BadRequestException(
        named.length > 0
          ? `${named} ${foreign.length === 1 ? "is" : "are"} not taught by ${config.name}, so unlocking ${foreign.length === 1 ? "it" : "them"} here would open nothing.`
          : "One of those class-sections does not exist.",
      );
    }

    const teachers = await this.prisma.teacher.findMany({
      where: { id: { in: teacherIds } },
      select: { id: true },
    });
    if (teachers.length !== teacherIds.length) {
      throw new BadRequestException("One of those teachers does not exist.");
    }

    const mins = input.expiresInMinutes;
    if (mins !== null && (!Number.isInteger(mins) || mins < 1 || mins > MAX_UNLOCK_MINUTES)) {
      throw new BadRequestException(
        `An unlock lasts between 1 minute and ${MAX_UNLOCK_MINUTES / 60 / 24} days, or until it is closed.`,
      );
    }

    const schoolId = config.schoolId;
    const grant = await this.prisma.timetableUnlock.create({
      data: {
        schoolId,
        timetableConfigId: configId,
        reason,
        unlockedById: actorId,
        expiresAt: mins === null ? null : new Date(Date.now() + mins * 60_000),
        entities: {
          create: [
            ...sectionIds.map((id) => ({ schoolId, classSectionId: id })),
            ...teacherIds.map((id) => ({ schoolId, teacherId: id })),
          ],
        },
      },
      select: { id: true, unlockedAt: true, expiresAt: true },
    });

    await this.freeze.forgetGrant(configId);
    this.logger.log(
      `unlock ${grant.id} opened on timetable ${configId}: ` +
        `${sectionIds.length} class-section(s), ${teacherIds.length} teacher(s)`,
    );
    return {
      ok: true,
      id: grant.id,
      unlockedAt: grant.unlockedAt,
      expiresAt: grant.expiresAt,
      opens: await this.countOpened(configId, sectionIds, teacherIds),
    };
  }

  /** How many published lessons a set of entities opens. The price, after the fact. */
  private async countOpened(configId: number, sectionIds: number[], teacherIds: number[]) {
    if (sectionIds.length === 0 && teacherIds.length === 0) return 0;
    return this.prisma.timetableSlot.count({
      where: {
        timetableConfigId: configId,
        status: "published",
        source: { not: "extra" },
        OR: [
          ...(sectionIds.length > 0 ? [{ classSectionId: { in: sectionIds } }] : []),
          ...(teacherIds.length > 0 ? [{ teacherId: { in: teacherIds } }] : []),
        ],
      },
    });
  }

  /**
   * Close a grant and relock what it opened.
   *
   * The row is KEPT and marked, never deleted — §3.14's rule for withdrawal,
   * and for the same reason: deleting it would erase the school's own record of
   * a change somebody authorised, along with every event hanging off it.
   *
   * Asking twice is the same answer, not a 404: a double-click must not look
   * like a failure.
   */
  async close(configId: number, unlockId: number, actorId: number | null) {
    await this.ownConfig(configId);
    const grant = await this.prisma.timetableUnlock.findFirst({
      where: { id: unlockId, timetableConfigId: configId },
      select: { id: true, closedAt: true },
    });
    if (!grant) throw new NotFoundException(`Unlock ${unlockId} not found on this timetable`);
    if (grant.closedAt) return { ok: true, closedAt: grant.closedAt, alreadyClosed: true };

    const now = new Date();
    // `updateMany`, not `update`: §17's extension adds `schoolId` to every
    // `where`, and `update` needs a where Prisma knows is unique.
    await this.prisma.timetableUnlock.updateMany({
      where: { id: unlockId },
      data: { closedAt: now, closedById: actorId },
    });
    await this.freeze.forgetGrant(configId);
    this.logger.log(`unlock ${unlockId} closed on timetable ${configId}`);
    return { ok: true, closedAt: now };
  }

  /** What one grant was actually used for. */
  async events(configId: number, unlockId: number) {
    await this.ownConfig(configId);
    const grant = await this.prisma.timetableUnlock.findFirst({
      where: { id: unlockId, timetableConfigId: configId },
      select: { id: true, reason: true },
    });
    if (!grant) throw new NotFoundException(`Unlock ${unlockId} not found on this timetable`);
    const rows = await this.prisma.timetableUnlockEvent.findMany({
      where: { unlockId },
      orderBy: { at: "desc" },
      take: 200,
      select: {
        id: true,
        route: true,
        summary: true,
        alsoAffected: true,
        actorId: true,
        at: true,
      },
    });
    return {
      id: grant.id,
      reason: grant.reason,
      // §8.7's trap: the identifier is `id`, so §17.8's sweep can compare two
      // schools' answers rather than reporting "no ids here" and passing for
      // the wrong reason.
      events: rows.map((r) => ({ ...r, id: Number(r.id) })),
    };
  }
}
