/**
 * §29.6 — which week a staffing change acts on.
 *
 * ## The bug this exists to fix
 *
 * Reported: *"Ajay Verma resigned, I moved his lessons to Prakarti, the change
 * says applied — and the grid still shows Ajay."*
 *
 * It was right. §29.2 read `status: "published"` everywhere, and that school's
 * timetable had never been published: 30 draft rows, 0 published ones. So the
 * units came back with **no cells**, the apply's `updateMany` matched nothing,
 * and the change moved the mappings and the class-teacher pointer while leaving
 * every visible lesson with the leaver's name on it. Half-applied, and reported
 * as done.
 *
 * The published-only rule was not wrong, it was *incomplete*. Its reasoning —
 * *"draft rows belong to a working copy nobody is teaching from"* — is exactly
 * right for a school that has published, and describes nothing at all for a
 * school that has not. **Every school is in that state until its first
 * publish**, which is to say every school evaluating the product.
 *
 * ## The rule
 *
 * **The published week if there is one; otherwise the config's current draft.**
 *
 * Not both, and not the draft as well: a school that has published is teaching
 * from the wall, and a draft beside it is a working copy whose next Generate
 * will overwrite it anyway. One week, chosen by what the school actually has.
 *
 * ## Why it is one function
 *
 * Four places need the same answer — the unit enumeration, the plan's
 * occupancy, the apply's writes and the revert's — and the fault above was
 * precisely those four agreeing on a rule that was wrong. If they can disagree,
 * one of them will: a preview computed against the draft and an apply written
 * against the published rows would be the same half-applied change with a
 * different half missing.
 */
import type { PrismaClient } from "@prisma/client";

export interface WeekScope {
  /** Which rows this change may read and move. */
  status: "published" | "draft";
  /**
   * The draft those rows belong to, or null for the published week.
   *
   * Load-bearing for a draft: `timetable_slots` holds several named drafts at
   * once (§22) and a filter of `status: "draft"` alone would sweep all of them,
   * reassigning lessons in drafts nobody is looking at.
   */
  draftId: number | null;
}

/**
 * Resolve it, from the data rather than from a setting.
 *
 * `drafts.currentId` is the same "newest draft that has rows" every read in the
 * app defaults to (invariant 3), so this screen acts on the week the Board and
 * the Master Grid are showing — which is the week the person raising the change
 * is looking at while they raise it.
 */
export async function weekScopeFor(
  prisma: PrismaClient,
  configId: number,
  currentDraftId: (configId: number) => Promise<number | null>,
): Promise<WeekScope> {
  /*
    §18 extras are excluded from the question.

    They live in the same table in both statuses, and a school whose only
    published rows are next week's revision classes has not published a week —
    treating it as published would send the change at three rows and leave the
    other three hundred alone.
  */
  const published = await prisma.timetableSlot.count({
    where: { timetableConfigId: configId, status: "published", source: { not: "extra" } },
  });
  if (published > 0) return { status: "published", draftId: null };
  return { status: "draft", draftId: await currentDraftId(configId) };
}

/**
 * The `where` fragment for slots in this week.
 *
 * Published is left exactly as it was — `{ status: "published" }` and nothing
 * else — because a published row's `draft_id` is not reliably null: §3.14's
 * withdrawal flips rows between the two, so adding a `draftId` predicate here
 * would quietly stop matching on any school that has ever withdrawn a version.
 */
export function slotsIn(scope: WeekScope): { status: "published" | "draft"; draftId?: number } {
  return scope.status === "published"
    ? { status: "published" }
    : { status: "draft", ...(scope.draftId !== null ? { draftId: scope.draftId } : {}) };
}

/** How to say it on screen, where "which week did this move?" is a real question. */
export function describeScope(scope: WeekScope): string {
  return scope.status === "published"
    ? "the published timetable"
    : "the current draft — this timetable has not been published yet";
}
