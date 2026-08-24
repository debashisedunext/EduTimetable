-- CreateTable
CREATE TABLE `ai_settings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `school_id` INTEGER NOT NULL,
    `provider` ENUM('anthropic', 'openai', 'google', 'azure_openai') NOT NULL DEFAULT 'anthropic',
    `model` VARCHAR(60) NOT NULL DEFAULT 'claude-opus-5',
    `api_key_encrypted` VARBINARY(512) NULL,
    `api_base_url` VARCHAR(255) NULL,
    `monthly_token_budget` INTEGER NULL,
    `features` JSON NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `updated_by` INTEGER NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ai_settings_school_id_key`(`school_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_chat_log` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `school_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,
    `conversation_id` CHAR(36) NOT NULL,
    `role` ENUM('user', 'assistant', 'tool') NOT NULL,
    `content` MEDIUMTEXT NULL,
    `tools_called` JSON NULL,
    `input_tokens` INTEGER NOT NULL DEFAULT 0,
    `output_tokens` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ai_chat_log_school_id_created_at_idx`(`school_id`, `created_at`),
    INDEX `ai_chat_log_conversation_id_id_idx`(`conversation_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
