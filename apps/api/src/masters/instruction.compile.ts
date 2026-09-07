/**
 * §26.5 — the trust boundary between a language model and a teacher's rules.
 *
 * A school types "Mrs Rao leaves at 1pm on Fridays" and the app has to either
 * enforce it or say honestly that it cannot. The whole design is one sentence:
 *
 *   **The model translates. It never schedules.**
 *
 * Invariant 14 — the LLM never places a slot — is not bent here and is not
 * merely respected by convention: the model's entire vocabulary is the closed
 * set below, every member of which is a constraint the solver ALREADY enforces
 * and has enforced since long before any AI was involved. There is no way to
 * express "put her in period 3 on Tuesday" because no such term exists.
 *
 * That is what makes the green tick mean something. It does not mean *the AI
 * understood*; it means **this compiled to constraint X, and constraint X is
 * enforced by the solver whether the AI is switched on or not**. Turn the
 * school's API key off tomorrow and the timetable does not change, because by
 * then the instruction is ordinary rows.
 *
 * Anything outside the vocabulary is **denied, by name**, with the reason shown
 * on the row. "I cannot express 'put her with the nicer classes' as a
 * scheduling rule" is a better answer than a confident tick over nothing.
 *
 * This module is pure: no database, no network, no clock. Everything it needs
 * about the school arrives as `Context`, so the rules can be tested — and are —
 * without an LLM in the loop.
 */

/** What the school looks like, for resolving names and bounding numbers. */
export interface Context {
  /** ISO day numbers this timetable actually runs, 1=Mon..7=Sun. */
  workingDays: number[];
  /** Teaching periods per day. */
  periodsPerDay: number;
  /** Class names, for `onlyClasses`. Matched case-insensitively. */
  classNames: string[];
  /** The teacher's current weekly ceiling, so a new one can be sanity-checked. */
  maxPeriodsPerWeek: number;
}

/**
 * The closed vocabulary. Every member maps to a field or table the engine
 * already reads — see the §26.5 table in the architecture doc.
 */
export type CompiledConstraint =
  | { kind: "unavailable"; days: number[]; periods: number[] | null; reason: string }
  | { kind: "maxPerDay"; value: number }
  | { kind: "maxPerWeek"; value: number }
  | { kind: "minPerDay"; value: number }
  | { kind: "maxConsecutive"; value: number }
  | { kind: "firstPeriodRule"; value: "always_first_period" | "none" | "random" }
  | { kind: "pattern"; value: "every_period" | "alternate_period" | "alternate_day"; days: number[] | null }
  | { kind: "onlyClasses"; classNames: string[] }
  | { kind: "noSubstitutions" };

export interface CompileResult {
  status: "accepted" | "denied";
  constraints: CompiledConstraint[];
  /**
   * The plain-English read-back, or the refusal. Shown on the row either way,
   * so a tick can be checked rather than believed.
   */
  note: string;
}

const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const int = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r < lo || r > hi ? null : r;
};

/** Day numbers, keeping only days this timetable actually runs. */
function days(v: unknown, ctx: Context): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = new Set<number>();
  for (const d of v) {
    const n = int(d, 1, 7);
    // A rule about Sunday in a Monday-to-Friday school is not a rule, it is a
    // misunderstanding — and enforcing it would be a constraint that never
    // binds, which reads on the screen as a rule being honoured.
    if (n !== null && ctx.workingDays.includes(n)) out.add(n);
  }
  return out.size === 0 ? null : [...out].sort((a, b) => a - b);
}

/**
 * The periods a rule names, or `"whole-day"`, or `"invalid"`.
 *
 * Three outcomes rather than two, and the third is why: an earlier draft
 * returned `null` both for "no periods given" and for "every period given was
 * out of range", and `null` means the whole day. So an instruction naming
 * period 99 became "not available at all on Monday" — silently a far stronger
 * rule than anybody asked for, ticked green. Its own unit test caught it.
 */
function periods(v: unknown, ctx: Context): number[] | "whole-day" | "invalid" {
  if (v === null || v === undefined) return "whole-day";
  if (!Array.isArray(v)) return "invalid";
  if (v.length === 0) return "whole-day";
  const out = new Set<number>();
  for (const p of v) {
    const n = int(p, 1, ctx.periodsPerDay);
    if (n === null) return "invalid";
    out.add(n);
  }
  return out.size === 0 ? "invalid" : [...out].sort((a, b) => a - b);
}

/**
 * Check and narrow one constraint the model proposed.
 *
 * Returns the constraint, or a string saying why it was refused. Refusals are
 * sentences rather than codes because they are shown to the person who typed
 * the instruction, who is not a programmer and did nothing wrong.
 */
function one(raw: unknown, ctx: Context): CompiledConstraint | string {
  if (!raw || typeof raw !== "object") return "an entry that was not a rule at all";
  const c = raw as Record<string, unknown>;
  const kind = String(c.kind ?? "");

  switch (kind) {
    case "unavailable": {
      const d = days(c.days, ctx);
      if (!d) {
        return `a day this school does not teach on (it runs ${ctx.workingDays.map((n) => DAY_NAMES[n]).join(", ")})`;
      }
      const p = periods(c.periods, ctx);
      if (p === "invalid") return `a period outside the school day (it has ${ctx.periodsPerDay})`;
      // "whole-day" is meaningful, not a fallback: §4.7a stores a blocked day
      // as ONE row with a null period, which is what keeps it correct when the
      // day later gains a period.
      const reason = typeof c.reason === "string" && c.reason.trim() !== ""
        ? c.reason.trim().slice(0, 100)
        : "Special instruction";
      return { kind: "unavailable", days: d, periods: p === "whole-day" ? null : p, reason };
    }
    case "maxPerDay": {
      const n = int(c.value, 1, ctx.periodsPerDay);
      return n === null ? `a daily maximum outside 1–${ctx.periodsPerDay}` : { kind: "maxPerDay", value: n };
    }
    case "maxPerWeek": {
      const n = int(c.value, 1, ctx.periodsPerDay * ctx.workingDays.length);
      return n === null ? "a weekly maximum the week cannot hold" : { kind: "maxPerWeek", value: n };
    }
    case "minPerDay": {
      // §20: 0 or 1 both mean "no floor"; the rule is "zero or at least N".
      const n = int(c.value, 0, ctx.periodsPerDay);
      return n === null ? `a daily minimum outside 0–${ctx.periodsPerDay}` : { kind: "minPerDay", value: n };
    }
    case "maxConsecutive": {
      const n = int(c.value, 1, ctx.periodsPerDay);
      return n === null ? `a back-to-back limit outside 1–${ctx.periodsPerDay}` : { kind: "maxConsecutive", value: n };
    }
    case "firstPeriodRule": {
      const v = String(c.value ?? "");
      return v === "always_first_period" || v === "none" || v === "random"
        ? { kind: "firstPeriodRule", value: v }
        : "a first-period rule that is not one of the three the app has";
    }
    case "pattern": {
      const v = String(c.value ?? "");
      if (v !== "every_period" && v !== "alternate_period" && v !== "alternate_day") {
        return "a teaching pattern that is not one of the three the app has";
      }
      const d = v === "alternate_day" ? days(c.days, ctx) : null;
      // §4.7: alternate_day without its day set is a pattern that prunes
      // nothing, which is worse than no pattern because it looks set.
      if (v === "alternate_day" && !d) return "an alternate-day pattern with no days to alternate on";
      return { kind: "pattern", value: v, days: d };
    }
    case "onlyClasses": {
      if (!Array.isArray(c.classNames) || c.classNames.length === 0) return "a class list with nothing in it";
      const known = new Map(ctx.classNames.map((n) => [n.trim().toLowerCase(), n]));
      const resolved: string[] = [];
      const unknown: string[] = [];
      for (const raw2 of c.classNames) {
        const hit = known.get(String(raw2 ?? "").trim().toLowerCase());
        if (hit) resolved.push(hit);
        else unknown.push(String(raw2));
      }
      // §18: an empty scope means "not stated", never "no classes" — so a list
      // that resolves to nothing must be refused rather than written, or the
      // instruction would silently widen the teacher's scope instead of
      // narrowing it.
      if (resolved.length === 0) return `classes this school does not have (${unknown.slice(0, 3).join(", ")})`;
      return { kind: "onlyClasses", classNames: [...new Set(resolved)] };
    }
    case "noSubstitutions":
      return { kind: "noSubstitutions" };
    default:
      return kind ? `a rule of a kind the timetable does not have ("${kind}")` : "a rule with no kind";
  }
}

/** How a compiled constraint reads back to the person who typed the instruction. */
export function describe(c: CompiledConstraint): string {
  switch (c.kind) {
    case "unavailable": {
      const d = c.days.map((n) => DAY_NAMES[n]).join(", ");
      return c.periods === null
        ? `not available on ${d}`
        : `not available on ${d}, period${c.periods.length > 1 ? "s" : ""} ${c.periods.join(", ")}`;
    }
    case "maxPerDay": return `at most ${c.value} periods a day`;
    case "maxPerWeek": return `at most ${c.value} periods a week`;
    case "minPerDay": return c.value <= 1 ? "no daily minimum" : `a full day or none — at least ${c.value} periods`;
    case "maxConsecutive": return `at most ${c.value} periods back to back`;
    case "firstPeriodRule":
      return c.value === "always_first_period"
        ? "always takes period 1 with their own class"
        : `first-period rule set to ${c.value}`;
    case "pattern":
      return c.value === "alternate_day"
        ? `teaches on ${(c.days ?? []).map((n) => DAY_NAMES[n]).join(", ")} only`
        : `teaches ${c.value.replace("_", " ")}`;
    case "onlyClasses": return `teaches only ${c.classNames.join(", ")}`;
    case "noSubstitutions": return "never offered as a substitute";
  }
}

/**
 * Turn what the model reported into what will be enforced — or a refusal.
 *
 * `understood: false` from the model is honoured as-is: a model that says it
 * could not express something is more useful than one that guesses, and the
 * prompt asks it to say so.
 */
export function compile(
  reported: { understood?: unknown; constraints?: unknown; note?: unknown },
  ctx: Context,
): CompileResult {
  const note = typeof reported.note === "string" ? reported.note.trim().slice(0, 300) : "";

  if (reported.understood === false) {
    return {
      status: "denied",
      constraints: [],
      note: note || "This cannot be expressed as a scheduling rule the timetable enforces.",
    };
  }

  const list = Array.isArray(reported.constraints) ? reported.constraints.slice(0, 12) : [];
  if (list.length === 0) {
    return {
      status: "denied",
      constraints: [],
      note: note || "Nothing in this could be turned into a rule the timetable enforces.",
    };
  }

  const constraints: CompiledConstraint[] = [];
  const refused: string[] = [];
  for (const raw of list) {
    const r = one(raw, ctx);
    if (typeof r === "string") refused.push(r);
    else constraints.push(r);
  }

  // Partial success is still a refusal. Accepting half an instruction and
  // ticking it green would tell the school the whole sentence is being honoured
  // — the one lie this feature must not tell.
  if (constraints.length === 0 || refused.length > 0) {
    return {
      status: "denied",
      constraints: [],
      note: refused.length > 0
        ? `Part of this could not be applied: ${refused[0]}.`
        : note || "Nothing in this could be turned into a rule the timetable enforces.",
    };
  }

  return {
    status: "accepted",
    constraints,
    note: constraints.map(describe).join("; "),
  };
}
