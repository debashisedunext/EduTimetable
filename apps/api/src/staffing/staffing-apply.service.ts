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
import { DraftsService } from "../drafts/drafts.service";
import { slotsIn, weekScopeFor } from "./staffing-week";
import { StaffingPlanService, type PlanMode } from "./staffing-plan.service";
import { FreezeService } from "../freeze/freeze.service";

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
    private readonly drafts: DraftsService,
    private readonly freeze: FreezeService,
  ) {}

  /**
   * §29.6 — the week this change writes to.
   *
   * Resolved the same way the preview resolved it, from the same function: the
   * published week if this timetable has one, otherwise its current draft. The
   * fault this fixes was an apply that wrote only to `status: "published"` on a
   * school that had never published — every carrier moved, not one visible
   * lesson did, and the change said `applied`.
   */
  private week(configId: number) {
    return weekScopeFor(this.prisma as never, configId, (id) => this.drafts.currentId(id));
  }

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

    /*
      §29.8 — the headline case, and the reason a teacher unlock exists.

      A resignation moves one person's whole load across every class they teach.
      Requiring those classes to be unlocked would mean unlocking the twelve a
      real teacher covers, which is unlocking the timetable under another name —
      so the grant is asked about the RELEASING teachers, and their lessons are
      open wherever they sit. The classes stay locked; the record names them.

      Only the releasing side. A receiving teacher gaining lessons from a change
      somebody deliberately made is not the accident a lock exists to prevent,
      and could not be unlocked in advance anyway: §29.3 chooses them.

      Asked AFTER the plan is built and BEFORE the first write — the plan is a
      question (a GET, §29.3) and stays readable while locked, because being able
      to see it is how somebody decides whom to unlock.
    */
    const releasing = [...new Set(moving.map((a) => a.unit.fromTeacherId))];
    const ticket = await this.freeze.assertTouched(
      change.timetableConfigId,
      releasing.map((id) => ({ teacherIds: [id], classSectionIds: [] })),
      "who teaches these lessons",
    );

    /*
      Resolved OUTSIDE the transaction and before any write, so the preview's
      week and the apply's week are the same answer from the same function.
    */
    const scope = await this.week(change.timetableConfigId);

    const written = await this.prisma.$transaction(async (tx) => {
      let slots = 0;
      /*
        §29.7 — §36 fixed lessons are the FIFTH carrier of "who teaches".

        `staffing-units.ts` enumerates four; `timetable_fixed_lessons` arrived
        later (§36) and was never added to them. A pin is not an independent
        thing to reassign, though — §36 attaches one to a real mapping, matched
        on section + subject + teacher — so it moves WITH its mapping rather
        than beside it. Left behind, the pin names a teacher who no longer
        teaches that lesson, and Check 14 BLOCKS the next generation with "a pin
        whose lesson has moved". A staffing change that quietly makes a school
        unable to generate is not a staffing change that worked.
      */
      let pins = 0;
      const byType = { mapping: 0, merged_group: 0, elective_option: 0, class_teacher: 0 };
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
                ...slotsIn(scope),
                teacherId: from,
                subjectId: a.unit.subjectId,
                classSectionId: { in: a.unit.classSectionIds },
                mergedGroupId: null,
                electiveOptionId: null,
              },
              data: { teacherId: to },
            });
            slots += done.count;
            byType.mapping += 1;
            pins += await this.movePins(tx as never, change.timetableConfigId, from, to, a.unit);
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
                ...slotsIn(scope),
                mergedGroupId: a.unit.id,
                teacherId: from,
              },
              data: { teacherId: to },
            });
            slots += done.count;
            byType.merged_group += 1;
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
                ...slotsIn(scope),
                electiveOptionId: a.unit.id,
                teacherId: from,
              },
              data: { teacherId: to },
            });
            slots += done.count;
            byType.elective_option += 1;
            break;
          }
          case "class_teacher": {
            // No lessons: the pointer IS the unit. `classTeacherId: from` is the
            // same compare-and-set the others get.
            await tx.classSection.updateMany({
              where: { id: a.unit.id, classTeacherId: from },
              data: { classTeacherId: to },
            });
            byType.class_teacher += 1;
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
      return { slots, pins, byType };
    });

    await this.finish(change.timetableConfigId, change.schoolId);
    if (ticket.admittedBy.length > 0) {
      /*
        §29.8 — the honest half of a teacher unlock.

        A teacher grant opens lessons sitting inside classes nobody unlocked, so
        the record names those classes. Written from the PLAN's own units rather
        than re-queried, because the plan is what was applied and a second query
        would be a second answer.
      */
      const classes = [
        ...new Set(moving.flatMap((a) => a.unit.classSectionIds ?? [])),
      ];
      await ticket.record(
        `re-assigned ${written.slots} lesson(s) across ${moving.length} unit(s) from ` +
          `${preview.releasing.map((t) => t.name).join(", ")}`,
        { classSectionIds: classes, changeId, where: scope.status },
      );
    }
    await this.tellThem(moving.map((a) => a.toTeacherId as number), preview.releasing.map((t) => t.name));
    this.logger.log(
      `applied staffing change ${changeId}: ${moving.length} unit(s), `
        + `${written.slots} lesson(s) and ${written.pins} fixed lesson(s) re-assigned`,
    );

    return {
      ok: true,
      changeId,
      moved: moving.length,
      slots: written.slots,
      gaps: plan.uncovered,
      loads: plan.loads,
      /*
        §29.7 — what was changed, and where, in the words the screen prints.

        "Applied" on its own left somebody to go and look at four screens to
        find out whether anything had happened — which is exactly what the
        report that prompted this did. Every number here is counted from the
        writes that actually ran, never predicted from the plan: a summary
        computed from what was *going* to happen is the half-applied change
        saying it worked all over again.
      */
      changed: {
        where: scope.status === "published" ? "the published timetable" : "the current draft",
        lessons: written.slots,
        mappings: written.byType.mapping,
        mergedGroups: written.byType.merged_group,
        electiveOptions: written.byType.elective_option,
        classTeacher: written.byType.class_teacher,
        fixedLessons: written.pins,
      },
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

    /*
      §29.8 — a revert is a write to the published week like any other, so it
      asks too, and it asks about the RECEIVING teacher.

      That reads backwards for a moment and is the rule applied exactly: the
      grant is evaluated on the row as it stands, and after the apply these
      lessons belong to whoever took them. Undoing is therefore *releasing* them
      again, from that person. Reading `fromTeacherId` instead would be checking
      a grant against an owner the rows no longer have — the same mistake as
      reading the incoming teacher on a mapping edit, in the other direction.

      The practical consequence is real and correct: a grant opened on the
      leaver does not admit the undo, and the refusal names the person whose
      week the undo would change. That is what somebody needs to be told.
    */
    const holding = [...new Set(moved.map((i) => i.toTeacherId as number))];
    const ticket = await this.freeze.assertTouched(
      change.timetableConfigId,
      [{ teacherIds: holding, classSectionIds: [] }],
      "who teaches these lessons",
    );

    // §29.6 — put it back into the same week it was taken from.
    const scope = await this.week(change.timetableConfigId);
    const result = await this.prisma.$transaction(async (tx) => {
      let slots = 0;
      let units = 0;
      let pins = 0;
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
            ...slotsIn(scope),
            // Compare-and-set again, at row level: a lesson somebody has moved
            // on to a third teacher since is left where it is.
            teacherId: to,
            ...owned,
          },
          data: { teacherId: from },
        })).count;

        /*
          §29.7 — and the pins come back with it.

          A revert that returned the mapping but left the §36 pin pointing at
          the person who no longer teaches it would leave the school with the
          blocking Check 14 that moving the pin was meant to prevent — created
          by the act of undoing.
        */
        if (owned.subjectId !== null && owned.subjectId !== undefined) {
          pins += await this.movePins(
            tx as never,
            change.timetableConfigId,
            to,
            from,
            { subjectId: owned.subjectId as number, classSectionIds: owned.classSectionId !== undefined && owned.classSectionId !== null ? [owned.classSectionId as number] : [] },
          );
        }
      }

      await tx.staffingChange.update({
        where: { id: changeId },
        // The row is KEPT and marked, never deleted — §3.14's rule for a
        // withdrawn publication, and for the same reason: deleting it would
        // rewrite the school's own record of what happened.
        data: { status: "reverted", revertedAt: new Date() },
      });
      return { units, slots, pins };
    });

    await this.finish(change.timetableConfigId, change.schoolId);
    if (ticket.admittedBy.length > 0) {
      await ticket.record(
        `reverted staffing change #${changeId}: ${result.slots} lesson(s) put back` +
          (skipped.length > 0 ? `, ${skipped.length} skipped` : ""),
        { changeId, skipped },
      );
    }
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

  /**
   * §29.7 — move the §36 pins that belong to a unit that has just moved.
   *
   * Matched the way §36 matches a pin to its lesson — section + subject +
   * teacher — and compare-and-set on `teacherId: from` like every other write
   * here, so a pin somebody has already re-aimed is left alone.
   *
   * ## Only for a plain MAPPING, deliberately
   *
   * §36 attaches a pin to a mapping and to nothing else: a §4.10 merged group's
   * sections carry no separate mapping and a §4.9 block uses `placement: fixed`
   * rather than this table, so a pin cannot exist for either. Calling this for
   * them would be speculative on the way in and — because the revert identifies
   * a group by its id and never learns a subject — **not undoable on the way
   * out**. An apply that moves something its revert cannot put back is worse
   * than an apply that leaves it.
   *
   * A class-teacher unit has no subject at all; asking anyway would match every
   * pin in those sections and hand them all to the new class teacher, which is
   * a different and much worse bug than the one this fixes.
   */
  private async movePins(
    tx: { timetableFixedLesson: { updateMany: (args: unknown) => Promise<{ count: number }> } },
    configId: number,
    from: number,
    to: number,
    unit: { subjectId: number | null; classSectionIds: number[] },
  ): Promise<number> {
    if (unit.subjectId === null || unit.classSectionIds.length === 0) return 0;
    const done = await tx.timetableFixedLesson.updateMany({
      where: {
        timetableConfigId: configId,
        teacherId: from,
        subjectId: unit.subjectId,
        classSectionId: { in: unit.classSectionIds },
      },
      data: { teacherId: to },
    });
    return done.count;
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
