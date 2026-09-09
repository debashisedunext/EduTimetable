/**
 * §8.2/§8.3 — the Allocation grid, as its own page.
 *
 * The grid is step 9 of the guided setup (§27), and it stays there rather than
 * being ported to a second component. That is deliberate: it works on the guided
 * setup's draft answers and commits through the §16 importer, which is the one
 * path that writes curriculum and mappings. A standalone copy reading and
 * writing those rows directly would be a second writer over the same data — the
 * thing every other part of this codebase goes out of its way not to have.
 *
 * §27.12 is what makes opening it directly sensible: `GET /onboarding/session`
 * falls back to answers rebuilt from the school itself, so a school that
 * finished its setup months ago opens this and sees its own curriculum rather
 * than an empty draft.
 */
import { GuidedSetup } from "./GuidedSetup";

/** Step 9 of the guided setup (§28's ten-step scheme) — the Allocation grid. */
const ALLOCATION_STEP = 9;

export function AllocationEntry() {
  return <GuidedSetup startAt={ALLOCATION_STEP} />;
}
