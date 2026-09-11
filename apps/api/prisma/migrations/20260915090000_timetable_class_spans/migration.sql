-- §33 — how many BASE periods one of a class's lessons occupies.
--
-- Class 1 on 30-minute periods and Class 10 on 60-minute periods, same start
-- and same finish, is ONE grid of eight 30-minute periods where Class 10's
-- lessons are double periods. `span` is that multiplier.
--
-- This is safe where §28.5's unaligned durations are not: `writer.ts` emits one
-- `timetable_slots` row per period in a span, so an hour holds period 1 AND
-- period 2 and `uq_teacher_slot` refuses a collision with either.
--
-- **No backfill.** Empty means "not stated", never span 0 (invariant 7), so
-- every class in every school today keeps span 1 — exactly what it has now.
CREATE TABLE `timetable_class_spans` (
  `timetable_config_id` INTEGER NOT NULL,
  `class_id` INTEGER NOT NULL,
  `span` INTEGER NOT NULL DEFAULT 1,
  `school_id` INTEGER NOT NULL,

  PRIMARY KEY (`timetable_config_id`, `class_id`),
  INDEX `timetable_class_spans_school_id_idx` (`school_id`),
  INDEX `timetable_class_spans_class_id_idx` (`class_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `timetable_class_spans`
  ADD CONSTRAINT `timetable_class_spans_timetable_config_id_fkey`
  FOREIGN KEY (`timetable_config_id`) REFERENCES `timetable_config`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `timetable_class_spans`
  ADD CONSTRAINT `timetable_class_spans_class_id_fkey`
  FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `timetable_class_spans`
  ADD CONSTRAINT `timetable_class_spans_school_id_fkey`
  FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
