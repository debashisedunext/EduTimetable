/**
 * §24.6 Phase 25.5b — the trust boundary between a language model and a draft.
 *
 * The interviewer asks the eleven steps' questions in conversation, and reports
 * what it learned by calling one tool. This file is what stands between that
 * report and `onboarding_sessions.answers`.
 *
 * The reasoning is the same one §13.5 rests on — **the model proposes, a person
 * disposes** — but the boundary sits in a different place, so it is worth being
 * exact about what is and is not being trusted here:
 *
 *  - Nothing written here is master data. `answers` is a draft: the same JSON a
 *    person fills in by typing, committed only when somebody presses Next, and
 *    committed then through the §16 importer, which validates it all over again.
 *    A hallucinated teacher reaches a review screen, never a table.
 *  - So this is not the safety net. It is the thing that keeps the draft
 *    *coherent* — every key known, every number in range, every array bounded —
 *    because a draft with `sections: 4000` renders a screen nobody can use and
 *    an error two steps later that names the wrong cause.
 *
 * Two rules make it honest:
 *
 *  1. **An unknown key is dropped, and SAID.** Silently ignoring a field the
 *     model believed it had recorded produces a conversation where the assistant
 *     confirms something that never happened. Every rejection is returned and
 *     handed back as the tool result, so the model can correct itself or ask
 *     again.
 *  2. **Classes are named, never indexed.** The ladder position is an
 *     implementation detail of a slider; asking a model for `fromIndex: 4` is
 *     asking it to hallucinate an integer. It gives "Class 1" and this resolves
 *     it — an unknown name is an error with the vocabulary attached, not a guess.
 */
import { CLASS_LADDER, type WingAnswer } from "@edutimetable/shared";

/** Everything the interview may set. Steps 9-11 are not conversational (§24.6). */
const KEYS = ["school", "session", "wings", "weeks", "subjects", "teachers"] as const;
type Key = (typeof KEYS)[number];

export interface SanitizedTurn {
  /** The subset that survived, ready to merge into the draft. */
  answers: Record<string, unknown>;
  /** What was refused, and why — handed back to the model verbatim. */
  rejected: string[];
}

// §16's own VarChar limits, so a draft cannot hold a name the importer will
// later refuse. Duplicated as numbers rather than imported because the importer
// states them per column and this is a different, coarser cut.
const MAX = { name: 100, shortName: 50, code: 20, wing: 60 };

const str = (v: unknown, limit: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  return s === "" || s.length > limit ? null : s;
};

const int = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r < lo || r > hi ? null : r;
};

const bool = (v: unknown): boolean | undefined => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["yes", "y", "true", "1"].includes(s)) return true;
    if (["no", "n", "false", "0"].includes(s)) return false;
  }
  return undefined;
};

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** "class 5" → 8. Case- and spacing-insensitive; "5" alone works too. */
export function ladderIndex(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < CLASS_LADDER.length) {
    return value;
  }
  const raw = typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
  if (raw === "") return null;
  const i = CLASS_LADDER.findIndex((c) => c.toLowerCase() === raw);
  if (i >= 0) return i;
  // "5", "class-5", "grade 5", "std 5", "pre nursery" — the ways people say it
  // out loud, and therefore the ways a model transcribes them.
  const bare = raw.replace(/^(class|grade|std|standard)[\s-]*/, "");
  const j = CLASS_LADDER.findIndex((c) => c.toLowerCase() === `class ${bare}`);
  if (j >= 0) return j;
  const ALIASES: Record<string, string> = {
    "pre nursery": "Pre-Nursery", prenursery: "Pre-Nursery", "pre-nur": "Pre-Nursery",
    nur: "Nursery", kg: "LKG", "jr kg": "LKG", "sr kg": "UKG",
  };
  const alias = ALIASES[bare];
  return alias ? CLASS_LADDER.indexOf(alias as (typeof CLASS_LADDER)[number]) : null;
}

const LADDER_HELP = `Use a class name from: ${CLASS_LADDER.join(", ")}.`;

/**
 * Take a model's report and return the part of it a draft may hold.
 *
 * Every value is coerced and range-checked; anything that does not survive is
 * named in `rejected` rather than dropped quietly.
 */
export function sanitizeTurn(learned: unknown): SanitizedTurn {
  const rejected: string[] = [];
  const answers: Record<string, unknown> = {};
  if (!learned || typeof learned !== "object" || Array.isArray(learned)) {
    return { answers, rejected: ["The report was not an object, so nothing was recorded."] };
  }
  const input = learned as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (!KEYS.includes(key as Key)) {
      rejected.push(`"${key}" is not something this setup records, so it was ignored. Known fields: ${KEYS.join(", ")}.`);
    }
  }

  // ── school
  if (input.school !== undefined) {
    const s = input.school as Record<string, unknown>;
    const name = str(s?.name, MAX.name);
    if (name) answers.school = { name };
    else rejected.push("The school name was missing or too long (100 characters), so it was not recorded.");
  }

  // ── session
  if (input.session !== undefined) {
    const s = (input.session ?? {}) as Record<string, unknown>;
    const name = str(s.name, 20);
    if (!name) rejected.push("The session needs a name of 20 characters or fewer.");
    else if (!isDate(s.startDate) || !isDate(s.endDate)) {
      rejected.push("The session needs a start and end date as YYYY-MM-DD.");
    } else if (String(s.endDate) <= String(s.startDate)) {
      rejected.push("The session must end after it starts.");
    } else {
      answers.session = { name, startDate: s.startDate, endDate: s.endDate };
    }
  }

  // ── wings (and the class range on each)
  if (input.wings !== undefined) {
    if (!Array.isArray(input.wings)) rejected.push("Wings must be a list.");
    else {
      const wings: WingAnswer[] = [];
      const seen = new Set<string>();
      for (const raw of input.wings.slice(0, 12)) {
        const w = (raw ?? {}) as Record<string, unknown>;
        const name = str(w.name, MAX.wing);
        if (!name) { rejected.push("A wing with no usable name was skipped."); continue; }
        if (seen.has(name.toLowerCase())) { rejected.push(`Two wings were both called "${name}"; the second was skipped.`); continue; }
        const from = ladderIndex(w.fromClass ?? w.from ?? w.fromIndex);
        const to = ladderIndex(w.toClass ?? w.to ?? w.toIndex);
        if (from === null || to === null) {
          rejected.push(`${name}: the class range was not understood. ${LADDER_HELP}`);
          continue;
        }
        const sections = int(w.sections, 1, 26);
        if (sections === null) { rejected.push(`${name}: sections per class must be a whole number from 1 to 26.`); continue; }
        seen.add(name.toLowerCase());
        wings.push({ name, fromIndex: Math.min(from, to), toIndex: Math.max(from, to), sections });
      }
      if (wings.length > 0) answers.wings = wings;
      else rejected.push("No usable wing was recorded.");
    }
  }

  // ── the week, per wing
  if (input.weeks !== undefined) {
    if (typeof input.weeks !== "object" || Array.isArray(input.weeks)) rejected.push("The weeks must be given per wing, keyed by wing name.");
    else {
      const weeks: Record<string, unknown> = {};
      for (const [wingName, raw] of Object.entries(input.weeks as Record<string, unknown>).slice(0, 12)) {
        const w = (raw ?? {}) as Record<string, unknown>;
        const days = Array.isArray(w.workingDays)
          ? [...new Set(w.workingDays.map((d) => int(d, 1, 7)).filter((d): d is number => d !== null))].sort((a, b) => a - b)
          : [];
        if (days.length === 0) { rejected.push(`${wingName}: at least one working day (1 = Monday … 7 = Sunday) is needed.`); continue; }
        const periodsPerDay = int(w.periodsPerDay, 1, 14);
        if (periodsPerDay === null) { rejected.push(`${wingName}: periods per day must be from 1 to 14.`); continue; }
        const breaks = Array.isArray(w.breaks)
          ? w.breaks.slice(0, 6).map((b) => {
              const x = (b ?? {}) as Record<string, unknown>;
              return {
                name: str(x.name, 40) ?? "Break",
                afterPeriod: int(x.afterPeriod, 1, periodsPerDay) ?? 1,
                durationMins: int(x.durationMins, 5, 120) ?? 15,
              };
            })
          : [];
        weeks[wingName] = {
          workingDays: days,
          periodsPerDay,
          periodDurationMins: int(w.periodDurationMins, 20, 120) ?? 40,
          startTime: typeof w.startTime === "string" && /^\d{2}:\d{2}$/.test(w.startTime) ? w.startTime : "08:00",
          hasZeroPeriod: bool(w.hasZeroPeriod) ?? false,
          breaks,
        };
      }
      if (Object.keys(weeks).length > 0) answers.weeks = weeks;
    }
  }

  // ── subjects
  if (input.subjects !== undefined) {
    if (!Array.isArray(input.subjects)) rejected.push("Subjects must be a list.");
    else {
      const subjects: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      for (const raw of input.subjects.slice(0, 60)) {
        const s = (typeof raw === "string" ? { name: raw } : (raw ?? {})) as Record<string, unknown>;
        const name = str(s.name, 50);
        if (!name) { rejected.push("A subject with no usable name was skipped."); continue; }
        if (seen.has(name.toLowerCase())) { rejected.push(`"${name}" was listed twice; the second was skipped.`); continue; }
        seen.add(name.toLowerCase());
        subjects.push({
          name,
          code: str(s.code, 10) ?? "",
          isLab: bool(s.isLab) ?? false,
          requiresDoublePeriod: bool(s.requiresDoublePeriod) ?? false,
        });
      }
      if (subjects.length > 0) answers.subjects = subjects;
      else rejected.push("No usable subject was recorded.");
    }
  }

  // ── teachers
  if (input.teachers !== undefined) {
    if (!Array.isArray(input.teachers)) rejected.push("Teachers must be a list.");
    else {
      const teachers: Array<Record<string, unknown>> = [];
      const codes = new Set<string>();
      for (const raw of input.teachers.slice(0, 500)) {
        const t = (typeof raw === "string" ? { name: raw } : (raw ?? {})) as Record<string, unknown>;
        const name = str(t.name, MAX.name);
        if (!name) { rejected.push("A teacher with no usable name was skipped."); continue; }
        const code = str(t.employeeCode, MAX.code);
        if (code && codes.has(code.toLowerCase())) {
          rejected.push(`Employee code ${code} was used twice; it is the identifier, so the second was skipped.`);
          continue;
        }
        if (code) codes.add(code.toLowerCase());
        const subjects = Array.isArray(t.subjects)
          ? t.subjects.map((s) => str(s, 50)).filter((s): s is string => s !== null).slice(0, 20)
          : [];
        const engagement = String(t.employmentType ?? "permanent").toLowerCase();
        teachers.push({
          name,
          ...(code ? { employeeCode: code } : {}),
          subjects,
          ...(str(t.wing, MAX.wing) ? { wing: str(t.wing, MAX.wing) } : {}),
          ...(int(t.maxPeriodsPerDay, 1, 14) !== null ? { maxPeriodsPerDay: int(t.maxPeriodsPerDay, 1, 14) } : {}),
          ...(int(t.maxPeriodsPerWeek, 1, 60) !== null ? { maxPeriodsPerWeek: int(t.maxPeriodsPerWeek, 1, 60) } : {}),
          ...(int(t.maxConsecutivePeriodsPerDay, 1, 12) !== null
            ? { maxConsecutivePeriodsPerDay: int(t.maxConsecutivePeriodsPerDay, 1, 12) } : {}),
          ...(bool(t.canSubstitute) !== undefined ? { canSubstitute: bool(t.canSubstitute) } : {}),
          // §18: a guest teacher is refused the regular curriculum entirely, so
          // this is not a label — an unrecognised value must never quietly
          // become one of the two that carry consequences.
          employmentType: ["permanent", "adhoc", "guest"].includes(engagement) ? engagement : "permanent",
        });
      }
      if (teachers.length > 0) answers.teachers = teachers;
      else rejected.push("No usable teacher was recorded.");
    }
  }

  return { answers, rejected };
}

/**
 * Merge one turn into what is already collected — the difference between a
 * conversation and a form.
 *
 * A wizard screen holds the whole list and sends it complete on every save, so
 * the draft's shallow per-key merge is exactly right for it. A conversation does
 * not work that way: somebody says "and we also have three part-time teachers",
 * and the model reports those three. A shallow merge would make that sentence
 * DELETE every teacher named before it — the setup would quietly shrink as the
 * conversation went on, which is the worst possible failure here because it
 * looks like progress.
 *
 * So the collection-shaped keys accumulate, keyed by the thing that identifies
 * them, and restating one updates it rather than duplicating it — "no, Primary
 * has three sections" is a correction, not a second Primary.
 *
 * `replace` is the escape hatch for the correction a merge cannot express:
 * removing something. "Drop Sanskrit, the list is English, Hindi and Maths" is
 * the model declaring the list complete, and it says so by naming the key.
 */
export function mergeAnswers(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
  replace: string[] = [],
): Record<string, unknown> {
  const out = { ...existing };
  const wholesale = new Set(replace.map((k) => k.trim()));

  for (const [key, value] of Object.entries(patch)) {
    if (wholesale.has(key) || key === "school" || key === "session") {
      out[key] = value;
      continue;
    }
    if (key === "weeks") {
      // One entry per wing: a turn that sets Senior's week must not erase
      // Primary's, which was two questions ago.
      out.weeks = { ...((existing.weeks as Record<string, unknown>) ?? {}), ...(value as Record<string, unknown>) };
      continue;
    }
    if (Array.isArray(value)) {
      const idOf = (row: unknown): string => {
        const r = (row ?? {}) as Record<string, unknown>;
        const code = key === "teachers" ? (r.employeeCode as string | undefined)?.trim() : undefined;
        return (code || String(r.name ?? "")).trim().toLowerCase();
      };
      const merged = [...(((existing[key] as unknown[]) ?? []) as unknown[])];
      for (const row of value) {
        const at = merged.findIndex((m) => idOf(m) === idOf(row));
        if (at >= 0) merged[at] = row;
        else merged.push(row);
      }
      out[key] = merged;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * The model's suggested answers to its own question, made safe to render.
 *
 * These become BUTTONS, and a button's label is what gets sent when it is
 * pressed — so an unbounded "option" would be both an unreadable chip and a
 * paragraph submitted as somebody's answer. Trimmed, length-capped,
 * de-duplicated case-insensitively (two chips reading "Monday to Friday" and
 * "monday to friday" are one choice wearing two hats), and limited to four so
 * the row stays scannable. The screen adds its own "Something else" beyond
 * them, which is why four is a ceiling rather than a target.
 */
export function cleanOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const s = v.trim().replace(/\s+/g, " ");
    if (s === "" || s.length > 80) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length === 4) break;
  }
  return out;
}

/**
 * Which step the conversation has reached, from what has been collected.
 *
 * Derived rather than tracked, because the model is not a reliable narrator of
 * its own progress: it will happily say "step 5" while three of step 3's
 * answers are missing. What is in the draft is the only thing that decides.
 */
export function stepFrom(answers: Record<string, unknown>): number {
  const has = (k: string) => {
    const v = answers[k];
    return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null;
  };
  const wings = (answers.wings as WingAnswer[] | undefined) ?? [];
  const weeks = (answers.weeks as Record<string, unknown> | undefined) ?? {};
  const everyWingHasAWeek = wings.length > 0 && wings.every((w) => weeks[w.name] !== undefined);

  if (!has("school")) return 1;
  if (!has("session")) return 2;
  if (!has("wings")) return 3;
  // Step 4 is the class ladder, which the wing answer already carries — there is
  // no separate thing to collect, so the conversation goes straight to the week.
  if (!everyWingHasAWeek) return 5;
  if (!has("subjects")) return 6;
  if (!has("teachers")) return 7;
  // 8 (rooms) onward are proposed, not asked: the handover point.
  return 8;
}
