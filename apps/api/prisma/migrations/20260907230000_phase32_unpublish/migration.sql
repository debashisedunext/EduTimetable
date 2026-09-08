-- §3.14 — withdrawing a published timetable, recorded rather than erased.
--
-- Publishing wrote a `timetable_publications` row and there was no way back:
-- the only route out was to publish something else. That left two screens
-- telling schools to do something they could not do — §27.11's reset and
-- §27.15's cell delete both refuse a published timetable with "unpublish it
-- first", which was advice about a button that did not exist.
--
-- Withdrawal is a fact about a version, not the absence of one. Deleting the
-- publication row would make v3 disappear and the next publish would be v3
-- again, so a school's own record of "what was on the wall in September" would
-- quietly change. The version stays and is marked withdrawn.

ALTER TABLE `timetable_publications`
  ADD COLUMN `withdrawn_at` DATETIME(3) NULL AFTER `published_at`,
  ADD COLUMN `withdrawn_by_id` INT NULL AFTER `withdrawn_at`;
