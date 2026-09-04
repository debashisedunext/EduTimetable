-- Phase 27 (§26.2) — what a subject is, and where in the day it belongs.
--
-- Four columns on `subjects` rather than on `class_subjects`, because these are
-- facts about the SUBJECT: "Games is not taught straight after lunch" is true
-- of Games, not of Class 5's Games. The curriculum row already owns the
-- per-class facts (how many periods, how many a day, block size).
--
-- Every default reproduces today's behaviour exactly — priority 3 is the
-- neutral middle, `any` is no restriction, and the gap rule is off. A school
-- that upgrades and changes nothing generates precisely the timetable it
-- generated before.

ALTER TABLE `subjects`
  -- Scholastic vs co-scholastic. A classification the school recognises: it
  -- groups reports, and it is what makes the intelligent defaults defensible
  -- (a co-scholastic subject is the one that yields the morning periods).
  ADD COLUMN `category` ENUM('scholastic', 'co_scholastic') NOT NULL DEFAULT 'scholastic' AFTER `code`,

  -- 1..5, higher is earlier in the day. Deliberately a PREFERENCE, not a rule:
  -- "Maths must be in period 1" cannot hold for twenty sections at once, so as
  -- a hard constraint it would make every real school infeasible. It becomes a
  -- term in the §5.6 objective, which the CSP's value ordering and CP-SAT both
  -- read, so the two engines cannot disagree about what "nicer" means.
  ADD COLUMN `priority` TINYINT NOT NULL DEFAULT 3 AFTER `category`,

  -- Which side of lunch the subject may be taught. HARD (§26.3): pruned out of
  -- the domain before search, and checked by Feasibility Check 10 before a
  -- generation is allowed to start.
  ADD COLUMN `lunch_rule` ENUM('any', 'before', 'after') NOT NULL DEFAULT 'any' AFTER `priority`,

  -- May not occupy the period IMMEDIATELY after lunch. Games and Dance cannot
  -- be held on a full stomach, and a school expresses that as "leave a period
  -- in between" — which is a different rule from `lunch_rule = after`, and both
  -- are commonly wanted together.
  ADD COLUMN `gap_after_lunch` BOOLEAN NOT NULL DEFAULT FALSE AFTER `lunch_rule`;
