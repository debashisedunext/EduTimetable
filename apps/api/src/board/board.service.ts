/**
 * Task 3.5 — server-side drop revalidation. Every board mutation:
 *   1. re-runs the SAME BoardEngine the client ran (one rules engine),
 *   2. rejects stale state (409) when the touched cells no longer hold what
 *      the client saw,
 *   3. applies atomically — the §3 unique keys stay the last-resort guard,
 *   4. invalidates slot caches and broadcasts `slots:changed` so every other
 *      open board refetches (concurrent-admin awareness, task 3.1).
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type Redis from "ioredis";
import {
  BoardEngine,
  entryKeyOf,
  type SlotRow,
  type SolverInput,
} from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { DraftsService } from "../drafts/drafts.service";
import { FreezeService } from "../freeze/freeze.service";
import { REDIS } from "../redis/redis.module";
import { CacheKeysService } from "../redis/cache-keys.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EventsGateway } from "../events/events.gateway";
import { buildSolverInput } from "../solver/input";

export interface CellRef {
  /** null when the card is a §4.9 block: its option rows belong to no section */
  classSectionId: number | null;
  day: number;
  period: number;
  /** §4.9 — set instead of `classSectionId` to name a whole elective block */
  electiveBlockId?: number | null;
}
/**
 * What the client believes the cell holds — differing content = stale (409).
 *
 * A §4.9 block has no subject or teacher of its own, so it is identified by
 * the set of option ids running in it. That is the thing that would have
 * changed underneath the admin: an option retimed, added or removed.
 */
export interface CellExpectation {
  subjectId: number | null;
  teacherId: number | null;
  electiveOptionIds?: number[];
}

const occupancyKey = (teacherId: number, mergedGroupId: number | null) =>
  mergedGroupId !== null ? `MG-${mergedGroupId}` : `T-${teacherId}`;

@Injectable()
export class BoardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly keys: CacheKeysService,
    private readonly tenant: TenantContextService,
    private readonly drafts: DraftsService,
    private readonly freeze: FreezeService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * §29.1 — every board edit asks first.
   *
   * Guarded in the SERVICE rather than the controller, so the answer holds for
   * every caller — including anything that reaches these methods without going
   * through an HTTP route. `context` and the read paths are deliberately not
   * guarded: looking at a locked week is exactly what a locked week is for.
   *
   * Board edits touch DRAFT rows, not the published set, which makes it
   * tempting to leave them alone. That would make the lock theatre: a draft
   * edited and then published is the published week changed, by two clicks
   * instead of one.
   *
   * §29.8 splits the question in two, because a board edit cannot say what it
   * touches until it has resolved the cell:
   *
   *   `editable` is the precondition — locked with no grant at all refuses here,
   *   before the solver input is built, which is the common state and the one
   *   worth not paying for.
   *   `scoped` is the guard — once the rows are known, every one of them must be
   *   open, and the refusal names whichever is not.
   */
  private editable(configId: number) {
    return this.freeze.assertUnlockable(configId, "the timetable");
  }

  /**
   * §29.8 — the rows of a card, described by whom they belong to.
   *
   * A card is ONE row for the predicate however many database rows it holds: a
   * §4.10 merged group is one lesson taught to three sections, and a §4.9 block
   * is one cell holding several parallel options. Option rows carry
   * `classSectionId = NULL` by design and member rows carry no teacher, so
   * collecting both lists across the card is what makes "all its sections, or
   * all its teachers" mean the right thing for all three shapes.
   */
  private touchedOf(rows: Array<{ classSectionId: number | null; teacherId: number | null }>) {
    return {
      classSectionIds: [
        ...new Set(rows.map((r) => r.classSectionId).filter((x): x is number => x !== null)),
      ],
      teacherIds: [...new Set(rows.map((r) => r.teacherId).filter((x): x is number => x !== null))],
    };
  }

  /**
   * §29.8 — what to write in the audit, resolved only when there is one.
   *
   * The name lookup is deliberately inside the record path rather than beside
   * the guard: it runs only when a grant actually admitted the write, which is
   * a locked timetable being deliberately edited. Every other board edit — the
   * overwhelming majority — pays nothing for it.
   *
   * Names rather than ids, for §29.2's reason: the rows this describes may be
   * gone by the time anybody reads it, and `section 41` is not a record of
   * anything.
   */
  private async describeCard(
    rows: Array<{ classSectionId: number | null; subjectId: number | null; teacherId: number | null }>,
  ): Promise<{ label: string; teachers: string[] }> {
    const sectionIds = [
      ...new Set(rows.map((r) => r.classSectionId).filter((x): x is number => x !== null)),
    ];
    const subjectIds = [
      ...new Set(rows.map((r) => r.subjectId).filter((x): x is number => x !== null)),
    ];
    const teacherIds = [
      ...new Set(rows.map((r) => r.teacherId).filter((x): x is number => x !== null)),
    ];
    const [sections, subjects, teachers] = await Promise.all([
      sectionIds.length
        ? this.prisma.classSection.findMany({
            where: { id: { in: sectionIds } },
            select: { class: { select: { name: true } }, section: { select: { name: true } } },
          })
        : [],
      subjectIds.length
        ? this.prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { name: true } })
        : [],
      teacherIds.length
        ? this.prisma.teacher.findMany({ where: { id: { in: teacherIds } }, select: { name: true } })
        : [],
    ]);
    const where = sections.map((s) => `${s.class.name}-${s.section.name}`).join(", ");
    const what = subjects.map((s) => s.name).join("/");
    return {
      label: [where, what].filter(Boolean).join(" ") || "a lesson",
      teachers: teachers.map((t) => t.name),
    };
  }

  /** `Mon P3` — a cell, the way somebody reading the record thinks of one. */
  private cellName(day: number, period: number): string {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `${days[day] ?? `Day ${day}`} P${period}`;
  }

  /** The real guard, once the card is known. Returns the ticket to record with. */
  private scoped(
    configId: number,
    cards: Array<Array<{ classSectionId: number | null; teacherId: number | null }>>,
    what: string,
  ) {
    return this.freeze.assertTouched(
      configId,
      cards.map((rows) => this.touchedOf(rows)),
      what,
    );
  }

  /**
   * SolverInput for the client-side engine — cached under the slots:* sweep.
   *
   * Keyed by draft: the input carries the LOCKED cells the client engine
   * treats as immovable, and those differ between drafts. One shared `ctx` key
   * would hand Draft #4's board Draft #2's pins.
   */
  async context(configId: number, draftId?: number | null): Promise<SolverInput> {
    const scope = draftId === undefined ? await this.drafts.currentId(configId) : draftId;
    const cacheKey = this.keys.slots(configId, `ctx${scope !== null ? `:d${scope}` : ""}`);
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
    let input: SolverInput;
    try {
      input = await buildSolverInput(this.prisma, configId, scope);
    } catch (e) {
      throw new NotFoundException((e as Error).message);
    }
    await this.redis.set(cacheKey, JSON.stringify(input), "EX", 3600);
    return input;
  }

  /**
   * §22 — the rows of ONE draft, plus the config's extras.
   *
   * `source='extra'` rows sit outside any draft (§18: once per config, in both
   * statuses), so they are included whichever draft is open — the board must
   * show the extra window as occupied no matter which alternative future the
   * admin is editing.
   */
  private async draftRows(configId: number, draftId?: number | null) {
    const scope = draftId === undefined ? await this.drafts.currentId(configId) : draftId;
    return this.prisma.timetableSlot.findMany({
      where: {
        timetableConfigId: configId,
        status: "draft",
        ...(scope !== null ? { OR: [{ draftId: scope }, { source: "extra" }] } : {}),
      },
    });
  }

  private toSlotRows(rows: Awaited<ReturnType<BoardService["draftRows"]>>): SlotRow[] {
    return rows
      // §4.9 rows all pass through now: a block's member rows carry its
      // sections and its option rows carry the lessons, and `rowsToEntries`
      // folds a cell's worth of both into ONE draggable card. Filtering them
      // out here is what used to make a block an immovable "reserved" cell.
      // An ordinary row still needs a subject and a teacher to be a lesson.
      .filter((r) => r.electiveBlockId !== null || (r.subjectId !== null && r.teacherId !== null))
      .map((r) => ({
        classSectionId: r.classSectionId,
        dayOfWeek: r.dayOfWeek,
        periodNumber: r.periodNumber,
        subjectId: r.subjectId,
        teacherId: r.teacherId,
        roomId: r.roomId,
        mergedGroupId: r.mergedGroupId,
        electiveBlockId: r.electiveBlockId,
        electiveOptionId: r.electiveOptionId,
        isLocked: r.isLocked,
      }));
  }

  private async engineFor(configId: number, draftId?: number | null) {
    const [input, rows] = await Promise.all([
      this.drafts
        .currentId(configId)
        .then((d) => buildSolverInput(this.prisma, configId, d))
        .catch((e) => {
        throw new NotFoundException((e as Error).message);
      }),
      this.draftRows(configId, draftId),
    ]);
    // §4.9 blocks used to be passed in separately as immovable "reserved"
    // cells. They are ordinary entries now — the block's name and daily cap
    // come from the snapshot, which `buildSolverInput` already carries.
    return { engine: new BoardEngine(input, this.toSlotRows(rows)), rows };
  }

  /**
   * Every DB row forming one board entry.
   *
   * Three shapes: a lone lesson, a merged group's member rows, and a §4.9
   * block's member rows PLUS its option rows. The block is found by its own id
   * rather than by a section, because its option rows have no section at all —
   * looking it up through one member would silently leave the lessons behind.
   */
  private rowsOfEntry(
    rows: Awaited<ReturnType<BoardService["draftRows"]>>,
    ref: CellRef,
  ) {
    const atCell = (r: (typeof rows)[number]) =>
      r.dayOfWeek === ref.day && r.periodNumber === ref.period && r.status === "draft";
    if (ref.electiveBlockId != null) {
      return rows.filter((r) => r.electiveBlockId === ref.electiveBlockId && atCell(r));
    }
    const hit = rows.find((r) => r.classSectionId === ref.classSectionId && atCell(r));
    if (!hit) return [];
    if (hit.electiveBlockId !== null) {
      return rows.filter((r) => r.electiveBlockId === hit.electiveBlockId && atCell(r));
    }
    if (hit.mergedGroupId === null) return [hit];
    return rows.filter(
      (r) =>
        r.mergedGroupId === hit.mergedGroupId &&
        r.dayOfWeek === ref.day &&
        r.periodNumber === ref.period,
    );
  }

  private assertFresh(
    rows: ReturnType<BoardService["rowsOfEntry"]>,
    expect: CellExpectation,
    label: string,
  ) {
    const stale = () => {
      throw new ConflictException(
        `Stale board: the ${label} cell changed since you loaded it — refresh and retry`,
      );
    };
    // §4.9: a block is its options. Comparing subject/teacher would compare
    // two NULLs on a member row and call any block equal to any other.
    if (rows.some((r) => r.electiveBlockId !== null)) {
      const actual = rows
        .map((r) => r.electiveOptionId)
        .filter((x): x is number => x !== null)
        .sort((a, b) => a - b);
      const claimed = [...(expect.electiveOptionIds ?? [])].sort((a, b) => a - b);
      if (actual.length === 0 || actual.join(",") !== claimed.join(",")) stale();
      return;
    }
    const primary = rows.find((r) => r.teacherOccupancyKey !== null) ?? rows[0];
    if (!primary || primary.subjectId !== expect.subjectId || primary.teacherId !== expect.teacherId) stale();
  }

  private async finish(configId: number) {
    // §22: naming three exact keys stopped being enough the moment the suffix
    // became open-ended — a board edit left `slots:119:draft:d2` and
    // `slots:119:ctx:d2` in place as stale copies of the week just changed.
    // One invalidator, so no write path can drift from another.
    await this.keys.invalidateTimetable(configId);
    this.events.emitToCurrentSchool("slots:changed", { configId });
  }

  async move(configId: number, from: CellRef, expect: CellExpectation, to: { day: number; period: number }) {
    await this.editable(configId);
    const { engine, rows } = await this.engineFor(configId);
    const sourceRows = this.rowsOfEntry(rows, from);
    if (sourceRows.length === 0) {
      throw new ConflictException("Stale board: that card no longer exists — refresh and retry");
    }
    this.assertFresh(sourceRows, expect, "source");
    // §29.8 — the card is known now, so the lock can answer precisely.
    const ticket = await this.scoped(configId, [sourceRows], "this lesson");
    const key = this.keyOfRows(sourceRows, from);
    const verdict = engine.checkMove(key, to.day, to.period);
    if (!verdict.ok) throw new BadRequestException(verdict.reason);

    const isBlock = sourceRows.some((r) => r.electiveBlockId !== null);
    await this.prisma.$transaction(
      sourceRows.map((r) =>
        this.prisma.timetableSlot.update({
          where: { id: r.id },
          data: {
            dayOfWeek: to.day,
            periodNumber: to.period,
            // §4.9: an option row keeps its OWN room — the block never draws
            // on the lab pool, so there is nothing to re-home. A member row
            // keeps its NULL. Feeding either the verdict's room would put
            // three languages in one room.
            roomId: isBlock ? r.roomId : r.teacherOccupancyKey !== null ? verdict.roomId : null,
            source: "manual",
          },
        }),
      ),
    ).catch(rethrowUniqueAs409);
    if (ticket.admittedBy.length > 0) {
      const card = await this.describeCard(sourceRows);
      await ticket.record(
        `moved ${card.label} from ${this.cellName(from.day, from.period)} to ${this.cellName(to.day, to.period)}`,
        // §29.8 — the honest half: a class-scoped move takes its teacher's week
        // with it, and the record is where that is admitted rather than hidden.
        { teachers: card.teachers },
      );
    }
    await this.finish(configId);
    return { ok: true, roomId: verdict.roomId };
  }

  /** The engine key for a set of rows already fetched for a cell. */
  private keyOfRows(rows: ReturnType<BoardService["rowsOfEntry"]>, ref: CellRef) {
    return entryKeyOf({
      classSectionId: ref.classSectionId,
      mergedGroupId: rows[0].mergedGroupId,
      electiveBlockId: rows[0].electiveBlockId,
      dayOfWeek: ref.day,
      periodNumber: ref.period,
    });
  }

  /**
   * §7.3 group swap — drop a multi-section card (a merged group or a §4.9
   * block) onto an occupied cell. The card takes the target; every distinct
   * entry displaced across its member sections comes back to the source.
   *
   * The engine decides what moves where; this only writes it. Rows are deleted
   * and recreated rather than updated because a row-by-row UPDATE transits
   * through a state with two cards in one cell and trips the §3 unique keys —
   * the same reason the two-card swap does it.
   */
  async swapGroup(configId: number, from: CellRef, expect: CellExpectation, to: { day: number; period: number }) {
    await this.editable(configId);
    const { engine, rows } = await this.engineFor(configId);
    const sourceRows = this.rowsOfEntry(rows, from);
    if (sourceRows.length === 0) {
      throw new ConflictException("Stale board: that card no longer exists — refresh and retry");
    }
    this.assertFresh(sourceRows, expect, "source");
    const key = this.keyOfRows(sourceRows, from);
    const verdict = engine.checkSwapGroup(key, to.day, to.period);
    if (!verdict.ok) throw new BadRequestException(verdict.reason);

    // Resolve each displaced entry back to its rows through the engine's own
    // answer — never through the request, which must not be able to name a
    // card the engine did not decide to move.
    const displaced = verdict.displaced.map((d) => {
      const entry = engine.get(d.key);
      if (!entry) throw new ConflictException("Stale board: a displaced card vanished — refresh and retry");
      const ref: CellRef = {
        classSectionId: entry.classSectionIds[0] ?? null,
        electiveBlockId: entry.electiveBlockId,
        day: entry.day,
        period: entry.period,
      };
      return { rows: this.rowsOfEntry(rows, ref), roomId: d.roomId, entry };
    });
    if (displaced.some((d) => d.rows.length === 0)) {
      throw new ConflictException("Stale board: a displaced card no longer exists — refresh and retry");
    }

    /*
      §29.8 — a group swap moves the card AND everything it displaces, so every
      displaced card is a touched row too. Guarding only the card somebody
      dragged would let an unlocked group push three locked classes' lessons
      around, which is the rule broken from inside the one operation that can
      change most cells at once.
    */
    const ticket = await this.scoped(
      configId,
      [sourceRows, ...displaced.map((d) => d.rows)],
      "these lessons",
    );

    const recreate = (
      src: ReturnType<BoardService["rowsOfEntry"]>,
      at: { day: number; period: number },
      roomId: number | null,
    ) => {
      const block = src.some((r) => r.electiveBlockId !== null);
      return src.map((r) => ({
        schoolId: r.schoolId,
        timetableConfigId: configId,
        status: "draft" as const,
        // §22: stays in the draft it came from — see the note in `swap`.
        draftId: r.draftId,
        classSectionId: r.classSectionId,
        dayOfWeek: at.day,
        periodNumber: at.period,
        subjectId: r.subjectId,
        teacherId: r.teacherId,
        roomId: block ? r.roomId : r.teacherOccupancyKey !== null ? roomId : null,
        mergedGroupId: r.mergedGroupId,
        electiveBlockId: r.electiveBlockId,
        electiveOptionId: r.electiveOptionId,
        teacherOccupancyKey: r.teacherOccupancyKey,
        isLocked: r.isLocked,
        source: "manual" as const,
      }));
    };

    const allIds = [...sourceRows, ...displaced.flatMap((d) => d.rows)].map((r) => r.id);
    await this.prisma.$transaction([
      this.prisma.timetableSlot.deleteMany({ where: { id: { in: allIds } } }),
      this.prisma.timetableSlot.createMany({ data: recreate(sourceRows, to, verdict.roomAtTarget) }),
      ...displaced.map((d) =>
        this.prisma.timetableSlot.createMany({
          data: recreate(d.rows, { day: from.day, period: from.period }, d.roomId),
        }),
      ),
    ]).catch(rethrowUniqueAs409);
    if (ticket.admittedBy.length > 0) {
      const card = await this.describeCard(sourceRows);
      await ticket.record(
        `moved ${card.label} to ${this.cellName(to.day, to.period)}, displacing ${displaced.length} card(s)`,
        { teachers: card.teachers, displaced: displaced.length },
      );
    }
    await this.finish(configId);
    return { ok: true, roomId: verdict.roomAtTarget, displaced: displaced.length };
  }

  async swap(
    configId: number,
    a: CellRef,
    expectA: CellExpectation,
    b: CellRef,
    expectB: CellExpectation,
  ) {
    await this.editable(configId);
    const { engine, rows } = await this.engineFor(configId);
    const rowsA = this.rowsOfEntry(rows, a);
    const rowsB = this.rowsOfEntry(rows, b);
    if (rowsA.length === 0 || rowsB.length === 0) {
      throw new ConflictException("Stale board: one of the cards no longer exists — refresh and retry");
    }
    this.assertFresh(rowsA, expectA, "source");
    this.assertFresh(rowsB, expectB, "target");
    // §29.8 — two cards change places, so both must be open. No special case
    // for a swap: it is the predicate applied twice.
    const ticket = await this.scoped(configId, [rowsA, rowsB], "these lessons");
    const keyA = entryKeyOf({ classSectionId: a.classSectionId, mergedGroupId: rowsA[0].mergedGroupId, dayOfWeek: a.day, periodNumber: a.period });
    const keyB = entryKeyOf({ classSectionId: b.classSectionId, mergedGroupId: rowsB[0].mergedGroupId, dayOfWeek: b.day, periodNumber: b.period });
    const verdict = engine.checkSwap(keyA, keyB);
    if (!verdict.ok) throw new BadRequestException(verdict.reason);

    // delete + recreate both sides: a row-by-row UPDATE would transit through
    // a state where both cards sit in one cell and trip the §3 unique keys.
    const recreate = (
      src: typeof rowsA,
      to: CellRef,
      roomId: number | null,
    ) =>
      src.map((r) => ({
        schoolId: r.schoolId,
        timetableConfigId: configId,
        status: "draft" as const,
        // §22: a recreated row must stay in the draft it came from. Without
        // this it lands in scope 0, escaping the draft entirely and colliding
        // with the published set instead of with its own siblings.
        draftId: r.draftId,
        classSectionId: r.classSectionId,
        dayOfWeek: to.day,
        periodNumber: to.period,
        subjectId: r.subjectId,
        teacherId: r.teacherId,
        roomId: r.teacherOccupancyKey !== null ? roomId : null,
        mergedGroupId: r.mergedGroupId,
        teacherOccupancyKey: r.teacherOccupancyKey,
        isLocked: r.isLocked,
        source: "manual" as const,
      }));
    await this.prisma.$transaction([
      this.prisma.timetableSlot.deleteMany({ where: { id: { in: [...rowsA, ...rowsB].map((r) => r.id) } } }),
      this.prisma.timetableSlot.createMany({ data: recreate(rowsA, { ...b }, verdict.roomA) }),
      this.prisma.timetableSlot.createMany({ data: recreate(rowsB, { ...a }, verdict.roomB) }),
    ]).catch(rethrowUniqueAs409);
    if (ticket.admittedBy.length > 0) {
      const [cardA, cardB] = await Promise.all([this.describeCard(rowsA), this.describeCard(rowsB)]);
      await ticket.record(
        `swapped ${cardA.label} (${this.cellName(a.day, a.period)}) with ${cardB.label} (${this.cellName(b.day, b.period)})`,
        { teachers: [...new Set([...cardA.teachers, ...cardB.teachers])] },
      );
    }
    await this.finish(configId);
    return { ok: true };
  }

  /** Place a card from the unplaced tray (subject+teacher for a section). */
  async place(
    configId: number,
    body: { classSectionId: number; subjectId: number; teacherId: number; day: number; period: number },
  ) {
    /*
      §29.8 — the one write with no existing row to describe, so the touched row
      is the one about to exist.

      No `editable` precondition here, unlike every other method on this class:
      both owners arrive in the request, so the real guard can run first and the
      cheap one would only be the same question asked twice. Both owners are named in the request, which is
      why placing is scopeable at all: a write that could not say whose lesson it
      was creating would belong in the `whole` classification.
    */
    const ticket = await this.freeze.assertTouched(
      configId,
      [{ classSectionIds: [body.classSectionId], teacherIds: [body.teacherId] }],
      "this lesson",
    );
    const { engine } = await this.engineFor(configId);
    const verdict = engine.checkPlace(
      {
        classSectionIds: [body.classSectionId],
        subjectId: body.subjectId,
        teacherId: body.teacherId,
        roomId: null,
        mergedGroupId: null,
        // The tray holds unplaced MAPPING demand, never a block: a block is
        // created on the Electives screen, not placed card by card here.
        electiveBlockId: null,
        options: [],
      },
      body.day,
      body.period,
    );
    if (!verdict.ok) throw new BadRequestException(verdict.reason);
    await this.prisma.timetableSlot
      .create({
        data: {
          schoolId: this.tenant.requireSchoolId(),
          timetableConfigId: configId,
          status: "draft",
          // §22: a card placed from the tray belongs to the draft the board is
          // showing. Omitting this drops it into scope 0 — outside every
          // draft, and guarded against the PUBLISHED set instead of its own.
          draftId: await this.drafts.currentId(configId),
          classSectionId: body.classSectionId,
          dayOfWeek: body.day,
          periodNumber: body.period,
          subjectId: body.subjectId,
          teacherId: body.teacherId,
          roomId: verdict.roomId,
          mergedGroupId: null,
          teacherOccupancyKey: occupancyKey(body.teacherId, null),
          source: "manual",
        },
      })
      .catch(rethrowUniqueAs409);
    if (ticket.admittedBy.length > 0) {
      const card = await this.describeCard([
        { classSectionId: body.classSectionId, subjectId: body.subjectId, teacherId: body.teacherId },
      ]);
      await ticket.record(
        `placed ${card.label} at ${this.cellName(body.day, body.period)}`,
        { teachers: card.teachers },
      );
    }
    await this.finish(configId);
    return { ok: true, roomId: verdict.roomId };
  }

  /** Remove an unlocked card from the draft (back to the unplaced tray). */
  async remove(configId: number, ref: CellRef, expect: CellExpectation) {
    await this.editable(configId);
    const rows = await this.draftRows(configId);
    const target = this.rowsOfEntry(rows, ref);
    if (target.length === 0) {
      throw new ConflictException("Stale board: that card no longer exists — refresh and retry");
    }
    this.assertFresh(target, expect, "removed");
    const ticket = await this.scoped(configId, [target], "this lesson");
    if (target.some((r) => r.isLocked)) {
      throw new BadRequestException("This card is locked — unpin it first");
    }
    if (target.some((r) => r.mergedGroupId !== null)) {
      // the tray only re-places single-mapping cards; a removed merged group
      // would be stranded until the next full generate
      throw new BadRequestException("Merged-group cards can't be removed — move them instead, or regenerate");
    }
    // §4.9: same reason, sharper. The tray is per-section MAPPING demand and a
    // block is not a mapping, so a removed block would have no way back at all
    // — and this deletes rows, so a guard only in the UI is not a guard.
    if (target.some((r) => r.electiveBlockId !== null)) {
      throw new BadRequestException(
        "An elective block can't be removed here — move it instead, or edit it on the Electives screen",
      );
    }
    const card = ticket.admittedBy.length > 0 ? await this.describeCard(target) : null;
    await this.prisma.timetableSlot.deleteMany({ where: { id: { in: target.map((r) => r.id) } } });
    if (card) {
      await ticket.record(
        `removed ${card.label} from ${this.cellName(ref.day, ref.period)}`,
        { teachers: card.teachers },
      );
    }
    await this.finish(configId);
    return { ok: true };
  }

  /** §7.4 pin/unpin — locked cards are fixed for drags AND solver re-runs. */
  async setLock(configId: number, ref: CellRef, locked: boolean) {
    await this.editable(configId);
    const rows = await this.draftRows(configId);
    const target = this.rowsOfEntry(rows, ref);
    if (target.length === 0) throw new NotFoundException("No card in that cell");
    const ticket = await this.scoped(configId, [target], "this lesson");
    // §4.9: `lockedSlots` is built filtered to rows carrying a section, a
    // subject and a teacher, so a block's rows never reach the solver as locks
    // — setting the flag here would look like it worked and be ignored by the
    // next Generate. Phase 15's `placement: fixed` is the setting that holds a
    // block's time, and it works by domain pruning, so it survives a re-run.
    if (target.some((r) => r.electiveBlockId !== null)) {
      throw new BadRequestException(
        "An elective block can't be pinned here — set Fixed slots on the Electives screen, which the solver honours on every re-run",
      );
    }
    await this.prisma.timetableSlot.updateMany({
      where: { id: { in: target.map((r) => r.id) } },
      data: { isLocked: locked },
    });
    if (ticket.admittedBy.length > 0) {
      const card = await this.describeCard(target);
      await ticket.record(
        `${locked ? "pinned" : "unpinned"} ${card.label} at ${this.cellName(ref.day, ref.period)}`,
        { teachers: card.teachers },
      );
    }
    await this.finish(configId);
    return { ok: true, locked };
  }
}

function rethrowUniqueAs409(e: any): never {
  if (e?.code === "P2002") {
    throw new ConflictException(
      "Another admin took that cell a moment ago (DB unique guard) — refresh and retry",
    );
  }
  throw e;
}
