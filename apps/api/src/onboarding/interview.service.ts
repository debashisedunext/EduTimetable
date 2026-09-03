/**
 * §24.6 Phase 25.5 — the third door: the same eleven questions, in conversation.
 *
 * The whole design is a refusal to build a second setup path. The interviewer
 * asks the questions the wizard's screens ask, fills in the **same**
 * `onboarding_sessions.answers`, and commits through the **same**
 * `POST /onboarding/commit/:step`. Switching between chat and wizard mid-setup
 * therefore loses nothing, and there is exactly one definition of what a school
 * is — which is what stops the two paths drifting into disagreement about, say,
 * whether a wing's week is per wing.
 *
 * What the model can and cannot do here:
 *
 *  - It is offered **one tool**, `recordSetupAnswers`, and none of the §13.1
 *    registry. It cannot read the school, cannot draft master data, cannot
 *    place a slot. It gains no authority the conversation did not already have.
 *  - That tool writes a **draft**, not master data. `answers` is the same JSON a
 *    person produces by typing, and it becomes rows only when somebody presses
 *    Next — at which point the §16 importer validates all of it again.
 *  - Everything it reports passes `sanitizeTurn` first, and whatever is refused
 *    is handed straight back to it as the tool result. A model that is told what
 *    it got wrong asks again; one that is silently ignored confirms things that
 *    never happened.
 *
 * The conversation covers steps 1-8 and stops. Steps 9-11 are a matrix, a table
 * and three toggles — things that are read at a glance and are painful to hear
 * read aloud one cell at a time — so the interview hands over to the wizard
 * there, with everything already saved.
 */
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { AiSettingsService } from "../ai/settings.service";
import type { LlmMessage, LlmTool } from "../ai/providers";
import { PrismaService } from "../prisma/prisma.service";
import { OnboardingService } from "./onboarding.service";
import { cleanOptions, mergeAnswers, sanitizeTurn, stepFrom } from "./interview.answers";

/** Where the conversation stops and the wizard takes over (§24.6). */
export const HANDOVER_STEP = 8;

const RECORD_TOOL: LlmTool = {
  name: "recordSetupAnswers",
  description:
    "Record what you have just learned about the school, and state the next question you will ask. " +
    "Call this on EVERY turn, even if you learned nothing (send an empty `learned`). " +
    "Only send fields the user actually stated — never invent a value to fill the shape.",
  input_schema: {
    type: "object",
    properties: {
      learned: {
        type: "object",
        description:
          "Only the fields you learned this turn. Known fields: " +
          "school {name}; session {name, startDate YYYY-MM-DD, endDate}; " +
          "wings [{name, fromClass, toClass, sections}] where fromClass/toClass are class NAMES " +
          "such as \"Class 1\" or \"Nursery\"; " +
          "weeks {\"<wing name>\": {workingDays [1-7], periodsPerDay, periodDurationMins, startTime \"HH:MM\", " +
          "hasZeroPeriod, breaks [{name, afterPeriod, durationMins}]}}; " +
          "subjects [{name, code, isLab, requiresDoublePeriod}]; " +
          "teachers [{name, employeeCode, subjects [names], wing, maxPeriodsPerDay, maxPeriodsPerWeek, " +
          "maxConsecutivePeriodsPerDay, canSubstitute, employmentType permanent|adhoc|guest}].",
        properties: {},
      },
      replace: {
        type: "array",
        items: { type: "string" },
        description:
          "Lists in `learned` that are now COMPLETE and supersede what was recorded before — " +
          "use this and only this to remove something. Adding is the default: a `teachers` list " +
          "is appended to the teachers already collected, and a repeated name updates that one. " +
          "So when the user drops a subject, resend the whole subject list with replace: [\"subjects\"].",
      },
      nextQuestion: {
        type: "string",
        description:
          "The single next question to put to the user, in plain English. Ask about ONE thing. " +
          "Empty when everything up to teachers has been collected.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description:
          "TWO to FOUR ready-made answers to `nextQuestion`, each a short phrase the user can tap " +
          "instead of typing — the ordinary answers a school would give, commonest first " +
          "(e.g. \"Monday to Friday\", \"Monday to Saturday\"; or \"8 periods\", \"7 periods\", " +
          "\"6 periods\"). Make each one a COMPLETE answer on its own, because tapping it sends it " +
          "as the reply. Leave this empty ONLY for a genuinely open question — a school's name, a " +
          "list of its teachers — where any option would be a guess at something only they know.",
      },
    },
    required: ["learned"],
  },
};

/**
 * The session an Indian school is most likely setting up, right now.
 *
 * The same April-March rule the wizard's own `defaultSession()` uses, so the
 * two doors propose the same thing rather than each having an opinion.
 */
function currentSession(now: Date): { name: string; startDate: string; endDate: string } {
  const startYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    name: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    startDate: `${startYear}-04-01`,
    endDate: `${startYear + 1}-03-31`,
  };
}

function systemPrompt(collected: Record<string, unknown>, step: number, now: Date): string {
  const session = currentSession(now);
  return [
    "You are setting up a school timetable by interviewing an administrator. Your job is to collect, in order, exactly what the guided setup wizard collects — nothing more.",
    "",
    "WHAT TO COLLECT, in this order:",
    "  1. The school's name.",
    `  2. The academic session — its name and its start and end dates. TODAY IS ${now.toISOString().slice(0, 10)}, and most Indian schools run April to March, so the session being set up is almost certainly "${session.name}" (${session.startDate} to ${session.endDate}). Offer that first. You have no other way to know the date, and a session guessed from memory is a whole year of timetable filed against the wrong one.`,
    "  3. The wings that are timetabled separately (most schools have one to three; one is normal), and for each: the range of classes it runs and how many sections each class has.",
    "  4. Each wing's week: working days, periods per day, when the day starts, how long a period is, and any breaks.",
    "  5. The subjects taught, marking which ones need a laboratory.",
    "  6. The teachers: name, which subjects they teach, and which wing. Employee codes and period limits only if offered.",
    "",
    "HOW TO ASK:",
    "- ONE question per turn. A form asks everything at once; a conversation must not.",
    "- Offer the ordinary answer as a default the user can accept: 'Most schools run Monday to Friday with 8 periods a day — is that right for the Primary wing?'",
    "- Accept several facts at once when the user gives them, and record all of them.",
    "- Never invent a value to complete the shape. If a number was not stated, do not record it; ask, or leave it out and let the setup use its own default.",
    "- Confirm a list back briefly after recording it, so a mistake is caught while it is cheap.",
    "- OFFER OPTIONS. With almost every question, send two to four ready-made answers in `options` — the ordinary answers, commonest first. Tapping one sends it as the reply, so each must stand alone as a complete answer. A person setting up a school on a phone between lessons should be able to get most of the way through by tapping.",
    "- Leave `options` empty only where any option would be a guess at something only they know: the school's name, the list of subjects they teach, their staff. Ask those openly.",
    "",
    "HARD RULES:",
    "- Call recordSetupAnswers on EVERY turn. Anything you do not record is lost.",
    "- If the tool reports that something was refused, tell the user plainly and ask again. Never repeat the same rejected value.",
    "- You are not creating anything. Nothing is written to the school until the administrator reviews it and presses Next; say so if asked.",
    "- Rooms, the curriculum and teacher assignments are worked out automatically after this conversation, from what you collect. Do not ask about them.",
    "",
    `PROGRESS: the setup is at step ${step} of 8. Already collected: ${describe(collected)}.`,
    step >= HANDOVER_STEP
      ? "Everything needed has been collected. Tell the user they are done and that the remaining steps — rooms, curriculum and teacher assignments — are proposed for them to review."
      : "Ask for the next missing thing.",
  ].join("\n");
}

/** A short, honest inventory — not the whole draft, which would dwarf the prompt. */
function describe(a: Record<string, unknown>): string {
  const bits: string[] = [];
  const school = a.school as { name?: string } | undefined;
  if (school?.name) bits.push(`school "${school.name}"`);
  const session = a.session as { name?: string } | undefined;
  if (session?.name) bits.push(`session "${session.name}"`);
  const wings = (a.wings as Array<{ name: string }> | undefined) ?? [];
  if (wings.length) bits.push(`wings ${wings.map((w) => w.name).join(", ")}`);
  const weeks = Object.keys((a.weeks as Record<string, unknown>) ?? {});
  if (weeks.length) bits.push(`weeks set for ${weeks.join(", ")}`);
  const subjects = (a.subjects as Array<{ name: string }> | undefined) ?? [];
  if (subjects.length) bits.push(`${subjects.length} subjects (${subjects.slice(0, 8).map((s) => s.name).join(", ")}${subjects.length > 8 ? "…" : ""})`);
  const teachers = (a.teachers as unknown[] | undefined) ?? [];
  if (teachers.length) bits.push(`${teachers.length} teachers`);
  return bits.length ? bits.join("; ") : "nothing yet";
}

export interface InterviewTurn {
  /** What the assistant said, for the transcript. */
  reply: string;
  /** The question it wants answered next; empty once the interview is done. */
  nextQuestion: string;
  /**
   * Ready-made answers to `nextQuestion`, for tapping instead of typing.
   *
   * Never the whole story: the screen always leaves a way to type something
   * else, because a list of options a school does not fit is a dead end — and
   * the questions where that happens (their name, their subjects) are exactly
   * the ones the model is told not to guess at.
   */
  options: string[];
  /** Everything collected so far — drives the live panel beside the chat. */
  answers: Record<string, unknown>;
  step: number;
  /** Whether the conversation has collected everything it asks for. */
  done: boolean;
  /** What the model reported that was refused, in the words the model was given. */
  rejected: string[];
}

@Injectable()
export class InterviewService {
  private readonly logger = new Logger(InterviewService.name);

  constructor(
    private readonly onboarding: OnboardingService,
    private readonly settings: AiSettingsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Replay the transcript from the audit log, never from the request.
   *
   * The client could perfectly well hold the conversation and send it back, and
   * it must not: a history supplied by the caller is a history the caller can
   * edit, and "the administrator already told you the school has 40 periods a
   * day" is exactly the kind of thing that would then be arguable. The log is
   * the record, so the log is the source.
   */
  private async history(conversationId: string, schoolId: number): Promise<LlmMessage[]> {
    const rows = await this.prisma.aiChatLog.findMany({
      where: { conversationId, schoolId, role: { in: ["user", "assistant"] } },
      orderBy: { id: "asc" },
      take: 60,
    });
    return rows
      .filter((r) => (r.content ?? "").trim().length > 0)
      .map((r) =>
        r.role === "user"
          ? ({ role: "user", text: r.content as string } as const)
          : ({ role: "assistant", text: r.content as string } as const),
      );
  }

  /**
   * Merge one model report into the draft.
   *
   * Separated from the conversation deliberately: this is the half that decides
   * what a school looks like, and it must be testable without an LLM in the
   * loop. A test that needed a provider key is a test nobody runs — the same
   * reasoning `/dev/ai-tool` rests on (§17.8).
   */
  async applyLearned(
    schoolId: number,
    userId: number,
    learned: unknown,
    replace: string[] = [],
  ): Promise<{ answers: Record<string, unknown>; step: number; rejected: string[] }> {
    const { answers: patch, rejected } = sanitizeTurn(learned);
    const draft = await this.onboarding.draftFor(schoolId, userId);
    const before = (draft?.answers as Record<string, unknown>) ?? {};

    // Accumulated HERE, then handed to `save` complete. The draft's own merge is
    // per top-level key, which is right for a wizard screen holding a whole list
    // and wrong for a conversation adding to one — see `mergeAnswers`.
    const merged = mergeAnswers(before, patch, replace);
    const saved = Object.keys(patch).length > 0
      ? await this.onboarding.save(schoolId, userId, { answers: merged, mode: "ai" })
      : { answers: before };

    const answers = saved.answers as Record<string, unknown>;
    const step = stepFrom(answers);
    if (Object.keys(patch).length > 0) {
      // The step is recorded so that switching to the wizard opens where the
      // conversation reached, rather than at question one.
      await this.onboarding.save(schoolId, userId, { currentStep: step, mode: "ai" });
    }
    return { answers, step, rejected };
  }

  /** One turn of the interview. */
  async turn(
    schoolId: number,
    userId: number,
    conversationId: string,
    message: string,
  ): Promise<InterviewTurn> {
    const provider = await this.settings.client(schoolId);
    if (!provider) {
      throw new BadRequestException(
        "No AI provider key is configured, so the conversational setup is unavailable. " +
          "An administrator can add one on the AI Settings screen — or use the step-by-step wizard, which needs no key.",
      );
    }
    await this.settings.assertWithinBudget(schoolId);

    const draft = await this.onboarding.draftFor(schoolId, userId);
    const collected = (draft?.answers as Record<string, unknown>) ?? {};

    const messages: LlmMessage[] = [
      ...(await this.history(conversationId, schoolId)),
      { role: "user", text: message },
    ];
    let reply = "";
    let nextQuestion = "";
    let options: string[] = [];
    let answers = collected;
    let step = stepFrom(collected);
    let rejected: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    await this.settings.log({ schoolId, userId, conversationId, role: "user", content: message });

    // Two rounds at most: one to report and ask, one to react to a refusal. A
    // longer loop is how a model that keeps re-sending a rejected value turns
    // one question into a paid infinite argument.
    for (let round = 0; round < 2; round++) {
      const turn = await provider.streamChat(
        { system: systemPrompt(answers, step, new Date()), messages, tools: [RECORD_TOOL], maxTokens: 2048 },
        (delta) => { reply += delta; },
      );
      inputTokens += turn.usage.inputTokens;
      outputTokens += turn.usage.outputTokens;
      messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls, providerRaw: turn.providerRaw });

      const calls = turn.toolCalls.filter((c) => c.name === RECORD_TOOL.name);
      if (calls.length === 0) break;

      const results = [];
      for (const call of calls) {
        const replace = Array.isArray(call.args?.replace)
          ? (call.args.replace as unknown[]).filter((k): k is string => typeof k === "string")
          : [];
        const applied = await this.applyLearned(schoolId, userId, call.args?.learned, replace);
        answers = applied.answers;
        step = applied.step;
        rejected = applied.rejected;
        const asked = typeof call.args?.nextQuestion === "string" ? call.args.nextQuestion.trim() : "";
        if (asked) {
          nextQuestion = asked;
          // Tied to the question they belong to: a turn that asks something new
          // must not leave the previous question's chips underneath it, which
          // is how somebody taps "Monday to Friday" at a question about
          // periods per day.
          options = cleanOptions(call.args?.options);
        }
        results.push({
          id: call.id,
          name: call.name,
          content: JSON.stringify({
            recorded: Object.keys(applied.answers),
            step: applied.step,
            ...(applied.rejected.length > 0 ? { refused: applied.rejected } : {}),
          }),
        });
      }
      messages.push({ role: "tool", results });
      // Nothing was refused, so there is nothing for a second round to fix.
      if (rejected.length === 0) break;
    }

    await this.settings.log({
      schoolId, userId, conversationId, role: "assistant",
      content: reply, toolsCalled: [{ name: RECORD_TOOL.name, args: {} }],
      inputTokens, outputTokens,
    });
    this.logger.log(`interview turn: step ${step}, ${rejected.length} refused, ${inputTokens} in / ${outputTokens} out`);

    return { reply, nextQuestion, options, answers, step, done: step >= HANDOVER_STEP, rejected };
  }
}
