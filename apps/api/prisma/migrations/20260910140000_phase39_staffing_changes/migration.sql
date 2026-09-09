-- §29.2 — a staffing change: the scoped thaw, and the record of what it did.
--
-- A teacher resigns, goes on leave, or joins. Their classes have to go
-- somewhere without disturbing anybody else's week, and on a frozen timetable
-- (§29.1) nothing may be edited at all. So the release is not a flag on the
-- config — it is a RECORD of a change somebody is making, naming the teachers
-- it concerns, and it is the only thing allowed to write while frozen.
--
-- Modelled as a record rather than a mode for one reason: "who taught Class 5-A
-- Maths before September, and why did it move?" is a question a school asks,
-- and a mode that is switched on and off cannot answer it.

CREATE TABLE `staffing_changes` (
  `id`                  INT NOT NULL AUTO_INCREMENT,
  `timetable_config_id` INT NOT NULL,
  -- Why, in the school's words. An enum rather than free text because the
  -- reason chooses the DEFAULT shape of the change — a resignation releases
  -- everything the teacher holds, an adjustment releases what somebody picks —
  -- and free text cannot drive that. `note` is where the sentence goes.
  `reason`              ENUM('resigned','leave','joined','adjustment') NOT NULL,
  `status`              ENUM('planning','applied','reverted') NOT NULL DEFAULT 'planning',
  -- The date the school considers this effective. Recorded, never acted on: a
  -- change takes effect when somebody applies it, and a timetable that
  -- rewrote itself overnight on a date nobody was watching is precisely the
  -- behaviour §29 was asked not to have.
  `effective_from`      DATE NULL,
  `note`                VARCHAR(200) NULL,
  `created_by_id`       INT NULL,
  `created_at`          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `applied_by_id`       INT NULL,
  `applied_at`          DATETIME(3) NULL,
  `reverted_at`         DATETIME(3) NULL,
  `school_id`           INT NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `staffing_changes_school_id_idx` (`school_id`),
  INDEX `staffing_changes_config_idx` (`timetable_config_id`, `status`),
  CONSTRAINT `sch_config_fk` FOREIGN KEY (`timetable_config_id`) REFERENCES `timetable_config`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `sch_school_fk` FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Which teachers this change concerns, and on which side.
--
-- `releasing` means "take their classes off them"; `receiving` means "they may
-- be given work". A teacher is one or the other, never both — hence the
-- composite primary key with no room for a second row. Both roles at once is
-- not a shape the engine can score: a candidate has to have a settled load
-- before anything can be offered to them, and a teacher who is simultaneously
-- losing and gaining has two answers to "how full are they?".
CREATE TABLE `staffing_change_teachers` (
  `change_id`  INT NOT NULL,
  `teacher_id` INT NOT NULL,
  `role`       ENUM('releasing','receiving') NOT NULL,
  `school_id`  INT NOT NULL,
  PRIMARY KEY (`change_id`, `teacher_id`),
  INDEX `sct_school_id_idx` (`school_id`),
  INDEX `sct_teacher_idx` (`teacher_id`),
  CONSTRAINT `sct_change_fk` FOREIGN KEY (`change_id`) REFERENCES `staffing_changes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `sct_teacher_fk` FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `sct_school_fk` FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- What actually moved. Written by §29.4's apply; this is the undo record.
--
-- A real table rather than `auto_fix_runs`-style JSON, and the difference is
-- worth stating because that precedent is close: an auto-fix change is a
-- heterogeneous field-set replayed only as a unit, whereas every row here is
-- the SAME fact — this unit moved from teacher X to teacher Y — and it answers
-- a standing question ("who taught Class 5-A Maths last term?") that JSON
-- cannot index.
--
-- `unit_id` is polymorphic and has NO foreign key, which §4.7b argues against
-- for live rows and which is right for this one. An FK would delete the record
-- when its mapping is deleted — and a mapping being deleted is exactly the case
-- you most want the record for. Same reasoning as `substitution_log` pointing
-- at slot ids, and as `frozen_by_id` outliving the account that set it: history
-- must not be erased by a cascade.
CREATE TABLE `staffing_change_items` (
  `id`              INT NOT NULL AUTO_INCREMENT,
  `change_id`       INT NOT NULL,
  `unit_type`       ENUM('mapping','merged_group','elective_option','class_teacher') NOT NULL,
  `unit_id`         INT NOT NULL,
  -- A label frozen at the moment of the change ("Class 5-A · Mathematics"), so
  -- the record still reads in English after the section is renamed or the
  -- mapping deleted. Denormalised on purpose: the row has to survive its
  -- subject, and a join cannot.
  `label`           VARCHAR(120) NOT NULL,
  `from_teacher_id` INT NULL,
  `to_teacher_id`   INT NULL,
  `slot_count`      INT NOT NULL DEFAULT 0,
  `school_id`       INT NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_change_unit` (`change_id`, `unit_type`, `unit_id`),
  INDEX `sci_school_id_idx` (`school_id`),
  CONSTRAINT `sci_change_fk` FOREIGN KEY (`change_id`) REFERENCES `staffing_changes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `sci_school_fk` FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
