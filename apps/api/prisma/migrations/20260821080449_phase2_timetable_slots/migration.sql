-- CreateTable
CREATE TABLE `timetable_slots` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `timetable_config_id` INTEGER NOT NULL,
    `status` ENUM('draft', 'published') NOT NULL DEFAULT 'draft',
    `class_section_id` INTEGER NOT NULL,
    `day_of_week` TINYINT NOT NULL,
    `period_number` INTEGER NOT NULL,
    `subject_id` INTEGER NULL,
    `teacher_id` INTEGER NULL,
    `room_id` INTEGER NULL,
    `merged_group_id` INTEGER NULL,
    `teacher_occupancy_key` VARCHAR(30) NULL,
    `is_locked` BOOLEAN NOT NULL DEFAULT false,
    `source` ENUM('auto', 'manual', 'substitute') NOT NULL DEFAULT 'auto',

    INDEX `timetable_slots_timetable_config_id_status_teacher_id_idx`(`timetable_config_id`, `status`, `teacher_id`),
    UNIQUE INDEX `uq_class_slot`(`timetable_config_id`, `status`, `class_section_id`, `day_of_week`, `period_number`),
    UNIQUE INDEX `uq_teacher_slot`(`timetable_config_id`, `status`, `teacher_occupancy_key`, `day_of_week`, `period_number`),
    UNIQUE INDEX `uq_room_slot`(`timetable_config_id`, `status`, `room_id`, `day_of_week`, `period_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
