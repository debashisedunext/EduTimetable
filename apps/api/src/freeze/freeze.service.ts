/**
 * §29.1 + §29.8 — what a locked timetable refuses, in one place.
 *
 * Publishing puts a week on the wall. Locking says it is settled: while a
 * timetable is locked, nothing may change what a class is taught, who teaches
 * it, or when. The reason is not tidiness — it is that the printed copy in
 * every classroom and staff room is now a second source of truth, and a change
 * made here without a change made there produces two answers to "when is Class
 * 5-A's Maths?" with nothing to say which is right.
 *
 * ## §29.8 — the grant
 *
 * §29.1 gave a timetable one state: frozen or not, all or nothing. That is
 * right for "this week is settled" and useless for what a school does next —
 * one urgent change to Class 1-A, or replacing a teacher who has resigned. The
 * only way through was to unfreeze everything, which protects nothing for as
 * long as the change takes.
 *
 * So an unlock names ENTITIES — class-sections and teachers, as many as the
 * school means to re-plan — and opens every lesson those entities appear in:
 *
 *     open(row) = every teacher on it is unlocked
 *              OR every class-section on it is unlocked
 *
 * A write is admitted when every row it touches is open, and refused, by name,
 * the moment one is not. `grant.ts` is that predicate and the only statement of
 * it; this service is the IO around it.
 *
 * ## Two classifications, and the line between them
 *
 * Every guarded route is either **scopeable** or **whole**:
 *
 * - `assertTouched` is the scopeable guard. The caller says which rows it is
 *   about to change, and a grant can admit it.
 * - `assertConfigs` / `assertNoneFrozen` are the whole-timetable guards. **No
 *   entity grant can reach them, however many entities are ticked.** Generate
 *   is the clearest case: it decides which rows exist, so "is every touched row
 *   open?" cannot be answered before it runs.
 *
 * A route with no classification is a route nobody decided about, which is why
 * `scripts/locks-smoke.cjs` drives every one of them and requires each to
 * refuse under lock — and, for the scopeable ones, to succeed for an unlocked
 * entity while the identical call for a locked one still refuses.
 *
 * ## The shape, and why it is this shape
 *
 * This is `teacher-scope.util.ts` and `subject-scope.util.ts` again: ONE
 * definition of the rule and its message, called at every attachment point.
 * The alternative — a Prisma extension, as §17's school-scoping uses — was
 * considered and rejected: school scoping reads an ambient context and needs no
 * query, whereas "is this row's timetable locked?" needs a lookup per write for
 * models that reach a config only through two joins (`class_subjects` through
 * classes and sections; `teacher_subject_class_section` through a section), and
 * the §14 budget is not the place to pay for that on every insert.
 *
 * The cost of the call-site shape is that a NEW write path can forget to ask.
 * `scripts/freeze-smoke.cjs` and `scripts/locks-smoke.cjs` are what stop that
 * being discovered by a school.
 *
 * ## What is deliberately NOT locked
 *
 * Anything that cannot contradict the published week: adding a teacher, a room
 * or a subject; creating next year's session; cloning this timetable into a new
 * one (the source is only read). A lock that blocked hiring would be a lock
 * people work around.
 *
 * **Availability (§4.7a/§4.7b) is also deliberately not locked**, and it is the
 * one case worth arguing. "Mrs Rao now leaves at 1pm on Fridays" is a fact about
 * a person, not an allocation — and it is exactly the fact a school records
 * *before* re-staffing. Refusing it would leave them unable to write down the
 * thing that prompted the unlock. Accepted, it makes Readiness report a
 * published week that no longer satisfies a hard constraint, which is true, and
 * is the school being told there is something to fix.
 */
import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import type Redis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";
import { REDIS } from "../redis/redis.module";
import { CacheKeysService } from "../redis/cache-keys.service";
import { opensRow, shutEntities, type GrantSets, type TouchedRow } from "./grant";

/** The locked timetables among a set, named for the message. */
interface Locked {
  id: number;
  name: string;
}

/** One live grant, flattened for the predicate. */
interface Grant extends GrantSets {
  ids: number[];
}

/**
 * What a successful `assertTouched` hands back.
 *
 * The write has been admitted; `record` is how it says what it then did. It is
 * deliberately a separate call made AFTER the write rather than something the
 * guard does for you: recording at guard time would claim changes that went on
 * to fail on a unique key, and an audit that over-reports is worse than one
 * with a gap, because nothing in it can be trusted.
 */
export interface GrantTicket {
  /** Grant ids that admitted this write. Empty when the timetable was not locked. */
  admittedBy: number[];
  /** Say what happened. Never throws — see `record` below. */
  record(summary: string, alsoAffected?: unknown): Promise<void>;
}

/** A ticket for a write that needed no grant, so has nothing to record. */
const UNLOCKED_TICKET: GrantTicket = { admittedBy: [], record: async () => {} };

@Injectable()
export class FreezeService {
  private readonly logger = new Logger(FreezeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: CacheKeysService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ───────────────────────────────────────────────────── the refusals

  /**
   * The refusal, worded once.
   *
   * Every call site passes only WHAT it was about to do, so the sentence reads
   * as one voice however it is reached — and so that a change to how a school
   * gets out of it is made in one place rather than in twenty strings.
   */
  private refuse(locked: Locked[], what: string, hint?: string): never {
    const names = locked.map((f) => f.name).join(", ");
    throw new BadRequestException(
      `${names} ${locked.length === 1 ? "is" : "are"} locked, so ${what} cannot be changed. ` +
        (hint ??
          `Unlock the classes or teachers you need to re-plan — or the whole timetable — ` +
            `on the Timetables screen.`),
    );
  }

  /**
   * §29.8 — the scoped refusal, which NAMES what is shut.
   *
   * The whole value of a scoped lock is in this sentence. "The timetable is
   * locked" sends somebody to unlock everything; "Class 1-B is not unlocked"
   * tells them the one thing to add, which is the difference between a feature
   * people use and one they route around.
   */
  private async refuseScoped(
    locked: Locked,
    shut: { teacherIds: number[]; classSectionIds: number[] },
    what: string,
  ): Promise<never> {
    const names: string[] = [];
    if (shut.classSectionIds.length > 0) {
      const rows = await this.prisma.classSection.findMany({
        where: { id: { in: shut.classSectionIds } },
        select: { class: { select: { name: true } }, section: { select: { name: true } } },
      });
      names.push(...rows.map((r) => `${r.class.name}-${r.section.name}`));
    }
    if (shut.teacherIds.length > 0) {
      const rows = await this.prisma.teacher.findMany({
        where: { id: { in: shut.teacherIds } },
        select: { name: true },
      });
      names.push(...rows.map((r) => r.name));
    }
    const list = names.length > 0 ? names.join(", ") : "part of what this changes";
    throw new BadRequestException(
      `${locked.name} is locked and ${list} ${names.length === 1 ? "is" : "are"} not unlocked, ` +
        `so ${what} cannot be changed. Add ${names.length === 1 ? "it" : "them"} to the unlock ` +
        `on the Timetables screen, or unlock the whole timetable.`,
    );
  }

  // ───────────────────────────────────────────────── reading the state

  /** Which of these timetables are locked. Empty ids is empty, not "all". */
  private async lockedAmong(configIds: number[]): Promise<Locked[]> {
    const ids = [...new Set(configIds.filter((n) => Number.isInteger(n)))];
    if (ids.length === 0) return [];
    return this.prisma.timetableConfig.findMany({
      where: { id: { in: ids }, frozenAt: { not: null } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
  }

  /**
   * The live grant for one timetable, or an empty one.
   *
   * Cached under the config's own slot prefix, so `invalidateTimetable` already
   * sweeps it and there is no second invalidation rule to remember (invariant
   * 3's lesson about open-ended suffixes). The cached value keeps `expiresAt`
   * rather than a pre-computed answer, because expiry is a function of *now*
   * and a cached "still open" would go on admitting writes after the grant had
   * lapsed.
   */
  async liveGrant(configId: number): Promise<Grant> {
    const key = this.keys.slots(configId, "unlock");
    const cached = await this.redis.get(key);
    let raw: Array<{ id: number; expiresAt: string | null; t: number[]; s: number[] }>;

    if (cached) {
      raw = JSON.parse(cached);
    } else {
      const rows = await this.prisma.timetableUnlock.findMany({
        where: { timetableConfigId: configId, closedAt: null },
        select: {
          id: true,
          expiresAt: true,
          entities: {
            where: { releasedAt: null },
            select: { teacherId: true, classSectionId: true },
          },
        },
      });
      raw = rows.map((r) => ({
        id: r.id,
        expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
        t: r.entities.map((e) => e.teacherId).filter((x): x is number => x !== null),
        s: r.entities.map((e) => e.classSectionId).filter((x): x is number => x !== null),
      }));
      await this.redis.set(key, JSON.stringify(raw), "EX", 900);
    }

    const now = Date.now();
    const grant: Grant = { ids: [], teacherIds: new Set(), classSectionIds: new Set() };
    for (const g of raw) {
      if (g.expiresAt !== null && Date.parse(g.expiresAt) <= now) continue;
      grant.ids.push(g.id);
      g.t.forEach((id) => grant.teacherIds.add(id));
      g.s.forEach((id) => grant.classSectionIds.add(id));
    }
    return grant;
  }

  /** Drop the cached grant for one timetable. Called by the unlock writer. */
  async forgetGrant(configId: number): Promise<void> {
    await this.redis.del(this.keys.slots(configId, "unlock"));
  }

  // ─────────────────────────────────────────── the WHOLE-timetable guard

  /**
   * Refuse when any of these timetables is locked.
   *
   * **No entity grant reaches this.** It is the guard for writes whose touched
   * set is the week itself — generate, the period grid, daily activities,
   * publish, withdraw, deleting the timetable — or cannot be known in advance.
   * Generate is the one worth stating: it decides which rows exist, so there is
   * nothing to check against a grant before it runs.
   */
  async assertConfigs(configIds: number[], what: string, hint?: string): Promise<void> {
    const locked = await this.lockedAmong(configIds);
    if (locked.length > 0) this.refuse(locked, what, hint);
  }

  /**
   * Refuse when ANY timetable in the school is locked.
   *
   * For the bulk writers — the §16 importer and the guided setup's commits —
   * which resolve names to rows deep inside one transaction and cannot say up
   * front which timetables they will touch. Deliberately blunt: a school that
   * has locked one wing and is still building another unlocks to import, which
   * is one click and is at least honest about what it is protecting. The narrow
   * version would have to re-derive the importer's own name resolution, and a
   * second copy of that is how the two would drift.
   */
  async assertNoneFrozen(what: string): Promise<void> {
    const locked = await this.prisma.timetableConfig.findMany({
      where: { frozenAt: { not: null } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    if (locked.length > 0) this.refuse(locked, what);
  }

  // ─────────────────────────────────────────────── the SCOPEABLE guard

  /**
   * §29.8 — refuse unless every row this write touches is open.
   *
   * The rows are described by their owners, never by their ids: the predicate
   * is about who a lesson belongs to, and a caller that has not resolved that
   * cannot be admitted (a row naming nothing is never open — see `grant.ts`).
   *
   * Returns a ticket. The write happens, then the caller records what it did.
   */
  async assertTouched(configId: number, rows: TouchedRow[], what: string): Promise<GrantTicket> {
    const locked = await this.lockedAmong([configId]);
    if (locked.length === 0) return UNLOCKED_TICKET;

    const grant = await this.liveGrant(configId);
    // The common case by a wide margin: locked, nothing unlocked. One extra
    // Redis read has already answered it, so refuse here without touching the
    // database again.
    if (grant.ids.length === 0) this.refuse(locked, what);

    for (const row of rows) {
      if (opensRow(grant, row)) continue;
      await this.refuseScoped(locked[0], shutEntities(grant, row), what);
    }
    return this.ticketFor(configId, grant, what);
  }

  /**
   * §29.8 — the fast refusal, for callers that must do work before they can
   * describe what they touch.
   *
   * The board is the case: it cannot name the rows of a card until it has built
   * the solver input and resolved the cell, and building that input for a
   * locked timetable with nothing unlocked — the overwhelmingly common state —
   * would be the §14 budget spent entirely on producing a refusal.
   *
   * It is a *precondition*, never the guard. A caller that stops here has
   * checked only that SOME grant exists, which says nothing about whether this
   * grant opens that row; `assertTouched` is still required afterwards.
   */
  async assertUnlockable(configId: number, what: string): Promise<void> {
    const locked = await this.lockedAmong([configId]);
    if (locked.length === 0) return;
    const grant = await this.liveGrant(configId);
    if (grant.ids.length === 0) this.refuse(locked, what);
  }

  /**
   * Refuse when any of these class-sections belongs to a locked timetable.
   *
   * The route for mappings, merged groups, elective blocks and class-teacher
   * assignment — all of which name sections rather than a timetable. A section
   * with no timetable yet (§16.1) is not locked, and is simply absent from the
   * result rather than treated as a missing case.
   *
   * §29.8: the sections are treated as ONE row, so it takes all of them — see
   * `grant.ts` for why a merged group cannot be opened by one of its three
   * members. `teacherIds` is the other clause: a mapping names a teacher, and
   * unlocking that teacher is what makes re-staffing possible without unlocking
   * every class they teach.
   */
  async assertSections(
    classSectionIds: number[],
    what: string,
    opts?: { teacherIds?: number[] },
  ): Promise<GrantTicket> {
    const ids = [...new Set(classSectionIds.filter((n) => Number.isInteger(n)))];
    if (ids.length === 0) return UNLOCKED_TICKET;
    const sections = await this.prisma.classSection.findMany({
      where: { id: { in: ids }, timetableConfigId: { not: null } },
      select: { id: true, timetableConfigId: true },
    });
    return this.assertGroupedByConfig(sections, opts?.teacherIds ?? [], what);
  }

  /**
   * Refuse when a class's sections sit in a locked timetable.
   *
   * The route for the curriculum, which is keyed by CLASS (§3.11) and so may
   * reach several timetables at once — a school running Class 5 in two wings
   * has one curriculum row and two published weeks, and changing the row
   * changes both. The year narrows it, because a class has sections in every
   * session it has ever run and last year's locked timetable must not refuse
   * this year's planning.
   *
   * §29.8: no teacher clause, because a `class_subjects` row does not name one
   * (§27 — periods are a class fact). It therefore takes every section of the
   * class in that timetable, which is exactly what changing the row changes.
   */
  async assertClasses(
    classIds: number[],
    academicYearId: number | null,
    what: string,
  ): Promise<GrantTicket> {
    const ids = [...new Set(classIds.filter((n) => Number.isInteger(n)))];
    if (ids.length === 0) return UNLOCKED_TICKET;
    const sections = await this.prisma.classSection.findMany({
      where: {
        classId: { in: ids },
        timetableConfigId: { not: null },
        ...(academicYearId !== null ? { academicYearId } : {}),
      },
      select: { id: true, timetableConfigId: true },
    });
    return this.assertGroupedByConfig(sections, [], what);
  }

  /**
   * One row per timetable, checked against that timetable's own grant.
   *
   * A set of sections can span configs — §4.10 merged groups carry no config FK
   * and a class runs in several wings — and a grant belongs to one timetable.
   * Checking the whole set against one grant would let a grant in Main Wing
   * admit a change to Junior Wing's rows.
   */
  private async assertGroupedByConfig(
    sections: Array<{ id: number; timetableConfigId: number | null }>,
    teacherIds: number[],
    what: string,
  ): Promise<GrantTicket> {
    const byConfig = new Map<number, number[]>();
    for (const s of sections) {
      if (s.timetableConfigId === null) continue;
      const list = byConfig.get(s.timetableConfigId) ?? [];
      list.push(s.id);
      byConfig.set(s.timetableConfigId, list);
    }
    const tickets: GrantTicket[] = [];
    for (const [configId, ids] of byConfig) {
      tickets.push(await this.assertTouched(configId, [{ teacherIds, classSectionIds: ids }], what));
    }
    return mergeTickets(tickets);
  }

  // ───────────────────────────────────────────────────────── the record

  private ticketFor(configId: number, grant: Grant, what: string): GrantTicket {
    const record = async (summary: string, alsoAffected?: unknown) => {
      try {
        const schoolId = this.keys.schoolId();
        await this.prisma.timetableUnlockEvent.createMany({
          data: grant.ids.map((unlockId) => ({
            schoolId,
            unlockId,
            route: what,
            summary: summary.slice(0, 255),
            alsoAffected: (alsoAffected ?? null) as never,
          })),
        });
      } catch (e) {
        /*
          Logged, never thrown. The write this describes has already succeeded,
          and turning a failed audit insert into a 500 would tell the client
          their change did not happen when it did — the half-applied report
          §29.6 exists to prevent, in its other direction.
        */
        this.logger.error(
          `unlock event not recorded for config ${configId}: ${(e as Error).message}`,
        );
      }
    };
    return { admittedBy: grant.ids, record };
  }
}

/** One ticket standing for several, when a write spanned two timetables. */
function mergeTickets(tickets: GrantTicket[]): GrantTicket {
  const live = tickets.filter((t) => t.admittedBy.length > 0);
  if (live.length === 0) return UNLOCKED_TICKET;
  if (live.length === 1) return live[0];
  return {
    admittedBy: live.flatMap((t) => t.admittedBy),
    record: async (summary, also) => {
      for (const t of live) await t.record(summary, also);
    },
  };
}
