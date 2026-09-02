-- §23.7 — the sync history.
--
-- One row per master per run. Written whether the run succeeded, failed or was
-- refused, because "nothing changed" and "we could not reach the ERP" are
-- indistinguishable from the outside and have different remedies.
--
-- `school_id` carries a real foreign key like every other table since 9.2, and
-- the two indexes are the two reads the screen makes: the latest run for one
-- master (the card), and the latest runs for the school (the history panel).

CREATE TABLE `erp_sync_runs` (
  `id`          INT          NOT NULL AUTO_INCREMENT,
  `school_id`   INT          NOT NULL,
  `sheet`       VARCHAR(40)  NOT NULL,
  `mode`        VARCHAR(10)  NOT NULL,
  `status`      VARCHAR(10)  NOT NULL,
  `endpoint`    VARCHAR(255) NULL,
  `fetched`     INT          NOT NULL DEFAULT 0,
  `created`     INT          NOT NULL DEFAULT 0,
  `updated`     INT          NOT NULL DEFAULT 0,
  `deleted`     INT          NOT NULL DEFAULT 0,
  `duration_ms` INT          NOT NULL,
  `error`       TEXT         NULL,
  `detail`      JSON         NULL,
  `run_by_id`   INT          NULL,
  `created_at`  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `erp_sync_runs_school_id_sheet_idx` (`school_id`, `sheet`),
  INDEX `erp_sync_runs_school_id_created_at_idx` (`school_id`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `erp_sync_runs`
  ADD CONSTRAINT `erp_sync_runs_school_id_fkey`
  FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
