-- Phase 15 (§4.9) — when a split elective runs.
--
-- Until now the solver chose freely, so a school's third-language block landed
-- Mon P3, Tue P6, Wed P2 … A school that runs one language slot for a whole
-- grade needs it in a known place: everybody moves rooms at once.
--
--   solver      — today's behaviour, and the default so existing blocks are
--                 untouched by this migration.
--   same_period — the same period NUMBER on each of its days (P4 Mon-Fri).
--   fixed       — exact cells, named by the admin, pruned into the solver's
--                 domain before search (invariant 2) rather than scored.
--
-- `fixed_slots` is only read when placement = 'fixed': [{"day":1,"period":4}, …]
ALTER TABLE elective_blocks
  ADD COLUMN placement ENUM('solver', 'same_period', 'fixed') NOT NULL DEFAULT 'solver' AFTER max_periods_per_day,
  ADD COLUMN fixed_slots JSON NULL AFTER placement;
