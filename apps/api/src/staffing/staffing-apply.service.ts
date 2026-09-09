/**
 * §29.4 — writing a staffing change, and taking it back.
 *
 * The one place in §29 that touches a published week. Three rules shape all of
 * it, and each is load-bearing:
 *
 * **1. The plan is recomputed here, never taken from the request.** The same
 * rule §21's auto-resolve follows: a preview the admin held for five minutes is
 * not what is true now, and it is never the list of writes. What the request
 * carries is the *choice* — replace or redistribute, who, which units — and the
 * server works out the consequences again from the live database.
 *
 * **2. Slots are UPDATED in place, never deleted and recreated.**
 * `substitution_log` points at slot ids with no foreign key (the same fact that
 * made §3.14's withdraw *flip* rows rather than copy them), so recreating would
 * orphan every recorded cover. Updating also means the three unique keys are
 * never transited through a bad state: the class and the room are not moving,
 * so only `teacher_occupancy_key` changes, and it changes to a cell the engine
 * has already proved is free.
 *
 * **3. The carrier is rewritten too, not just the slots.** A mapping, a merged
 * group, an elective option or a class-teacher pointer is what the next Generate
 * reads. Move the lessons and leave the mapping and the leaver is quietly back
 * the first time anybody presses Generate, with nothing to connect the two
 * events.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { RestaffPlan } from "@edutimetable/shared";
import { PrismaService } from "../prisma/prisma.service";
import { CacheKeysService } from "../redis/cache-keys.service";
import { EventsGateway } from "../events/events.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { ReadinessService } from "../readiness/readiness.service";
import { StaffingPlanService, type PlanMode } from "./staffing-plan.service";

export interface ApplyInput {
  mode?: unknown;
  toTeacherId?: unknown;
  units?: unknown;
  /**
   * §29.4 — "leave these unstaffed" (the answer chosen for gaps).
   *
   * Apply refuses while anything is uncovered unless this is explicitly true,
   * so a gap is always something somebody chose rather than something that
   * happened.
   */
  acceptGaps?: unknown;
}

@Injectable()
export class StaffingApplyService {
  private readonly logger = new Logger(StaffingApplyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly planner: StaffingPlanService,
    private readonly keys: CacheKeysService,
    private readonly events: EventsGateway,
    private readonly notifications: NotificationsService,
    private readonly readiness: ReadinessService,
  ) {}

  async apply(changeId: number, userId: number | null, body: ApplyInput) {
    const change = await this.prisma.staffingChange.findFirst({
      where: { id: changeId },
      select: { id: true, status: true, timetableConfigId: true, schoolId: true },
    });
    if (!change) throw new NotFoundException(`Staffing change ${changeId} not found`);
    if (change.status !== "planning") {
      throw new BadRequestException(
        `Staffing change #${changeId} has already been ${change.status}. Open a new one.`,
      );
    }

    const mode: PlanMode = body.mode === "redistribute" ? "redistribute" : "replace";
    const preview = await this.planner.preview(
      changeId,
      mode,
      body.toTeacherId != null ? Number(body.toTeacherId) : null,
      Array.isArray(body.units) ? body.units.map(String) : null,
    );
    const plan: RestaffPlan = preview.plan;

    /*
      A gap is always chosen, never discovered.

      Refusing outright would be safer and is wrong: a school losing a teacher
      mid-term may genuinely have no cover for one class and still needs the
      other nine moved today. So the refusal is conditional, and it names what
      it is refusing over.
    */
    if (plan.uncovered > 0 && body.acceptGaps !== true) {
      const stuck = plan.assignments.filter((a) => a.toTeacherId === null);
      throw new BadRequestException(
        `${stuck.length} of these cannot be covered — ${stuck.slice(0, 3).map((a) => a.unit.label).join(", ")}` +
          `${stuck.length > 3 ? `, and ${stuck.length - 3} more` : ""}. ` +
          `Choose somebody who can take them, or tick "leave these unstaffed" to apply the rest.`,
      );
    }

    const moving = plan.assignments.filter((a) => a.toTeacherId !== null);
    if (moving.length === 0) {
      throw new BadRequestException(
        "Nothing in this plan can be moved, so there is nothing to apply.",
      );
    }

    const written = await this.prisma.$transaction(async (tx) => {
      let slots = 0;
      for (const a of moving) {
        const to = a.toTeacherId as number;
        const from = a.unit.fromTeacherId;
        /*
          Every branch does the same two things — move the carrier, then move
          the published rows — and the second is always scoped by `teacherId:
          from` as well as by the unit. That extra predicate is what makes apply
          safe to run against a week that has moved since the preview: a row
          somebody else has already changed simply is not matched, rather than
          being overwritten with an answer computed from a school that no longer
          exists.
        */
        switch (a.unit.type) {
          case "mapping": {
            await tx.teacherSubjectClassSection.updateMany({
              where: { id: a.unit.id, teacherId: from },
              data: { teacherId: to },
            });
            const done = await tx.timetableSlot.updateMany({
              where: {
                timetableConfigId: change.timetableConfigId,
                status: "published",
                teacherId: from,
                subjectId: a.unit.subjectId,
                classSectionId: { in: a.unit.classSectionIds },
                mergedGroupId: null,
                electiveOptionId: null,
              },
              data: { teacherId: to },
            });
            slots += done.count;
            break;
          }
          case "merged_group": {
            await tx.mergedTeachingGroup.updateMany({
              where: { id: a.unit.id, teacherId: from },
              data: { teacherId: to },
            });
            const done = await tx.timetableSlot.updateMany({
              where: {
                timetableConfigId: change.timetableConfigId,
                status: "published",
                mergedGroupId: a.unit.id,
                teacherId: from,
              },
              data: { teacherId: to },
            });
            slots += done.count;
            break;
          }
          case "elective_option": {
            await tx.electiveOption.updateMany({
              where: { id: a.unit.id, teacherId: from },
              data: { teacherId: to },
            });
            const done = await tx.timetableSlot.updateMany({
              where: {
                timetableConfigId: change.timetableConfigId,
                status: "published",
                electiveOptionId: a.unit.id,
                teacherId: from,
              },
              data: { teacherId: to },
            });
            slots += done.count;
            break;
          }
          case "class_teacher": {
            // No lessons: the pointer IS the unit. `classTeacherId: from` is the
            // same compare-and-set the others get.
            await tx.classSection.updateMany({
              where: { id: a.unit.id, classTeacherId: from },
              data: { classTeacherId: to },
            });
            break;
          }
        }

        await tx.staffingChangeItem.create({
          data: {
            schoolId: change.schoolId,
            changeId,
            unitType: a.unit.type,
            unitId: a.unit.id,
            // Frozen here, so the record still reads in English after the
            // section is renamed or the mapping deleted (§29.2).
            label: a.unit.label.slice(0, 120),
            fromTeacherId: from,
            toTeacherId: to,
            slotCount: a.unit.cells.length,
          },
        });
      }

      /*
        An accepted gap is recorded, and the unit is left exactly as it is.

        Not nulled. Nulling the slots would destroy the only surviving statement
        of what that class needs — and §29.0's promise is that nothing is damaged
        to make a change look complete. The record says "this one did not move",
        the screen says so, and the school deals with it deliberately.
      */
      for (const a of plan.assignments.filter((x) => x.toTeacherId === null)) {
        await tx.staffingChangeItem.create({
          data: {
            schoolId: change.schoolId,
            changeId,
            unitType: a.unit.type,
            unitId: a.unit.id,
            label: a.unit.label.slice(0, 120),
            fromTeacherId: a.unit.fromTeacherId,
            toTeacherId: null,
            slotCount: a.unit.cells.length,
          },
        });
      }

      await tx.staffingChange.update({
        where: { id: changeId },
        data: { status: "applied", appliedAt: new Date(), appliedById: userId },
      });
      return slots;
    });

    await this.finish(change.timetableConfigId, change.schoolId);
    await this.tellThem(moving.map((a) => a.toTeacherId as number), preview.releasing.map((t) => t.name));
    this.logger.log(
      `applied staffing change ${changeId}: ${moving.length} unit(s), ${written} published lesson(s) re-assigned`,
    );

    return {
      ok: true,
      changeId,
      moved: moving.length,
      slots: written,
      gaps: plan.uncovered,
      loads: plan.loads,
    };
  }

  /**
   * §29.5 — put it back.
   *
   * Built from `staffing_change_items` rather than by re-planning: a revert is
   * not a decision, it is the reversal of one that was recorded. Every write is
   * **compare-and-set on what the change actually did** — a carrier that no
   * longer points at the teacher this change gave it to has been moved again by
   * somebody else, and quietly overwriting that would make revert a way of
   * losing work rather than of undoing it. Those are reported, not applied.
   */
  async revert(changeId: number) {
    const change = await this.prisma.staffingChange.findFirst({
      where: { id: changeId },
      include: { items: true },
    });
    if (!change) throw new NotFoundException(`Staffing change ${changeId} not found`);
    if (change.status !== "applied") {
      throw new BadRequestException(
        `Staffing change #${changeId} is ${change.status}, so there is nothing to put back.`,
      );
    }

    const moved = change.items.filter((i) => i.toTeacherId !== null);
    const skipped: string[] = [];
    const result = await this.prisma.$transaction(async (tx) => {
      let slots = 0;
      let units = 0;
      for (const item of moved) {
        const to = item.toTeacherId as number;
        const from = item.fromTeacherId as number;
        let carrier = 0;
        switch (item.unitType) {
          case "mapping":
            carrier = (await tx.teacherSubjectClassSection.updateMany({
              where: { id: item.unitId, teacherId: to }, data: { teacherId: from },
            })).count;
            break;
          case "merged_group":
            carrier = (await tx.mergedTeachingGroup.updateMany({
              where: { id: item.unitId, teacherId: to }, data: { teacherId: from },
            })).count;
            break;
          case "elective_option":
            carrier = (await tx.electiveOption.updateMany({
              where: { id: item.unitId, teacherId: to }, data: { teacherId: from },
            })).count;
            break;
          case "class_teacher":
            carrier = (await tx.classSection.updateMany({
              where: { id: item.unitId, classTeacherId: to }, data: { classTeacherId: from },
            })).count;
            break;
        }
        if (carrier === 0) { skipped.push(item.label); continue; }
        units += 1;

        // A class-teacher role has no lessons; the pointer above was the whole
        // of it.
        if (item.unitType === "class_teacher") continue;

        /*
          Which published rows this unit owns.

          A mapping is identified by (subject, section) rather than by its own
          id, because `timetable_slots` carries no mapping id — the same reason
          §29.2's enumeration has to match on those two columns and exclude the
          rows that belong to a group or an option.
        */
        let owned: Record<string, unknown> | null = null;
        if (item.unitType === "merged_group") owned = { mergedGroupId: item.unitId };
        else if (item.unitType === "elective_option") owned = { electiveOptionId: item.unitId };
        else {
          const mapping = await tx.teacherSubjectClassSection.findFirst({
            where: { id: item.unitId },
            select: { subjectId: true, classSectionId: true },
          });
          // The mapping has been deleted since. The carrier update above
          // matched nothing, so this is unreachable in practice — kept because
          // "unreachable" and "cannot happen" are different things.
          if (!mapping) continue;
          owned = {
            subjectId: mapping.subjectId,
            classSectionId: mapping.classSectionId,
            mergedGroupId: null,
            electiveOptionId: null,
          };
        }

        slots += (await tx.timetableSlot.updateMany({
          where: {
            timetableConfigId: change.timetableConfigId,
            status: "published",
            // Compare-and-set again, at row level: a lesson somebody has moved
            // on to a third teacher since is left where it is.
            teacherId: to,
            ...owned,
          },
          data: { teacherId: from },
        })).count;
      }

      await tx.staffingChange.update({
        where: { id: changeId },
        // The row is KEPT and marked, never deleted — §3.14's rule for a
        // withdrawn publication, and for the same reason: deleting it would
        // rewrite the school's own record of what happened.
        data: { status: "reverted", revertedAt: new Date() },
      });
      return { units, slots };
    });

    await this.finish(change.timetableConfigId, change.schoolId);
    this.logger.log(`reverted staffing change ${changeId}: ${result.units} unit(s), ${result.slots} lesson(s)`);
    return {
      ok: true,
      changeId,
      ...result,
      /*
        Named rather than counted. "3 could not be put back" is a number nobody
        can act on; "Class 5-A Maths has been moved again since" is the sentence
        that tells somebody where to look.
      */
      skipped,
    };
  }

  /** Everything a change to the published week makes stale. */
  private async finish(configId: number, schoolId: number) {
    await this.keys.invalidateTimetable(configId);
    await this.readiness.invalidate(schoolId);
    this.events.emitToCurrentSchool("slots:changed", { configId });
  }

  /**
   * Tell the teachers who just gained classes.
   *
   * The leaver deliberately is not told: they have resigned or gone on leave,
   * and a notification saying their timetable changed would be at best strange.
   * Failures are swallowed — a notification that could not be delivered must
   * never roll back a timetable that has already been written.
   */
  private async tellThem(teacherIds: number[], releasing: string[]) {
    if (teacherIds.length === 0) return;
    try {
      await this.notifications.notifyTeachers([...new Set(teacherIds)], {
        type: "staffing_change",
        title: "Your timetable has changed",
        body: `Some of ${releasing.join(", ")}'s classes have been assigned to you. Open My Timetable to see your week.`,
      });
    } catch (e) {
      this.logger.warn(`staffing change applied, but teachers could not be notified: ${(e as Error).message}`);
    }
  }
}
