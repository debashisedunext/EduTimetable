-- §30 stage 1 — the resource group: the pool a timetable draws its cohorts from.
--
-- Today every timetable in a school-year implicitly shares one pool: a
-- class-section belongs to exactly one `timetable_config` (invariant 11) and a
-- teacher's weekly load is summed across every config in the year (Check 2).
-- That is the *only* coupling between two timetables, and it is unnamed — which
-- is why there is no way to say "this timetable is on its own".
--
-- Naming the pool is what makes both answers expressible:
--
--   * `grouped`    — several timetables share cohorts and staff capacity. Today.
--   * `individual` — one timetable, its own cohorts, calculated alone. New.
--
-- Invariant 11 is GENERALISED, not broken:
--     before: a class-section belongs to exactly one timetable_config
--     after:  WITHIN A RESOURCE GROUP, a class-section belongs to exactly one
--             timetable_config
--
-- With one group per school-year — which is exactly what the backfill below
-- creates — those two sentences say the same thing, and every school behaves
-- byte-for-byte as it did before. That property is the whole point of this
-- migration: a flag would have to be interpreted at every call site, whereas a
-- pool is a narrower WHERE.

CREATE TABLE `timetable_groups` (
  `id`               INT NOT NULL AUTO_INCREMENT,
  `school_id`        INT NOT NULL,
  -- The pool is per session, because everything it scopes already is: a
  -- class-section is keyed by academic year (§3.11) and cross-config teacher
  -- load is summed within a year. A pool spanning two sessions would have to
  -- answer "is Class 1-A taken?" for a year nobody asked about.
  `academic_year_id` INT NOT NULL,
  `name`             VARCHAR(60) NOT NULL,
  -- `individual` is a pool that holds exactly ONE timetable and refuses a
  -- second. That refusal is the whole of "an individual timetable cannot have
  -- more than one wing" — expressed where it is checkable, rather than as a
  -- rule the Wings step has to remember.
  `mode`             ENUM('grouped','individual') NOT NULL DEFAULT 'grouped',
  `created_at`       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_group_name` (`school_id`, `academic_year_id`, `name`),
  INDEX `timetable_groups_school_id_idx` (`school_id`),
  INDEX `timetable_groups_year_idx` (`academic_year_id`),
  CONSTRAINT `tg_school_fk` FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  -- CASCADE, matching `academic_terms`: deleting a session takes its pools with
  -- it, and a pool outliving its session could never be reached again.
  CONSTRAINT `tg_year_fk` FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One pool per session, for EVERY session — not only those that currently hold
-- a timetable. A session with no timetables yet still needs somewhere for the
-- first one to land, and creating the pool lazily would put a second writer of
-- this row in the application.
INSERT INTO `timetable_groups` (`school_id`, `academic_year_id`, `name`, `mode`)
SELECT `school_id`, `id`, 'Main', 'grouped' FROM `academic_years`;

-- ── timetable_config ────────────────────────────────────────────────────────
--
-- Added nullable, backfilled, then made NOT NULL. The three steps are not
-- ceremony: a NOT NULL column with no default cannot be added to a table that
-- already has rows, and a DEFAULT would leave a wrong pool on every existing
-- timetable if the backfill were ever skipped.

ALTER TABLE `timetable_config` ADD COLUMN `resource_group_id` INT NULL AFTER `academic_year_id`;

UPDATE `timetable_config` c
  JOIN `timetable_groups` g
    ON g.`academic_year_id` = c.`academic_year_id` AND g.`school_id` = c.`school_id`
  SET c.`resource_group_id` = g.`id`;

ALTER TABLE `timetable_config` MODIFY COLUMN `resource_group_id` INT NOT NULL;
ALTER TABLE `timetable_config`
  ADD INDEX `timetable_config_group_idx` (`resource_group_id`),
  ADD CONSTRAINT `tc_group_fk` FOREIGN KEY (`resource_group_id`) REFERENCES `timetable_groups`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── class_sections ──────────────────────────────────────────────────────────
--
-- The pool OWNS the cohort row; `timetable_config_id` keeps meaning "which
-- timetable in this pool teaches it", and NULL still means "not attached yet".
-- Reading it that way is what makes an unattached section belong somewhere at
-- all — it is available to the pool, not to the school.

ALTER TABLE `class_sections` ADD COLUMN `resource_group_id` INT NULL AFTER `academic_year_id`;

UPDATE `class_sections` cs
  JOIN `timetable_groups` g
    ON g.`academic_year_id` = cs.`academic_year_id` AND g.`school_id` = cs.`school_id`
  SET cs.`resource_group_id` = g.`id`;

ALTER TABLE `class_sections` MODIFY COLUMN `resource_group_id` INT NOT NULL;

-- The key that carries the whole feature. `(class, section, year)` said Class
-- 1-A exists once in a school-year; `(class, section, year, pool)` says it
-- exists once PER POOL — which is what lets an individual timetable have its
-- own Class 1-A, with its own class teacher, home room and Maths teacher.
--
-- Dropped and re-created rather than added alongside: leaving the old key would
-- make the new one unreachable, and the failure would be a school unable to
-- create the second Class 1-A with no clue why.
ALTER TABLE `class_sections`
  DROP INDEX `class_sections_class_id_section_id_academic_year_id_key`,
  ADD UNIQUE KEY `uq_section_in_group` (`class_id`, `section_id`, `academic_year_id`, `resource_group_id`),
  ADD INDEX `class_sections_group_idx` (`resource_group_id`),
  ADD CONSTRAINT `cs_group_fk` FOREIGN KEY (`resource_group_id`) REFERENCES `timetable_groups`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
