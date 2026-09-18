-- §28.6 — minutes of changeover between one period and the next.
--
-- A school wanting five minutes for children to move rooms had to pad every
-- period's duration, which is a lie told to the curriculum, to the load
-- arithmetic and to the wall: a 30-minute lesson taught in a 35-minute slot.
--
-- Affects the CLOCK only. No row occupies the gap, so no grid gains a cell and
-- the solver — which places into period numbers — is untouched.
--
-- 0 is every school today, so nothing moves until somebody sets it.
ALTER TABLE `timetable_config`
  ADD COLUMN `period_gap_mins` SMALLINT NOT NULL DEFAULT 0 AFTER `period_duration_mins`;

-- §28.7 — the walk between wings.
--
-- `cross_wing_travel_mins` is how long it takes to reach THIS wing from another
-- in the same §30 pool; a pair of wings uses the larger of the two, so one
-- number per wing composes without a distance matrix nobody would fill in.
--
-- `cross_wing_rule` is the school's decision about what to do with it:
--   'prefer' — the solver avoids a back-to-back crossing but may still make one
--              when the alternative is an unplaced lesson (the default, and
--              what every school gets without touching anything);
--   'forbid' — it may not, ever.
ALTER TABLE `timetable_config`
  ADD COLUMN `cross_wing_travel_mins` SMALLINT NOT NULL DEFAULT 0 AFTER `period_gap_mins`,
  ADD COLUMN `cross_wing_rule` ENUM('prefer','forbid') NOT NULL DEFAULT 'prefer' AFTER `cross_wing_travel_mins`;
