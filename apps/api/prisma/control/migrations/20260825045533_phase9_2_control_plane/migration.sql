-- CreateTable
CREATE TABLE `erp_instances` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(120) NOT NULL,
    `issuer` VARCHAR(160) NULL,
    `kid` VARCHAR(80) NULL,
    `public_key_pem` TEXT NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `erp_instances_kid_key`(`kid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trusts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `erp_instance_id` INTEGER NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `trusts_erp_instance_id_code_key`(`erp_instance_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tenants` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `erp_instance_id` INTEGER NOT NULL,
    `trust_id` INTEGER NULL,
    `school_code` VARCHAR(40) NOT NULL,
    `display_name` VARCHAR(120) NOT NULL,
    `mode` ENUM('shared', 'dedicated') NOT NULL DEFAULT 'shared',
    `db_url_encrypted` VARBINARY(1024) NULL,
    `local_school_id` INTEGER NOT NULL,
    `schema_version` VARCHAR(80) NULL,
    `status` ENUM('provisioning', 'active', 'suspended') NOT NULL DEFAULT 'active',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `tenants_trust_id_idx`(`trust_id`),
    UNIQUE INDEX `tenants_erp_instance_id_school_code_key`(`erp_instance_id`, `school_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `trusts` ADD CONSTRAINT `trusts_erp_instance_id_fkey` FOREIGN KEY (`erp_instance_id`) REFERENCES `erp_instances`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tenants` ADD CONSTRAINT `tenants_erp_instance_id_fkey` FOREIGN KEY (`erp_instance_id`) REFERENCES `erp_instances`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tenants` ADD CONSTRAINT `tenants_trust_id_fkey` FOREIGN KEY (`trust_id`) REFERENCES `trusts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
