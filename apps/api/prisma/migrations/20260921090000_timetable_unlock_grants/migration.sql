-- §29.8 — a published timetable is LOCKED, and an unlock is a scoped grant.
--
-- §29.1 gave a timetable one boolean-ish state: frozen or not, all or nothing.
-- That is right for "this week is settled" and useless for the thing a school
-- actually does next — one urgent change to Class 1-A, or replacing a teacher
-- who has resigned. The only way through was to unfreeze the entire timetable,
-- which protects nothing for as long as it takes to make the change.
--
-- ## The rule these tables store
--
-- An unlock names ENTITIES — class-sections and teachers, as many as the school
-- means to re-plan — and opens every lesson those entities appear in. A write
-- is admitted when every lesson it touches is open, and refused, by name, the
-- moment one is not:
--
--     open(row) = every teacher on it is unlocked
--              OR every class-section on it is unlocked
--
-- For a `timetable_slots` row that collapses to "its teacher or its section",
-- which is the whole enforcement model. For a mapping naming three sections it
-- means all three, because changing that one row changes all three weeks.
--
-- ## Why three tables and not one
--
-- Ticking four classes and two teachers is ONE decision, with one reason, one
-- author and one moment. Six independent unlock rows would give six copies of
-- the reason free to disagree, and no way to close the decision as one. So:
--
--   timetable_unlocks           the grant  — who, when, why, until
--   timetable_unlock_entities   what it opens
--   timetable_unlock_events     what it was actually used for
--
-- The third table is the half that makes the feature trustworthy. §29.2 already
-- had to learn this: a staffing change is a record, not a mode. An unlock that
-- was only a flag could never answer "what did we let through, and did it do
-- what the reason said?".

-- ─────────────────────────────────────────────────────────── the grant
CREATE TABLE `timetable_unlocks` (
  `id`                  INT NOT NULL AUTO_INCREMENT,
  `school_id`           INT NOT NULL,
  `timetable_config_id` INT NOT NULL,
  -- Required, and deliberately with no default. The record is the point: a
  -- grant whose reason could be blank is a grant that answers "why?" with
  -- silence six months later, which is exactly when the question is asked.
  `reason`              TEXT NOT NULL,
  `unlocked_by_id`      INT NULL,
  `unlocked_at`         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- NULL is "until somebody closes it". The app defaults it to a few hours,
  -- because an unlock left open is not a lock — but that is a default, not a
  -- rule, and a school that wants to close every grant by hand can.
  `expires_at`          DATETIME(3) NULL,
  -- Kept and marked, never deleted (§3.14's rule for withdrawal): deleting the
  -- row would erase the school's record of a change somebody authorised.
  `closed_at`           DATETIME(3) NULL,
  `closed_by_id`        INT NULL,
  PRIMARY KEY (`id`),
  -- The hot read is "does this timetable have a live grant?", asked on every
  -- guarded write. Partial indexes do not exist in MySQL, so the filter on
  -- closed_at/expires_at happens after this narrows to the config.
  INDEX `ix_unlock_live` (`school_id`, `timetable_config_id`, `closed_at`),
  CONSTRAINT `fk_unlock_school` FOREIGN KEY (`school_id`) REFERENCES `schools` (`id`),
  CONSTRAINT `fk_unlock_config` FOREIGN KEY (`timetable_config_id`) REFERENCES `timetable_config` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─────────────────────────────────────────────── what the grant opens
--
-- Two nullable foreign keys, NEVER a polymorphic `entity_id` + `entity_type`.
-- §4.7b made this call already and the argument is the same: an `entity_id`
-- costs the foreign key, and here the foreign key is what we want — an unlock
-- pointing at a teacher who has been deleted is meaningless, not historic. (The
-- opposite case is §29.2's `staffing_change_items`, which is deliberately
-- polymorphic *because* the record must outlive its rows.)
CREATE TABLE `timetable_unlock_entities` (
  `id`               INT NOT NULL AUTO_INCREMENT,
  `school_id`        INT NOT NULL,
  `unlock_id`        INT NOT NULL,
  -- Exactly one of these two is set. MySQL cannot state that as a constraint
  -- worth having (a CHECK can, but it cannot stop a second row naming neither),
  -- so UnlockService is the only writer and validates it — the same shape as
  -- §30's `ResourceGroupService`.
  `teacher_id`       INT NULL,
  `class_section_id` INT NULL,
  -- One entity may be relocked early without ending the grant. NULL is "still
  -- open", matching every other timestamp in this schema.
  `released_at`      DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  -- NULLs are distinct in a MySQL unique index, so these two keys coexist: the
  -- teacher rows all carry class_section_id = NULL and vice versa.
  UNIQUE KEY `uq_unlock_teacher` (`unlock_id`, `teacher_id`),
  UNIQUE KEY `uq_unlock_section` (`unlock_id`, `class_section_id`),
  CONSTRAINT `fk_unlock_ent_school` FOREIGN KEY (`school_id`) REFERENCES `schools` (`id`),
  CONSTRAINT `fk_unlock_ent_grant` FOREIGN KEY (`unlock_id`) REFERENCES `timetable_unlocks` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_unlock_ent_teacher` FOREIGN KEY (`teacher_id`) REFERENCES `teachers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_unlock_ent_section` FOREIGN KEY (`class_section_id`) REFERENCES `class_sections` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────────────────────────── what the grant was used for
CREATE TABLE `timetable_unlock_events` (
  `id`            BIGINT NOT NULL AUTO_INCREMENT,
  `school_id`     INT NOT NULL,
  `unlock_id`     INT NOT NULL,
  -- The operation, not the URL: `board.move`, `staffing.apply`. A URL changes
  -- when a route is renamed and takes the school's history with it.
  `route`         VARCHAR(96) NOT NULL,
  -- Denormalised prose, for §29.2's reason: the rows this describes may be gone
  -- by the time anybody reads it, and "3 lessons moved" with no names is not a
  -- record of anything.
  `summary`       VARCHAR(255) NOT NULL,
  -- The classes a teacher-scoped change reached into, and the teachers a
  -- class-scoped one dragged along. This is the honest half of §29.8's rule: a
  -- lesson has two owners, so opening one of them necessarily touches the
  -- other, and the record is where that is admitted rather than hidden.
  `also_affected` JSON NULL,
  `actor_id`      INT NULL,
  `at`            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `ix_unlock_event_grant` (`unlock_id`, `at`),
  CONSTRAINT `fk_unlock_ev_school` FOREIGN KEY (`school_id`) REFERENCES `schools` (`id`),
  CONSTRAINT `fk_unlock_ev_grant` FOREIGN KEY (`unlock_id`) REFERENCES `timetable_unlocks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────────────────────────────────── publish becomes the lock
--
-- §29.1 said in as many words that "a freeze is a decision rather than a side
-- effect of publishing". That is now reversed, deliberately, for the reason
-- §29.1 itself gives: the printed copy in every classroom becomes a second
-- source of truth the moment it is printed, not the moment somebody remembers
-- to press a button.
--
-- Default TRUE, so nobody has to discover a setting in order to be protected by
-- it. A school that wants the old behaviour turns it off, and the schools that
-- exist today keep whatever `frozen_at` they already have — this column changes
-- nothing until the next publish.
ALTER TABLE `schools`
  ADD COLUMN `lock_on_publish` TINYINT(1) NOT NULL DEFAULT 1;
