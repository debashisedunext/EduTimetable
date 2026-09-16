-- §36 — a lesson pinned to a cell before the timetable is generated.
--
-- The school says "Class 1-A does Mathematics with Puja Sri on Monday period 2"
-- and the solver has to honour it, then build the rest of the week around it.
--
-- ## Keyed to the TIMETABLE, not to a draft
--
-- `timetable_slots.is_locked` already pins a placement, and it is deliberately
-- not this: a locked slot belongs to ONE draft (§22), so generating a second
-- draft would ignore every pin. This is the school's standing intention and has
-- to survive every regeneration into any draft.
--
-- ## Not a slot, either
--
-- Nothing here is written into `timetable_slots`. A fixed lesson becomes DOMAIN
-- PRUNING (invariant 2): the solver variable for that occurrence is handed
-- exactly this cell, and the solver then places it — which is what keeps the
-- room assignment, the occupancy keys and the §20 shape rules working, rather
-- than a row inserted behind the engine's back.
--
-- ## `room_id` is nullable, and NULL is not "anywhere"
--
-- It means the school did not name a room, so the solver picks by the §19
-- ladder exactly as for any other lesson. Naming one is the narrower statement,
-- and it binds: it rides as the variable's `preferred_room_id`, which is already
-- the top of that ladder and already refuses hard when the room is taken.
--
-- No backfill: a school with no pins behaves exactly as it does today.
CREATE TABLE `timetable_fixed_lessons` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `timetable_config_id` INTEGER NOT NULL,
  `class_section_id` INTEGER NOT NULL,
  `subject_id` INTEGER NOT NULL,
  `teacher_id` INTEGER NOT NULL,
  `room_id` INTEGER NULL,
  `day_of_week` TINYINT NOT NULL,
  `period_number` INTEGER NOT NULL,
  `school_id` INTEGER NOT NULL,

  PRIMARY KEY (`id`),

  -- A class-section cannot be pinned into two lessons at the same moment.
  -- Enforced here rather than by a screen remembering to check — invariant 1's
  -- rule, applied to intent rather than to placement.
  UNIQUE KEY `uq_fixed_cell` (`timetable_config_id`, `class_section_id`, `day_of_week`, `period_number`),

  -- "How many Maths are pinned for this section?" is asked on every save and by
  -- Check 14, and it is the query the curriculum lock runs too.
  INDEX `timetable_fixed_lessons_section_subject_idx` (`class_section_id`, `subject_id`),
  -- "Is this teacher already pinned into that cell?" — the cross-section clash.
  INDEX `timetable_fixed_lessons_teacher_cell_idx` (`timetable_config_id`, `teacher_id`, `day_of_week`, `period_number`),
  INDEX `timetable_fixed_lessons_school_id_idx` (`school_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `timetable_fixed_lessons`
  ADD CONSTRAINT `timetable_fixed_lessons_timetable_config_id_fkey`
  FOREIGN KEY (`timetable_config_id`) REFERENCES `timetable_config`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- CASCADE on the masters: a pin names a cohort, a subject, a teacher and a
-- room, and it is meaningless without any of them. §23's sync deletes masters,
-- and a pin left pointing at a deleted teacher would be a hard constraint
-- nobody could see or remove.
ALTER TABLE `timetable_fixed_lessons`
  ADD CONSTRAINT `timetable_fixed_lessons_class_section_id_fkey`
  FOREIGN KEY (`class_section_id`) REFERENCES `class_sections`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `timetable_fixed_lessons`
  ADD CONSTRAINT `timetable_fixed_lessons_subject_id_fkey`
  FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `timetable_fixed_lessons`
  ADD CONSTRAINT `timetable_fixed_lessons_teacher_id_fkey`
  FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The room is the one nullable reference, so losing the room drops the school
-- back to "not stated" — the solver picks one — rather than deleting the pin.
ALTER TABLE `timetable_fixed_lessons`
  ADD CONSTRAINT `timetable_fixed_lessons_room_id_fkey`
  FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `timetable_fixed_lessons`
  ADD CONSTRAINT `timetable_fixed_lessons_school_id_fkey`
  FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
