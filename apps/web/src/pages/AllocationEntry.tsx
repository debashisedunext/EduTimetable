import { Navigate } from "react-router-dom";

/**
 * §31.13 — `/allocation` now points at where the allocation actually is.
 *
 * It used to be `<GuidedSetup startAt={9} />`: the guided setup opened on its
 * Allocation step. That step is gone — curriculum and mappings are entered on
 * the Master Grid's **Lesson Grid**, which is the same `StepAllocation`
 * component embedded there (§31.10) rather than a second editor. So the wizard
 * runs School → … → Rooms → Settings, and Settings offers the door across.
 *
 * Kept as a redirect rather than deleted. `ClassLessons` links here, the nav
 * entry pointed here for months, and people bookmark screens — a route that
 * quietly lands somebody where the thing they wanted now lives is worth more
 * than a 404 that is technically tidier.
 *
 * `replace`, so Back goes to wherever they came from rather than bouncing
 * through this redirect again.
 */
export function AllocationEntry() {
  return <Navigate to="/master-grid?tab=lesson" replace />;
}
