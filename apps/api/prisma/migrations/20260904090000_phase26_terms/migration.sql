-- Phase 26 (§25) — a session may run as one year or as several terms.
--
-- The device is the one Phase 17 used for named drafts, for the same reason.
-- `uq_class_slot` is
--   (timetable_config_id, status, draft_scope, class_section_id, day_of_week, period_number)
-- so Term 1 and Term 2 both placing 5-A on Monday P1 collide, and a SECOND TERM
-- CANNOT PHYSICALLY EXIST. That is invariant 1 doing its job, which is why this
-- needs a new dimension in the key rather than a new screen.
--
-- Two designs were rejected on invariants this schema already holds:
--   * one timetable_config per term breaks §3.10 — a class-section belongs to
--     exactly ONE config, so 5-A cannot be in both terms' timetables;
--   * one named draft per term breaks §22 — draft_scope collapses every
--     published row to 0, so two terms could never be live at once, which is
--     the whole feature.

-- ------------------------------------------------------------------ the terms
CREATE TABLE `academic_terms` (
  `id`               INT NOT NULL AUTO_INCREMENT,
  `school_id`        INT NOT NULL,
  `academic_year_id` INT NOT NULL,
  -- What the school calls it. "Term 1" by default; "Semester 1", "Autumn Term"
  -- and "First Term" are all things real schools say.
  `name`             VARCHAR(30) NOT NULL,
  -- Position in the year. The dates decide what a term MEANS; this decides the
  -- order dropdowns list them in, and survives a term being re-dated.
  `sort_order`       SMALLINT NOT NULL,
  `start_date`       DATE NOT NULL,
  `end_date`         DATE NOT NULL,
  `created_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_term_order`(`school_id`, `academic_year_id`, `sort_order`),
  UNIQUE INDEX `uq_term_name`(`school_id`, `academic_year_id`, `name`),
  INDEX `academic_terms_school_id_idx`(`school_id`),
  INDEX `academic_terms_year_dates_idx`(`academic_year_id`, `start_date`, `end_date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `academic_terms`
  ADD CONSTRAINT `academic_terms_school_id_fkey`
    FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `academic_terms_year_fkey`
    FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- No column anywhere says "this session is term-wise". A session is term-wise
-- IF AND ONLY IF it has rows here — one source of truth, which cannot come to
-- disagree with the rows the way a flag can.

-- -------------------------------------------------- which term a slot is in
--
-- NULL means "the whole year", which is every row that exists today. Nothing
-- below rewrites a single one of them: a year-wise school comes out of this
-- migration byte-identical, and that is the property that makes it safe to run
-- on every school's database (§17.3) rather than only on the ones that asked
-- for terms.
ALTER TABLE `timetable_slots` ADD COLUMN `term_id` INT NULL AFTER `draft_id`;

-- COALESCE, not a bare `term_id`: a column inside a UNIQUE key must never be
-- NULL, because MySQL treats NULLs as distinct and would happily accept two
-- year-wide rows in the same cell — silently undoing invariant 1 for every
-- school that never uses terms. Exactly the reason `draft_scope` exists.
ALTER TABLE `timetable_slots`
  ADD COLUMN `term_scope` INT
    GENERATED ALWAYS AS (COALESCE(`term_id`, 0))
    STORED NOT NULL
    AFTER `term_id`,
  DROP INDEX `uq_class_slot`,
  DROP INDEX `uq_teacher_slot`,
  DROP INDEX `uq_room_slot`,
  ADD UNIQUE INDEX `uq_class_slot`(`timetable_config_id`, `status`, `draft_scope`, `term_scope`, `class_section_id`, `day_of_week`, `period_number`),
  ADD UNIQUE INDEX `uq_teacher_slot`(`timetable_config_id`, `status`, `draft_scope`, `term_scope`, `teacher_occupancy_key`, `day_of_week`, `period_number`),
  ADD UNIQUE INDEX `uq_room_slot`(`timetable_config_id`, `status`, `draft_scope`, `term_scope`, `room_id`, `day_of_week`, `period_number`);

-- RESTRICT, and MySQL would refuse anything else anyway: `term_id` is the base
-- column of a STORED generated column. Right on the merits too — SET NULL would
-- push a deleted term's rows to scope 0, where they would collide with each
-- other and with the year-wide set. Deleting a term therefore deletes its slots
-- first, explicitly, in one transaction (§25.5).
ALTER TABLE `timetable_slots`
  ADD CONSTRAINT `timetable_slots_term_id_fkey`
    FOREIGN KEY (`term_id`) REFERENCES `academic_terms`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The hot scoped read gains the term (§14): reads are always
-- `school_id = ? AND timetable_config_id = ? AND status = ? [AND draft_id = ?] [AND term_id = ?]`.
CREATE INDEX `timetable_slots_school_config_status_term_idx`
  ON `timetable_slots`(`school_id`, `timetable_config_id`, `status`, `term_id`);

-- ------------------------------------------- the three tables that follow it
--
-- A draft belongs to ONE term. The alternative — a draft spanning every term —
-- would make its §22.3 stats ("87% generated, 4 errors") a number about several
-- different timetables at once, which is not a number. The five-live-drafts
-- limit is per term for the same reason.
ALTER TABLE `timetable_drafts`
  ADD COLUMN `term_id` INT NULL AFTER `timetable_config_id`,
  ADD COLUMN `term_scope` INT GENERATED ALWAYS AS (COALESCE(`term_id`, 0)) STORED NOT NULL AFTER `term_id`,
  DROP INDEX `uq_draft_no`,
  ADD UNIQUE INDEX `uq_draft_no`(`school_id`, `timetable_config_id`, `term_scope`, `draft_no`),
  ADD CONSTRAINT `timetable_drafts_term_id_fkey`
    FOREIGN KEY (`term_id`) REFERENCES `academic_terms`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Each term publishes on its own and keeps its own history, so each has a
-- version 1. Publishing Term 3 in November must not renumber Term 1.
ALTER TABLE `timetable_publications`
  ADD COLUMN `term_id` INT NULL AFTER `timetable_config_id`,
  ADD COLUMN `term_scope` INT GENERATED ALWAYS AS (COALESCE(`term_id`, 0)) STORED NOT NULL AFTER `term_id`,
  DROP INDEX `uq_config_version`,
  ADD UNIQUE INDEX `uq_config_version`(`timetable_config_id`, `term_scope`, `version`),
  ADD CONSTRAINT `timetable_publications_term_id_fkey`
    FOREIGN KEY (`term_id`) REFERENCES `academic_terms`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- §18 extra classes are per config and outside every draft, but they are NOT
-- outside a term: a Saturday revision class runs in the term it was arranged
-- for. The cell key gains the term so Term 1 and Term 2 may each hold one.
ALTER TABLE `extra_classes`
  ADD COLUMN `term_id` INT NULL AFTER `timetable_config_id`,
  ADD COLUMN `term_scope` INT GENERATED ALWAYS AS (COALESCE(`term_id`, 0)) STORED NOT NULL AFTER `term_id`,
  DROP INDEX `uq_extra_class_cell`,
  ADD UNIQUE INDEX `uq_extra_class_cell`(`timetable_config_id`, `term_scope`, `class_section_id`, `day_of_week`, `period_number`),
  ADD CONSTRAINT `extra_classes_term_id_fkey`
    FOREIGN KEY (`term_id`) REFERENCES `academic_terms`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
