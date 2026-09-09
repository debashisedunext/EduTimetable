/**
 * §29.2 — creating, reading and editing a staffing change.
 *
 * Everything here is about the PLAN. Nothing in this file writes a mapping, a
 * slot or a class teacher — §29.4's apply does that, and keeping the two apart
 * is what lets a school open a change, look at what it would cost, and close it
 * again having touched nothing.
 *
 * ## Why a change may be opened on a timetable that is not frozen
 *
 * Freezing is what makes this *necessary*, not what makes it useful. A school
 * that never freezes still has teachers resign, and the plan, the validation
 * and the record are worth the same to them. So the two features are related
 * rather than coupled: §29.1 refuses the ordinary routes, and this is the one
 * path that stays open — but it does not require the refusal to exist.
 */
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { unitsFor, type StaffingUnit } from "./staffing-units";

const REASONS = ["resigned", "leave", "joined", "adjustment"] as const;
type Reason = (typeof REASONS)[number];

export interface ChangeInput {
  reason?: unknown;
  effectiveFrom?: unknown;
  note?: unknown;
  releasing?: unknown;
  receiving?: unknown;
}

@Injectable()
export class StaffingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 404 unless this timetable belongs to the caller's school.
   *
   * Asked before the body is parsed, for the §17.8 reason: a stranger must be
   * told "no such timetable" rather than "malformed reason", and the sweep
   * needs the owner and the stranger to get different answers or the route is
   * reported as proving nothing.
   */
  private async ownConfig(configId: number) {
    const config = await this.prisma.timetableConfig.findFirst({
      where: { id: configId },
      select: { id: true, name: true, frozenAt: true, schoolId: true },
    });
    if (!config) throw new NotFoundException(`Timetable ${configId} not found`);
    return config;
  }

  private async ownChange(changeId: number) {
    const change = await this.prisma.staffingChange.findFirst({
      where: { id: changeId },
      include: { teachers: { include: { teacher: true } }, config: { select: { id: true, name: true, frozenAt: true } } },
    });
    if (!change) throw new NotFoundException(`Staffing change ${changeId} not found`);
    return change;
  }

  private reasonOf(v: unknown): Reason {
    if (typeof v !== "string" || !REASONS.includes(v as Reason)) {
      throw new BadRequestException(`reason must be one of ${REASONS.join(", ")}`);
    }
    return v as Reason;
  }

  /** A YYYY-MM-DD, or null. Recorded only — nothing fires on it (§29.2). */
  private dateOf(v: unknown): Date | null {
    if (v === undefined || v === null || v === "") return null;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new BadRequestException("effectiveFrom must be a date");
    return d;
  }

  private idsOf(v: unknown, field: string): number[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new BadRequestException(`${field} must be an array of teacher ids`);
    return [...new Set(v.map((x) => {
      const n = Number(x);
      if (!Number.isInteger(n)) throw new BadRequestException(`${field} must contain whole numbers`);
      return n;
    }))];
  }

  /**
   * The two sides, checked together.
   *
   * Three refusals, and the second is the one that would otherwise be found by
   * a confusing plan rather than by a message:
   *
   *  - a change with nobody releasing has nothing to move;
   *  - a teacher on both sides is not a shape the engine can score, because a
   *    candidate must have a settled load before anything is offered to them;
   *  - a teacher from another school is simply not found, which the scoped
   *    client makes true without a school filter here (§17).
   */
  private async resolveTeachers(releasing: number[], receiving: number[]) {
    if (releasing.length === 0) {
      throw new BadRequestException(
        "Name at least one teacher whose classes are being released — a staffing change with nobody leaving has nothing to move.",
      );
    }
    const both = releasing.filter((id) => receiving.includes(id));
    const all = [...new Set([...releasing, ...receiving])];
    const known = await this.prisma.teacher.findMany({
      where: { id: { in: all } },
      select: { id: true, name: true, isActive: true, employmentType: true },
    });
    const byId = new Map(known.map((t) => [t.id, t]));
    const missing = all.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new BadRequestException(`No teacher with id ${missing.join(", ")}`);

    if (both.length > 0) {
      const names = both.map((id) => byId.get(id)!.name).join(", ");
      throw new BadRequestException(
        `${names} cannot be both releasing and receiving in one change. ` +
          `A teacher who is losing and gaining at the same time has two answers to "how full are they?", ` +
          `which is the number every candidate is scored against — make it two changes.`,
      );
    }

    /*
      §18 — a guest teacher is never offered the regular curriculum.

      Refused here rather than left to the engine to score down, for the same
      reason `assertCanTeach` refuses it: a guest is engaged for a lecture
      series, and a timetable should not quietly come to depend on them.
      Releasing one is fine — that is just tidying up.
    */
    const guests = receiving.map((id) => byId.get(id)!).filter((t) => t.employmentType === "guest");
    if (guests.length > 0) {
      throw new BadRequestException(
        `${guests.map((t) => t.name).join(", ")} ${guests.length === 1 ? "is a guest teacher" : "are guest teachers"}, ` +
          `so they can only take extra classes — not the regular timetable. Change their engagement type on the Teachers screen.`,
      );
    }

    const inactive = receiving.map((id) => byId.get(id)!).filter((t) => !t.isActive);
    if (inactive.length > 0) {
      throw new BadRequestException(
        `${inactive.map((t) => t.name).join(", ")} ${inactive.length === 1 ? "is" : "are"} marked inactive, ` +
          `so nothing can be given to them. Reactivate them on the Teachers screen first.`,
      );
    }
    return byId;
  }

  /**
   * Refuse a second open change over the same teachers.
   *
   * Two plans that both intend to move Class 5-A Maths would each look valid
   * on their own and collide at apply — and the second would be applied against
   * a week the first had already changed, so its own preview would have been a
   * description of a school that no longer exists. One open change per teacher,
   * named when refused.
   */
  private async assertNotAlreadyOpen(configId: number, teacherIds: number[], exceptChangeId?: number) {
    const open = await this.prisma.staffingChangeTeacher.findMany({
      where: {
        teacherId: { in: teacherIds },
        change: {
          timetableConfigId: configId,
          status: "planning",
          ...(exceptChangeId ? { id: { not: exceptChangeId } } : {}),
        },
      },
      include: { teacher: { select: { name: true } }, change: { select: { id: true } } },
    });
    if (open.length === 0) return;
    const names = [...new Set(open.map((o) => o.teacher.name))].join(", ");
    const ids = [...new Set(open.map((o) => o.change.id))].join(", ");
    throw new BadRequestException(
      `${names} ${open.length === 1 ? "is" : "are"} already named in staffing change #${ids}, which is still open. ` +
        `Apply or discard that one first — two open plans over the same teacher would each look valid and collide.`,
    );
  }

  // ─────────────────────────────────────────────────────────────── reading

  async list(configId: number) {
    await this.ownConfig(configId);
    const rows = await this.prisma.staffingChange.findMany({
      where: { timetableConfigId: configId },
      include: {
        teachers: { include: { teacher: { select: { id: true, name: true } } } },
        _count: { select: { items: true } },
      },
      orderBy: { id: "desc" },
    });
    return rows.map((c) => this.summary(c));
  }

  /** One change, with what its released teachers currently carry. */
  async get(changeId: number) {
    const change = await this.ownChange(changeId);
    const releasing = change.teachers.filter((t) => t.role === "releasing").map((t) => t.teacherId);
    const units = await unitsFor(this.prisma, change.timetableConfigId, releasing);
    return {
      ...this.summary({ ...change, _count: { items: 0 } }),
      frozen: change.config.frozenAt !== null,
      units: units.map((u) => this.unitView(u)),
      totals: this.totals(units),
    };
  }

  // ─────────────────────────────────────────────────────────────── writing
  //
  // "Writing" here means the PLAN — a `staffing_changes` row and its teacher
  // list. No mapping, slot or class teacher is touched by anything in this
  // file.

  async create(configId: number, userId: number | null, body: ChangeInput) {
    const config = await this.ownConfig(configId);
    const reason = this.reasonOf(body.reason);
    const releasing = this.idsOf(body.releasing, "releasing");
    const receiving = this.idsOf(body.receiving, "receiving");
    await this.resolveTeachers(releasing, receiving);
    await this.assertNotAlreadyOpen(configId, [...releasing, ...receiving]);

    const created = await this.prisma.staffingChange.create({
      data: {
        /*
          `schoolId` is written on the member rows below even though §17's
          extension already stamps nested `createMany.data`.

          Not a hedge and not a scoping filter (invariant 18 is about READS):
          an unchecked nested create is typed as requiring it, and the local
          idiom — `setRooms`, `setClasses`, the importer's own `createMany`s —
          passes it. The value comes from the config the caller reached through
          the scoped client, so it cannot name another school's id.
        */
        schoolId: config.schoolId,
        timetableConfigId: configId,
        reason,
        effectiveFrom: this.dateOf(body.effectiveFrom),
        note: body.note ? String(body.note).slice(0, 200) : null,
        createdById: userId,
        teachers: {
          // `createMany` inside a nested write, so the rows are unchecked
          // inputs and Prisma stops asking for the `teacher` and `school`
          // relations that §17's extension fills in.
          createMany: {
            data: [
              ...releasing.map((teacherId) => ({ teacherId, role: "releasing" as const, schoolId: config.schoolId })),
              ...receiving.map((teacherId) => ({ teacherId, role: "receiving" as const, schoolId: config.schoolId })),
            ],
          },
        },
      },
      select: { id: true },
    });
    return this.get(created.id);
  }

  /**
   * Edit an open change.
   *
   * Only while `planning`: once applied it is a record of what happened, and a
   * record that can be rewritten afterwards is not one. The teacher lists are
   * REPLACED rather than merged when sent, because the screen shows the whole
   * list it is editing — the same rule §19.1's rooms and §27.16's classes
   * follow. Absent means "not mentioned" and changes nothing.
   */
  async update(changeId: number, body: ChangeInput) {
    const change = await this.ownChange(changeId);
    this.assertPlanning(change.status, changeId);

    const sendsTeachers = body.releasing !== undefined || body.receiving !== undefined;
    let releasing = change.teachers.filter((t) => t.role === "releasing").map((t) => t.teacherId);
    let receiving = change.teachers.filter((t) => t.role === "receiving").map((t) => t.teacherId);
    if (sendsTeachers) {
      releasing = body.releasing !== undefined ? this.idsOf(body.releasing, "releasing") : releasing;
      receiving = body.receiving !== undefined ? this.idsOf(body.receiving, "receiving") : receiving;
      await this.resolveTeachers(releasing, receiving);
      await this.assertNotAlreadyOpen(change.timetableConfigId, [...releasing, ...receiving], changeId);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.staffingChange.update({
        where: { id: changeId },
        data: {
          ...(body.reason !== undefined ? { reason: this.reasonOf(body.reason) } : {}),
          ...(body.effectiveFrom !== undefined ? { effectiveFrom: this.dateOf(body.effectiveFrom) } : {}),
          ...(body.note !== undefined ? { note: body.note ? String(body.note).slice(0, 200) : null } : {}),
        },
      });
      if (!sendsTeachers) return;
      await tx.staffingChangeTeacher.deleteMany({ where: { changeId } });
      await tx.staffingChangeTeacher.createMany({
        data: [
          ...releasing.map((teacherId) => ({ changeId, teacherId, role: "releasing" as const, schoolId: change.schoolId })),
          ...receiving.map((teacherId) => ({ changeId, teacherId, role: "receiving" as const, schoolId: change.schoolId })),
        ],
      });
    });
    return this.get(changeId);
  }

  /**
   * Discard an open change.
   *
   * An applied one is kept for ever and is not deletable — the same rule §3.14
   * applies to a withdrawn publication, and for the same reason: deleting it
   * would rewrite the school's own record of what happened.
   */
  async discard(changeId: number) {
    const change = await this.ownChange(changeId);
    this.assertPlanning(change.status, changeId);
    await this.prisma.staffingChange.delete({ where: { id: changeId } });
    return { ok: true };
  }

  private assertPlanning(status: string, changeId: number) {
    if (status === "planning") return;
    throw new BadRequestException(
      `Staffing change #${changeId} has been ${status}, so it can no longer be edited. ` +
        `${status === "applied" ? "Revert it, or open a new change." : "Open a new change."}`,
    );
  }

  // ─────────────────────────────────────────────────────────────── shaping

  private summary(c: {
    id: number; reason: string; status: string; effectiveFrom: Date | null; note: string | null;
    createdAt: Date; appliedAt: Date | null; revertedAt: Date | null; timetableConfigId: number;
    teachers: Array<{ teacherId: number; role: string; teacher: { id: number; name: string } }>;
    _count?: { items: number };
  }) {
    return {
      id: c.id,
      configId: c.timetableConfigId,
      reason: c.reason,
      status: c.status,
      effectiveFrom: c.effectiveFrom,
      note: c.note,
      createdAt: c.createdAt,
      appliedAt: c.appliedAt,
      revertedAt: c.revertedAt,
      releasing: c.teachers.filter((t) => t.role === "releasing").map((t) => t.teacher),
      receiving: c.teachers.filter((t) => t.role === "receiving").map((t) => t.teacher),
      itemCount: c._count?.items ?? 0,
    };
  }

  /** A unit as the screen shows it — the cells stay for §29.3, not for reading. */
  private unitView(u: StaffingUnit) {
    return {
      type: u.type,
      id: u.id,
      label: u.label,
      teacherId: u.teacherId,
      teacherName: u.teacherName,
      subjectId: u.subjectId,
      subjectName: u.subjectName,
      classSectionIds: u.classSectionIds,
      periodsPerWeek: u.periodsPerWeek,
      slotCount: u.cells.length,
      /*
        Said out loud, because it is the difference between "nothing to move"
        and "nothing published yet".

        A mapping added after the last publish has no cells; so does a class
        teacher, by nature. Both are real units that must be reassigned — the
        screen would otherwise show a row with 0 beside it and leave the reader
        guessing which of the two it meant.
      */
      unpublished: u.type !== "class_teacher" && u.cells.length === 0,
    };
  }

  private totals(units: StaffingUnit[]) {
    return {
      units: units.length,
      lessons: units.reduce((n, u) => n + u.cells.length, 0),
      classSections: new Set(units.flatMap((u) => u.classSectionIds)).size,
      byType: {
        mapping: units.filter((u) => u.type === "mapping").length,
        merged_group: units.filter((u) => u.type === "merged_group").length,
        elective_option: units.filter((u) => u.type === "elective_option").length,
        class_teacher: units.filter((u) => u.type === "class_teacher").length,
      },
    };
  }
}
