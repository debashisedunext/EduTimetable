-- CreateTable
CREATE TABLE `teacher_absences` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `teacher_id` INTEGER NOT NULL,
    `date` DATE NOT NULL,
    `reason` VARCHAR(100) NULL,
    `status` ENUM('reported', 'substitutes_assigned', 'resolved') NOT NULL DEFAULT 'reported',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_teacher_absence_date`(`teacher_id`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `substitution_log` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `timetable_slot_id` BIGINT NOT NULL,
    `absence_id` INTEGER NOT NULL,
    `original_teacher_id` INTEGER NOT NULL,
    `substitute_teacher_id` INTEGER NOT NULL,
    `date` DATE NOT NULL,
    `reason` VARCHAR(100) NULL,
    `created_by` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `substitution_log_date_substitute_teacher_id_idx`(`date`, `substitute_teacher_id`),
    UNIQUE INDEX `uq_slot_substitution_date`(`timetable_slot_id`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `teacher_absences` ADD CONSTRAINT `teacher_absences_teacher_id_fkey` FOREIGN KEY (`teacher_id`) REFERENCES `teachers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `substitution_log` ADD CONSTRAINT `substitution_log_absence_id_fkey` FOREIGN KEY (`absence_id`) REFERENCES `teacher_absences`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
