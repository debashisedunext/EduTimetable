-- §15.3 Phase 25.1 — when the ERP last wrote a school's name from an SSO token.
--
-- `origin = 'erp'` is too blunt to decide who may rename a school. Phase 9.2
-- back-filled placeholder names ("School 1") for rows predating school claims,
-- and those schools receive no name from the ERP at all — refusing an edit
-- there would strand them under a placeholder forever, and it is the workflow
-- the 9.2 migration explicitly documents.
--
-- Backfilled as NULL for every existing row: no school is treated as
-- ERP-named until an SSO token actually names it, so nothing that could be
-- renamed yesterday stops being renameable today.
ALTER TABLE `schools`
  ADD COLUMN `erp_name_synced_at` DATETIME(3) NULL;
