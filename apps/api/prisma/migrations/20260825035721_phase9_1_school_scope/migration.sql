-- Phase 9.1 (§17) — denormalize school_id onto every tenant-owned child table.
--
-- Why: 16 of the 30 tables carried no school_id and were reachable only through
-- a parent join. Scoping them by join would put a multi-table join on the
-- hottest read path in the app (timetable_slots) and blow the §14 100ms DB
-- budget. With the column present, every scoped query is a direct indexed
-- predicate, and a future physical split of one school into its own database
-- becomes a plain `WHERE school_id = ?` export.
--
-- Shape of each table's change, deliberately in three steps:
--   1. ADD COLUMN ... NULL   (instant, no rewrite conflict with existing rows)
--   2. UPDATE ... JOIN       (backfill from the owning parent)
--   3. MODIFY ... NOT NULL   (the guarantee)
--
-- Step 3 is the safety net: sql_mode includes STRICT_TRANS_TABLES, so if any
-- row failed to backfill — an orphan whose parent was deleted — the ALTER
-- aborts the whole migration with "Column 'school_id' cannot be null" instead
-- of silently writing 0 and quietly mis-filing the row into school 0.
--
-- Backfills join straight through to a table that ALREADY has school_id, never
-- to another table being backfilled in this same migration, so the statements
-- below have no ordering dependency between them.

-- ---------------------------------------------------------------- 1. ADD NULL
ALTER TABLE `sections`                      ADD COLUMN `school_id` INTEGER NULL;
ALTER TABLE `class_sections`                ADD COLUMN `school_id` INTEGER NULL;
ALTER TABLE `class_subjects`                ADD COLUMN `school_id` INTEGER NULL;
ALTER TABLE `teacher_subject_class_section` ADD COLUMN `school_id` INTEGER NULL;
ALTER TABLE `teacher_unavailability`        ADD COLUMN `school_id` INTEGER NULL;
ALTER TABLE `periods`                       ADD COLUMN `school_id` INTEGER NULL;
ALTER TABLE `holidays`                      ADD COLUMN `school_id` INTEGER NULL;
ALTER TABLE `merged_teaching_group_members` ADD COLUMN `school_id` INTEGER NULL;
ALTER TABLE `elective_block_members`        ADD COLUMN `school_id` INTEGER NULL;
ALTER TABLE `elective_options`              ADD COLUMN `school_id` INTEGER NULL;
ALTER TABLE `timetable_slots`               ADD COLUMN `school_id` INTEGER NULL;
ALTER TABLE `timetable_publications`        ADD COLUMN `school_id` INTEGER NULL;
ALTER TABLE `teacher_absences`              ADD COLUMN `school_id` INTEGER NULL;
ALTER TABLE `substitution_log`              ADD COLUMN `school_id` INTEGER NULL;
ALTER TABLE `notifications`                 ADD COLUMN `school_id` INTEGER NULL;
ALTER TABLE `role_permissions`              ADD COLUMN `school_id` INTEGER NULL;

-- ---------------------------------------------------------------- 2. BACKFILL
UPDATE `sections` s
  JOIN `classes` c ON c.id = s.class_id
  SET s.school_id = c.school_id;

UPDATE `class_sections` cs
  JOIN `classes` c ON c.id = cs.class_id
  SET cs.school_id = c.school_id;

UPDATE `class_subjects` csub
  JOIN `classes` c ON c.id = csub.class_id
  SET csub.school_id = c.school_id;

-- through class_sections to classes, so it does not depend on the backfill above
UPDATE `teacher_subject_class_section` m
  JOIN `class_sections` cs ON cs.id = m.class_section_id
  JOIN `classes` c ON c.id = cs.class_id
  SET m.school_id = c.school_id;

UPDATE `teacher_unavailability` tu
  JOIN `teachers` t ON t.id = tu.teacher_id
  SET tu.school_id = t.school_id;

UPDATE `periods` p
  JOIN `timetable_config` tc ON tc.id = p.timetable_config_id
  SET p.school_id = tc.school_id;

UPDATE `holidays` h
  JOIN `academic_years` ay ON ay.id = h.academic_year_id
  SET h.school_id = ay.school_id;

UPDATE `merged_teaching_group_members` mm
  JOIN `merged_teaching_groups` mg ON mg.id = mm.merged_group_id
  SET mm.school_id = mg.school_id;

UPDATE `elective_block_members` em
  JOIN `elective_blocks` eb ON eb.id = em.elective_block_id
  SET em.school_id = eb.school_id;

UPDATE `elective_options` eo
  JOIN `elective_blocks` eb ON eb.id = eo.elective_block_id
  SET eo.school_id = eb.school_id;

-- timetable_slots / timetable_publications have no FK to timetable_config by
-- design (the slot writer owns the relationship), so a row whose config was
-- deleted is a true orphan and will fail step 3 loudly — which is correct: it
-- must be investigated, not guessed at.
UPDATE `timetable_slots` ts
  JOIN `timetable_config` tc ON tc.id = ts.timetable_config_id
  SET ts.school_id = tc.school_id;

UPDATE `timetable_publications` tp
  JOIN `timetable_config` tc ON tc.id = tp.timetable_config_id
  SET tp.school_id = tc.school_id;

UPDATE `teacher_absences` ta
  JOIN `teachers` t ON t.id = ta.teacher_id
  SET ta.school_id = t.school_id;

UPDATE `substitution_log` sl
  JOIN `teacher_absences` ta ON ta.id = sl.absence_id
  JOIN `teachers` t ON t.id = ta.teacher_id
  SET sl.school_id = t.school_id;

UPDATE `notifications` n
  JOIN `users` u ON u.id = n.user_id
  SET n.school_id = u.school_id;

UPDATE `role_permissions` rp
  JOIN `roles` r ON r.id = rp.role_id
  SET rp.school_id = r.school_id;

-- ------------------------------------------------------------ 3. ENFORCE NULL
ALTER TABLE `sections`                      MODIFY `school_id` INTEGER NOT NULL;
ALTER TABLE `class_sections`                MODIFY `school_id` INTEGER NOT NULL;
ALTER TABLE `class_subjects`                MODIFY `school_id` INTEGER NOT NULL;
ALTER TABLE `teacher_subject_class_section` MODIFY `school_id` INTEGER NOT NULL;
ALTER TABLE `teacher_unavailability`        MODIFY `school_id` INTEGER NOT NULL;
ALTER TABLE `periods`                       MODIFY `school_id` INTEGER NOT NULL;
ALTER TABLE `holidays`                      MODIFY `school_id` INTEGER NOT NULL;
ALTER TABLE `merged_teaching_group_members` MODIFY `school_id` INTEGER NOT NULL;
ALTER TABLE `elective_block_members`        MODIFY `school_id` INTEGER NOT NULL;
ALTER TABLE `elective_options`              MODIFY `school_id` INTEGER NOT NULL;
ALTER TABLE `timetable_slots`               MODIFY `school_id` INTEGER NOT NULL;
ALTER TABLE `timetable_publications`        MODIFY `school_id` INTEGER NOT NULL;
ALTER TABLE `teacher_absences`              MODIFY `school_id` INTEGER NOT NULL;
ALTER TABLE `substitution_log`              MODIFY `school_id` INTEGER NOT NULL;
ALTER TABLE `notifications`                 MODIFY `school_id` INTEGER NOT NULL;
ALTER TABLE `role_permissions`              MODIFY `school_id` INTEGER NOT NULL;

-- ----------------------------------------------------------------- 4. INDEXES
CREATE INDEX `sections_school_id_idx`                      ON `sections`(`school_id`);
CREATE INDEX `class_sections_school_id_idx`                ON `class_sections`(`school_id`);
CREATE INDEX `class_subjects_school_id_idx`                ON `class_subjects`(`school_id`);
CREATE INDEX `teacher_subject_class_section_school_id_idx` ON `teacher_subject_class_section`(`school_id`);
CREATE INDEX `teacher_unavailability_school_id_idx`        ON `teacher_unavailability`(`school_id`);
CREATE INDEX `periods_school_id_idx`                       ON `periods`(`school_id`);
CREATE INDEX `holidays_school_id_idx`                      ON `holidays`(`school_id`);
CREATE INDEX `merged_teaching_group_members_school_id_idx` ON `merged_teaching_group_members`(`school_id`);
CREATE INDEX `elective_block_members_school_id_idx`        ON `elective_block_members`(`school_id`);
CREATE INDEX `elective_options_school_id_idx`              ON `elective_options`(`school_id`);
CREATE INDEX `timetable_publications_school_id_idx`        ON `timetable_publications`(`school_id`);
CREATE INDEX `teacher_absences_school_id_idx`              ON `teacher_absences`(`school_id`);
CREATE INDEX `substitution_log_school_id_idx`              ON `substitution_log`(`school_id`);
CREATE INDEX `notifications_school_id_idx`                 ON `notifications`(`school_id`);
CREATE INDEX `role_permissions_school_id_idx`              ON `role_permissions`(`school_id`);

-- The hottest table gets a composite matching the shape scoped reads actually
-- use — `school_id = ? AND timetable_config_id = ? AND status = ?` — so EXPLAIN
-- keeps picking an index for the matrix and board queries (§14).
CREATE INDEX `timetable_slots_school_id_timetable_config_id_status_idx` ON `timetable_slots`(`school_id`, `timetable_config_id`, `status`);
