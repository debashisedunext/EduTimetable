/**
 * §6 — Substitute Teacher Engine. A bounded weighted bipartite matching,
 * solved per absent-teacher-per-day. Pure module: the API feeds it a snapshot
 * of the day (affected slots + every teacher's availability) and gets back a
 * ranked candidate list per slot plus a fair maximum-coverage assignment.
 *
 * Matching strategy (§6.1 step 4): greedy best-score assignment in period
 * order with a depth-1 ejection/augmenting pass for unmatched slots — exact
 * Hungarian is unnecessary at this scale (a handful of slots per absence) and
 * the greedy+augment shape mirrors the solver's repair pass.
 */

export interface AffectedSlot {
  /** published timetable_slots id (string — BigInt-safe) */
  slotId: string;
  /**
   * NULL for a §4.9 elective option: the lesson belongs to a block, not to one
   * section, so the two section-derived signals below (grade-band eligibility
   * and the continuity bonus) simply have nothing to say about it. The subject
   * match still does, and that is the stronger signal anyway.
   */
  classSectionId: number | null;
  classSectionLabel: string;
  period: number;
  subjectId: number;
  subjectName: string;
  /** teacher being covered (the absentee whose slot this is) */
  absentTeacherId: number;
  /** true when the absentee was themselves substituting here today (§6 edge) */
  viaSubstitution?: boolean;
}

export interface SubstituteTeacher {
  id: number;
  name: string;
  maxPeriodsPerDay: number;
  /** subject ids this teacher teaches anywhere (mappings + merged groups) */
  subjectIds: number[];
  /** class-section ids this teacher teaches (for the +2 continuity bonus) */
  classSectionIds: number[];
  /**
   * §18 teaching scope: the classes this teacher may take at all. Until Phase
   * 11 this was *derived* from what they already taught, which made it a
   * description rather than a rule — a teacher who happened to have no Class 2
   * mapping simply scored lower, instead of being ineligible. It is now
   * declared, and it is a hard filter.
   */
  classIds: number[];
  /** §18: guests are not on site for cover; permanent is preferred over adhoc. */
  employmentType?: "permanent" | "adhoc" | "guest";
  /**
   * §15.3 Phase 25.4 — whether this teacher covers at all.
   *
   * A hard filter, not a penalty, and the distinction is the whole point:
   * scoring them down still puts them on the screen, at the bottom, where
   * somebody assigns them anyway on a bad morning. "I don't cover" means they
   * do not appear. Same treatment §4.7a unavailability gets.
   *
   * Optional so a caller that predates the column behaves exactly as before.
   */
  canSubstitute?: boolean;
  /** periods already occupied on this day: own published slots + substitutions already confirmed */
  busyPeriods: number[];
  /** periods blocked by teacher_unavailability for this day (full-day = all) */
  unavailablePeriods: number[];
  /** substitutions already confirmed for this teacher on this date (other absences) */
  substitutionsToday: number;
}

export interface SubstituteInput {
  dayOfWeek: number;
  periodsPerDay: number;
  absentTeacherIds: number[];
  affectedSlots: AffectedSlot[];
  teachers: SubstituteTeacher[];
  /** classId per class-section (grade-band eligibility) */
  classIdBySection: Record<number, number>;
}

export interface Candidate {
  teacherId: number;
  name: string;
  score: number;
  /** human rationale fragments, e.g. "subject specialist", "already teaches 5-A" */
  reasons: string[];
}

export interface SlotPlan {
  slot: AffectedSlot;
  /** ranked eligible candidates (best first, capped) */
  candidates: Candidate[];
  /** teacherId the matcher assigned, or null when uncoverable */
  assigned: number | null;
  /** §6.1 step 5 fallback text when assigned is null */
  fallback: string | null;
}

export interface SubstitutePlan {
  slots: SlotPlan[];
  coveredCount: number;
  unmatchedCount: number;
}

const MAX_ALTERNATES = 4;

interface Ctx {
  input: SubstituteInput;
  /** in-plan assignments: teacherId -> periods taken */
  planPeriods: Map<number, Set<number>>;
  /** in-plan assignment count per teacher (fairness) */
  planCount: Map<number, number>;
}

function eligible(t: SubstituteTeacher, slot: AffectedSlot, ctx: Ctx): boolean {
  const { input, planPeriods } = ctx;
  if (input.absentTeacherIds.includes(t.id)) return false;
  // §18: a guest is engaged for a specific extra class, not kept on hand.
  if (t.employmentType === "guest") return false;
  // §15.3: opted out of cover entirely. Refused rather than ranked last.
  if (t.canSubstitute === false) return false;

  const classId = slot.classSectionId === null ? undefined : input.classIdBySection[slot.classSectionId];
  // §18: scope is a hard gate — a primary teacher does not cover Class 12 just
  // because nobody better is free. Only applied when a scope is recorded;
  // an empty one means "not stated", not "nothing".
  if (classId !== undefined && t.classIds.length > 0 && !t.classIds.includes(classId)) return false;

  const subjectOk = t.subjectIds.includes(slot.subjectId);
  const gradeBandOk = classId !== undefined && t.classIds.includes(classId);
  if (!subjectOk && !gradeBandOk) return false;
  if (t.busyPeriods.includes(slot.period)) return false;
  if (planPeriods.get(t.id)?.has(slot.period)) return false;
  if (t.unavailablePeriods.includes(slot.period)) return false;
  const dailyLoad = t.busyPeriods.length + (ctx.planCount.get(t.id) ?? 0);
  if (dailyLoad >= t.maxPeriodsPerDay) return false;
  return true;
}

/** §6.1 step 3 preference score, with the fairness malus made dynamic so it
 *  reacts to assignments made earlier in this same plan. */
function scoreOf(t: SubstituteTeacher, slot: AffectedSlot, ctx: Ctx): Candidate {
  let score = 0;
  const reasons: string[] = [];
  if (t.subjectIds.includes(slot.subjectId)) {
    score += 3;
    reasons.push(`${slot.subjectName} specialist`);
  } else {
    reasons.push("teaches this grade");
  }
  if (slot.classSectionId !== null && t.classSectionIds.includes(slot.classSectionId)) {
    score += 2;
    reasons.push(`already teaches ${slot.classSectionLabel} (continuity)`);
  }
  // §18 tie-break: permanent staff are the school's own, and continuity of
  // cover matters more than filling the slot with whoever is nearest free.
  if (t.employmentType === "permanent") score += 1;
  if (t.busyPeriods.includes(slot.period - 1) || t.busyPeriods.includes(slot.period + 1)) {
    score += 1;
    reasons.push("adjacent to their own period");
  } else {
    reasons.push("free this period");
  }
  const covers = t.substitutionsToday + (ctx.planCount.get(t.id) ?? 0);
  if (covers >= 2) {
    score -= 1;
    reasons.push(`already ${covers} substitution(s) today`);
  } else if (covers === 1) {
    reasons.push("1 substitution today");
  }
  return { teacherId: t.id, name: t.name, score, reasons };
}

function rankedCandidates(slot: AffectedSlot, ctx: Ctx): Candidate[] {
  return ctx.input.teachers
    .filter((t) => eligible(t, slot, ctx))
    .map((t) => scoreOf(t, slot, ctx))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function take(ctx: Ctx, teacherId: number, period: number) {
  const set = ctx.planPeriods.get(teacherId) ?? new Set<number>();
  set.add(period);
  ctx.planPeriods.set(teacherId, set);
  ctx.planCount.set(teacherId, (ctx.planCount.get(teacherId) ?? 0) + 1);
}
function release(ctx: Ctx, teacherId: number, period: number) {
  ctx.planPeriods.get(teacherId)?.delete(period);
  ctx.planCount.set(teacherId, Math.max(0, (ctx.planCount.get(teacherId) ?? 1) - 1));
}

export function planSubstitutes(input: SubstituteInput): SubstitutePlan {
  const ctx: Ctx = { input, planPeriods: new Map(), planCount: new Map() };
  const slots = [...input.affectedSlots].sort(
    (a, b) => a.period - b.period || a.classSectionLabel.localeCompare(b.classSectionLabel),
  );

  // pass 1 — greedy best-score in period order (fairness malus updates live)
  const assigned = new Map<string, number>();
  for (const slot of slots) {
    const best = rankedCandidates(slot, ctx)[0];
    if (best) {
      assigned.set(slot.slotId, best.teacherId);
      take(ctx, best.teacherId, slot.period);
    }
  }

  // pass 2 — depth-1 augmenting for unmatched slots: eject a blocker whose own
  // slot has an alternate (mirrors the solver's §5.4 repair)
  for (const slot of slots) {
    if (assigned.has(slot.slotId)) continue;
    let done = false;
    for (const other of slots) {
      if (done || !assigned.has(other.slotId)) continue;
      const holder = assigned.get(other.slotId)!;
      release(ctx, holder, other.period);
      const meNow = rankedCandidates(slot, ctx).find((c) => c.teacherId === holder);
      if (meNow) {
        // holder could cover the unmatched slot — can someone else cover theirs?
        take(ctx, holder, slot.period);
        const replacement = rankedCandidates(other, ctx)[0];
        if (replacement) {
          assigned.set(slot.slotId, holder);
          assigned.set(other.slotId, replacement.teacherId);
          take(ctx, replacement.teacherId, other.period);
          done = true;
        } else {
          release(ctx, holder, slot.period);
          take(ctx, holder, other.period);
        }
      } else {
        take(ctx, holder, other.period);
      }
    }
  }

  // final plan: re-rank candidates against the finished assignment so the
  // alternates shown in the UI are the ones actually still free
  const planSlots: SlotPlan[] = slots.map((slot) => {
    const chosen = assigned.get(slot.slotId) ?? null;
    if (chosen !== null) release(ctx, chosen, slot.period);
    const candidates = rankedCandidates(slot, ctx).slice(0, MAX_ALTERNATES);
    if (chosen !== null) take(ctx, chosen, slot.period);
    // keep the chosen teacher at the head of the list
    candidates.sort((a, b) => Number(b.teacherId === chosen) - Number(a.teacherId === chosen) || b.score - a.score);
    return {
      slot,
      candidates,
      assigned: chosen,
      fallback:
        chosen === null
          ? `No eligible substitute for ${slot.classSectionLabel} P${slot.period} — options: merge with an adjacent section, assign a free-period duty teacher, or cancel the period`
          : null,
    };
  });

  const covered = planSlots.filter((s) => s.assigned !== null).length;
  return { slots: planSlots, coveredCount: covered, unmatchedCount: planSlots.length - covered };
}
