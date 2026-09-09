/**
 * §4.7b — one Availability screen, four kinds of time off.
 *
 * A teacher, a class, a subject and a room can each be unavailable, and a
 * school thinks of all four the same way: a weekly grid with some cells turned
 * off. They are four tables (see the migration for why: a polymorphic
 * `entity_id` would cost the foreign key), and this is the one endpoint the
 * screen talks to — `kind` chooses the table, and everything else is identical.
 *
 * The alternative was a fourth `PUT :id/unavailability` beside the teachers'
 * one, three times over. Four copies of the same replace-in-a-transaction, the
 * same ownership check and the same "another school's id is 404" rule is four
 * chances to get one of them subtly wrong — and the isolation gate would only
 * catch the third of those three mistakes if somebody remembered to sweep it.
 */
import {
  BadRequestException, Body, Controller, Get, NotFoundException, Param, Put, Query, Req,
} from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { toInt, type AuthedRequest } from "./crud.util";

/**
 * The four masters, and the three things that differ between them: which table
 * holds the rows, what the foreign key is called, and where the list of
 * entities comes from.
 *
 * A table rather than a switch, so adding a fifth is a row — and so that no
 * branch can quietly forget the ownership check or the scoped delete.
 */
const KINDS = {
  teacher: { table: "teacherUnavailability", fk: "teacherId", owner: "teacher", noun: "Teacher" },
  class: { table: "classSectionUnavailability", fk: "classSectionId", owner: "classSection", noun: "Class-section" },
  subject: { table: "subjectUnavailability", fk: "subjectId", owner: "subject", noun: "Subject" },
  room: { table: "roomUnavailability", fk: "roomId", owner: "room", noun: "Room" },
} as const;

type Kind = keyof typeof KINDS;

const isKind = (v: string): v is Kind => Object.prototype.hasOwnProperty.call(KINDS, v);

@Controller("availability")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class AvailabilityController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
  ) {}

  private spec(kind: string) {
    if (!isKind(kind)) {
      throw new BadRequestException(`kind must be one of ${Object.keys(KINDS).join(", ")}`);
    }
    return KINDS[kind];
  }

  /**
   * Everything of one kind, with its blocked cells.
   *
   * One request rather than one per entity: the screen is a list of 122
   * teachers beside a grid, and it has to show at a glance which of them have
   * time off at all. 122 round trips to render a sidebar would be exactly the
   * §14 budget going out through a door nobody was watching.
   */
  @Get(":kind")
  async list(@Req() req: AuthedRequest, @Param("kind") kind: string, @Query("configId") configQ?: string) {
    const spec = this.spec(kind);
    const rows = await (this.prisma as any)[spec.table].findMany({
      orderBy: [{ dayOfWeek: "asc" }, { periodNumber: "asc" }],
    });
    const byEntity = new Map<number, any[]>();
    for (const r of rows) {
      const id = r[spec.fk] as number;
      const list = byEntity.get(id) ?? [];
      list.push({ dayOfWeek: r.dayOfWeek, periodNumber: r.periodNumber, reason: r.reason });
      byEntity.set(id, list);
    }

    const entities = await this.entitiesOf(spec.owner, configQ ? toInt(configQ, "configId") : null);
    return entities.map((e) => ({ ...e, blocked: byEntity.get(e.id) ?? [] }));
  }

  /**
   * The pickable entities of one kind, already named the way the screen shows
   * them. Kept here rather than left to the client to assemble from three other
   * endpoints, so "which classes exist" has one answer.
   */
  private async entitiesOf(owner: string, configId: number | null) {
    if (owner === "teacher") {
      const rows = await this.prisma.teacher.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, employeeCode: true, initials: true },
      });
      return rows.map((t) => ({ id: t.id, name: t.name, short: t.initials ?? t.employeeCode }));
    }
    if (owner === "classSection") {
      const rows = await this.prisma.classSection.findMany({
        // Scoped to one timetable when the screen is looking at one: a
        // section's week is its config's week, and offering a section from
        // another wing beside this wing's period grid would invite blocking a
        // period that section does not have.
        where: configId !== null ? { timetableConfigId: configId } : {},
        include: { class: true, section: true },
      });
      return rows
        .map((cs) => ({ id: cs.id, name: `${cs.class.name}-${cs.section.name}`, short: `${cs.class.name}-${cs.section.name}` }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }
    if (owner === "subject") {
      const rows = await this.prisma.subject.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true, code: true },
      });
      return rows.map((s) => ({ id: s.id, name: s.name, short: s.code ?? s.name.slice(0, 4) }));
    }
    const rows = await this.prisma.room.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, roomType: true },
    });
    return rows.map((r) => ({ id: r.id, name: r.name, short: r.roomType }));
  }

  /**
   * Replace one entity's blocked cells.
   *
   * A replace, not a patch: the grid shows the complete answer it is editing,
   * so what comes back IS the answer. The ownership check is asked FIRST and
   * explicitly, for the reason §17.8 gives — an empty `rows` array writes
   * nothing, so nothing gets reference-checked, and the endpoint would answer
   * `{ok: true}` for another school's teacher. Another school's id is a 404.
   */
  @Put(":kind/:id")
  async set(@Req() req: AuthedRequest, @Param("kind") kind: string, @Param("id") id: string, @Body() body: any) {
    const spec = this.spec(kind);
    const entityId = toInt(id, "id");
    const owner = await (this.prisma as any)[spec.owner].findFirst({
      where: { id: entityId },
      select: { id: true },
    });
    if (!owner) throw new NotFoundException(`${spec.noun} ${entityId} not found`);

    const rows: any[] = Array.isArray(body?.rows) ? body.rows : [];
    await this.prisma.$transaction([
      (this.prisma as any)[spec.table].deleteMany({ where: { [spec.fk]: entityId } }),
      (this.prisma as any)[spec.table].createMany({
        data: rows.map((r) => ({
          schoolId: req.user.schoolId,
          [spec.fk]: entityId,
          dayOfWeek: toInt(r.dayOfWeek, "dayOfWeek"),
          // null = the whole day (§4.7a). Kept as one row rather than expanded
          // here, so a blocked day survives the timetable gaining a period.
          periodNumber: r.periodNumber != null ? toInt(r.periodNumber, "periodNumber") : null,
          reason: r.reason ? String(r.reason) : null,
        })),
      }),
    ]);
    // Time off changes what fits in the week (§4.7b Check 1), so the readiness
    // score is stale the moment this returns.
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true, count: rows.length };
  }
}
