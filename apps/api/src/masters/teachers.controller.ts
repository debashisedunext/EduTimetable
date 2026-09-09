import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Req } from "@nestjs/common";
import { PERMISSIONS } from "@edutimetable/shared";
import { RequirePermission } from "../auth/decorators";
import { PrismaService } from "../prisma/prisma.service";
import { ReadinessService } from "../readiness/readiness.service";
import { InstructionService } from "./instruction.service";
import { requireFields, toInt, uniq, type AuthedRequest } from "./crud.util";

const RULES = ["none", "always_first_period", "random"];
const PATTERNS = ["every_period", "alternate_period", "alternate_day"];
const ENGAGEMENTS = ["permanent", "adhoc", "guest"];

/**
 * §31 — `teachers.initials`, normalised on the way in.
 *
 * `VarChar(6)`, so it is truncated here rather than rejected by MySQL with a
 * message about a column nobody typed the name of. **Blank stores NULL**, not
 * an empty string: empty means "not stated" (invariant 7), and `initialsOf`
 * reads NULL as permission to derive one — an empty string would be a stored
 * answer of "nothing", which paints a blank cell in a 27-pixel grid and reads
 * as a free period.
 */
const initialsField = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim().slice(0, 6) : "";
  return s.length ? s : null;
};

@Controller("teachers")
@RequirePermission(PERMISSIONS.MASTERS_MANAGE)
export class TeachersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly readiness: ReadinessService,
    private readonly instructions: InstructionService,
  ) {}

  /** Teacher Directory (§8.1a): list-first with load vs. capacity. */
  @Get()
  async list(@Req() req: AuthedRequest) {
    const teachers = await this.prisma.teacher.findMany({
      where: { schoolId: req.user.schoolId },
      include: {
        mappings: { include: { subject: true } },
        // §27.13 — what this teacher is DECLARED to teach, which is not the
        // same question as what they have been given.
        teacherSubjects: { include: { subject: true } },
        classTeacherOf: { include: { class: true, section: true } },
        unavailability: true,
        eligibility: { include: { class: true }, orderBy: { class: { sequence: "asc" } } },
      },
      orderBy: { name: "asc" },
    });
    return teachers.map((t) => ({
      id: t.id,
      employeeCode: t.employeeCode,
      name: t.name,
      /**
       * §31 — how this person is named where there is no room for a name.
       *
       * The Master Grid gives a cell 27 pixels, so a school that writes
       * "S.-PE" on its own wall chart has to be able to say so. It always
       * could through the §16 importer and the guided setup; this screen is
       * the third door, and until §31 it was the one that could not.
       */
      initials: t.initials,
      maxPeriodsPerDay: t.maxPeriodsPerDay,
      minPeriodsPerDay: t.minPeriodsPerDay,
      maxPeriodsPerWeek: t.maxPeriodsPerWeek,
      classTeacherPeriodRule: t.classTeacherPeriodRule,
      // §26.5 — what the school said about this teacher, and what became of it.
      specialInstruction: t.specialInstruction,
      instructionStatus: t.instructionStatus,
      instructionNote: t.instructionNote,
      periodPattern: t.periodPattern,
      alternateDaySet: t.alternateDaySet,
      employmentType: t.employmentType,
      // §18: the classes this teacher may be given, and the names to show.
      classIds: t.eligibility.map((e) => e.classId),
      classNames: t.eligibility.map((e) => e.class.name),
      isActive: t.isActive,
      /**
       * §27.13 — DECLARED, so the screen can edit it and so a teacher who has
       * been given nothing yet still says what they teach.
       */
      subjectIds: t.teacherSubjects.map((x) => x.subjectId),
      /**
       * §27.13 — the UNION of declared and mapped, which is the documented
       * reading rule and was not being followed here.
       *
       * Mapped-only was invisible in the obvious case and wrong in the one that
       * matters: a school that has just entered its staff has no mappings yet,
       * so every teacher's Subjects column read "—" however carefully it had
       * been filled in. Declared-only would be worse — every school predating
       * `teacher_subjects` has no declarations and would lose the column
       * entirely. Both, de-duplicated by name.
       */
      subjects: [...new Set([
        ...t.teacherSubjects.map((x) => x.subject.name),
        ...t.mappings.map((m) => m.subject.name),
      ])].sort(),
      sectionsMapped: new Set(t.mappings.map((m) => m.classSectionId)).size,
      weeklyLoad: t.mappings.reduce((s, m) => s + m.periodsPerWeek, 0),
      classTeacherOf: t.classTeacherOf.map((cs) => `${cs.class.name}-${cs.section.name}`),
      unavailability: t.unavailability,
    }));
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: any) {
    requireFields(body, ["name", "employeeCode"]);
    this.validateRules(body);
    const created = await uniq(
      () =>
        this.prisma.teacher.create({
          data: {
            schoolId: req.user.schoolId,
            name: String(body.name),
            employeeCode: String(body.employeeCode),
            // §31 — empty means "not stated", which is what makes `initialsOf`
            // fall back to deriving one rather than printing a blank cell.
            initials: initialsField(body.initials),
            maxPeriodsPerDay: body.maxPeriodsPerDay != null ? toInt(body.maxPeriodsPerDay, "maxPeriodsPerDay") : 6,
            minPeriodsPerDay: body.minPeriodsPerDay != null ? toInt(body.minPeriodsPerDay, "minPeriodsPerDay") : 3,
            maxPeriodsPerWeek: body.maxPeriodsPerWeek != null ? toInt(body.maxPeriodsPerWeek, "maxPeriodsPerWeek") : 30,
            classTeacherPeriodRule: body.classTeacherPeriodRule ?? "none",
            periodPattern: body.periodPattern ?? "every_period",
            alternateDaySet: body.alternateDaySet ?? undefined,
            employmentType: body.employmentType ?? "permanent",
            eligibility: {
              create: this.scopeIds(body).map((classId) => ({ classId, schoolId: req.user.schoolId })),
            },
          },
        }),
      `Teacher '${body.employeeCode}'`,
    );
    await this.setSubjects(req.user.schoolId, created.id, body.subjectIds);
    await this.readiness.invalidate(req.user.schoolId);
    return created;
  }

  @Put(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    this.validateRules(body);
    const updated = await uniq(
      () =>
        this.prisma.teacher.update({
          where: { id: toInt(id, "id") },
          data: {
            ...(body.name !== undefined ? { name: String(body.name) } : {}),
            ...(body.employeeCode !== undefined ? { employeeCode: String(body.employeeCode) } : {}),
            ...(body.initials !== undefined ? { initials: initialsField(body.initials) } : {}),
            ...(body.maxPeriodsPerDay !== undefined ? { maxPeriodsPerDay: toInt(body.maxPeriodsPerDay, "maxPeriodsPerDay") } : {}),
            ...(body.minPeriodsPerDay !== undefined ? { minPeriodsPerDay: toInt(body.minPeriodsPerDay, "minPeriodsPerDay") } : {}),
            ...(body.maxPeriodsPerWeek !== undefined ? { maxPeriodsPerWeek: toInt(body.maxPeriodsPerWeek, "maxPeriodsPerWeek") } : {}),
            ...(body.classTeacherPeriodRule !== undefined ? { classTeacherPeriodRule: body.classTeacherPeriodRule } : {}),
            ...(body.periodPattern !== undefined ? { periodPattern: body.periodPattern } : {}),
            ...(body.alternateDaySet !== undefined ? { alternateDaySet: body.alternateDaySet } : {}),
            ...(body.employmentType !== undefined ? { employmentType: body.employmentType } : {}),
            ...(body.isActive !== undefined ? { isActive: Boolean(body.isActive) } : {}),
          },
        }),
      "Teacher",
    );

    // Scope is replaced wholesale when the field is sent, and left untouched
    // when it is not — so a PUT that only changes a name cannot silently wipe
    // what a teacher is allowed to take.
    if (Array.isArray(body.classIds)) {
      const teacherId = toInt(id, "id");
      const ids = this.scopeIds(body);
      await this.prisma.$transaction([
        this.prisma.teacherClassEligibility.deleteMany({ where: { teacherId } }),
        this.prisma.teacherClassEligibility.createMany({
          data: ids.map((classId) => ({ teacherId, classId, schoolId: req.user.schoolId })),
        }),
      ]);
    }
    await this.setSubjects(req.user.schoolId, toInt(id, "id"), body.subjectIds);
    await this.readiness.invalidate(req.user.schoolId);
    return updated;
  }

  /**
   * §27.13 — replace what this teacher is DECLARED to teach.
   *
   * There was no way to set this from the API at all: `teacher_subjects` could
   * only be written by the §16 importer's Subjects column or the guided setup,
   * so a school that entered its staff on the Teachers screen and then looked
   * at the Subjects column saw "—" and had nowhere to fix it. The table existed,
   * the screen did not.
   *
   * Same contract as the eligibility above and §19.1's rooms: sent means
   * replace, absent means not mentioned. A PUT that changes a max-periods field
   * must not clear what somebody teaches.
   */
  private async setSubjects(schoolId: number, teacherId: number, subjectIds: unknown) {
    if (!Array.isArray(subjectIds)) return;
    const ids = [...new Set(subjectIds.map((s) => toInt(s, "subjectIds[]")))];
    if (ids.length > 0) {
      // Scoped: `createMany` would otherwise stamp this school's id onto a link
      // to another school's subject (§17, invariant 18).
      const mine = await this.prisma.subject.findMany({ where: { id: { in: ids } }, select: { id: true } });
      const known = new Set(mine.map((s) => s.id));
      const stranger = ids.find((x) => !known.has(x));
      if (stranger !== undefined) throw new BadRequestException(`No subject with id ${stranger}`);
    }
    await this.prisma.$transaction([
      this.prisma.teacherSubject.deleteMany({ where: { teacherId } }),
      ...(ids.length > 0
        ? [this.prisma.teacherSubject.createMany({
            data: ids.map((subjectId) => ({ teacherId, subjectId, schoolId })),
          })]
        : []),
    ]);
  }

  /** Replace a teacher's weekly-off / unavailability rows. */
  @Put(":id/unavailability")
  async setUnavailability(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const teacherId = toInt(id, "id");
    // A write carrying rows is already refused for another school's teacher —
    // the reference check on `createMany` catches it (§17, invariant 13). An
    // *empty* rows array writes nothing, so nothing is checked, and this used
    // to answer `{ok: true}` for a teacher belonging to someone else. Ask
    // first, so the answer is the same either way: not found (§17.8).
    const teacher = await this.prisma.teacher.findFirst({
      where: { id: teacherId },
      select: { id: true },
    });
    if (!teacher) throw new NotFoundException(`Teacher ${teacherId} not found`);

    const rows: any[] = Array.isArray(body.rows) ? body.rows : [];
    await this.prisma.$transaction([
      this.prisma.teacherUnavailability.deleteMany({ where: { teacherId } }),
      this.prisma.teacherUnavailability.createMany({
        data: rows.map((r) => ({
          schoolId: req.user.schoolId,
          teacherId,
          dayOfWeek: toInt(r.dayOfWeek, "dayOfWeek"),
          periodNumber: r.periodNumber != null ? toInt(r.periodNumber, "periodNumber") : null,
          reason: r.reason ? String(r.reason) : null,
        })),
      }),
    ]);
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true, count: rows.length };
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    await uniq(() => this.prisma.teacher.delete({ where: { id: toInt(id, "id") } }), "Teacher");
    await this.readiness.invalidate(req.user.schoolId);
    return { ok: true };
  }

  /**
   * The classes this teacher may take (§18). Absent means "not stated" and is
   * left alone; an explicit empty list clears the scope.
   */
  private scopeIds(body: any): number[] {
    if (!Array.isArray(body.classIds)) return [];
    return [...new Set(body.classIds.map((x: unknown) => toInt(x, "classIds[]")))] as number[];
  }

  private validateRules(body: any) {
    // §20: the floor cannot sit above the ceiling. Caught here rather than left
    // to the solver, where it would surface as an unexplainable dead end.
    if (body.minPeriodsPerDay !== undefined) {
      const min = toInt(body.minPeriodsPerDay, "minPeriodsPerDay");
      if (min < 0) throw new BadRequestException("minPeriodsPerDay cannot be negative");
      const max = body.maxPeriodsPerDay !== undefined ? toInt(body.maxPeriodsPerDay, "maxPeriodsPerDay") : null;
      if (max !== null && min > max) {
        throw new BadRequestException(
          `minPeriodsPerDay (${min}) cannot exceed maxPeriodsPerDay (${max}) — a day cannot need more periods than it can hold.`,
        );
      }
    }
    if (body.employmentType !== undefined && !ENGAGEMENTS.includes(body.employmentType)) {
      throw new BadRequestException(`employmentType must be one of ${ENGAGEMENTS.join(", ")}`);
    }
    if (body.classTeacherPeriodRule !== undefined && !RULES.includes(body.classTeacherPeriodRule)) {
      throw new BadRequestException(`classTeacherPeriodRule must be one of ${RULES.join(", ")}`);
    }
    if (body.periodPattern !== undefined && !PATTERNS.includes(body.periodPattern)) {
      throw new BadRequestException(`periodPattern must be one of ${PATTERNS.join(", ")}`);
    }
    if (body.alternateDaySet !== undefined && body.alternateDaySet !== null) {
      if (
        !Array.isArray(body.alternateDaySet) ||
        body.alternateDaySet.some((d: unknown) => !Number.isInteger(d) || (d as number) < 1 || (d as number) > 7)
      ) {
        throw new BadRequestException("alternateDaySet must be an array of day numbers 1-7");
      }
    }
  }

  /**
   * §26.5 — evaluate a teacher's plain-English instruction, and apply it.
   *
   * A single endpoint rather than a separate "check" and "apply", because there
   * is nothing to decide in between: an accepted instruction that had not
   * written its rows would be a green tick over nothing, which is precisely the
   * failure the whole design is arranged to avoid. The refusal path writes
   * nothing but keeps the text.
   *
   * `masters.manage`, inherited from the controller — the authority to set a
   * teacher's availability is the one this borrows, not a new AI permission.
   */
  @Put(":id/instruction")
  async instruction(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: any) {
    const teacherId = toInt(id, "id");
    // Ownership first, so a stranger is told "no such teacher" rather than
    // anything about this school's AI configuration (§17).
    const own = await this.prisma.teacher.findFirst({ where: { id: teacherId }, select: { id: true } });
    if (!own) throw new NotFoundException("Teacher not found");

    const result = await this.instructions.evaluate(
      req.user.schoolId, req.user.sub ?? null, teacherId, String(body?.text ?? ""),
    );
    // An accepted instruction changes availability and load, both of which
    // Readiness reports on.
    await this.readiness.invalidate(req.user.schoolId);
    return result;
  }

  /** Whether this school can evaluate instructions at all — decides if the box is shown. */
  @Get("instruction/available")
  async instructionAvailable(@Req() req: AuthedRequest) {
    return { available: await this.instructions.available(req.user.schoolId) };
  }
}
