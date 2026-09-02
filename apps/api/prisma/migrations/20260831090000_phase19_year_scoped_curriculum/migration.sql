-- Phase 19 Step 1 (§3) — the curriculum becomes year-scoped.
--
-- `class_subjects` was keyed (class_id, subject_id), with no year dimension at
-- all, so ONE row served every academic year at once: editing Class 5's
-- periods/week for 2026-27 silently changed what 2025-26's readiness report
-- said about the same class. Nobody hit it because every school so far runs a
-- single year. Cloning a timetable into a new session (Phase 19 Step 2) makes
-- two live years the normal case, so the year joins the key.
--
-- Scoped by ACADEMIC YEAR rather than by timetable config on purpose: what
-- Class 5 studies is a property of the year, not of which wing happens to
-- timetable it. A class whose sections are split across two configs in the
-- same year shares one curriculum, which is correct.

ALTER TABLE `class_subjects` ADD COLUMN `academic_year_id` INT NULL AFTER `class_id`;

-- Backfill: every existing row belongs to its own school's year. Prefer the
-- active one; fall back to the earliest by start date, so a school that has
-- switched `is_active` off everywhere still lands its rows on a real year
-- rather than none.
UPDATE `class_subjects` cs
   SET cs.`academic_year_id` = (
     SELECT ay.`id`
       FROM `academic_years` ay
      WHERE ay.`school_id` = cs.`school_id`
      ORDER BY ay.`is_active` DESC, ay.`start_date` ASC, ay.`id` ASC
      LIMIT 1
   );

-- The guard is the NOT NULL below, and it is deliberate: a curriculum row in a
-- school with no academic year has nowhere to go, and the ALTER aborts the
-- whole migration rather than let the backfill quietly leave it behind. Fix by
-- creating that school's academic year, then re-running.
ALTER TABLE `class_subjects`
  MODIFY `academic_year_id` INT NOT NULL,
  DROP INDEX `class_subjects_class_id_subject_id_key`,
  ADD UNIQUE INDEX `class_subjects_class_id_subject_id_academic_year_id_key` (`class_id`, `subject_id`, `academic_year_id`),
  ADD INDEX `class_subjects_academic_year_id_idx` (`academic_year_id`),
  ADD CONSTRAINT `class_subjects_academic_year_id_fkey`
    FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
