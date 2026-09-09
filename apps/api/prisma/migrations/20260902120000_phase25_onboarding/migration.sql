-- §15.3 Phase 25.2 — the welcome screen's dismissal, and a resumable guided setup.
--
-- `onboarding_sessions` holds ANSWERS, never rows. The masters it will
-- eventually create are written at the end through the endpoints that already
-- exist, which is what lets an abandoned wizard leave no trace anywhere else.
ALTER TABLE `users`
  ADD COLUMN `onboarding_dismissed_at` DATETIME(3) NULL;

CREATE TABLE `onboarding_sessions` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `school_id` INTEGER NOT NULL,
  `user_id` INTEGER NOT NULL,
  `mode` ENUM('wizard', 'ai') NOT NULL DEFAULT 'wizard',
  `current_step` INTEGER NOT NULL DEFAULT 1,
  `answers` JSON NULL,
  `completed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  -- One draft per person per school: two admins setting up the same school get
  -- their own, rather than overwriting each other's half-typed answers.
  UNIQUE INDEX `onboarding_sessions_school_id_user_id_key`(`school_id`, `user_id`),
  INDEX `onboarding_sessions_school_id_idx`(`school_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `onboarding_sessions`
  ADD CONSTRAINT `onboarding_sessions_school_id_fkey`
  FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
