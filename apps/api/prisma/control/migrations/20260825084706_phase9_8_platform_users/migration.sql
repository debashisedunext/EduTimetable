-- CreateTable
CREATE TABLE `platform_users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `erp_instance_id` INTEGER NOT NULL,
    `erp_user_id` VARCHAR(50) NOT NULL,
    `name` VARCHAR(100) NULL,
    `email` VARCHAR(120) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_seen_at` DATETIME(3) NULL,

    UNIQUE INDEX `platform_users_erp_instance_id_erp_user_id_key`(`erp_instance_id`, `erp_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `platform_users` ADD CONSTRAINT `platform_users_erp_instance_id_fkey` FOREIGN KEY (`erp_instance_id`) REFERENCES `erp_instances`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
