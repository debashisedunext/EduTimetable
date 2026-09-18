-- `classes.sequence` is the ladder position. Repair the schools where it is not.
--
-- The column had two vocabularies. `planClasses` (the guided setup) wrote the
-- CLASS_LADDER position; `POST /classes`, the §16 importer and the §23 ERP sync
-- all defaulted to 0; and `scripts/school2-model.cjs` hand-numbered a school
-- with no LKG or UKG from 1 to 14. They met: adding an LKG through the guided
-- setup gave it sequence 3, which Class 1 already held, and every screen that
-- orders by `[{class: {sequence}}, {section: {name}}]` then drew the tie in
-- whatever order MySQL felt like — LKG-A, Class 1-A, Class 1-B, LKG-B on the
-- Master Grid.
--
-- It is not only an ordering. `bandOf` and `subjectSuitsClass` compare this
-- number against ABSOLUTE ladder positions to decide which subjects a class is
-- offered, so a school numbered 1..14 with no LKG had Class 9 reading as
-- "upper" rather than "senior" long before anything looked wrong on a screen.
-- Closing the gaps would not have fixed that; only the ladder position does.
--
-- ## Only schools whose every class is on the ladder
--
-- `FIELD()` returns the 1-based position of a value in its list, and 0 when it
-- is not there — so the HAVING clause below means "no class in this school has
-- a name the ladder does not know". A school with a Playgroup or a Grade 5R is
-- left completely alone: we know where Class 7 belongs and we do not know where
-- Playgroup belongs, and reordering somebody's own vocabulary on a guess is
-- worse than the tie this is fixing. The `classSequence` helper stops those
-- schools acquiring a collision from here on.
--
-- For every school this does touch, the relative order either stays exactly as
-- it was (the classes were already in ladder order, only differently numbered)
-- or was undefined (the tie). No school that was reading correctly changes.
UPDATE classes c
JOIN (
  SELECT school_id
  FROM classes
  GROUP BY school_id
  HAVING SUM(
    FIELD(name,
      'Pre-Nursery', 'Nursery', 'LKG', 'UKG',
      'Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6',
      'Class 7', 'Class 8', 'Class 9', 'Class 10', 'Class 11', 'Class 12'
    ) = 0
  ) = 0
) fully_on_ladder ON fully_on_ladder.school_id = c.school_id
SET c.sequence = FIELD(c.name,
  'Pre-Nursery', 'Nursery', 'LKG', 'UKG',
  'Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6',
  'Class 7', 'Class 8', 'Class 9', 'Class 10', 'Class 11', 'Class 12'
);
