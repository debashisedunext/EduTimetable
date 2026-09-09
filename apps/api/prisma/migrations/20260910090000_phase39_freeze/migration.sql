-- §29.1 — a published timetable can be FROZEN.
--
-- Publishing puts a week on the wall; freezing says it is settled. While a
-- timetable is frozen nothing may change what it teaches, who teaches it, or
-- when — because every one of those would leave the printed copy in every
-- classroom quietly wrong, and nobody would know which of the two was true.
--
-- Two columns, not a status enum. `status` on `timetable_config` already means
-- something else (draft/active/archived), and a second meaning on one column is
-- how a field ends up unable to say "archived AND frozen". A timestamp also
-- answers *when*, which a boolean cannot, and that is the first thing anybody
-- asks of a change they did not make.
--
-- NULL is "not frozen", which is every timetable that exists today: this
-- migration changes no behaviour anywhere until somebody presses the button.
-- That is deliberate — freezing is a decision a school makes, never a side
-- effect of publishing (§29.1).
ALTER TABLE `timetable_config`
  ADD COLUMN `frozen_at` DATETIME(3) NULL,
  -- No foreign key, matching `timetable_publications.published_by_id`: this is
  -- a record of who acted, and it must survive that person's account being
  -- removed. A cascade here would erase the school's own history of the change.
  ADD COLUMN `frozen_by_id` INT NULL;
