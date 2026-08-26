-- Phase 12 (§19) — rooms that are actually assigned.
--
-- `class_sections.home_room_id` has existed since Phase 1 and the solver has
-- never read it: every ordinary lesson was written with `room_id = NULL`, so a
-- school that carefully recorded which room Class 1-A sits in got a timetable
-- that never mentioned it. And `findFreeLab` took *any* free lab, so a Biology
-- period could be sent to the physics lab because it happened to be empty.
--
-- This table fixes the second half: which subjects a room serves. A lab with no
-- rows here is a general lab and still serves any lab subject, so existing
-- schools keep working exactly as before until they say otherwise.
CREATE TABLE `room_subjects` (
  `room_id` INT NOT NULL,
  `subject_id` INT NOT NULL,
  `school_id` INT NOT NULL,
  PRIMARY KEY (`room_id`, `subject_id`),
  INDEX `room_subjects_school_id_idx` (`school_id`),
  CONSTRAINT `rs_room_fk` FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `rs_subject_fk` FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `rs_school_fk` FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- A room named for a subject almost certainly serves it. Matching on the room
-- name is a guess, so it is deliberately narrow: the subject's name must appear
-- in the room's, and only lab rooms are considered. Anything it misses stays a
-- general lab, which is the old behaviour.
INSERT IGNORE INTO `room_subjects` (`room_id`, `subject_id`, `school_id`)
SELECT r.`id`, s.`id`, r.`school_id`
  FROM `rooms` r
  JOIN `subjects` s ON s.`school_id` = r.`school_id`
 WHERE r.`room_type` = 'lab'
   AND LOWER(r.`name`) LIKE CONCAT('%', LOWER(s.`name`), '%');
