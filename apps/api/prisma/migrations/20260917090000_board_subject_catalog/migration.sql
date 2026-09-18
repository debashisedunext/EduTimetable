-- §35 — the board's own subject list, as REFERENCE DATA.
--
-- "Which subjects does CBSE run, and for which classes" is the same answer for
-- every school in the country. So this is seeded once per database and read by
-- all of them, and it is the one master in this schema with NO `school_id`:
-- invariant 18 scopes rows a school OWNS, and nobody owns the CBSE scheme of
-- studies. It is read through `PrismaBaseService` and written only by the seed.
--
-- `from_seq`/`to_seq` are inclusive CLASS_LADDER positions — 5 = Class 1,
-- 16 = Class 12 — the same vocabulary `classes.sequence` uses (§31.12).
CREATE TABLE `board_subject_catalog` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `board` VARCHAR(20) NOT NULL,
  `version` VARCHAR(20) NOT NULL,
  `name` VARCHAR(60) NOT NULL,
  `code` VARCHAR(10) NULL,
  `category` ENUM('scholastic', 'co_scholastic') NOT NULL DEFAULT 'scholastic',
  `is_lab` BOOLEAN NOT NULL DEFAULT false,
  `from_seq` INTEGER NOT NULL,
  `to_seq` INTEGER NOT NULL,
  `is_language` BOOLEAN NOT NULL DEFAULT false,
  `group_label` VARCHAR(40) NOT NULL,
  `sort_order` INTEGER NOT NULL DEFAULT 0,

  UNIQUE INDEX `board_subject_catalog_board_version_name_key` (`board`, `version`, `name`),
  INDEX `board_subject_catalog_board_version_idx` (`board`, `version`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
