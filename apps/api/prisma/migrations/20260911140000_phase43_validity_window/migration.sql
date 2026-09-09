-- §30.5 — when a timetable applies, and the rule that follows from it.
--
-- Two timetables may now cover the same children (§30.1 gave each pool its own
-- cohort rows). That is only safe if at most one of them is LIVE for those
-- children at a time — otherwise a school publishes two timetables for Class 1
-- and nothing in the app says which one a Tuesday in July belongs to.
--
-- So a timetable says when it applies, and publishing checks by CLASS:
--
--     Timetable 1 · Class 1-3 · 01 Apr – 30 Jun   ┐ both publishable,
--     Timetable 2 · Class 1-4 · 01 Jul – 31 Aug   ┘ the windows are disjoint
--
--     Timetable 1 · Class 1-3 · 01 Apr – 31 Aug   ┐ refused: Class 1, 2 and 3
--     Timetable 2 · Class 1-4 · 01 Jul – 31 Aug   ┘ would be live in both
--
-- **Both columns are NULL for every existing school, and NULL means the whole
-- session.** That is what makes this rule unable to fire on existing data: two
-- configs cannot share a class today at all, because a class-section belongs to
-- one config and, before §30, existed once per school-year.
--
-- Deliberately NOT reusing §25's `academic_terms`. A term is a dated span too,
-- but §25 states that "a session is term-wise if and only if it has term rows",
-- so creating terms in order to date a timetable would flip that school's whole
-- app into term-wise mode — term selectors, per-term publishing, the Board
-- loading one term at a time. They also answer different questions at different
-- levels, which is what stops them competing:
--
--     academic year   the session
--     this window     WHICH timetable is live for these children, over these dates
--     term (§25)      WHICH SHAPE of week that timetable uses, within itself

ALTER TABLE `timetable_config`
  -- DATE, not DATETIME: a timetable applies to a day, and a timestamp would
  -- invite a question about what happens at 14:30 on the boundary that the rest
  -- of the system has no way to answer.
  ADD COLUMN `effective_from` DATE NULL AFTER `resource_group_id`,
  ADD COLUMN `effective_to`   DATE NULL AFTER `effective_from`;

-- Publishing asks "which other timetables are live, and when" for every class
-- this one teaches. That query walks publications by config and filters the
-- withdrawn ones out (§3.14 keeps the row and marks it), so it wants an index
-- that starts where it starts.
CREATE INDEX `tp_live_idx` ON `timetable_publications` (`timetable_config_id`, `withdrawn_at`);

-- And the window itself, for the "who else is live over these dates" half.
CREATE INDEX `tc_window_idx` ON `timetable_config` (`resource_group_id`, `effective_from`, `effective_to`);
