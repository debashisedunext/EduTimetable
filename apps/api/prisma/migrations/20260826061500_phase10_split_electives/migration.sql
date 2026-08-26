-- Phase 10 (§4.9) — split electives: one shared slot, several parallel lessons.
--
-- `class_section_id` becomes nullable so an elective *option* row can exist
-- without belonging to a section. That is not a loophole, it is the same
-- deliberate use of NULL that `teacher_occupancy_key` already makes for merged
-- groups: MySQL unique indexes ignore NULLs, so option rows drop out of
-- `uq_class_slot` while every member section keeps exactly one guarded cell —
-- and `uq_teacher_slot` / `uq_room_slot` still catch a double-booked language
-- teacher or room, so invariant 1 keeps its teeth.
--
-- No existing row changes: every slot written before this migration is a member
-- row with a section, and widening NOT NULL to NULL rewrites nothing.
ALTER TABLE `timetable_slots`
  MODIFY COLUMN `class_section_id` INT NULL,
  ADD COLUMN `elective_block_id` INT NULL,
  ADD COLUMN `elective_option_id` INT NULL;

-- Reading a block's placements back (matrix, board, publish) always starts from
-- the config, so this only has to make the block lookup itself cheap.
CREATE INDEX `timetable_slots_elective_block_id_idx`
  ON `timetable_slots` (`elective_block_id`);

-- A block of 5 periods/week over 5 days means one a day; without a cap the
-- solver may legally stack all five on Monday.
ALTER TABLE `elective_blocks`
  ADD COLUMN `max_periods_per_day` INT NOT NULL DEFAULT 1;
