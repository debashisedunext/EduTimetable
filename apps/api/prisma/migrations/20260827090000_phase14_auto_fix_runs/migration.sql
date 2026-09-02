-- Phase 14.1 (§21) — auto-resolve run log.
--
-- Auto-resolve edits master data across many rows in one press. That is only
-- a reasonable thing to offer if it is reversible, so every run records the
-- value each field held *before* it was touched, and "Undo this run" puts
-- them all back.
--
-- `changes` is JSON rather than a child table on purpose: a change is only
-- ever read back as a whole run, never queried across runs, and the shape is
-- the engine's `RemedyChange` — which belongs to the shared package, not to
-- a schema that would then have to be migrated every time a remedy learns a
-- new trick.
CREATE TABLE `auto_fix_runs` (
  `id`                  INT          NOT NULL AUTO_INCREMENT,
  `school_id`           INT          NOT NULL,
  `timetable_config_id` INT          NOT NULL,
  `applied_by_id`       INT          NULL,
  `score_before`        INT          NOT NULL,
  `score_after`         INT          NOT NULL,
  `changes`             JSON         NOT NULL,
  `outcomes`            JSON         NOT NULL,
  `undone_at`           DATETIME(3)  NULL,
  `created_at`          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `auto_fix_runs_school_config_idx` (`school_id`, `timetable_config_id`),
  CONSTRAINT `auto_fix_runs_school_fk`
    FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`),
  CONSTRAINT `auto_fix_runs_config_fk`
    FOREIGN KEY (`timetable_config_id`) REFERENCES `timetable_config`(`id`) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
