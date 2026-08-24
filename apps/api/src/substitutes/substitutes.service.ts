/**
 * Phase 4 (§6): absences + the substitute matching pipeline. Builds the pure
 * engine's day-snapshot from the PUBLISHED timetable, computes the plan, and
 * confirms assignments as date-scoped overlay rows in substitution_log —
 * the base published grid is never touched (invariant 4).
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
  planSubstitutes,
  type AffectedSlot,
  type SubstitutePlan,
  type SubstituteTeacher,
} from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { REDIS } from "../redis/redis.module";
import { EventsGateway } from "../events/events.gateway";

/** our convention: 1 = Monday … 7 = Sunday */
export function dayOfWeekOf(date: Date): number {
  const d = date.getUTCDay();
  return d === 0 ? 7 : d;
}

export function parseDateOnly(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new BadRequestException("date must be YYYY-MM-DD");
  }
  return new Date(`${s}T00:00:00.000Z`);
}

@Injectable()
export class SubstitutesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async listAbsences(schoolId: number, dateStr?: string) {
    const where: any = { teacher: { schoolId } };
    if (dateStr) where.date = parseDateOnly(dateStr);
    const rows = await this.prisma.teacherAbsence.findMany({
      where,
      include: { teacher: true, substitutions: true },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      take: 60,
    });
    return rows.map((a) => ({
      id: a.id,
      teacherId: a.teacherId,
      teacherName: a.teacher.name,
      date: a.date.toISOString().slice(0, 10),
      reason: a.reason,
      status: a.status,
      substitutionCount: a.substitutions.length,
    }));
  }

  async reportAbsence(schoolId: number, body: { teacherId: number; date: string; reason?: string }) {
    const teacher = await this.prisma.teacher.findFirst({
      where: { id: body.teacherId, schoolId, isActive: true },
    });
    if (!teacher) throw new BadRequestException("Teacher not found or inactive");
    const date = parseDateOnly(body.date);
    try {
      const absence = await this.prisma.teacherAbsence.create({
        data: { teacherId: body.teacherId, date, reason: body.reason ?? null },
      });
      this.events.server?.emit("substitutions:changed", { date: body.date });
      return { id: absence.id };
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new ConflictException(`${teacher.name} is already marked absent on ${body.date}`);
      }
      throw e;
    }
  }

  /** Remove an absence — its overlay rows cascade away; the base grid was never touched. */
  async removeAbsence(schoolId: number, id: number) {
    const absence = await this.prisma.teacherAbsence.findFirst({
      where: { id, teacher: { schoolId } },
    });
    if (!absence) throw new NotFoundException("Absence not found");
    await this.prisma.teacherAbsence.delete({ where: { id } });
    await this.invalidateSlotCaches();
    this.events.server?.emit("substitutions:changed", { date: absence.date.toISOString().slice(0, 10) });
    return { ok: true };
  }

  /** §6.1 — compute (or recompute) the matching plan for one absence. */
  async plan(schoolId: number, absenceId: number) {
    const absence = await this.prisma.teacherAbsence.findFirst({
      where: { id: absenceId, teacher: { schoolId } },
      include: { teacher: true },
    });
    if (!absence) throw new NotFoundException("Absence not found");
    const date = absence.date;
    const day = dayOfWeekOf(date);

    const [absencesToday, subsToday, teachers, sections, configs, unavail, publishedToday] =
      await Promise.all([
        this.prisma.teacherAbsence.findMany({ where: { date, teacher: { schoolId } } }),
        this.prisma.substitutionLog.findMany({ where: { date } }),
        this.prisma.teacher.findMany({
          where: { schoolId, isActive: true },
          include: { mappings: true, mergedGroups: { include: { members: true } }, unavailability: true },
        }),
        this.prisma.classSection.findMany({
          where: { class: { schoolId } },
          include: { class: true, section: true },
        }),
        this.prisma.timetableConfig.findMany({ where: { schoolId } }),
        this.prisma.teacherUnavailability.findMany({ where: { dayOfWeek: day, teacher: { schoolId } } }),
        this.prisma.timetableSlot.findMany({
          where: { status: "published", dayOfWeek: day, subjectId: { not: null }, teacherId: { not: null } },
        }),
      ]);

    const periodsPerDay = Math.max(1, ...configs.map((c) => c.periodsPerDay));
    const sectionById = new Map(sections.map((cs) => [cs.id, cs]));
    const label = (id: number) => {
      const cs = sectionById.get(id);
      return cs ? `${cs.class.name}-${cs.section.name}` : `#${id}`;
    };
    const subjectNames = new Map<number, string>();
    const subjects = await this.prisma.subject.findMany({ where: { schoolId } });
    for (const s of subjects) subjectNames.set(s.id, s.name);

    const slotById = new Map(publishedToday.map((s) => [s.id.toString(), s]));
    const subBySlot = new Map(subsToday.map((r) => [r.timetableSlotId.toString(), r]));

    // affected = the absentee's own published PRIMARY occupancies today that are
    // not yet covered, plus any substitution duties they had accepted (§4.6 edge)
    const own = publishedToday.filter(
      (s) => s.teacherId === absence.teacherId && s.teacherOccupancyKey !== null,
    );
    const affectedSlots: AffectedSlot[] = own
      .filter((s) => !subBySlot.has(s.id.toString()))
      .map((s) => ({
        slotId: s.id.toString(),
        classSectionId: s.classSectionId,
        classSectionLabel:
          s.mergedGroupId !== null
            ? publishedToday
                .filter((x) => x.mergedGroupId === s.mergedGroupId && x.dayOfWeek === s.dayOfWeek && x.periodNumber === s.periodNumber)
                .map((x) => label(x.classSectionId))
                .join(" + ")
            : label(s.classSectionId),
        period: s.periodNumber,
        subjectId: s.subjectId as number,
        subjectName: subjectNames.get(s.subjectId as number) ?? `subject #${s.subjectId}`,
        absentTeacherId: absence.teacherId,
      }));
    for (const duty of subsToday.filter((r) => r.substituteTeacherId === absence.teacherId)) {
      const s = slotById.get(duty.timetableSlotId.toString());
      if (!s) continue;
      affectedSlots.push({
        slotId: s.id.toString(),
        classSectionId: s.classSectionId,
        classSectionLabel: label(s.classSectionId),
        period: s.periodNumber,
        subjectId: s.subjectId as number,
        subjectName: subjectNames.get(s.subjectId as number) ?? `subject #${s.subjectId}`,
        absentTeacherId: duty.originalTeacherId,
        viaSubstitution: true,
      });
    }

    const absentIds = absencesToday.map((a) => a.teacherId);
    const unavailByTeacher = new Map<number, number[]>();
    for (const u of unavail) {
      const list = unavailByTeacher.get(u.teacherId) ?? [];
      if (u.periodNumber === null) {
        for (let p = 1; p <= periodsPerDay; p++) list.push(p);
      } else list.push(u.periodNumber);
      unavailByTeacher.set(u.teacherId, list);
    }
    const busyByTeacher = new Map<number, Set<number>>();
    for (const s of publishedToday) {
      if (s.teacherId === null || s.teacherOccupancyKey === null) continue;
      const set = busyByTeacher.get(s.teacherId) ?? new Set<number>();
      set.add(s.periodNumber);
      busyByTeacher.set(s.teacherId, set);
    }
    const subsCountByTeacher = new Map<number, number>();
    for (const r of subsToday) {
      // duties the absentee is shedding today don't count as busy for anyone
      if (absentIds.includes(r.substituteTeacherId)) continue;
      subsCountByTeacher.set(r.substituteTeacherId, (subsCountByTeacher.get(r.substituteTeacherId) ?? 0) + 1);
      const s = slotById.get(r.timetableSlotId.toString());
      if (s) {
        const set = busyByTeacher.get(r.substituteTeacherId) ?? new Set<number>();
        set.add(s.periodNumber);
        busyByTeacher.set(r.substituteTeacherId, set);
      }
    }

    const engineTeachers: SubstituteTeacher[] = teachers.map((t) => {
      const subjectIds = [
        ...new Set([...t.mappings.map((m) => m.subjectId), ...t.mergedGroups.map((g) => g.subjectId)]),
      ];
      const csIds = [
        ...new Set([
          ...t.mappings.map((m) => m.classSectionId),
          ...t.mergedGroups.flatMap((g) => g.members.map((m) => m.classSectionId)),
        ]),
      ];
      return {
        id: t.id,
        name: t.name,
        maxPeriodsPerDay: t.maxPeriodsPerDay,
        subjectIds,
        classSectionIds: csIds,
        classIds: [...new Set(csIds.map((id) => sectionById.get(id)?.classId).filter((x): x is number => x != null))],
        busyPeriods: [...(busyByTeacher.get(t.id) ?? [])],
        unavailablePeriods: unavailByTeacher.get(t.id) ?? [],
        substitutionsToday: subsCountByTeacher.get(t.id) ?? 0,
      };
    });

    const plan: SubstitutePlan = planSubstitutes({
      dayOfWeek: day,
      periodsPerDay,
      absentTeacherIds: absentIds,
      affectedSlots,
      teachers: engineTeachers,
      classIdBySection: Object.fromEntries(sections.map((cs) => [cs.id, cs.classId])),
    });

    // already-confirmed rows for this absence, shown as locked in the UI
    const confirmed = subsToday
      .filter((r) => r.absenceId === absence.id)
      .map((r) => {
        const s = slotById.get(r.timetableSlotId.toString());
        return {
          slotId: r.timetableSlotId.toString(),
          period: s?.periodNumber ?? 0,
          classSectionLabel: s ? label(s.classSectionId) : "?",
          subjectName: s?.subjectId ? (subjectNames.get(s.subjectId) ?? "?") : "?",
          substituteTeacherId: r.substituteTeacherId,
          substituteName: teachers.find((t) => t.id === r.substituteTeacherId)?.name ?? `#${r.substituteTeacherId}`,
        };
      })
      .sort((a, b) => a.period - b.period);

    return {
      absence: {
        id: absence.id,
        teacherId: absence.teacherId,
        teacherName: absence.teacher.name,
        date: date.toISOString().slice(0, 10),
        dayOfWeek: day,
        reason: absence.reason,
        status: absence.status,
      },
      plan,
      confirmed,
    };
  }

  /** §6.2 step 3 — Confirm All: write the overlay rows in one transaction. */
  async confirm(
    schoolId: number,
    absenceId: number,
    assignments: Array<{ slotId: string; substituteTeacherId: number }>,
    userId: number | null,
  ) {
    if (assignments.length === 0) throw new BadRequestException("No assignments to confirm");
    const { absence, plan } = await this.plan(schoolId, absenceId);

    const bySlot = new Map(plan.slots.map((s) => [s.slot.slotId, s]));
    for (const a of assignments) {
      const sp = bySlot.get(a.slotId);
      if (!sp) throw new BadRequestException(`Slot ${a.slotId} is not part of this absence`);
      if (!sp.candidates.some((c) => c.teacherId === a.substituteTeacherId)) {
        throw new ConflictException(
          `The chosen substitute for ${sp.slot.classSectionLabel} P${sp.slot.period} is no longer eligible — refresh the plan`,
        );
      }
    }

    try {
      await this.prisma.$transaction([
        this.prisma.substitutionLog.createMany({
          data: assignments.map((a) => ({
            timetableSlotId: BigInt(a.slotId),
            absenceId: absence.id,
            originalTeacherId: bySlot.get(a.slotId)!.slot.absentTeacherId,
            substituteTeacherId: a.substituteTeacherId,
            date: parseDateOnly(absence.date),
            reason: absence.reason,
            createdById: userId,
          })),
        }),
        this.prisma.teacherAbsence.update({
          where: { id: absence.id },
          data: { status: "substitutes_assigned" },
        }),
      ]);
    } catch (e: any) {
      if (e?.code === "P2002") {
        throw new ConflictException("One of these slots was already covered for that date — refresh the plan");
      }
      throw e;
    }
    await this.invalidateSlotCaches();
    this.events.server?.emit("substitutions:changed", { date: absence.date });
    return { ok: true, confirmed: assignments.length };
  }

  private async invalidateSlotCaches() {
    const keys = await this.redis.keys("slots:*");
    if (keys.length > 0) await this.redis.del(...keys);
  }
}
