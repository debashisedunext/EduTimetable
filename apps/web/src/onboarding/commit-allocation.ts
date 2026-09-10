/**
 * §31.10 — what "commit the allocation" means, defined once.
 *
 * The Allocation grid had two doors — the guided setup's step 9 and the Master
 * Grid's **Lesson Grid** tab. §31.13 removed the first: the wizard runs School
 * → … → Rooms → Settings, and Settings offers a button across to the Lesson
 * Grid instead. So there is one caller now, and this module stays because the
 * SEQUENCE is the thing worth having in one place, not because two callers
 * need it — `ALLOCATION_STEP` is still 9 on the server, and a second door
 * appearing later must land the same rows in the same order.
 *
 * The order is not incidental. It is two calls rather than one because they
 * write to different places:
 *
 *  1. **`commitWeeks(answers, { changedOnly: true })`** — §28 lets this grid
 *     change a period's *length*, which is a `timetable_config` fact (a step 5
 *     row), not a master row, so it cannot ride through the §16 importer with
 *     the rest. `changedOnly` matters: `PUT /:id/structure` rewrites a wing's
 *     period grid wholesale, so an unconditional call would rewrite every
 *     wing's week on every save.
 *  2. **`POST /onboarding/commit/9`** — the §16 importer, which is what makes
 *     this idempotent. Pressing Save twice creates nothing extra, because the
 *     importer skips rows that already exist by natural key.
 *
 * ## The precondition, which is the easy thing to get wrong
 *
 * **The caller MUST have persisted the draft before calling this.** The server
 * commits from the *stored* draft, so an answer that is still only in the
 * browser is one the commit cannot see — it would report "there is nothing to
 * create yet" while the screen shows a full grid. Both call sites are three
 * lines long for that reason: persist, then commit, then report.
 *
 * A second copy of these two calls in the Master Grid would have been free to
 * drift from the wizard's — most likely by forgetting `changedOnly`, which
 * does nothing visible until a school with two wings saves once.
 */
import { api } from "../api";
import { commitWeeks } from "./steps/Structure";

/** Step 9 of the §28 ten-step scheme. */
export const ALLOCATION_STEP = 9;

interface Committed {
  created?: Record<string, number>;
}

/**
 * @param answers the draft, **already saved to the server** — see above.
 * @returns what the importer created, per table, for a caller that reports it.
 */
export async function commitAllocation(
  answers: Record<string, unknown>,
): Promise<Record<string, number> | undefined> {
  await commitWeeks(answers as never, { changedOnly: true });
  return (await api<Committed>(`/onboarding/commit/${ALLOCATION_STEP}`, { method: "POST" })).created;
}
