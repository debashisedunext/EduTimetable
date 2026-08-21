-- CreateTable
CREATE TABLE `timetable_publications` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `timetable_config_id` INTEGER NOT NULL,
    `version` INTEGER NOT NULL,
    `slot_count` INTEGER NOT NULL,
    `changed_count` INTEGER NOT NULL,
    `unallocated_count` INTEGER NOT NULL,
    `published_by_id` INTEGER NULL,
    `published_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_config_version`(`timetable_config_id`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
