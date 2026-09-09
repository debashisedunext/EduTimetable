-- §4.7b — time off for a class, a subject and a room, beside the teacher's.
--
-- §4.7a gave TEACHERS a hard availability grid: one row per blocked cell,
-- `period_number = NULL` meaning the whole day, pruned out of the domain before
-- search. Three other things in a school have exactly the same kind of fact and
-- had no way to say it:
--
--   * a CLASS is not in school then (a half-day, a wing that starts late),
--   * a SUBJECT may not be taught then (no games in period 1),
--   * a ROOM cannot be used then (the hall is booked, the lab is being cleaned).
--
-- THREE TABLES, NOT ONE POLYMORPHIC TABLE. An `entity_type`/`entity_id` pair
-- would save two migrations and cost the foreign key: a blocked cell pointing at
-- a teacher who has been deleted is invisible to the database and becomes a
-- constraint nobody can find. It would also make the §23 sync cascades unable
-- to name what they delete, which §23.7 requires. The shape is identical in all
-- four, and one module reads them into one structure — the sameness lives in
-- the code that uses them, not in a column that erases what a row is about.
--
-- The class-section one is the load-bearing one: it REDUCES THE WEEK. Check 1
-- computes `available = days × periods`, so without subtracting these a class
-- with Friday afternoon off still looks like it has 40 slots — Readiness would
-- say 100%, and the solver would then fail to place a curriculum that no longer
-- fits. Time off is not a preference; it makes the week smaller.

CREATE TABLE `class_section_unavailability` (
  `id`               INT NOT NULL AUTO_INCREMENT,
  `class_section_id` INT NOT NULL,
  `day_of_week`      TINYINT NOT NULL,
  -- NULL = the whole day, so a blocked Friday survives the timetable gaining
  -- a period. That is why this is nullable rather than a row per cell.
  `period_number`    INT NULL,
  `reason`           VARCHAR(100) NULL,
  `school_id`        INT NOT NULL,

  PRIMARY KEY (`id`),
  INDEX `class_section_unavail_school_idx` (`school_id`),
  INDEX `class_section_unavail_section_idx` (`class_section_id`),
  CONSTRAINT `class_section_unavail_section_fk` FOREIGN KEY (`class_section_id`)
    REFERENCES `class_sections`(`id`) ON DELETE CASCADE,
  CONSTRAINT `class_section_unavail_school_fk` FOREIGN KEY (`school_id`)
    REFERENCES `schools`(`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `subject_unavailability` (
  `id`            INT NOT NULL AUTO_INCREMENT,
  `subject_id`    INT NOT NULL,
  `day_of_week`   TINYINT NOT NULL,
  `period_number` INT NULL,
  `reason`        VARCHAR(100) NULL,
  `school_id`     INT NOT NULL,

  PRIMARY KEY (`id`),
  INDEX `subject_unavail_school_idx` (`school_id`),
  INDEX `subject_unavail_subject_idx` (`subject_id`),
  CONSTRAINT `subject_unavail_subject_fk` FOREIGN KEY (`subject_id`)
    REFERENCES `subjects`(`id`) ON DELETE CASCADE,
  CONSTRAINT `subject_unavail_school_fk` FOREIGN KEY (`school_id`)
    REFERENCES `schools`(`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `room_unavailability` (
  `id`            INT NOT NULL AUTO_INCREMENT,
  `room_id`       INT NOT NULL,
  `day_of_week`   TINYINT NOT NULL,
  `period_number` INT NULL,
  `reason`        VARCHAR(100) NULL,
  `school_id`     INT NOT NULL,

  PRIMARY KEY (`id`),
  INDEX `room_unavail_school_idx` (`school_id`),
  INDEX `room_unavail_room_idx` (`room_id`),
  CONSTRAINT `room_unavail_room_fk` FOREIGN KEY (`room_id`)
    REFERENCES `rooms`(`id`) ON DELETE CASCADE,
  CONSTRAINT `room_unavail_school_fk` FOREIGN KEY (`school_id`)
    REFERENCES `schools`(`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
