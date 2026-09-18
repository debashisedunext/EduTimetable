-- §34 — a weekday that runs a different shape from the rest of the week.
--
-- A short Saturday: six periods of thirty minutes where Monday to Friday run
-- eight of forty. `periods_per_day` and `period_duration_mins` belong to the
-- `timetable_config`, so they belonged to every working day at once.
--
-- Safe where §28.5's per-class durations are not: `day_of_week` is already part
-- of `uq_teacher_slot`, so Saturday's period 3 and Monday's are different cells
-- today and nobody is in two days at once. §28.5's collision is WITHIN a day.
--
-- **No backfill.** Empty means "the same as every other day" (invariant 7), so
-- every day of every school today keeps the config's shape.
CREATE TABLE `timetable_day_shapes` (
  `timetable_config_id` INTEGER NOT NULL,
  `day_of_week` TINYINT NOT NULL,
  `periods_per_day` INTEGER NOT NULL,
  `period_duration_mins` INTEGER NOT NULL,
  `school_id` INTEGER NOT NULL,

  PRIMARY KEY (`timetable_config_id`, `day_of_week`),
  INDEX `timetable_day_shapes_school_id_idx` (`school_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `timetable_day_shapes`
  ADD CONSTRAINT `timetable_day_shapes_timetable_config_id_fkey`
  FOREIGN KEY (`timetable_config_id`) REFERENCES `timetable_config`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `timetable_day_shapes`
  ADD CONSTRAINT `timetable_day_shapes_school_id_fkey`
  FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
