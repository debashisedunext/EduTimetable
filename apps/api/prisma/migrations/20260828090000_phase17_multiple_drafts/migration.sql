-- Phase 17 (§22) — a school keeps several named drafts and publishes the best.
--
-- The blocker was never the UI. `uq_class_slot` is
--   (timetable_config_id, status, class_section_id, day_of_week, period_number)
-- so two drafts both placing 5-A on Monday P1 collide, and a SECOND DRAFT
-- CANNOT PHYSICALLY EXIST. That is invariant 1 doing its job, which is why
-- this needs a new dimension rather than a new screen.

-- ---------------------------------------------------------------- registry
CREATE TABLE `timetable_drafts` (
  `id`                  INT NOT NULL AUTO_INCREMENT,
  `school_id`           INT NOT NULL,
  `timetable_config_id` INT NOT NULL,
  -- per-config sequence: "Draft #1", "Draft #2" — what the school calls them
  `draft_no`            SMALLINT NOT NULL,
  `label`               VARCHAR(80) NULL,
  `status`              ENUM('draft', 'published', 'archived', 'discarded') NOT NULL DEFAULT 'draft',
  -- §22.3 stats snapshot. Stamped after a generation, a board edit batch or an
  -- import; READ from here, never recounted per render (§14 budget).
  `required_lessons`    INT NULL,
  `placed_lessons`      INT NULL,
  `generation_pct`      DECIMAL(5,2) NULL,
  `error_count`         INT NULL,
  `warning_count`       INT NULL,
  `locked_count`        INT NULL,
  `manual_count`        INT NULL,
  `solver_stats`        JSON NULL,
  `generated_at`        DATETIME(3) NULL,
  `created_by`          INT NULL,
  `created_at`          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `published_at`        DATETIME(3) NULL,
  `published_by`        INT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_draft_no`(`school_id`, `timetable_config_id`, `draft_no`),
  INDEX `timetable_drafts_school_id_idx`(`school_id`),
  INDEX `timetable_drafts_config_status_idx`(`timetable_config_id`, `status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `timetable_drafts`
  ADD CONSTRAINT `timetable_drafts_school_id_fkey`
    FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `timetable_drafts_config_fkey`
    FOREIGN KEY (`timetable_config_id`) REFERENCES `timetable_config`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------- which draft a slot is in
ALTER TABLE `timetable_slots` ADD COLUMN `draft_id` INT NULL AFTER `status`;

-- Existing draft rows become Draft #1 of their config, so a school that has
-- been using the app sees its work exactly where it left it.
INSERT INTO `timetable_drafts`
  (`school_id`, `timetable_config_id`, `draft_no`, `label`, `status`, `generated_at`)
SELECT s.`school_id`, s.`timetable_config_id`, 1, 'Draft 1', 'draft', NOW(3)
FROM `timetable_slots` s
WHERE s.`status` = 'draft' AND s.`source` <> 'extra'
GROUP BY s.`school_id`, s.`timetable_config_id`;

UPDATE `timetable_slots` s
JOIN `timetable_drafts` d
  ON d.`timetable_config_id` = s.`timetable_config_id` AND d.`draft_no` = 1
SET s.`draft_id` = d.`id`
WHERE s.`status` = 'draft' AND s.`source` <> 'extra';

-- ----------------------------------------------------- the collapsing scope
--
-- The same device as `teacher_occupancy_key`, for the same reason: the key
-- must COLLAPSE exactly where the guarantee has to stay global.
--
--   * every published row  -> 0, so there can never be two published sets for
--     a config however many drafts it was promoted from;
--   * every source='extra' row -> 0, because extras live once per config in
--     BOTH statuses and outside any draft (§18: regeneration is not a
--     cancellation — that stays true verbatim);
--   * every draft row keeps its own draft id, so Draft #1 and Draft #2 may
--     both put Mrs. Sharma in Monday P3. Alternative futures, not a
--     double-booking.
--
-- COALESCE, not a bare `draft_id`: the column is NOT NULL, and a draft row
-- that somehow arrived without an id would otherwise be REFUSED at insert.
ALTER TABLE `timetable_slots`
  ADD COLUMN `draft_scope` INT
    GENERATED ALWAYS AS (CASE WHEN `status` = 'published' OR `source` = 'extra' THEN 0 ELSE COALESCE(`draft_id`, 0) END)
    STORED NOT NULL
    AFTER `draft_id`,
  DROP INDEX `uq_class_slot`,
  DROP INDEX `uq_teacher_slot`,
  DROP INDEX `uq_room_slot`,
  ADD UNIQUE INDEX `uq_class_slot`(`timetable_config_id`, `status`, `draft_scope`, `class_section_id`, `day_of_week`, `period_number`),
  ADD UNIQUE INDEX `uq_teacher_slot`(`timetable_config_id`, `status`, `draft_scope`, `teacher_occupancy_key`, `day_of_week`, `period_number`),
  ADD UNIQUE INDEX `uq_room_slot`(`timetable_config_id`, `status`, `draft_scope`, `room_id`, `day_of_week`, `period_number`);

-- RESTRICT, not SET NULL — and MySQL would refuse anything else anyway, since
-- `draft_id` is the base column of a STORED generated column. That refusal is
-- correct on the merits: SET NULL would push a deleted draft's orphaned rows to
-- scope 0, where they would collide with each other AND with the published set.
-- Discarding a draft therefore has to delete its slots first, explicitly, in
-- one transaction — which is what §22.4's "discard" does.
ALTER TABLE `timetable_slots`
  ADD CONSTRAINT `timetable_slots_draft_id_fkey`
    FOREIGN KEY (`draft_id`) REFERENCES `timetable_drafts`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The hot scoped read gains the draft (§14): reads are always
-- `school_id = ? AND timetable_config_id = ? AND status = ? [AND draft_id = ?]`.
CREATE INDEX `timetable_slots_school_config_status_draft_idx`
  ON `timetable_slots`(`school_id`, `timetable_config_id`, `status`, `draft_id`);
