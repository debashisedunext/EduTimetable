/**
 * §26.5 — turning a teacher's plain-English instruction into rules the solver
 * already enforces.
 *
 * The shape is §24.6's exactly: one forced tool over the neutral `LlmProvider`
 * contract, whose output crosses a pure trust boundary (`instruction.compile`)
 * before anything is written. What differs is what happens after — the
 * interview writes a *draft* a person later commits, and this writes real
 * constraint rows. So the guarantee has to come from somewhere else, and it
 * comes from the vocabulary: **there is no term in it that places a lesson.**
 *
 * Three properties worth stating, because they are what makes the green tick
 * honest rather than decorative:
 *
 *  - **The compiled rows are the authority.** Delete the school's API key
 *    tomorrow and its timetables do not change: the instruction became
 *    `teacher_unavailability` rows and column values, which the engine has read
 *    since long before any of this existed.
 *  - **Nothing is applied that was not fully understood.** A partially
 *    compiled instruction is refused whole (see `compile`), because a tick over
 *    half a sentence tells the school the other half is being honoured.
 *  - **Re-evaluated when the text changes, never re-run silently.** A stored
 *    verdict belongs to the words it was given. Re-running it later against a
 *    different model would change a school's timetable with nobody asking.
 */
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { LlmTool } from "../ai/providers";
import { AiSettingsService } from "../ai/settings.service";
import { PrismaService } from "../prisma/prisma.service";
import { compile, type CompiledConstraint, type Context } from "./instruction.compile";

/**
 * The one tool the model is offered. Its schema IS the vocabulary — there is no
 * "other" branch and no free-text passthrough, so a rule the timetable cannot
 * express has nowhere to go but `understood: false`.
 */
const RECORD_TOOL: LlmTool = {
  name: "recordTeacherConstraint",
  description:
    "Record the school's instruction about one teacher as scheduling rules. " +
    "Use ONLY the rule kinds listed. If the instruction cannot be expressed with them — " +
    "if it is about who somebody gets on with, how well they teach, or anything the timetable " +
    "does not decide — set understood to false and say why in `note`. Guessing is worse than refusing.",
  input_schema: {
    type: "object",
    properties: {
      understood: {
        type: "boolean",
        description: "False if this cannot be expressed as scheduling rules. Then send no constraints.",
      },
      note: {
        type: "string",
        description: "One short sentence: what you understood, or why you could not.",
      },
      constraints: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: [
                "unavailable", "maxPerDay", "maxPerWeek", "minPerDay",
                "maxConsecutive", "firstPeriodRule", "pattern", "onlyClasses", "noSubstitutions",
              ],
            },
            days: {
              type: "array",
              items: { type: "integer" },
              description: "ISO day numbers, 1=Monday..7=Sunday. For `unavailable` and `pattern: alternate_day`.",
            },
            periods: {
              type: "array",
              items: { type: "integer" },
              description: "Period numbers within the day. OMIT for a whole day off — do not guess a range.",
            },
            value: { type: "string", description: "The number or the enum value, for the kinds that take one." },
            classNames: { type: "array", items: { type: "string" }, description: "For `onlyClasses`. Exact class names." },
            reason: { type: "string", description: "For `unavailable`: a few words shown on the availability screen." },
          },
          required: ["kind"],
        },
      },
    },
    required: ["understood"],
  },
};

function systemPrompt(ctx: Context, teacherName: string): string {
  const dayNames = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  return [
    `You are translating a school's instruction about a teacher, ${teacherName}, into scheduling rules.`,
    "",
    "THE SCHOOL:",
    `  It teaches on ${ctx.workingDays.map((d) => dayNames[d]).join(", ")}, ${ctx.periodsPerDay} periods a day.`,
    `  Its classes are: ${ctx.classNames.join(", ") || "(none yet)"}.`,
    "",
    "HOW TO TRANSLATE:",
    "- A time of day is a PERIOD NUMBER. 'Leaves at 1pm' on an 8-period day starting at 8am is roughly the last two periods — if you cannot tell which periods a clock time means, say so rather than guessing, because a wrong guess silently frees a teacher who is actually there.",
    "- 'Only mornings', 'only after lunch': express as `unavailable` for the periods they are NOT there.",
    "- A whole day off is `unavailable` with days and NO periods. Do not list every period.",
    "- 'Not more than N in a row' is `maxConsecutive`. 'Not more than N a day' is `maxPerDay`. They are different rules.",
    "",
    "REFUSE, by setting understood to false, anything that is not about WHEN or WHICH CLASSES:",
    "- preferences about people, quality, pairing, mood, or which colleagues they work with;",
    "- requests to put a specific subject in a specific slot — the solver decides that, and it is not a property of the teacher;",
    "- anything you would have to invent a fact to apply.",
    "",
    "Call recordTeacherConstraint exactly once. Never answer in prose alone.",
  ].join("\n");
}

@Injectable()
export class InstructionService {
  private readonly logger = new Logger(InstructionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AiSettingsService,
  ) {}

  /** Whether the school can evaluate instructions at all — decides if the UI shows the box. */
  async available(schoolId: number): Promise<boolean> {
    return (await this.settings.client(schoolId)) !== null;
  }

  /**
   * Evaluate a teacher's instruction and, if it compiles, apply it.
   *
   * Applying is not a second decision: an accepted instruction that did not
   * write its rows would be a tick over nothing, which is the failure this
   * whole design is arranged to avoid.
   */
  async evaluate(schoolId: number, userId: number | null, teacherId: number, text: string) {
    const teacher = await this.prisma.teacher.findFirst({ where: { id: teacherId } });
    if (!teacher) throw new NotFoundException("Teacher not found");

    const trimmed = String(text ?? "").trim().slice(0, 600);
    if (trimmed === "") return this.clear(teacherId);

    const provider = await this.settings.client(schoolId);
    if (!provider) {
      // Stored as pending rather than refused: the instruction is not wrong,
      // the school simply has no assistant configured. Marking it denied would
      // blame the text for the deployment.
      return this.save(teacherId, trimmed, "pending", [], "No AI provider is configured, so this has not been checked yet.");
    }
    await this.settings.assertWithinBudget(schoolId);

    const ctx = await this.contextFor(schoolId);
    let reported: Record<string, unknown> = {};
    let usage = { inputTokens: 0, outputTokens: 0 };
    try {
      const turn = await provider.streamChat(
        {
          system: systemPrompt(ctx, teacher.name),
          messages: [{ role: "user", text: trimmed }],
          tools: [RECORD_TOOL],
          maxTokens: 1024,
        },
        () => undefined,
      );
      usage = turn.usage;
      const call = turn.toolCalls.find((c) => c.name === RECORD_TOOL.name);
      // A model that answered in prose has not translated anything. Treated as
      // a refusal rather than retried: one instruction is not worth a loop.
      reported = call ? (call.args as Record<string, unknown>) : { understood: false, note: turn.text.slice(0, 200) };
    } catch (e) {
      this.logger.warn(`instruction for teacher ${teacherId} could not be evaluated: ${(e as Error).message}`);
      return this.save(teacherId, trimmed, "pending", [], "The assistant could not be reached. Try again, or leave it — nothing has been applied.");
    }

    // `userId` is required by the audit log and is null only on paths with no
    // signed-in person; 0 is this deployment's "not attributed", the same value
    // an unattended run uses.
    await this.settings.log({
      schoolId, userId: userId ?? 0, conversationId: `instruction-${teacherId}`,
      role: "assistant", content: JSON.stringify(reported).slice(0, 2000),
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    }).catch(() => undefined);

    const result = compile(reported, ctx);
    if (result.status === "denied") {
      // The text is KEPT. It is what somebody typed, and discarding it to teach
      // them about phrasing is not our call.
      return this.save(teacherId, trimmed, "denied", [], result.note);
    }

    await this.apply(schoolId, teacherId, result.constraints);
    return this.save(teacherId, trimmed, "accepted", result.constraints, result.note);
  }

  /** What the school looks like, for resolving names and bounding numbers. */
  private async contextFor(schoolId: number): Promise<Context> {
    const [config, classes] = await Promise.all([
      this.prisma.timetableConfig.findFirst({ where: { schoolId }, orderBy: { id: "asc" } }),
      this.prisma.schoolClass.findMany({ where: { schoolId }, orderBy: { sequence: "asc" }, select: { name: true } }),
    ]);
    return {
      workingDays: (config?.workingDays as number[]) ?? [1, 2, 3, 4, 5],
      periodsPerDay: config?.periodsPerDay ?? 8,
      classNames: classes.map((c) => c.name),
      maxPeriodsPerWeek: 40,
    };
  }

  /**
   * Write the constraints as ordinary rows — the same rows the screens write.
   *
   * Unavailability is REPLACED rather than added to, and only the rows this
   * instruction owns: an edited instruction that left its previous blocks
   * behind would accumulate a teacher into unavailability nobody asked for, one
   * edit at a time. They are identified by the reason prefix, so a block the
   * admin set by hand on the §4.7a screen is never touched.
   */
  private async apply(schoolId: number, teacherId: number, constraints: CompiledConstraint[]) {
    const data: Record<string, unknown> = {};
    const unavailable = constraints.filter((c): c is Extract<CompiledConstraint, { kind: "unavailable" }> => c.kind === "unavailable");

    for (const c of constraints) {
      switch (c.kind) {
        case "maxPerDay": data.maxPeriodsPerDay = c.value; break;
        case "maxPerWeek": data.maxPeriodsPerWeek = c.value; break;
        case "minPerDay": data.minPeriodsPerDay = c.value; break;
        case "maxConsecutive": data.maxConsecutivePeriodsPerDay = c.value; break;
        case "firstPeriodRule": data.classTeacherPeriodRule = c.value; break;
        case "pattern":
          data.periodPattern = c.value;
          data.alternateDaySet = c.days ?? null;
          break;
        case "noSubstitutions": data.canSubstitute = false; break;
        default: break;
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.teacherUnavailability.deleteMany({
        where: { teacherId, reason: { startsWith: OWNED } },
      });
      for (const u of unavailable) {
        for (const day of u.days) {
          if (u.periods === null) {
            // §4.7a: a whole day is ONE row with a null period, so it survives
            // the timetable later gaining a period.
            await tx.teacherUnavailability.create({
              data: { schoolId, teacherId, dayOfWeek: day, periodNumber: null, reason: `${OWNED}${u.reason}`.slice(0, 100) },
            });
          } else {
            for (const p of u.periods) {
              await tx.teacherUnavailability.create({
                data: { schoolId, teacherId, dayOfWeek: day, periodNumber: p, reason: `${OWNED}${u.reason}`.slice(0, 100) },
              });
            }
          }
        }
      }
      const only = constraints.find((c): c is Extract<CompiledConstraint, { kind: "onlyClasses" }> => c.kind === "onlyClasses");
      if (only) {
        const classes = await tx.schoolClass.findMany({ where: { name: { in: only.classNames } }, select: { id: true } });
        await tx.teacherClassEligibility.deleteMany({ where: { teacherId } });
        for (const c of classes) {
          await tx.teacherClassEligibility.create({ data: { schoolId, teacherId, classId: c.id } });
        }
      }
      if (Object.keys(data).length > 0) {
        await tx.teacher.update({ where: { id: teacherId }, data: data as never });
      }
    });
  }

  private async save(
    teacherId: number,
    text: string,
    status: "pending" | "accepted" | "denied",
    constraints: CompiledConstraint[],
    note: string,
  ) {
    const row = await this.prisma.teacher.update({
      where: { id: teacherId },
      data: {
        specialInstruction: text,
        instructionStatus: status,
        instructionCompiled: constraints.length > 0 ? (constraints as never) : undefined,
        instructionNote: note.slice(0, 400),
        instructionAt: new Date(),
      },
      select: {
        id: true, specialInstruction: true, instructionStatus: true,
        instructionCompiled: true, instructionNote: true, instructionAt: true,
      },
    });
    return row;
  }

  /** Clearing the text clears the verdict — and the rows it wrote. */
  private async clear(teacherId: number) {
    await this.prisma.teacherUnavailability.deleteMany({
      where: { teacherId, reason: { startsWith: OWNED } },
    });
    return this.prisma.teacher.update({
      where: { id: teacherId },
      data: {
        specialInstruction: null, instructionStatus: null,
        instructionCompiled: undefined, instructionNote: null, instructionAt: null,
      },
      select: {
        id: true, specialInstruction: true, instructionStatus: true,
        instructionCompiled: true, instructionNote: true, instructionAt: true,
      },
    });
  }
}

/**
 * The marker on unavailability rows this feature owns.
 *
 * Without it, re-evaluating an edited instruction would either leave the old
 * blocks behind — accumulating a teacher into unavailability nobody asked for,
 * one edit at a time — or delete rows an admin set by hand on the §4.7a screen.
 * Neither is acceptable, and the prefix is the cheapest thing that separates
 * them. It is visible on that screen, which is the point: a block should say
 * where it came from.
 */
const OWNED = "AI: ";
