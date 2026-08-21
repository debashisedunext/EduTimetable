-- CreateTable
CREATE TABLE `academic_years` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `school_id` INTEGER NOT NULL,
    `name` VARCHAR(20) NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `academic_years_school_id_name_key`(`school_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `classes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `school_id` INTEGER NOT NULL,
    `name` VARCHAR(20) NOT NULL,
    `sequence` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `classes_school_id_name_key`(`school_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sections` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `class_id` INTEGER NOT NULL,
    `name` VARCHAR(10) NOT NULL,

    UNIQUE INDEX `sections_class_id_name_key`(`class_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `class_sections` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `class_id` INTEGER NOT NULL,
    `section_id` INTEGER NOT NULL,
    `academic_year_id` INTEGER NOT NULL,
    `timetable_config_id` INTEGER NULL,
    `home_room_id` INTEGER NULL,
    `strength` INTEGER NULL,
    `class_teacher_id` INTEGER NULL,

    UNIQUE INDEX `class_sections_class_id_section_id_academic_year_id_key`(`class_id`, `section_id`, `academic_year_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rooms` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `school_id` INTEGER NOT NULL,
    `name` VARCHAR(50) NOT NULL,
    `capacity` INTEGER NULL,
    `room_type` ENUM('classroom', 'lab', 'sports', 'music', 'art', 'auditorium', 'other') NOT NULL DEFAULT 'classroom',
    `is_shared` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `rooms_school_id_name_key`(`school_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subjects` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `school_id` INTEGER NOT NULL,
    `name` VARCHAR(50) NOT NULL,
    `code` VARCHAR(10) NULL,
    `is_lab` BOOLEAN NOT NULL DEFAULT false,
    `requires_double_period` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `subjects_school_id_name_key`(`school_id`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `teachers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `school_id` INTEGER NOT NULL,
    `employee_code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `max_periods_per_day` INTEGER NOT NULL DEFAULT 6,
    `max_periods_per_week` INTEGER NOT NULL DEFAULT 30,
    `class_teacher_period_rule` ENUM('none', 'always_first_period', 'random') NOT NULL DEFAULT 'none',
    `period_pattern` ENUM('every_period', 'alternate_period', 'alternate_day') NOT NULL DEFAULT 'every_period',
    `alternate_day_set` JSON NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `teachers_school_id_employee_code_key`(`school_id`, `employee_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `teacher_unavailability` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `teacher_id` INTEGER NOT NULL,
    `day_of_week` TINYINT NOT NULL,
    `period_number` INTEGER NULL,
    `reason` VARCHAR(100) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `class_subjects` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `class_id` INTEGER NOT NULL,
    `subject_id` INTEGER NOT NULL,
    `periods_per_week` INTEGER NOT NULL,
    `max_periods_per_day` INTEGER NOT NULL DEFAULT 1,
    `same_period_across_week` BOOLEAN NOT NULL DEFAULT false,
    `consecutive_block_size` INTEGER NOT NULL DEFAULT 1,
    `consecutive_blocks_per_week` INTEGER NULL,

    UNIQUE INDEX `class_subjects_class_id_subject_id_key`(`class_id`, `subject_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `teacher_subject_class_section` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `teacher_id` INTEGER NOT NULL,
    `subject_id` INTEGER NOT NULL,
    `class_section_id` INTEGER NOT NULL,
    `periods_per_week` INTEGER NOT NULL,
    `preferred_room_id` INTEGER NULL,

    UNIQUE INDEX `teacher_subject_class_section_subject_id_class_section_id_key`(`subject_id`, `class_section_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `timetable_config` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `school_id` INTEGER NOT NULL,
    `academic_year_id` INTEGER NOT NULL,
    `name` VARCHAR(50) NOT NULL,
    `description` TEXT NULL,
    `working_days` JSON NOT NULL,
    `periods_per_day` INTEGER NOT NULL DEFAULT 8,
    `period_duration_mins` INTEGER NOT NULL DEFAULT 40,
    `has_zero_period` BOOLEAN NOT NULL DEFAULT false,
    `zero_period_duration_mins` INTEGER NULL,
    `allow_consecutive_periods` BOOLEAN NOT NULL DEFAULT true,
    `class_teacher_gets_first_period` BOOLEAN NOT NULL DEFAULT false,
    `start_time` VARCHAR(5) NOT NULL DEFAULT '08:00',
    `end_time` VARCHAR(5) NULL,
    `status` ENUM('draft', 'active', 'archived') NOT NULL DEFAULT 'draft',

    UNIQUE INDEX `timetable_config_school_id_name_academic_year_id_key`(`school_id`, `name`, `academic_year_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `periods` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `timetable_config_id` INTEGER NOT NULL,
    `sort_order` INTEGER NOT NULL,
    `period_number` INTEGER NULL,
    `start_time` VARCHAR(5) NOT NULL,
    `end_time` VARCHAR(5) NOT NULL,
    `is_break` BOOLEAN NOT NULL DEFAULT false,
    `break_name` VARCHAR(30) NULL,

    UNIQUE INDEX `periods_timetable_config_id_sort_order_key`(`timetable_config_id`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `holidays` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `academic_year_id` INTEGER NOT NULL,
    `date` DATE NOT NULL,
    `name` VARCHAR(100) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `merged_teaching_groups` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `school_id` INTEGER NOT NULL,
    `subject_id` INTEGER NOT NULL,
    `teacher_id` INTEGER NOT NULL,
    `periods_per_week` INTEGER NOT NULL,
    `room_id` INTEGER NULL,
    `consecutive_block_size` INTEGER NOT NULL DEFAULT 1,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `merged_teaching_group_members` (
    `merged_group_id` INTEGER NOT NULL,
    `class_section_id` INTEGER NOT NULL,

    PRIMARY KEY (`merged_group_id`, `class_section_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `elective_blocks` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `school_id` INTEGER NOT NULL,
    `name` VARCHAR(50) NOT NULL,
    `periods_per_week` INTEGER NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `elective_block_members` (
    `elective_block_id` INTEGER NOT NULL,
    `class_section_id` INTEGER NOT NULL,

    PRIMARY KEY (`elective_block_id`, `class_section_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `elective_options` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `elective_block_id` INTEGER NOT NULL,
    `subject_id` INTEGER NOT NULL,
    `teacher_id` INTEGER NOT NULL,
    `room_id` INTEGER NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_log` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `school_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,
    `action` VARCHAR(80) NOT NULL,
    `detail` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sections` ADD CONSTRAINT `sections_class_id_fkey` FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `class_sections` ADD CONSTRAINT `class_sections_class_id_fkey` FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `class_sections` ADD CONSTRAINT `class_sections_section_id_fkey` FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `class_sections` ADD CONSTRAINT `class_sections_academic_year_id_fkey` FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `class_sections` ADD CONSTRAINT `class_sections_timetable_config_id_fkey` FOREIGN KEY (`timetable_config_id`) REFERENCES `timetable_config`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `class_sections` ADD CONSTRAINT `class_sections_home_room_id_fkey` FOREIGN KEY (`home_room_id`) REFERENCES `rooms`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `class_sections` ADD CONSTRAINT `class_sections_class_teacher_id_fkey` FOREIGN KEY (`class_teacher_id`) REFERENCES `teachers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `teacher_unavailability` ADD CONSTRAINT `teacher_unavailability_teacher_id_fkey` FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `class_subjects` ADD CONSTRAINT `class_subjects_class_id_fkey` FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `class_subjects` ADD CONSTRAINT `class_subjects_subject_id_fkey` FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `teacher_subject_class_section` ADD CONSTRAINT `teacher_subject_class_section_teacher_id_fkey` FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `teacher_subject_class_section` ADD CONSTRAINT `teacher_subject_class_section_subject_id_fkey` FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `teacher_subject_class_section` ADD CONSTRAINT `teacher_subject_class_section_class_section_id_fkey` FOREIGN KEY (`class_section_id`) REFERENCES `class_sections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `teacher_subject_class_section` ADD CONSTRAINT `teacher_subject_class_section_preferred_room_id_fkey` FOREIGN KEY (`preferred_room_id`) REFERENCES `rooms`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `timetable_config` ADD CONSTRAINT `timetable_config_academic_year_id_fkey` FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `periods` ADD CONSTRAINT `periods_timetable_config_id_fkey` FOREIGN KEY (`timetable_config_id`) REFERENCES `timetable_config`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `holidays` ADD CONSTRAINT `holidays_academic_year_id_fkey` FOREIGN KEY (`academic_year_id`) REFERENCES `academic_years`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `merged_teaching_groups` ADD CONSTRAINT `merged_teaching_groups_subject_id_fkey` FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `merged_teaching_groups` ADD CONSTRAINT `merged_teaching_groups_teacher_id_fkey` FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `merged_teaching_groups` ADD CONSTRAINT `merged_teaching_groups_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `merged_teaching_group_members` ADD CONSTRAINT `merged_teaching_group_members_merged_group_id_fkey` FOREIGN KEY (`merged_group_id`) REFERENCES `merged_teaching_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `merged_teaching_group_members` ADD CONSTRAINT `merged_teaching_group_members_class_section_id_fkey` FOREIGN KEY (`class_section_id`) REFERENCES `class_sections`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `elective_block_members` ADD CONSTRAINT `elective_block_members_elective_block_id_fkey` FOREIGN KEY (`elective_block_id`) REFERENCES `elective_blocks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `elective_block_members` ADD CONSTRAINT `elective_block_members_class_section_id_fkey` FOREIGN KEY (`class_section_id`) REFERENCES `class_sections`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `elective_options` ADD CONSTRAINT `elective_options_elective_block_id_fkey` FOREIGN KEY (`elective_block_id`) REFERENCES `elective_blocks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `elective_options` ADD CONSTRAINT `elective_options_subject_id_fkey` FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `elective_options` ADD CONSTRAINT `elective_options_teacher_id_fkey` FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `elective_options` ADD CONSTRAINT `elective_options_room_id_fkey` FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
