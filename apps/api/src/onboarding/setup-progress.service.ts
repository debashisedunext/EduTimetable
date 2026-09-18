/**
 * §24.9 — how far a TIMETABLE is, read from the timetable rather than from
 * where somebody last clicked.
 *
 * ## The bug this replaces
 *
 * Reported: *"I have already generated the timetable, but the guided setup says
 * I am on step 3 — because step 3 is the last one I clicked."*
 *
 * It was right about the cause. The progress bar was
 * `(onboarding_sessions.current_step - 1) / 10`, and `current_step` is a
 * **cursor**: where a person last was in the wizard. Pressing Back moved the
 * school backwards; a finished school that opened the wizard to look at step 3
 * read 20% for ever. A cursor answers "where was I?"; nobody was asking that.
 *
 * So nothing here reads the draft at all. Every milestone is a **fact about the
 * database**, and the only way to move the bar is to create the thing it
 * counts.
 *
 * ## Per timetable, not per school
 *
 * The old bar sat above every card, one number for the whole school, which on a
 * two-wing school describes neither of them. These milestones are per
 * `timetable_config` where the fact is (its classes, its week, its lessons, its
 * generation) and school-wide where the fact is school-wide (subjects, staff,
 * rooms — a master is entered once and used for ever, §27.12).
 *
 * ## What is NOT on the list
 *
 * *School* and *Session*, the wizard's first two steps. A config always has an
 * academic year and a school always has a name, so both are true the moment
 * there is anything to report — and a checklist item that can never be false is
 * a tick that teaches the reader to stop reading ticks.
 *
 * *Published* is not a step either. Publishing is a decision about a finished
 * timetable, not the last chore of building one; the card's own status badge
 * says it, and it is reported here as a flag so the summary line can.
 */
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface SetupStep {
  key: string;
  label: string;
  done: boolean;
  /**
   * Where this gets filled in — a guided-setup step, or a screen.
   *
   * Exactly one of the two is set, and both live here rather than in the
   * client so the bar and the "Carry on" button cannot disagree about which
   * screen fixes a missing thing (§10.6).
   *
   * Three milestones are deliberately NOT wizard steps. §31.13 took Allocation
   * out of the wizard — the Lesson grid owns the curriculum and the staffing
   * now — and generating was never a step in it. Sending somebody to step 9
   * would land them on Settings, which is the shape of bug this file exists to
   * stop: a pointer that is confidently wrong.
   */
  step: number | null;
  route: string | null;
  /** What to do about it, when it is not done. */
  hint: string;
}

export interface ConfigSetup {
  /**
   * The timetable this row is about.
   *
   * Named `id`, not `configId`, and that is not cosmetic: §17.8's sweep
   * compares every list route by the `id` keys in its payload, so a row whose
   * identifier is called anything else passes the tenancy gate by having
   * nothing to compare — reported as *"A returned no ids here"* rather than as
   * a pass. One row, one `id`, like every other collection in the app.
   */
  id: number;
  /**
   * §39.1 — the timetable's own name.
   *
   * Added for the welcome dialog, which has to say *"Junior Wing still needs
   * its rooms"* rather than a step number. The Timetables card never needed it
   * because it is already drawn inside the card that carries the name; a dialog
   * on a different screen has no such context.
   */
  name: string;
  steps: SetupStep[];
  done: number;
  total: number;
  pct: number;
  /** Slots exist for this timetable — the milestone that completes the list. */
  generated: boolean;
  /** A live publication exists. Reported, never a step. */
  published: boolean;
  /** The first unfinished milestone, or null when there is nothing left. */
  nextStep: number | null;
  nextRoute: string | null;
  nextLabel: string | null;
}

@Injectable()
export class SetupProgressService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One row per timetable, in the order the configs come back.
   *
   * Seven queries however many timetables there are — never one per config.
   * This is read by the Timetables page on every visit, and an N+1 here is a
   * school with six wings paying forty round trips to draw six progress bars
   * (§14).
   *
   * Deliberately its own endpoint rather than folded into `GET
   * /timetable-configs`: that payload feeds `ConfigContext` on **every** screen
   * in the app, and none of the others want these counts.
   */
  async forSchool(schoolId: number): Promise<ConfigSetup[]> {
    const configs = await this.prisma.timetableConfig.findMany({
      where: { schoolId },
      select: {
        id: true,
        name: true,
        academicYearId: true,
        classSections: { select: { id: true, classId: true } },
        periods: { select: { isBreak: true, isActivity: true } },
      },
      orderBy: { name: "asc" },
    });
    if (configs.length === 0) return [];

    const [subjects, teachers, rooms, curriculum, mappings, slots, publications] = await Promise.all([
      this.prisma.subject.count({ where: { schoolId } }),
      /*
        Active teachers only. An `is_active = false` row is somebody who has
        left; counting them would tick "Teachers" for a school whose entire
        staff list is former staff, which is the one school that most needs to
        be told.
      */
      this.prisma.teacher.count({ where: { schoolId, isActive: true } }),
      this.prisma.room.count({ where: { schoolId } }),
      // §3.11 — the curriculum is year-scoped, so the year is part of the key.
      this.prisma.classSubject.findMany({
        where: { schoolId },
        select: { classId: true, academicYearId: true },
      }),
      this.prisma.teacherSubjectClassSection.findMany({
        where: { schoolId },
        select: { classSectionId: true },
      }),
      /*
        ANY status, not just `draft`.

        A published timetable's rows are `status: published` and its draft can
        be empty — so counting drafts alone would report the most finished
        school in the building as never having generated anything.

        `source: extra` is excluded: §18 extra classes live in the same table
        in both statuses, and next week's revision class is not a generated
        week.
      */
      this.prisma.timetableSlot.groupBy({
        by: ["timetableConfigId"],
        where: { schoolId, source: { not: "extra" } },
        _count: { _all: true },
      }),
      // §3.14 — a withdrawn publication is history, not a live one.
      this.prisma.timetablePublication.groupBy({
        by: ["timetableConfigId"],
        where: { schoolId, withdrawnAt: null },
        _count: { _all: true },
      }),
    ]);

    const taught = new Set(curriculum.map((r) => `${r.classId}:${r.academicYearId}`));
    const staffed = new Set(mappings.map((r) => r.classSectionId));
    const hasSlots = new Set(slots.map((r) => r.timetableConfigId));
    const isLive = new Set(publications.map((r) => r.timetableConfigId));

    return configs.map((c) => {
      const sections = c.classSections;
      const classIds = [...new Set(sections.map((s) => s.classId))];
      // A break is not a teaching period, and neither is an assembly (§28.3) —
      // a week of nothing but a lunch row is not a week.
      const teaching = c.periods.filter((p) => !p.isBreak && !p.isActivity).length;
      const generated = hasSlots.has(c.id);

      const LESSON_GRID = "/master-grid?tab=lesson";
      const wizard = (step: number) => ({ step, route: null });
      const screen = (route: string) => ({ step: null, route });

      const steps: SetupStep[] = [
        {
          key: "classes", label: "Classes", ...wizard(4), done: sections.length > 0,
          hint: "Choose which classes and sections this timetable teaches.",
        },
        {
          key: "week", label: "Week", ...wizard(5), done: teaching > 0,
          hint: "Set the working days, periods and breaks for this timetable.",
        },
        {
          key: "subjects", label: "Subjects", ...wizard(6), done: subjects > 0,
          hint: "Add the subjects your school teaches.",
        },
        {
          key: "teachers", label: "Teachers", ...wizard(7), done: teachers > 0,
          hint: "Add your teaching staff.",
        },
        {
          key: "rooms", label: "Rooms", ...wizard(8), done: rooms > 0,
          hint: "Add the rooms and labs lessons can be placed in.",
        },
        {
          /*
            EVERY class, not any: a school that has entered Class 1's periods
            and none of Class 2's has not finished its lesson plan, and a tick
            there would be the same lie in a smaller place.
          */
          key: "curriculum", label: "Lesson plan", ...screen(LESSON_GRID),
          done: classIds.length > 0 && classIds.every((id) => taught.has(`${id}:${c.academicYearId}`)),
          hint: "Set how many periods a week each class gets of each subject.",
        },
        {
          key: "staffing", label: "Staffing", ...screen(LESSON_GRID),
          done: sections.length > 0 && sections.every((s) => staffed.has(s.id)),
          hint: "Say who teaches what, on the Lesson grid.",
        },
        {
          key: "generated", label: "Generated", ...screen("/generate"), done: generated,
          hint: "Press Generate once Readiness is green.",
        },
      ];

      const done = steps.filter((s) => s.done).length;
      const next = steps.find((s) => !s.done) ?? null;
      return {
        id: c.id,
        name: c.name,
        steps,
        done,
        total: steps.length,
        pct: Math.round((done / steps.length) * 100),
        generated,
        published: isLive.has(c.id),
        nextStep: next?.step ?? null,
        nextRoute: next?.route ?? null,
        nextLabel: next?.label ?? null,
      };
    });
  }
}
