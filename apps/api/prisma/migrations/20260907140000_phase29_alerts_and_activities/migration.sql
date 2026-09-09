-- §28 Phase 29 — two generation settings and a third kind of band in the day.
--
-- 1. `load_alert_pct` replaces the hardcoded 0.75 in the shared load module.
--    A WARNING threshold, never a blocker: a teacher at 80% is a normally
--    employed teacher, and refusing to generate at a number a school chose for
--    its own reporting would make most real schools ungenerable.
--
-- 2. `daily_activities` — assembly, attendance, bus dispersal. One table for
--    both ends of the day, because an assembly and a dispersal differ only in
--    `placement`; two tables would duplicate every rule about duration, days
--    and staffing so that the two could eventually disagree.
--
--    The load-bearing property: an activity sits OUTSIDE `1..periods_per_day`,
--    so `domainFor` cannot reach it — exactly as it cannot reach the §18 extra
--    window. That is what keeps the solver untouched by this phase. The moment
--    an activity could overlap a teaching period, the teacher on duty becomes a
--    real occupancy conflict and `uq_teacher_slot` could not see it, because
--    that key compares period NUMBERS. Do not widen the domain to include them.

ALTER TABLE `timetable_config`
  ADD COLUMN `load_alert_pct` INT NOT NULL DEFAULT 75;

CREATE TABLE `daily_activities` (
  `id`                  INT NOT NULL AUTO_INCREMENT,
  `timetable_config_id` INT NOT NULL,
  `name`                VARCHAR(60) NOT NULL,
  -- Which end of the day. An enum rather than a boolean because "after the
  -- last period" and "before the first" are not opposites of one thing —
  -- a later phase may well want "after a named break".
  `placement`           ENUM('before_first', 'after_last') NOT NULL,
  `duration_mins`       INT NOT NULL,
  -- The working days it runs on, as a JSON array of ISO day numbers. Assembly
  -- on Monday only is the ordinary case, not an edge case.
  `days`                JSON NOT NULL,
  -- Who is on duty, and where. Both nullable: a school that has not decided
  -- yet still wants the band on the timetable, and "not stated" must not read
  -- as "nobody" (the §18 rule about empty scopes).
  `teacher_id`          INT NULL,
  `room_id`             INT NULL,
  `sort_order`          INT NOT NULL DEFAULT 0,
  `is_active`           TINYINT(1) NOT NULL DEFAULT 1,
  `school_id`           INT NOT NULL,
  `created_at`          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  -- The natural key, so the §16 importer can be idempotent by name the way
  -- every other sheet is: re-running a commit must not create a second
  -- assembly.
  UNIQUE INDEX `uq_activity_name` (`timetable_config_id`, `name`),
  INDEX `daily_activities_school_id_idx` (`school_id`),
  INDEX `daily_activities_config_idx` (`timetable_config_id`),

  CONSTRAINT `daily_activities_config_fk` FOREIGN KEY (`timetable_config_id`)
    REFERENCES `timetable_config`(`id`) ON DELETE CASCADE,
  CONSTRAINT `daily_activities_teacher_fk` FOREIGN KEY (`teacher_id`)
    REFERENCES `teachers`(`id`) ON DELETE SET NULL,
  CONSTRAINT `daily_activities_room_fk` FOREIGN KEY (`room_id`)
    REFERENCES `rooms`(`id`) ON DELETE SET NULL,
  CONSTRAINT `daily_activities_school_fk` FOREIGN KEY (`school_id`)
    REFERENCES `schools`(`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The period row an activity produces. A third band beside `is_break` and
-- `is_extra`, rather than a flavour of break: a break is unstaffed by
-- definition, and the whole point of an activity is that somebody is on duty.
ALTER TABLE `periods`
  ADD COLUMN `is_activity` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `activity_id` INT NULL,
  ADD CONSTRAINT `periods_activity_fk` FOREIGN KEY (`activity_id`)
    REFERENCES `daily_activities`(`id`) ON DELETE CASCADE;
