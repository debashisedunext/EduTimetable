-- Phase 27 (§26.5) — a teacher's special instruction, in plain English.
--
-- The columns record three separate things, and keeping them apart is the whole
-- audit story:
--
--   * `special_instruction`  — what a person TYPED. Never rewritten, and kept
--     even when it is refused: it is theirs, and losing it to teach them a
--     lesson about phrasing is not our call.
--   * `instruction_compiled` — what it BECAME: the constraint rows the engine
--     already enforces. This is the authority. Remove the school's AI key
--     tomorrow and the timetable does not change, because by then the
--     instruction is ordinary data.
--   * `instruction_note`     — why it was refused, or the plain-English
--     read-back of what was understood, so the green tick is auditable rather
--     than trusted.
--
-- `pending` is the state a freshly typed instruction sits in until it has been
-- evaluated, and the state one returns to when the text changes: an instruction
-- is re-evaluated when it is edited, never silently re-run later against a
-- different model.

ALTER TABLE `teachers`
  ADD COLUMN `special_instruction` TEXT NULL,
  ADD COLUMN `instruction_status` ENUM('pending', 'accepted', 'denied') NULL,
  ADD COLUMN `instruction_compiled` JSON NULL,
  ADD COLUMN `instruction_note` VARCHAR(400) NULL,
  ADD COLUMN `instruction_at` DATETIME(3) NULL;
