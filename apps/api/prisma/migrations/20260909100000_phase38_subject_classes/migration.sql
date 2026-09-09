-- §27.16 — which classes a subject is taught to, DECLARED.
--
-- The same correction §18 made for teaching scope, and for the same reason. The
-- setup already had an opinion about this — §27.15's `CLASS_LADDER` ranges keep
-- Biology out of Pre-Nursery — but that opinion is a GUESS read off the
-- subject's NAME. It can shape a proposal; it can never be a statement, because
-- a school that calls its subject "Bio-Science" gets no opinion at all, and one
-- that teaches French from Nursery is simply contradicted.
--
-- So the school says it, once, on the subject: "Biology is Class 9 upward".
-- The Allocation grid then proposes it in exactly those classes and nowhere
-- else, and the school stops deleting the same cell in fourteen rows.
--
-- Deliberately NOT a range (from/to). A range is only expressible on the ladder
-- — a school with its own class names could not use it — and it cannot say
-- "Class 5 and Class 8 but not 6 or 7", which is an ordinary thing for an
-- elective to be. A row per class costs nothing at this size and can say
-- anything.
--
-- EMPTY MEANS "NOT STATED", never "no classes" (invariant 7). Every school that
-- exists today has no rows here and must behave exactly as it does now: the
-- ladder proposes, and nothing refuses anything. That is why there is no
-- backfill below — §18 backfilled its scope from existing mappings, and the
-- point of THIS table is that a fact derived from what somebody has already
-- been given cannot constrain what they are given next.
CREATE TABLE `subject_classes` (
  `subject_id` INT NOT NULL,
  `class_id` INT NOT NULL,
  `school_id` INT NOT NULL,
  PRIMARY KEY (`subject_id`, `class_id`),
  INDEX `subject_classes_school_id_idx` (`school_id`),
  INDEX `subject_classes_class_id_idx` (`class_id`),
  CONSTRAINT `sc_subject_fk` FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `sc_class_fk` FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `sc_school_fk` FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
