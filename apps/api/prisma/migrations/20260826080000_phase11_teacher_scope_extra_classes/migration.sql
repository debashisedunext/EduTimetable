-- Phase 11 (§18) — teaching scope, employment type, and extra classes.

-- ---------------------------------------------------------------- teachers --
ALTER TABLE `teachers`
  ADD COLUMN `employment_type` ENUM('permanent','adhoc','guest') NOT NULL DEFAULT 'permanent';

-- Which classes a teacher may be given at all. A set, not a range: the PE
-- teacher covers Nursery and Class 12, and a range cannot say that.
CREATE TABLE `teacher_class_eligibility` (
  `teacher_id` INT NOT NULL,
  `class_id` INT NOT NULL,
  `school_id` INT NOT NULL,
  PRIMARY KEY (`teacher_id`, `class_id`),
  INDEX `teacher_class_eligibility_school_id_idx` (`school_id`),
  CONSTRAINT `tce_teacher_fk` FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `tce_class_fk` FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `tce_school_fk` FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Backfill from what each teacher already teaches, so the rule starts out
-- describing reality rather than refusing it. Four sources, because a teacher
-- can be attached to a class through any of them.
INSERT IGNORE INTO `teacher_class_eligibility` (`teacher_id`, `class_id`, `school_id`)
SELECT DISTINCT m.`teacher_id`, cs.`class_id`, m.`school_id`
FROM `teacher_subject_class_section` m
JOIN `class_sections` cs ON cs.`id` = m.`class_section_id`;

INSERT IGNORE INTO `teacher_class_eligibility` (`teacher_id`, `class_id`, `school_id`)
SELECT DISTINCT g.`teacher_id`, cs.`class_id`, g.`school_id`
FROM `merged_teaching_groups` g
JOIN `merged_teaching_group_members` mm ON mm.`merged_group_id` = g.`id`
JOIN `class_sections` cs ON cs.`id` = mm.`class_section_id`;

INSERT IGNORE INTO `teacher_class_eligibility` (`teacher_id`, `class_id`, `school_id`)
SELECT DISTINCT o.`teacher_id`, cs.`class_id`, o.`school_id`
FROM `elective_options` o
JOIN `elective_block_members` bm ON bm.`elective_block_id` = o.`elective_block_id`
JOIN `class_sections` cs ON cs.`id` = bm.`class_section_id`;

INSERT IGNORE INTO `teacher_class_eligibility` (`teacher_id`, `class_id`, `school_id`)
SELECT DISTINCT cs.`class_teacher_id`, cs.`class_id`, cs.`school_id`
FROM `class_sections` cs
WHERE cs.`class_teacher_id` IS NOT NULL;

-- ------------------------------------------------------- the extra window --
-- Appended after the teaching day. The solver places only into
-- 1..periods_per_day, so this is free space by construction rather than by a
-- new rule it has to remember.
ALTER TABLE `timetable_config`
  ADD COLUMN `extra_periods_per_day` INT NOT NULL DEFAULT 0,
  ADD COLUMN `extra_period_duration_mins` INT NULL,
  ADD COLUMN `extra_days` JSON NULL;

ALTER TABLE `periods`
  ADD COLUMN `is_extra` BOOLEAN NOT NULL DEFAULT false;

-- `extra` joins auto/manual/substitute: same table, same three unique keys, so
-- an extra class still cannot double-book a teacher or a room.
ALTER TABLE `timetable_slots`
  MODIFY COLUMN `source` ENUM('auto','manual','substitute','extra') NOT NULL DEFAULT 'auto';

-- --------------------------------------------------------- extra classes --
CREATE TABLE `extra_classes` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `school_id` INT NOT NULL,
  `timetable_config_id` INT NOT NULL,
  `class_section_id` INT NOT NULL,
  `subject_id` INT NOT NULL,
  `teacher_id` INT NOT NULL,
  `room_id` INT NULL,
  `day_of_week` TINYINT NOT NULL,
  `period_number` INT NOT NULL,
  `reason` VARCHAR(160) NULL,
  `effective_from` DATE NULL,
  `effective_to` DATE NULL,
  `created_by` INT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_extra_class_cell` (`timetable_config_id`, `class_section_id`, `day_of_week`, `period_number`),
  INDEX `extra_classes_school_id_idx` (`school_id`),
  CONSTRAINT `extra_school_fk` FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `extra_config_fk` FOREIGN KEY (`timetable_config_id`) REFERENCES `timetable_config`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `extra_cs_fk` FOREIGN KEY (`class_section_id`) REFERENCES `class_sections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `extra_subject_fk` FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `extra_teacher_fk` FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `extra_room_fk` FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
