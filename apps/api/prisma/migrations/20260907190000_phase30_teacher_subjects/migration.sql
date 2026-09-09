-- §27.13 — what a teacher teaches, recorded about the TEACHER.
--
-- It was never stored. The guided setup asked "what does this teacher teach?",
-- used the answer to propose mappings, and threw it away; the only surviving
-- trace was whatever `teacher_subject_class_section` rows happened to exist. So
-- a school setting up its second wing met a Teachers step with every "Teaches"
-- cell empty and the line "16 teachers have no subject yet" — about teachers
-- whose subjects it had entered an hour earlier.
--
-- Derived-from-mappings is the exact mistake §18 already corrected once:
-- `teacher_class_eligibility` is DECLARED, not derived, because a scope read
-- back from existing mappings can only ever describe what somebody has already
-- been given and can never constrain what they are given next. A teacher's
-- subjects are the same kind of fact, and this is the same shape of table.
--
-- Absent means NOT STATED, never "teaches nothing" (invariant 7). Every school
-- that predates this has no rows here, and reading falls back to what its
-- mappings imply — so nothing changes for anybody until they say something.

CREATE TABLE `teacher_subjects` (
  `teacher_id` INT NOT NULL,
  `subject_id` INT NOT NULL,
  `school_id`  INT NOT NULL,

  PRIMARY KEY (`teacher_id`, `subject_id`),
  INDEX `teacher_subjects_school_id_idx` (`school_id`),
  INDEX `teacher_subjects_subject_idx` (`subject_id`),

  CONSTRAINT `teacher_subjects_teacher_fk` FOREIGN KEY (`teacher_id`)
    REFERENCES `teachers`(`id`) ON DELETE CASCADE,
  CONSTRAINT `teacher_subjects_subject_fk` FOREIGN KEY (`subject_id`)
    REFERENCES `subjects`(`id`) ON DELETE CASCADE,
  CONSTRAINT `teacher_subjects_school_fk` FOREIGN KEY (`school_id`)
    REFERENCES `schools`(`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Backfill from what the school has already been doing.
--
-- A teacher mapped to Maths in any section plainly teaches Maths, so the
-- declaration starts out agreeing with the record rather than contradicting it
-- — and a school that opens the Teachers step tomorrow sees its own staff
-- correctly, without having entered anything twice.
INSERT INTO `teacher_subjects` (`teacher_id`, `subject_id`, `school_id`)
SELECT DISTINCT m.`teacher_id`, m.`subject_id`, m.`school_id`
FROM `teacher_subject_class_section` m;

-- Merged teaching groups are teaching too (§4.10) — one lesson to several
-- sections is still that teacher taking that subject.
INSERT IGNORE INTO `teacher_subjects` (`teacher_id`, `subject_id`, `school_id`)
SELECT DISTINCT g.`teacher_id`, g.`subject_id`, g.`school_id`
FROM `merged_teaching_groups` g;

-- And §4.9 elective options: a French teacher whose only teaching is inside a
-- split block would otherwise read as teaching nothing at all, which is the
-- bug that made nine of the reference school's teachers look unscheduled.
INSERT IGNORE INTO `teacher_subjects` (`teacher_id`, `subject_id`, `school_id`)
SELECT DISTINCT o.`teacher_id`, o.`subject_id`, o.`school_id`
FROM `elective_options` o;
