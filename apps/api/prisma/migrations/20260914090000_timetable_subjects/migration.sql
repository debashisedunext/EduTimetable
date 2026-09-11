-- §32 — which subjects a TIMETABLE teaches.
--
-- `subjects` is school-wide and stays that way. What differs between timetables
-- is which of them a given week actually runs: a Junior wing that does not
-- teach Chemistry, an individual timetable set up for a handful of languages.
--
-- **No backfill, deliberately.** Empty means "not stated", never "teaches
-- nothing" (invariant 7), so every timetable that exists today has no rows and
-- keeps seeing every subject — exactly what it sees now. Backfilling every
-- timetable with every subject would look identical on the first screen and be
-- wrong the moment somebody adds a subject: a new subject would silently belong
-- to no timetable, because every timetable had already "stated" its list.
--
-- Per `timetable_config_id`, not per `resource_group_id`: two grouped wings
-- share a pool and are the case that motivates this.
CREATE TABLE `timetable_subjects` (
  `timetable_config_id` INTEGER NOT NULL,
  `subject_id` INTEGER NOT NULL,
  `school_id` INTEGER NOT NULL,

  PRIMARY KEY (`timetable_config_id`, `subject_id`),
  INDEX `timetable_subjects_school_id_idx` (`school_id`),
  INDEX `timetable_subjects_subject_id_idx` (`subject_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `timetable_subjects`
  ADD CONSTRAINT `timetable_subjects_timetable_config_id_fkey`
  FOREIGN KEY (`timetable_config_id`) REFERENCES `timetable_config`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `timetable_subjects`
  ADD CONSTRAINT `timetable_subjects_subject_id_fkey`
  FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `timetable_subjects`
  ADD CONSTRAINT `timetable_subjects_school_id_fkey`
  FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
