-- Phase 13 (§20) — minimum periods per day per teacher.
--
-- A teacher who comes in for a single period has spent a commute on one
-- lesson. `max_periods_per_day` has always guarded the top of the range;
-- nothing guarded the bottom, so the solver was free to smear a light load
-- one period at a time across all five days.
--
-- The default is 3, applied to existing rows as well as new ones: this is a
-- rule about how a school runs, not a per-teacher exception, so silently
-- leaving old teachers at "no minimum" would mean the setting appeared to be
-- on and did nothing. Where 3 cannot be met (a teacher with two periods in the
-- whole week), Feasibility Check 10 says so and the solver uses what is
-- actually achievable — it never refuses to generate over this.
ALTER TABLE `teachers`
  ADD COLUMN `min_periods_per_day` INT NOT NULL DEFAULT 3 AFTER `max_periods_per_day`;
