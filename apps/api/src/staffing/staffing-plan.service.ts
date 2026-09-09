/**
 * §29.3 — building the engine's input, and nothing else.
 *
 * The engine (`packages/shared/src/restaff/engine.ts`) is pure: it knows about
 * weeks, caps and eligibility and nothing about Prisma. This is the layer that
 * feeds it, and it has exactly one difficult job — **the occupancy it hands
 * over must be the published week with the released units already taken out.**
 *
 * Get that wrong in either direction and the plan is silently useless: leave
 * the released lessons in and the leaver's own replacement is "already
 * teaching" at every cell; take too much out and a candidate looks free at a
 * period they are actually standing in front of a class for.
 *
 * Still writes nothing. §29.4's apply is the write.
 */
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  planRedistribute, planReplace,
  type RestaffInput, type RestaffPlan, type RestaffUnit,
} from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { buildFeasibilitySnapshot } from "../solver/input";
import { unitsFor, type StaffingUnit } from "./staffing-units";

export type PlanMode = "replace" | "redistribute";

@Injectable()
export class StaffingPlanService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * What would happen, without anything happening.
   *
   * `mode` is chosen by the caller rather than derived from the change's
   * `reason`: "somebody joined" usually means replace and "adjustment" usually
   * means redistribute, but a school that hires one teacher to cover half a
   * leaver's classes and spreads the rest is doing both, and guessing would
   * take that choice away from them.
   */
  async preview(
    changeId: number,
    mode: PlanMode,
    toTeacherId?: number | null,
    /**
     * §29.2 — which of the released units are actually on the table.
     *
     * `["mapping:12", "class_teacher:7"]`, or omitted for all of them. A
     * resignation releases everything a teacher holds; an **adjustment**
     * releases what somebody picks, and without this the two reasons would
     * differ only in the word printed on the record.
     *
     * A key naming a unit the release does not contain is ignored rather than
     * refused: the list comes from a screen that may be a moment out of date,
     * and 400-ing a stale checkbox would be a worse experience than planning
     * the units that are really there.
     */
    unitKeys?: string[] | null,
  ): Promise<{
    changeId: number;
    mode: PlanMode;
    plan: RestaffPlan;
    releasing: Array<{ id: number; name: string }>;
    /** How many of the released units this plan actually covered. */
    scope: { selected: number; available: number };
  }> {
    const change = await this.prisma.staffingChange.findFirst({
      where: { id: changeId },
      include: { teachers: { include: { teacher: { select: { id: true, name: true } } } } },
    });
    if (!change) throw new NotFoundException(`Staffing change ${changeId} not found`);
    if (change.status !== "planning") {
      throw new BadRequestException(
        `Staffing change #${changeId} has been ${change.status}, so there is nothing left to plan.`,
      );
    }

    const releasing = change.teachers.filter((t) => t.role === "releasing");
    const receiving = change.teachers.filter((t) => t.role === "receiving");
    const releasingIds = releasing.map((t) => t.teacherId);

    if (mode === "replace") {
      if (!toTeacherId) {
        throw new BadRequestException("Name the teacher who is taking over (`toTeacherId`).");
      }
      if (releasingIds.includes(toTeacherId)) {
        throw new BadRequestException("A teacher cannot take over from themselves.");
      }
    }

    const all = await unitsFor(this.prisma, change.timetableConfigId, releasingIds);
    const wanted = unitKeys && unitKeys.length > 0 ? new Set(unitKeys) : null;
    const units = wanted ? all.filter((u) => wanted.has(`${u.type}:${u.id}`)) : all;
    if (units.length === 0) {
      throw new BadRequestException(
        all.length === 0
          ? "These teachers hold nothing in this timetable, so there is nothing to plan."
          : "None of the chosen items are part of this release — pick at least one.",
      );
    }
    const input = await this.buildInput(
      change.timetableConfigId,
      units,
      mode === "replace"
        ? [toTeacherId as number]
        // Redistribute over exactly who the school named. Falling back to "every
        // teacher in the school" would be a different feature — the point of
        // naming a receiving list is that these are the people whose weeks the
        // school has agreed may move.
        : receiving.map((t) => t.teacherId),
    );

    return {
      changeId,
      mode,
      plan: mode === "replace" ? planReplace(input, toTeacherId as number) : planRedistribute(input),
      releasing: releasing.map((t) => t.teacher),
      scope: { selected: units.length, available: all.length },
    };
  }

  /**
   * The engine's input, assembled from the live database.
   *
   * `buildFeasibilitySnapshot` is reused rather than re-queried, so the caps,
   * patterns, §18 scopes, §27.16 declarations and cross-config loads the engine
   * scores against are byte-for-byte the ones Readiness and the solver use. A
   * second set of queries here would be a second chance to disagree.
   */
  private async buildInput(
    configId: number,
    units: StaffingUnit[],
    candidateTeacherIds: number[],
  ): Promise<RestaffInput> {
    const config = await this.prisma.timetableConfig.findFirst({ where: { id: configId } });
    if (!config) throw new NotFoundException(`Timetable ${configId} not found`);
    const snapshot = await buildFeasibilitySnapshot(this.prisma as never, configId);

    const unavailability = await this.prisma.teacherUnavailability.findMany({
      where: { teacher: { schoolId: config.schoolId } },
      select: { teacherId: true, dayOfWeek: true, periodNumber: true },
    });

    /*
      Occupancy: the published week MINUS the units being released.

      Subtracted by slot id rather than by teacher, and that distinction is the
      whole correctness of this method. Removing "every row belonging to the
      leaver" would be wrong the moment a change releases only part of somebody's
      work — the §29.2 units are the authority on what is on the table, and
      anything not in them is a lesson somebody is still teaching.
    */
    const released = new Set(units.flatMap((u) => u.cells.map((c) => c.slotId)));
    const slots = await this.prisma.timetableSlot.findMany({
      where: { timetableConfigId: configId, status: "published", teacherId: { not: null } },
      select: { id: true, teacherId: true, dayOfWeek: true, periodNumber: true, classSectionId: true, subjectId: true },
    });
    const kept = slots.filter((s) => !released.has(String(s.id)));

    /*
      A merged group's published rows are one per member section, but §4.10 is
      one occupancy event. Left as-is a group teacher would look doubly busy at
      the same cell — harmless for a Set of keys, which is why occupancy is
      deduplicated here rather than counted.
    */
    const seen = new Set<string>();
    const occupancy: RestaffInput["occupancy"] = [];
    for (const s of kept) {
      const key = `${s.teacherId}:${s.dayOfWeek}:${s.periodNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      occupancy.push({ teacherId: s.teacherId as number, dayOfWeek: s.dayOfWeek, periodNumber: s.periodNumber });
    }

    /*
      §27.13 — declared subjects UNIONED with mapped ones.

      The union, not one or the other, for the reason §27.13 gives: declared is
      the fact, and the mappings are kept because every school that predates the
      table has no declarations at all. Reading only the new table would make
      every such teacher look unqualified for everything and leave a school
      unable to re-staff at all.
    */
    const subjectsByTeacher: Record<number, number[]> = {};
    const add = (teacherId: number, subjectId: number) => {
      const list = subjectsByTeacher[teacherId] ?? [];
      if (!list.includes(subjectId)) list.push(subjectId);
      subjectsByTeacher[teacherId] = list;
    };
    for (const d of await this.prisma.teacherSubject.findMany({ where: { schoolId: config.schoolId } })) {
      add(d.teacherId, d.subjectId);
    }
    for (const m of await this.prisma.teacherSubjectClassSection.findMany({
      where: { schoolId: config.schoolId }, select: { teacherId: true, subjectId: true },
    })) {
      add(m.teacherId, m.subjectId);
    }

    // Continuity — what each teacher still teaches here once the release is out.
    const classOfSection = new Map(
      (await this.prisma.classSection.findMany({
        where: { timetableConfigId: configId }, select: { id: true, classId: true },
      })).map((cs) => [cs.id, cs.classId]),
    );
    const sectionsByTeacher: Record<number, number[]> = {};
    const classesByTeacher: Record<number, number[]> = {};
    for (const s of kept) {
      if (s.classSectionId === null || s.teacherId === null) continue;
      const sections = sectionsByTeacher[s.teacherId] ?? [];
      if (!sections.includes(s.classSectionId)) sections.push(s.classSectionId);
      sectionsByTeacher[s.teacherId] = sections;
      const classId = classOfSection.get(s.classSectionId);
      if (classId === undefined) continue;
      const classes = classesByTeacher[s.teacherId] ?? [];
      if (!classes.includes(classId)) classes.push(classId);
      classesByTeacher[s.teacherId] = classes;
    }

    return {
      snapshot,
      teacherUnavailability: unavailability,
      units: units.map(toEngineUnit),
      occupancy,
      candidateTeacherIds: [...new Set(candidateTeacherIds)],
      subjectsByTeacher,
      sectionsByTeacher,
      classesByTeacher,
    };
  }
}

/** The §29.2 unit, with the slot ids the engine has no use for dropped. */
function toEngineUnit(u: StaffingUnit): RestaffUnit {
  return {
    type: u.type,
    id: u.id,
    label: u.label,
    fromTeacherId: u.teacherId,
    subjectId: u.subjectId,
    classIds: u.classIds,
    classSectionIds: u.classSectionIds,
    periodsPerWeek: u.periodsPerWeek,
    cells: u.cells.map((c) => ({
      dayOfWeek: c.dayOfWeek,
      periodNumber: c.periodNumber,
      classSectionId: c.classSectionId,
    })),
  };
}
