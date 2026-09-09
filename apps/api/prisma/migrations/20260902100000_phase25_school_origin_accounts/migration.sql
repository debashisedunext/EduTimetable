-- §15.3 Phase 25.1 — where a school's identity came from, and who signs in as a user.
--
-- `origin` is the one column that decides read-only vs editable identity on
-- Step 1, School Profile, My Schools and Users. It defaults to `erp` so every
-- school that already exists keeps exactly today's behaviour: the ERP names it
-- and refreshes that name on every login.
--
-- `users.account_id` links a row to a control-plane account. Deliberately NOT a
-- foreign key: `accounts` lives in a different database (the control plane),
-- and MySQL cannot reference across schemas. It is null for every ERP user.
ALTER TABLE `schools`
  ADD COLUMN `origin` ENUM('erp', 'self_serve') NOT NULL DEFAULT 'erp',
  ADD COLUMN `created_by_account_id` INTEGER NULL;

ALTER TABLE `users`
  ADD COLUMN `account_id` INTEGER NULL;

-- One account may hold several users (one per school it runs), so this is an
-- ordinary index rather than a unique one.
CREATE INDEX `users_account_id_idx` ON `users`(`account_id`);
