-- §15.3 Phase 25.4 — the five columns the guided setup's teacher grid needs.
--
-- Two of these are ENFORCED rather than merely stored, and that is the point:
--   * max_consecutive_periods_per_day is checked by SolverState.check(), so the
--     solver, the drag-and-drop board and the legal-destination highlighting
--     all honour it — one rules engine, three call sites.
--   * can_substitute = false REMOVES a teacher from the substitute candidate
--     list, the same way §4.7a unavailability does. A low score would still put
--     them on screen, which is not what "I don't cover" means.
--
-- A field that records a preference nothing acts on is worse than a missing
-- field, because it reads as a promise.
--
-- All nullable or defaulted, so every existing teacher keeps exactly today's
-- behaviour: no gender recorded, no initials, no consecutive limit, and
-- available to substitute as they always were.
ALTER TABLE `teachers`
  ADD COLUMN `gender` ENUM('male', 'female', 'other') NULL,
  ADD COLUMN `initials` VARCHAR(6) NULL,
  ADD COLUMN `email` VARCHAR(120) NULL,
  ADD COLUMN `max_consecutive_periods_per_day` INTEGER NULL,
  ADD COLUMN `can_substitute` BOOLEAN NOT NULL DEFAULT true;
