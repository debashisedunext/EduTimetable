-- §31.10 / §4.8 — may a consecutive block run through a break?
--
-- Until now it never could: `variables.ts` pruned any block whose first and
-- last period fell in different day segments, unconditionally, and Check 3
-- refused before Generate with "no block can ever fit" when the longest run in
-- the day was shorter than the block.
--
-- Both of those are right for a science practical, where the point of a double
-- period is the unbroken eighty minutes. They are wrong for a school that means
-- "let it run on across the short bell", or that is content with one period
-- either side of lunch.
--
-- FALSE is every school today and stays the default, so nothing that exists
-- changes behaviour. TRUE only ever WIDENS the domain — it permits a crossing,
-- it never requires one, so a block that fits inside a run still lands there.
ALTER TABLE `class_subjects`
  ADD COLUMN `block_may_cross_break` BOOLEAN NOT NULL DEFAULT FALSE
  AFTER `consecutive_blocks_per_week`;
