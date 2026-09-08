/**
 * §15.3 Phase 25.2 — is this school new, and what has somebody typed so far.
 *
 * Two jobs that look similar and are not:
 *
 *  - **State** (`stateFor`) is about the SCHOOL: does it have a timetable yet?
 *    It decides whether the welcome screen opens by itself.
 *  - **Draft** (`draftFor` / `save`) is about one PERSON's half-finished setup.
 *    It decides whether they lose twenty minutes to a refresh.
 *
 * The important thing a draft is not: it is **not committed data**. `answers`
 * is what somebody has typed; the actual masters are written at the end through
 * the endpoints that already exist. That separation is what lets an abandoned
 * wizard leave nothing behind in `classes`, `rooms` or anywhere else — and it is
 * the property the smoke suite checks rather than assumes.
 */
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import {
  CLASS_LADDER,
  classSheets, coverageGaps, curriculumSheets, mappingSheets, roomSheets, sessionSheets,
  subjectSheets, suggestCurriculum, suggestMappings, suggestRooms, teacherSheets,
  withCurriculumPeriods,
  type CurriculumCell, type MappingSuggestion, type SubjectAnswer, type SuggestedRoom,
  type TeacherAnswer, type WizardAnswers,
} from "@edutimetable/shared";
import { ImportService } from "../import/import.service";
import { TermsService } from "../terms/terms.service";
import { PrismaService } from "../prisma/prisma.service";
import { stepFrom } from "./interview.answers";

/**
 * §28 — the guided setup has TEN steps, not eleven.
 *
 * Curriculum and Mapping merged into one Allocation step, and that renumbering
 * is the only thing here that can hurt somebody: a draft saved mid-setup
 * remembers a step NUMBER, and old step 10 (Mapping) is new step 10 (Settings).
 * The number alone cannot say which is meant.
 *
 * So a draft records the scheme it was written under. Anything without the
 * marker predates the merge and is shifted down one from step 10; anything with
 * it is read as it stands. One line, and the alternative is dropping somebody
 * onto the wrong screen halfway through their own school's setup — exactly the
 * kind of thing only a school ever finds.
 */
export const TOTAL_STEPS = 10;
const STEP_SCHEME_KEY = "__stepScheme";
const STEP_SCHEME = 2;

/** Read a stored step number under whichever numbering wrote it. */
export function migrateStep(step: number, answers: unknown): number {
  const scheme = (answers as Record<string, unknown> | null)?.[STEP_SCHEME_KEY];
  if (scheme === STEP_SCHEME) return Math.min(TOTAL_STEPS, Math.max(1, step));
  // Pre-merge: 1–9 are unchanged (9 was Curriculum, now Allocation, which is
  // where that person was anyway); 10 (Mapping) and 11 (Settings) shift down.
  return Math.min(TOTAL_STEPS, Math.max(1, step >= 10 ? step - 1 : step));
}

export interface OnboardingState {
  /** No timetable configured yet — the real definition of "new". */
  isNew: boolean;
  hasConfig: boolean;
  hasClasses: boolean;
  hasPublished: boolean;
  /** When THIS user last said "later"; null if never. Recorded, not enforced. */
  dismissedAt: string | null;
  /** Whether a half-finished guided setup is waiting for them. */
  resumeStep: number | null;
  resumeMode: "wizard" | "ai" | null;
  /** The wings this setup is building — one draft covers all of them. */
  resumeWings: Array<{ name: string; weekReady: boolean }>;
  /** Whether the welcome screen should open on its own right now. */
  shouldPrompt: boolean;
}

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly importer: ImportService,
    private readonly terms: TermsService,
  ) {}

  /**
   * Deliberately NOT cached.
   *
   * The plan said "cached per school", and three indexed counts turn out to
   * measure well under a millisecond — so a cache would buy nothing and cost
   * the one bug that would actually be noticed: an admin creates their first
   * timetable and the app keeps offering to set the school up, because a
   * 60-second entry says it is still empty. Correctness here is worth more than
   * a saving that does not register against the §14 budget.
   */
  async stateFor(schoolId: number, userId: number): Promise<OnboardingState> {
    const [configs, classes, published, user, draft] = await Promise.all([
      this.prisma.timetableConfig.count({ where: { schoolId } }),
      this.prisma.schoolClass.count({ where: { schoolId } }),
      this.prisma.timetablePublication.count({ where: { schoolId } }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { onboardingDismissedAt: true },
      }),
      this.prisma.onboardingSession.findFirst({
        where: { schoolId, userId, completedAt: null },
        select: { currentStep: true, mode: true, answers: true },
      }),
    ]);

    const isNew = configs === 0;
    const dismissedAt = user?.onboardingDismissedAt ?? null;
    return {
      isNew,
      hasConfig: configs > 0,
      hasClasses: classes > 0,
      hasPublished: published > 0,
      dismissedAt: dismissedAt ? dismissedAt.toISOString() : null,
      resumeStep: draft ? migrateStep(draft.currentStep, draft.answers) : null,
      resumeWings: this.wingsInDraft(draft?.answers),
      resumeMode: (draft?.mode as "wizard" | "ai") ?? null,
      // Two independent reasons to open, and the OR between them matters.
      //
      // A half-finished draft always re-offers itself — "carry on where you
      // left off" is the entire point of having saved it.
      //
      // Otherwise: a school with no timetable at all. **Every sign-in**, not
      // once ever. A school that has not built a timetable has not started
      // using the product, and the thing standing between it and a timetable is
      // knowing where to begin; an offer that appears once and never returns
      // leaves anyone who was busy that morning with an app whose one job is
      // hidden behind a button they have no reason to look for.
      //
      // `dismissedAt` therefore no longer suppresses this (see `dismiss`). What
      // keeps it from being a nag is the CLIENT: the welcome screen opens once
      // per sitting, so "I'll do this later" means the rest of today, and the
      // next sign-in asks again because the school still has no timetable.
      //
      // Written this way rather than `isNew && (…)` deliberately. Step 5 of the
      // wizard creates the timetable config, so a draft past step 5 means
      // `isNew` is FALSE while the setup is still unfinished — and an `isNew &&`
      // would stop offering to resume at exactly the point the person has the
      // most to lose.
      shouldPrompt: draft !== null || isNew,
    };
  }

  /**
   * The wings this setup is building, and whether each has its week yet.
   *
   * A guided setup is **one draft for the whole school**, not one per wing: step
   * 3 names every wing at once and everything after it covers all of them. So
   * the honest thing to report is which wings it is building — the question
   * "which wing is this progress for?" has the answer "all of them", and the
   * useful version of that answer is the list.
   *
   * `weekReady` is the one genuinely per-wing fact worth surfacing: step 5 is
   * filled in wing by wing, so a two-wing school can be half-way through a
   * single step, and nothing else on the screen would show it.
   */
  private wingsInDraft(answers: unknown): Array<{ name: string; weekReady: boolean }> {
    const a = (answers ?? {}) as { wings?: Array<{ name?: unknown }>; weeks?: Record<string, unknown> };
    if (!Array.isArray(a.wings)) return [];
    const weeks = a.weeks ?? {};
    return a.wings
      .map((w) => String(w?.name ?? "").trim())
      .filter((name) => name !== "")
      .slice(0, 12)
      .map((name) => ({ name, weekReady: weeks[name] !== undefined }));
  }

  /**
   * "I'll do this later." Per user, so a colleague still sees it.
   *
   * Recorded, but no longer a permanent silence: a school with no timetable is
   * offered the setup on every sign-in (see `shouldPrompt`), and the welcome
   * screen's once-per-sitting rule is what makes "later" mean anything. The
   * timestamp stays because "this admin has now been offered the setup four
   * times and declined" is a real fact about an account that never got started,
   * and because a colleague's is deliberately independent of it.
   */
  async dismiss(userId: number): Promise<{ dismissedAt: string }> {
    const at = new Date();
    await this.prisma.user.update({
      where: { id: userId },
      data: { onboardingDismissedAt: at },
    });
    return { dismissedAt: at.toISOString() };
  }

  /** The half-finished setup, or null. */
  async draftFor(schoolId: number, userId: number) {
    const row = await this.prisma.onboardingSession.findFirst({
      where: { schoolId, userId, completedAt: null },
    });
    if (!row) return null;
    return {
      id: row.id,
      mode: row.mode,
      currentStep: migrateStep(row.currentStep, row.answers),
      answers: (row.answers as Record<string, unknown>) ?? {},
      // §24.6 — where this run's conversation begins in the audit log. Part of
      // the draft, because that is what it is a property of.
      chatSince: row.chatSince,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Build a guided-setup draft from what the school ALREADY has.
   *
   * The plan put "editing an existing school through the wizard" out of scope,
   * and the reason it gave still stands: pointing a first-run flow at a
   * published timetable needs a diff-and-merge story of its own. This is a
   * deliberately narrower thing, and the narrowing is what makes it safe.
   *
   * **It fills gaps; it never edits.** Every wizard commit goes through the §16
   * importer, which SKIPS rows that already exist by natural key — it does not
   * update them and cannot delete them. So re-walking the steps over an existing
   * school adds what is missing and leaves everything else exactly as it is.
   * Renaming a subject or removing a teacher stays where it belongs, on the
   * master screens, and the screen says so rather than implying otherwise.
   *
   * What comes back is the same `answers` shape a person would have typed, so
   * every step, every validator and every commit is the one that already exists.
   * The wizard then opens at the first thing that is missing, because "which
   * step am I on?" is already derived from the answers rather than remembered.
   */
  async adoptFromSchool(schoolId: number, userId: number) {
    const existing = await this.draftFor(schoolId, userId);
    // A live draft is somebody's unfinished work. Rebuilding over it would
    // throw away whatever they had typed but not yet committed.
    if (existing) return { ...existing, adopted: false, skippedWings: [] as string[] };

    const { answers, skippedWings, counts } = await this.answersFromSchool(schoolId);
    const saved = await this.save(schoolId, userId, {
      answers,
      /**
       * Open at the first thing still MISSING, not at question one.
       *
       * An adopted draft has no "where I left off" — nobody left off anywhere.
       * `stepFrom` is the rule the conversational setup already uses to answer
       * exactly this question, and it reads the same answers. One rule, so the
       * two doors cannot disagree about how far along a school is.
       */
      currentStep: stepFrom(answers),
      mode: "wizard",
    });
    this.logger.log(
      `Adopted school ${schoolId} into a guided draft: ${counts.wings} wing(s), ` +
        `${counts.subjects} subjects, ${counts.teachers} teachers` +
        (skippedWings.length ? `, skipped ${skippedWings.join(", ")}` : ""),
    );
    return { ...saved, adopted: true, skippedWings };
  }

  /**
   * What a school with no draft should open the guided setup on.
   *
   * Reads, never writes. A brand-new school gets `{ empty: true }` and question
   * one, which is right — §27.12 is about not asking a school that has already
   * answered.
   */
  async prefillFromSchool(schoolId: number) {
    const classes = await this.prisma.schoolClass.count({ where: { schoolId } });
    const subjects = await this.prisma.subject.count({ where: { schoolId } });
    if (classes === 0 && subjects === 0) return { empty: true };
    const { answers, skippedWings } = await this.answersFromSchool(schoolId);
    return {
      empty: true,
      /** The answers are real but unsaved — the client must persist them. */
      prefilled: true,
      currentStep: stepFrom(answers),
      answers,
      skippedWings,
    };
  }

  /**
   * §27.12 — the wizard's answers, rebuilt from what the school already has.
   *
   * **A master is entered once and used for ever.** A school that has run a
   * timetable has its session, classes, subjects, teachers, rooms and
   * curriculum; asking for them again because it is starting a second timetable
   * — or because somebody deleted the first — is asking it to retype its own
   * records. The masters were never deleted; the wizard simply behaved as
   * though they had been.
   *
   * Split out of `adoptFromSchool` so it can be read WITHOUT writing a draft:
   * opening the guided setup must not, by itself, create one, or a school that
   * merely looked would be offered a resume for ever afterwards.
   */
  private async answersFromSchool(schoolId: number) {
    const [configs, years, subjects, teachers, school] = await Promise.all([
      this.prisma.timetableConfig.findMany({ where: { schoolId }, orderBy: { id: "asc" } }),
      this.prisma.academicYear.findMany({ where: { schoolId }, orderBy: { id: "desc" } }),
      this.prisma.subject.findMany({ where: { schoolId }, orderBy: { name: "asc" } }),
      this.prisma.teacher.findMany({ where: { schoolId, isActive: true }, orderBy: { name: "asc" } }),
      this.prisma.school.findUnique({ where: { id: schoolId }, select: { name: true } }),
    ]);

    const sections = await this.prisma.classSection.findMany({
      where: { schoolId },
      // `section` too: §27.12 needs the "Class 5-A" label to carry the school's
      // own rooms, curriculum and mappings back into the wizard's answers.
      include: { class: true, section: true },
    });
    // Which subjects each teacher is already mapped to — the input the
    // Allocation step staffs from.
    const mappings = await this.prisma.teacherSubjectClassSection.findMany({
      where: { schoolId },
      select: { teacherId: true, subjectId: true },
    });
    /**
     * §27.9/§18 — the classes each teacher is DECLARED for.
     *
     * Read rather than re-derived, for the same reason as `initials`: a school
     * that has already said Mrs Rao takes Class 1 and 2 has said it, and an
     * adopted draft that quietly widened her to the whole wing would re-staff
     * the school against a scope nobody chose.
     */
    const eligibility = await this.prisma.teacherClassEligibility.findMany({
      where: { schoolId },
      select: { teacherId: true, class: { select: { name: true } } },
    });
    const teacherClasses = new Map<number, string[]>();
    for (const e of eligibility) {
      if (!teacherClasses.has(e.teacherId)) teacherClasses.set(e.teacherId, []);
      teacherClasses.get(e.teacherId)!.push(e.class.name);
    }
    const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
    const teacherSubjects = new Map<number, Set<string>>();
    const addSubject = (teacherId: number, subjectId: number) => {
      const name = subjectName.get(subjectId);
      if (!name) return;
      if (!teacherSubjects.has(teacherId)) teacherSubjects.set(teacherId, new Set());
      teacherSubjects.get(teacherId)!.add(name);
    };
    /**
     * §27.13 — the DECLARED subjects first, then whatever the mappings imply.
     *
     * The union, not one or the other. Declared is the fact — it is what
     * somebody typed on the Teachers step, and it survives having no mappings
     * yet, which is exactly the case that was broken: a school starting its
     * second wing saw every "Teaches" cell empty. The mappings are kept because
     * every school that predates this table has no declarations, and reading
     * only the new table would empty that column for all of them.
     */
    for (const d of await this.prisma.teacherSubject.findMany({ where: { schoolId } })) {
      addSubject(d.teacherId, d.subjectId);
    }
    for (const m of mappings) addSubject(m.teacherId, m.subjectId);

    const wings: Array<Record<string, unknown>> = [];
    const weeks: Record<string, unknown> = {};
    const skippedWings: string[] = [];

    for (const cfg of configs) {
      const mine = sections.filter((cs) => cs.timetableConfigId === cfg.id);
      const names = [...new Set(mine.map((cs) => cs.class.name))];
      const indices = names.map((n) => CLASS_LADDER.indexOf(n as (typeof CLASS_LADDER)[number]));
      /**
       * A wing is a RANGE on a fixed ladder, and a school that named its
       * classes something else cannot be described that way. Rather than
       * guessing a range that would quietly create the wrong classes, THAT wing
       * is left out and named — the master screens still cover it.
       */
      if (names.length > 0 && indices.some((i) => i < 0)) {
        skippedWings.push(cfg.name);
        continue;
      }
      /**
       * A wing with no classes yet is carried, not dropped.
       *
       * It was being skipped, and the effect on screen was a wing list missing
       * wings the school plainly has — which reads as the setup having lost
       * them. It exists, it simply has nothing in it yet, so it appears with
       * the same default range the Add-a-wing button uses and the person
       * adjusts it. Nothing is created until Next, and step 4 shows exactly
       * what would be.
       */
      const perClass = names.map((n) => mine.filter((cs) => cs.class.name === n).length);
      wings.push({
        name: cfg.name,
        fromIndex: names.length > 0 ? Math.min(...indices) : 4,
        toIndex: names.length > 0 ? Math.max(...indices) : 9,
        // The commonest, since one number has to stand for the wing; a class
        // that differs keeps its own count, because step 4 writes nothing over
        // sections that already exist.
        sections: perClass.sort((a, b) => perClass.filter((v) => v === b).length - perClass.filter((v) => v === a).length)[0] ?? 2,
      });

      const periods = await this.prisma.period.findMany({
        where: { timetableConfigId: cfg.id }, orderBy: { sortOrder: "asc" },
      });
      if (periods.length > 0) {
        weeks[cfg.name] = {
          workingDays: Array.isArray(cfg.workingDays) ? cfg.workingDays : [1, 2, 3, 4, 5],
          periodsPerDay: cfg.periodsPerDay,
          periodDurationMins: cfg.periodDurationMins,
          startTime: cfg.startTime,
          hasZeroPeriod: cfg.hasZeroPeriod,
          breaks: periods
            .filter((p) => p.isBreak)
            .map((p) => ({
              name: p.breakName ?? "Break",
              // The teaching period this break follows.
              afterPeriod: periods.filter((q) => !q.isBreak && q.sortOrder < p.sortOrder).length,
              durationMins: this.minutesBetween(p.startTime, p.endTime),
            })),
        };
      }
    }

    const year = years.find((y) => y.isActive) ?? years[0];

    /**
     * §27.12 — the rooms, the curriculum and the mappings this school already
     * has, so the Allocation step opens on the school's OWN plan rather than a
     * fresh proposal over the top of it.
     *
     * Left out until now, and the omission was visible: adopting a school with
     * 957 mappings produced a grid that re-staffed all of them from scratch and
     * reported hundreds of "unstaffed" cells for subjects taught through §4.9
     * elective blocks. A plan somebody has already made is an answer, not a
     * blank.
     *
     * Scoped to the ACTIVE year (§3.11): a class has curriculum rows in every
     * session it has ever run, and two sessions' rows would collapse into
     * whichever loaded last.
     */
    /** "Class 5-A", the label every wizard answer uses for a class-section. */
    const label = (cs: { class: { name: string }; section?: { name: string } }) =>
      `${cs.class.name}-${(cs as { section?: { name: string } }).section?.name ?? ""}`;

    const roomRows = await this.prisma.room.findMany({
      where: { schoolId }, include: { subjects: { include: { subject: true } } }, orderBy: { name: "asc" },
    });
    const homeRoomOf = new Map<number, string>();
    for (const cs of sections) if (cs.homeRoomId) homeRoomOf.set(cs.homeRoomId, label(cs));
    const rooms = roomRows.map((r) => ({
      name: r.name,
      type: r.roomType,
      capacity: r.capacity ?? null,
      isShared: r.isShared,
      subjects: r.subjects.map((x) => x.subject.name),
      because: "already in the school",
      ...(homeRoomOf.has(r.id) ? { homeRoomFor: homeRoomOf.get(r.id) } : {}),
    }));

    const curriculumRows = year
      ? await this.prisma.classSubject.findMany({
          where: { schoolId, academicYearId: year.id },
          include: { class: true, subject: true },
        })
      : [];
    const curriculum = curriculumRows.map((c) => ({
      className: c.class.name,
      subjectName: c.subject.name,
      periodsPerWeek: c.periodsPerWeek,
      maxPerDay: c.maxPeriodsPerDay,
    }));

    const mappingRows = await this.prisma.teacherSubjectClassSection.findMany({
      where: { schoolId },
      include: { teacher: true, subject: true, classSection: { include: { class: true, section: true } } },
    });
    const mappingAnswers = mappingRows.map((m) => ({
      employeeCode: m.teacher.employeeCode,
      subjectName: m.subject.name,
      classSections: [label(m.classSection)],
      periodsPerWeek: m.periodsPerWeek,
    }));
    const classTeachers = sections
      .filter((cs) => cs.classTeacherId)
      .map((cs) => ({
        classSection: label(cs),
        employeeCode: teachers.find((t) => t.id === cs.classTeacherId)?.employeeCode ?? "",
      }))
      .filter((c) => c.employeeCode);

    const answers: Record<string, unknown> = {
      school: { name: school?.name ?? "" },
      ...(year
        ? {
            session: {
              name: year.name,
              startDate: year.startDate.toISOString().slice(0, 10),
              endDate: year.endDate.toISOString().slice(0, 10),
            },
          }
        : {}),
      ...(wings.length > 0 ? { wings } : {}),
      ...(Object.keys(weeks).length > 0 ? { weeks } : {}),
      ...(rooms.length > 0 ? { rooms } : {}),
      ...(curriculum.length > 0 ? { curriculum } : {}),
      ...(mappingAnswers.length > 0 ? { mappings: mappingAnswers } : {}),
      ...(classTeachers.length > 0 ? { classTeachers } : {}),
      ...(subjects.length > 0
        ? {
            subjects: subjects.map((s) => ({
              name: s.name, code: s.code ?? "", isLab: s.isLab,
              requiresDoublePeriod: s.requiresDoublePeriod,
            })),
          }
        : {}),
      ...(teachers.length > 0
        ? {
            teachers: teachers.map((t) => ({
              name: t.name,
              employeeCode: t.employeeCode,
              // Carried, not re-derived. A school that already uses initials
              // has them printed on cover lists and staff-room doors; deriving
              // fresh ones would show it somebody else's shorthand for its own
              // teachers. Null is fine — `assignInitials` fills those in.
              initials: t.initials,
              classes: teacherClasses.get(t.id) ?? [],
              subjects: [...(teacherSubjects.get(t.id) ?? [])],
              maxPeriodsPerDay: t.maxPeriodsPerDay,
              maxPeriodsPerWeek: t.maxPeriodsPerWeek,
              canSubstitute: t.canSubstitute,
              employmentType: t.employmentType,
            })),
          }
        : {}),
    };

    /**
     * Open at the first thing still MISSING, not at question one.
     *
     * An adopted draft has no "where I left off" — nobody left off anywhere.
     * Starting at 1 meant walking back through a school's own name and session
     * before reaching anything worth doing, and being asked to add wings that
     * were already listed on the very screen the button was pressed from.
     *
     * `stepFrom` is the rule the conversational setup already uses to answer
     * exactly this question, and it reads the same answers. One rule, so the
     * two doors cannot disagree about how far along a school is.
     */
    return {
      answers,
      skippedWings,
      counts: { wings: wings.length, subjects: subjects.length, teachers: teachers.length },
    };
  }

  /** "08:00" → "08:30" is 30. Used only to describe an existing break. */
  private minutesBetween(from: string, to: string): number {
    const mins = (t: string) => {
      const [h, m] = t.split(":").map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    return Math.max(5, Math.min(120, mins(to) - mins(from)));
  }

  /**
   * Save progress.
   *
   * Answers are **merged**, not replaced: a step saves only its own keys, and a
   * client that sent the whole object would overwrite a step it never showed —
   * which is exactly how a "Back" button loses the answers in front of it.
   */
  async save(
    schoolId: number,
    userId: number,
    input: { currentStep?: number; answers?: Record<string, unknown>; mode?: "wizard" | "ai" },
  ) {
    /**
     * Looked up by the table's REAL key — `(school_id, user_id)` — not by
     * "is there an unfinished one".
     *
     * Those two are not the same question, and the difference was a 500 on the
     * first Next of anybody who had run the guided setup before. `finish` marks
     * the row `completed_at` rather than deleting it, and every read filters to
     * `completedAt: null` so a finished setup stops offering to resume — which
     * is right. But this write then found nothing, tried to INSERT, and hit the
     * unique key that says one row per person per school, forever.
     *
     * A completed setup is history, so starting again SUPERSEDES it rather than
     * merging into it: the row is reused, `completed_at` cleared, and the
     * answers begin from what this turn supplied. Merging would be worse than
     * the crash — last year's wings and teachers would silently reappear inside
     * a setup somebody believes they are starting fresh.
     */
    const existing = await this.prisma.onboardingSession.findUnique({
      where: { schoolId_userId: { schoolId, userId } },
    });
    const resuming = existing !== null && existing.completedAt === null;
    const merged = {
      ...(resuming ? ((existing.answers as Record<string, unknown>) ?? {}) : {}),
      ...(input.answers ?? {}),
    };
    const data = {
      currentStep: Math.max(1, Math.min(TOTAL_STEPS, input.currentStep ?? (resuming ? existing.currentStep : 1))),
      // Stamped on every save so a draft can say which numbering it was written
      // under — see `migrateStep`. Written here rather than by the client
      // because the server also writes drafts (`adoptFromSchool`), and a marker
      // only half the writers set is worse than none.
      answers: { ...merged, [STEP_SCHEME_KEY]: STEP_SCHEME } as never,
      // Clearing it is what makes this row the live draft again. Harmless when
      // it is already null.
      completedAt: null,
      // A run that is BEGINNING gets a fresh conversation boundary (§24.6): the
      // AI transcript is read from `ai_chat_log` filtered to rows after this,
      // so last time's questions do not reappear inside a setup somebody
      // believes they are starting clean — and the log itself is never deleted,
      // because the token budget is summed from it.
      ...(resuming ? {} : { chatSince: new Date() }),
      ...(input.mode ? { mode: input.mode } : {}),
    };

    const row = existing
      ? await this.prisma.onboardingSession.update({ where: { id: existing.id }, data })
      : await this.prisma.onboardingSession.create({
          data: { schoolId, userId, ...data },
        });

    return {
      id: row.id,
      mode: row.mode,
      // Just written under the current scheme, so this is a no-op clamp — but
      // it goes through the same function so there is exactly one place that
      // decides what a stored step number means.
      currentStep: migrateStep(row.currentStep, row.answers),
      answers: (row.answers as Record<string, unknown>) ?? {},
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Commit one step's answers.
   *
   * **Every row goes through `commitSheets` — the §16 pipeline the Excel
   * importer, the ERP sync and the AI assistant already share.** Nothing here
   * writes a master row itself, which is what keeps the wizard a face rather
   * than a fourth committer with its own idea of the rules.
   *
   * Two consequences worth stating, because both are load-bearing:
   *
   *  - **It is idempotent.** The importer skips rows that already exist by
   *    natural key, so pressing Next twice, resuming a draft, or re-running a
   *    step creates nothing extra. Without that the wizard would need its own
   *    "have I already made these?" bookkeeping, and that bookkeeping is
   *    precisely where duplicate classes come from.
   *  - **It validates identically.** Over-long names, a class-section naming a
   *    year that does not exist, a section already claimed by another
   *    timetable — all refused by the same code an upload meets, reported with
   *    the same cell references.
   *
   * The timetable config itself is NOT here: §16 is masters only, so wings and
   * the week go through `POST /timetable-configs` and `PUT /:id/structure`,
   * which already own that shape.
   */
  /**
   * The rows one step would write, and anything it could not work out.
   *
   * ONE builder, used by both `preview` and `commit`, so the dry run can never
   * describe something different from what the write does — which is the
   * failure mode a second copy of this switch would eventually produce.
   */
  private async sheetsFor(schoolId: number, step: number, answers: WizardAnswers & Record<string, any>) {
    const issues: Array<{ message: string; fix: string }> = [];
    const year = answers.session?.name ?? "";
    const subjects: SubjectAnswer[] = answers.subjects ?? [];
    const teachers: TeacherAnswer[] = answers.teachers ?? [];
    const wings = answers.wings ?? [];

    switch (step) {
      case 2:
        return { sheets: answers.session?.name ? sessionSheets(answers.session) : [], issues };
      case 4: {
        const built = classSheets(answers);
        return { sheets: built.sheets, issues: built.issues };
      }
      case 6:
        return { sheets: subjectSheets(subjects), issues };
      case 7:
        return { sheets: teacherSheets(teachers, wings), issues };
      case 8: {
        // Rooms carry their subject mappings, which the Rooms SHEET has no
        // column for — §19's room_subjects is a separate table. The sheet
        // creates the rooms; `attachLabSubjects` maps them, and without that a
        // proposed lab is a general-purpose room with a misleading name.
        return { sheets: roomSheets(await this.roomsFor(schoolId, answers)), issues };
      }
      /**
       * §28 — curriculum AND mapping, in one step.
       *
       * They were two, and the split was arbitrary: a curriculum row and the
       * mapping that teaches it are the same decision seen twice. The proof is
       * `withCurriculumPeriods`, which exists only to stop step 10 quoting a
       * number step 9 had since changed. One step, one commit, and the two
       * sheets go through the importer in the order it needs them.
       */
      case 9: {
        const cur = await this.curriculumFor(schoolId, answers);
        for (const d of cur.dropped) {
          issues.push({
            message: `${d.subjectName} was left out of ${d.className}.`,
            fix: d.reason + " Remove a subject, or give this wing a longer week on step 5.",
          });
        }
        const proposal = suggestMappings(wings, cur, teachers, await this.daysByWing(schoolId));
        // The two halves fall back INDEPENDENTLY, because they are edited
        // independently: the screen has an assignment table and a class-teacher
        // table, and somebody who reassigns one lesson has not thereby said
        // their school has no class teachers. Treating the pair as one edited
        // object drops all fourteen of them on the first change to either.
        const plan = {
          // Periods/week is quoted from the curriculum, never from whatever the
          // mapping half happened to store — otherwise editing a period count
          // leaves a stale number that Readiness reports as a blocker. Still
          // true with one step: the grid edits both halves of a cell, and the
          // curriculum is where the number is DECIDED.
          mappings: withCurriculumPeriods(
            cur, this.edited<MappingSuggestion>(answers.mappings) ?? proposal.mappings,
          ),
          classTeachers:
            this.edited<{ classSection: string; employeeCode: string }>(answers.classTeachers)
            ?? proposal.classTeachers,
          uncovered: [],
          load: [],
        };
        // Recomputed rather than read off the proposal: the moment the screen
        // lets somebody reassign or delete a row, the proposal's own
        // `uncovered` list describes a plan that no longer exists.
        for (const u of coverageGaps(wings, cur, plan.mappings)) {
          issues.push({
            message: `${u.className} has no teacher for ${u.subjectName}.`,
            fix: "Assign somebody on the Allocation step, add a teacher for it on step 7, or raise a weekly limit.",
          });
        }
        // Curriculum FIRST. The Subject Mapping sheet references subjects and
        // class-sections that the Curriculum sheet does not create — but the
        // importer validates cross-sheet references within one commit, and a
        // mapping quoting a periods/week the curriculum has not yet stated
        // reads as a mismatch. Order is cheaper than a second commit.
        return { sheets: [...curriculumSheets(cur, year), ...mappingSheets(plan)], issues };
      }
      default:
        return { sheets: [], issues };
    }
  }

  /**
   * Each wing's working days — the other half of Check 3's arithmetic.
   *
   * A teacher's real weekly ceiling is their daily reach TIMES the days
   * available, not their weekly cap. Without this the suggester happily staffs
   * a school that Check 3 then refuses.
   */
  private async daysByWing(schoolId: number): Promise<Record<string, number>> {
    const configs = await this.prisma.timetableConfig.findMany({ where: { schoolId } });
    const out: Record<string, number> = {};
    for (const c of configs) {
      out[c.name] = Array.isArray(c.workingDays) ? (c.workingDays as number[]).length : 5;
    }
    return out;
  }

  /** Each wing's real weekly capacity, read from what step 5 actually wrote. */
  private async capacityByWing(schoolId: number): Promise<Record<string, number>> {
    const configs = await this.prisma.timetableConfig.findMany({ where: { schoolId } });
    const out: Record<string, number> = {};
    for (const c of configs) {
      const days = Array.isArray(c.workingDays) ? (c.workingDays as number[]).length : 5;
      out[c.name] = c.periodsPerDay * days;
    }
    return out;
  }

  async commit(schoolId: number, userId: number, step: number) {
    const draft = await this.draftFor(schoolId, userId);
    if (!draft) throw new BadRequestException("There is nothing saved to commit.");
    const answers = draft.answers as WizardAnswers & Record<string, any>;

    const { sheets, issues } = await this.sheetsFor(schoolId, step, answers);
    // A class claimed by two wings is a decision, not something to merge:
    // `classes.name` is unique per school, so both cannot exist.
    const blocking = step === 4 ? issues : [];
    if (blocking.length > 0) {
      throw new BadRequestException(`${blocking[0].message} ${blocking[0].fix}`);
    }
    if (sheets.length === 0) throw new BadRequestException("There is nothing to create yet.");

    const result = await this.importer.commitSheets(schoolId, sheets);
    // §19: a lab with no subjects listed is GENERAL and serves everything, so
    // creating "Science Lab" without mapping Science to it produces a second
    // general-purpose room the solver will put Hindi in. The Rooms sheet has no
    // column for it, so it is done here, right after the rooms exist.
    if (step === 8) await this.attachLabSubjects(schoolId, answers);
    // §25 — the terms of the session the importer has just created. Not a
    // sheet, for the same reason the week is not one: §16 is master data, and
    // the school calendar is not master data. Matched by name so pressing Next
    // twice re-dates the same terms rather than replacing them.
    if (step === 2) await this.applyTerms(schoolId, answers);
    this.logger.log(`Onboarding step ${step} committed for school ${schoolId}: ${JSON.stringify(result.created)}`);
    return { ...result, issues };
  }

  /**
   * §25 — write the session's terms, if the admin asked for terms at all.
   *
   * Silent when the draft says nothing about terms, which is every draft made
   * before this phase and every school that runs a whole year: the guided setup
   * must not start writing a calendar nobody asked for.
   */
  private async applyTerms(schoolId: number, answers: WizardAnswers & Record<string, any>) {
    const wanted = Array.isArray(answers.terms) ? answers.terms : [];
    if (wanted.length === 0) return;
    const year = await this.prisma.academicYear.findFirst({
      where: { name: String(answers.session?.name ?? "") },
      select: { id: true },
    });
    if (!year) return;
    await this.terms.applyByName(year.id, wanted);
    this.logger.log(`Onboarding: ${wanted.length} terms written for school ${schoolId}`);
  }

  /**
   * Map each proposed lab to the subject it serves (§19).
   *
   * Idempotent by the composite primary key, like everything else in the
   * wizard: re-running step 8 adds nothing.
   */
  /**
   * The room list, built ONCE.
   *
   * Both the sheet and the lab-subject mapping read it, and they must agree on
   * the names — "Science Lab" vs "Science Lab 1" is the difference between a
   * mapped lab and a general-purpose room with a misleading name.
   */
  private async proposedRooms(schoolId: number, answers: WizardAnswers & Record<string, any>) {
    const capacityByWing = await this.capacityByWing(schoolId);
    const curriculum = await this.curriculumFor(schoolId, answers);
    return suggestRooms(answers.wings ?? [], answers.subjects ?? [], { curriculum, capacityByWing });
  }

  /**
   * The three suggested steps are PROPOSALS, and a proposal that ignores the
   * correction is not one.
   *
   * Steps 8, 9 and 10 each show what the suggester worked out and let it be
   * edited; the edit is stored in the draft under its own key. So every read of
   * that data goes through one of these: what the admin left, or — when they
   * touched nothing — what the suggester proposes right now.
   *
   * Recomputed rather than snapshotted, deliberately. Going back to step 7 to
   * add a teacher and forward again must change the mapping proposal; a
   * snapshot taken the first time step 10 rendered would silently ignore them.
   */
  /** What the admin left, or `null` if they left nothing and the suggester should speak. */
  private edited<T>(value: unknown): T[] | null {
    return Array.isArray(value) && value.length > 0 ? (value as T[]) : null;
  }

  private async roomsFor(schoolId: number, answers: WizardAnswers & Record<string, any>) {
    return this.edited<SuggestedRoom>(answers.rooms) ?? (await this.proposedRooms(schoolId, answers));
  }

  private async curriculumFor(schoolId: number, answers: WizardAnswers & Record<string, any>) {
    const cells = this.edited<CurriculumCell>(answers.curriculum);
    // `dropped` is empty because nothing was dropped — these are the rows a
    // person typed. Nothing may claim otherwise on their behalf.
    if (cells) return { cells, totals: [], dropped: [] };
    return suggestCurriculum(
      answers.wings ?? [], answers.subjects ?? [],
      await this.capacityByWing(schoolId), await this.daysByWing(schoolId),
    );
  }

  private async attachLabSubjects(schoolId: number, answers: WizardAnswers & Record<string, any>) {
    const proposed = await this.roomsFor(schoolId, answers);
    const labs = proposed.filter((r: { subjects: string[] }) => r.subjects?.length > 0);
    if (labs.length === 0) return;

    const [rooms, subjects] = await Promise.all([
      this.prisma.room.findMany({ where: { schoolId } }),
      this.prisma.subject.findMany({ where: { schoolId } }),
    ]);
    const roomByName = new Map(rooms.map((r) => [r.name.toLowerCase(), r.id]));
    const subjectByName = new Map(subjects.map((s) => [s.name.toLowerCase(), s.id]));

    for (const lab of labs) {
      const roomId = roomByName.get(lab.name.toLowerCase());
      if (!roomId) continue;
      for (const name of lab.subjects) {
        const subjectId = subjectByName.get(name.toLowerCase());
        if (!subjectId) continue;
        await this.prisma.roomSubject.upsert({
          where: { roomId_subjectId: { roomId, subjectId } },
          create: { roomId, subjectId, schoolId },
          update: {},
        });
      }
    }
  }

  /**
   * What committing this step WOULD do, without doing it.
   *
   * Same pipeline, dry. Lets the screen say "3 new, 9 already exist" before
   * anybody presses anything — and, on a resumed draft, is what tells them
   * their classes are already there rather than silently creating none.
   */
  async preview(schoolId: number, userId: number, step: number) {
    const draft = await this.draftFor(schoolId, userId);
    if (!draft) return { ok: true, totals: { read: 0, create: 0, skip: 0, errors: 0 }, issues: [] };
    const answers = draft.answers as WizardAnswers & Record<string, any>;
    const built = await this.sheetsFor(schoolId, step, answers);
    if (built.sheets.length === 0) {
      return { ok: built.issues.length === 0, totals: { read: 0, create: 0, skip: 0, errors: 0 }, issues: built.issues };
    }
    const { plan } = await this.importer.dryRunSheets(schoolId, built.sheets);
    return {
      ok: plan.ok,
      totals: plan.totals,
      sheets: plan.sheets,
      issues: [...built.issues, ...plan.issues.map((i) => ({ message: i.message, fix: i.fix }))],
    };
  }

  /**
   * §15.3 Phase 25.4 — step 11: the settings, and the end of the wizard.
   *
   * These live on `timetable_config`, which §16 deliberately does not carry, so
   * they are written directly — the same fields `PUT /timetable-configs/:id`
   * already owns.
   *
   * "Inter-wing teaching off" is expressed as `teacher_class_eligibility`
   * limited to that wing's classes, because that is an existing, already
   * enforced mechanism (§18) rather than a new flag nothing reads. Step 7
   * already writes it for any teacher pinned to a wing; the setting decides
   * whether the wizard pinned them at all.
   */
  async finish(schoolId: number, userId: number) {
    const draft = await this.draftFor(schoolId, userId);
    if (!draft) throw new BadRequestException("There is nothing saved to finish.");
    const answers = draft.answers as WizardAnswers & Record<string, any>;
    const s = answers.settings ?? {};

    await this.prisma.timetableConfig.updateMany({
      where: { schoolId },
      data: {
        ...(s.classTeacherFirstPeriod !== undefined
          ? { classTeacherGetsFirstPeriod: Boolean(s.classTeacherFirstPeriod) } : {}),
        ...(s.allowConsecutive !== undefined
          ? { allowConsecutivePeriods: Boolean(s.allowConsecutive) } : {}),
        // §28.1 — clamped rather than refused: it is a reporting preference,
        // and a slip is far likelier than an attack.
        ...(typeof s.loadAlertPct === "number"
          ? { loadAlertPct: Math.max(50, Math.min(100, Math.round(s.loadAlertPct))) } : {}),
      },
    });
    // Inter-wing teaching is not a flag — it is the ABSENCE of the §18 scope
    // step 7 wrote. Turning it on clears those rows, and an empty scope means
    // "not stated", never "no classes" (invariant 7), so a teacher becomes
    // available to every wing. Turning it off leaves step 7's pinning alone;
    // it is not this screen's business to invent a scope nobody chose.
    if (s.interWingTeaching === true) {
      await this.prisma.teacherClassEligibility.deleteMany({ where: { schoolId } });
    }
    if (typeof s.minPeriodsPerDay === "number") {
      await this.prisma.teacher.updateMany({
        where: { schoolId },
        data: { minPeriodsPerDay: Math.max(0, Math.min(12, s.minPeriodsPerDay)) },
      });
    }

    // Completed, not deleted: "did this school come through the guided setup?"
    // is worth being able to answer, and a completed draft stops offering to
    // resume because `draftFor` only ever looks at `completedAt: null`.
    await this.prisma.onboardingSession.updateMany({
      where: { schoolId, userId, completedAt: null },
      data: { completedAt: new Date() },
    });
    this.logger.log(`Onboarding completed for school ${schoolId}`);
    return { ok: true };
  }

  /**
   * Throw the draft away.
   *
   * Deleted rather than marked completed: an abandoned draft is not a finished
   * one, and leaving it as history would make "do you want to resume?" a
   * question with a wrong answer.
   */
  async discard(schoolId: number, userId: number): Promise<{ ok: true }> {
    await this.prisma.onboardingSession.deleteMany({
      where: { schoolId, userId, completedAt: null },
    });
    return { ok: true };
  }
}
