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
import { REDIS } from "../redis/redis.module";
import { EventsGateway } from "../events/events.gateway";
import { buildSolverInput } from "../solver/input";

export interface CellRef {
  classSectionId: number;
  day: number;
  period: number;
}
/** what the client believes the cell holds — differing content = stale (409) */
export interface CellExpectation {
  subjectId: number;
  teacherId: number;
}

const occupancyKey = (teacherId: number, mergedGroupId: number | null) =>
  mergedGroupId !== null ? `MG-${mergedGroupId}` : `T-${teacherId}`;

@Injectable()
export class BoardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** SolverInput for the client-side engine — cached under the slots:* sweep. */
  async context(configId: number): Promise<SolverInput> {
    const cacheKey = `slots:${configId}:ctx`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
    let input: SolverInput;
    try {
      input = await buildSolverInput(this.prisma, configId);
    } catch (e) {
      throw new NotFoundException((e as Error).message);
    }
    await this.redis.set(cacheKey, JSON.stringify(input), "EX", 3600);
    return input;
  }

  private async draftRows(configId: number) {
    return this.prisma.timetableSlot.findMany({
      where: { timetableConfigId: configId, status: "draft" },
    });
  }

  private toSlotRows(rows: Awaited<ReturnType<BoardService["draftRows"]>>): SlotRow[] {
    return rows
      .filter((r) => r.subjectId !== null && r.teacherId !== null)
      .map((r) => ({
        classSectionId: r.classSectionId,
        dayOfWeek: r.dayOfWeek,
        periodNumber: r.periodNumber,
        subjectId: r.subjectId as number,
        teacherId: r.teacherId as number,
        roomId: r.roomId,
        mergedGroupId: r.mergedGroupId,
        isLocked: r.isLocked,
      }));
  }

  private async engineFor(configId: number) {
    const [input, rows] = await Promise.all([
      buildSolverInput(this.prisma, configId).catch((e) => {
        throw new NotFoundException((e as Error).message);
      }),
      this.draftRows(configId),
    ]);
    return { engine: new BoardEngine(input, this.toSlotRows(rows)), rows };
  }

  /** DB rows forming one board entry (merged unit = all member rows of the cell). */
  private rowsOfEntry(
    rows: Awaited<ReturnType<BoardService["draftRows"]>>,
    ref: CellRef,
  ) {
    const hit = rows.find(
      (r) =>
        r.classSectionId === ref.classSectionId &&
        r.dayOfWeek === ref.day &&
        r.periodNumber === ref.period &&
        r.status === "draft",
    );
    if (!hit) return [];
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
    const primary = rows.find((r) => r.teacherOccupancyKey !== null) ?? rows[0];
    if (!primary || primary.subjectId !== expect.subjectId || primary.teacherId !== expect.teacherId) {
      throw new ConflictException(
        `Stale board: the ${label} cell changed since you loaded it — refresh and retry`,
      );
    }
  }

  private async finish(configId: number) {
    await this.redis.del(
      `slots:${configId}:draft`,
      `slots:${configId}:published`,
      `slots:${configId}:ctx`,
    );
    this.events.server?.emit("slots:changed", { configId });
  }

  async move(configId: number, from: CellRef, expect: CellExpectation, to: { day: number; period: number }) {
    const { engine, rows } = await this.engineFor(configId);
    const sourceRows = this.rowsOfEntry(rows, from);
    if (sourceRows.length === 0) {
      throw new ConflictException("Stale board: that card no longer exists — refresh and retry");
    }
    this.assertFresh(sourceRows, expect, "source");
    const key = entryKeyOf({
      classSectionId: from.classSectionId,
      mergedGroupId: sourceRows[0].mergedGroupId,
      dayOfWeek: from.day,
      periodNumber: from.period,
    });
    const verdict = engine.checkMove(key, to.day, to.period);
    if (!verdict.ok) throw new BadRequestException(verdict.reason);

    await this.prisma.$transaction(
      sourceRows.map((r) =>
        this.prisma.timetableSlot.update({
          where: { id: r.id },
          data: {
            dayOfWeek: to.day,
            periodNumber: to.period,
            // primary row keeps occupancy + (possibly re-homed lab) room
            roomId: r.teacherOccupancyKey !== null ? verdict.roomId : null,
            source: "manual",
          },
        }),
      ),
    ).catch(rethrowUniqueAs409);
    await this.finish(configId);
    return { ok: true, roomId: verdict.roomId };
  }

  async swap(
    configId: number,
    a: CellRef,
    expectA: CellExpectation,
    b: CellRef,
    expectB: CellExpectation,
  ) {
    const { engine, rows } = await this.engineFor(configId);
    const rowsA = this.rowsOfEntry(rows, a);
    const rowsB = this.rowsOfEntry(rows, b);
    if (rowsA.length === 0 || rowsB.length === 0) {
      throw new ConflictException("Stale board: one of the cards no longer exists — refresh and retry");
    }
    this.assertFresh(rowsA, expectA, "source");
    this.assertFresh(rowsB, expectB, "target");
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
        timetableConfigId: configId,
        status: "draft" as const,
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
    await this.finish(configId);
    return { ok: true };
  }

  /** Place a card from the unplaced tray (subject+teacher for a section). */
  async place(
    configId: number,
    body: { classSectionId: number; subjectId: number; teacherId: number; day: number; period: number },
  ) {
    const { engine } = await this.engineFor(configId);
    const verdict = engine.checkPlace(
      {
        classSectionIds: [body.classSectionId],
        subjectId: body.subjectId,
        teacherId: body.teacherId,
        roomId: null,
        mergedGroupId: null,
      },
      body.day,
      body.period,
    );
    if (!verdict.ok) throw new BadRequestException(verdict.reason);
    await this.prisma.timetableSlot
      .create({
        data: {
          timetableConfigId: configId,
          status: "draft",
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
    await this.finish(configId);
    return { ok: true, roomId: verdict.roomId };
  }

  /** Remove an unlocked card from the draft (back to the unplaced tray). */
  async remove(configId: number, ref: CellRef, expect: CellExpectation) {
    const rows = await this.draftRows(configId);
    const target = this.rowsOfEntry(rows, ref);
    if (target.length === 0) {
      throw new ConflictException("Stale board: that card no longer exists — refresh and retry");
    }
    this.assertFresh(target, expect, "removed");
    if (target.some((r) => r.isLocked)) {
      throw new BadRequestException("This card is locked — unpin it first");
    }
    if (target.some((r) => r.mergedGroupId !== null)) {
      // the tray only re-places single-mapping cards; a removed merged group
      // would be stranded until the next full generate
      throw new BadRequestException("Merged-group cards can't be removed — move them instead, or regenerate");
    }
    await this.prisma.timetableSlot.deleteMany({ where: { id: { in: target.map((r) => r.id) } } });
    await this.finish(configId);
    return { ok: true };
  }

  /** §7.4 pin/unpin — locked cards are fixed for drags AND solver re-runs. */
  async setLock(configId: number, ref: CellRef, locked: boolean) {
    const rows = await this.draftRows(configId);
    const target = this.rowsOfEntry(rows, ref);
    if (target.length === 0) throw new NotFoundException("No card in that cell");
    await this.prisma.timetableSlot.updateMany({
      where: { id: { in: target.map((r) => r.id) } },
      data: { isLocked: locked },
    });
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
