/**
 * §29.1 — what a frozen timetable refuses, in one place.
 *
 * Publishing puts a week on the wall. Freezing says it is settled: while a
 * timetable is frozen, nothing may change what a class is taught, who teaches
 * it, or when. The reason is not tidiness — it is that the printed copy in
 * every classroom and staff room is now a second source of truth, and a change
 * made here without a change made there produces two answers to "when is Class
 * 5-A's Maths?" with nothing to say which is right.
 *
 * ## The shape, and why it is this shape
 *
 * This is `teacher-scope.util.ts` and `subject-scope.util.ts` again: ONE
 * definition of the rule and its message, called at every attachment point.
 * The alternative — a Prisma extension, as §17's school-scoping uses — was
 * considered and rejected: school scoping reads an ambient context and needs no
 * query, whereas "is this row's timetable frozen?" needs a lookup per write for
 * models that reach a config only through two joins (`class_subjects` through
 * classes and sections; `teacher_subject_class_section` through a section), and
 * the §14 budget is not the place to pay for that on every insert.
 *
 * The cost of the call-site shape is that a NEW write path can forget to ask.
 * `scripts/freeze-smoke.cjs` is what stops that being discovered by a school:
 * it drives every allocation-writing route against a frozen timetable and
 * requires each one to refuse.
 *
 * ## What is deliberately NOT frozen
 *
 * Anything that cannot contradict the published week: adding a teacher, a room
 * or a subject; creating next year's session; cloning this timetable into a new
 * one (the source is only read). A freeze that blocked hiring would be a freeze
 * people work around.
 *
 * **Availability (§4.7a/§4.7b) is also deliberately not frozen**, and it is the
 * one case worth arguing. "Mrs Rao now leaves at 1pm on Fridays" is a fact about
 * a person, not an allocation — and it is exactly the fact a school records
 * *before* re-staffing. Refusing it would leave them unable to write down the
 * thing that prompted the change. Accepted, it makes Readiness report a
 * published week that no longer satisfies a hard constraint, which is true, and
 * is the school being told there is something to fix.
 */
import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/** The frozen timetables among a set, named for the message. */
interface Frozen {
  id: number;
  name: string;
}

@Injectable()
export class FreezeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The refusal, worded once.
   *
   * Every call site passes only WHAT it was about to do, so the sentence reads
   * as one voice however it is reached — and so that the second half, which
   * will name staffing changes once §29.2 exists, is changed in one place
   * rather than in twenty strings.
   */
  private refuse(frozen: Frozen[], what: string): never {
    const names = frozen.map((f) => f.name).join(", ");
    throw new BadRequestException(
      `${names} ${frozen.length === 1 ? "is" : "are"} frozen, so ${what} cannot be changed. ` +
        `Unfreeze the timetable on the Timetables screen to make changes.`,
    );
  }

  /** Which of these timetables are frozen. Empty ids is empty, not "all". */
  private async frozenAmong(configIds: number[]): Promise<Frozen[]> {
    const ids = [...new Set(configIds.filter((n) => Number.isInteger(n)))];
    if (ids.length === 0) return [];
    return this.prisma.timetableConfig.findMany({
      where: { id: { in: ids }, frozenAt: { not: null } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
  }

  /** Refuse when any of these timetables is frozen. */
  async assertConfigs(configIds: number[], what: string): Promise<void> {
    const frozen = await this.frozenAmong(configIds);
    if (frozen.length > 0) this.refuse(frozen, what);
  }

  /**
   * Refuse when any of these class-sections belongs to a frozen timetable.
   *
   * The route for mappings, merged groups, elective blocks and class-teacher
   * assignment — all of which name sections rather than a timetable. A section
   * with no timetable yet (§16.1) is not frozen, and is simply absent from the
   * result rather than treated as a missing case.
   */
  async assertSections(classSectionIds: number[], what: string): Promise<void> {
    const ids = [...new Set(classSectionIds.filter((n) => Number.isInteger(n)))];
    if (ids.length === 0) return;
    const sections = await this.prisma.classSection.findMany({
      where: { id: { in: ids }, timetableConfigId: { not: null } },
      select: { timetableConfigId: true },
    });
    await this.assertConfigs(
      sections.map((s) => s.timetableConfigId as number),
      what,
    );
  }

  /**
   * Refuse when a class's sections sit in a frozen timetable.
   *
   * The route for the curriculum, which is keyed by CLASS (§3.11) and so may
   * reach several timetables at once — a school running Class 5 in two wings
   * has one curriculum row and two published weeks, and changing the row
   * changes both. The year narrows it, because a class has sections in every
   * session it has ever run and last year's frozen timetable must not refuse
   * this year's planning.
   */
  async assertClasses(classIds: number[], academicYearId: number | null, what: string): Promise<void> {
    const ids = [...new Set(classIds.filter((n) => Number.isInteger(n)))];
    if (ids.length === 0) return;
    const sections = await this.prisma.classSection.findMany({
      where: {
        classId: { in: ids },
        timetableConfigId: { not: null },
        ...(academicYearId !== null ? { academicYearId } : {}),
      },
      select: { timetableConfigId: true },
    });
    await this.assertConfigs(
      sections.map((s) => s.timetableConfigId as number),
      what,
    );
  }

  /**
   * Refuse when ANY timetable in the school is frozen.
   *
   * For the bulk writers — the §16 importer and the guided setup's commits —
   * which resolve names to rows deep inside one transaction and cannot say up
   * front which timetables they will touch. Deliberately blunt: a school that
   * has frozen one wing and is still building another unfreezes to import,
   * which is one click and is at least honest about what it is protecting. The
   * narrow version would have to re-derive the importer's own name resolution,
   * and a second copy of that is how the two would drift.
   */
  async assertNoneFrozen(what: string): Promise<void> {
    const frozen = await this.prisma.timetableConfig.findMany({
      where: { frozenAt: { not: null } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    if (frozen.length > 0) this.refuse(frozen, what);
  }
}
