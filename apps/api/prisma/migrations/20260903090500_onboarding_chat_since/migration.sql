-- §24.6 Phase 25.5 — where the current run of the setup conversation begins.
--
-- The transcript itself stays in `ai_chat_log`; this is only the boundary that
-- says which part of it belongs to the setup somebody is doing now. It exists
-- because that log must never be deleted — the monthly AI token budget is
-- summed from it, so clearing a conversation would refund what it cost.
ALTER TABLE `onboarding_sessions`
  ADD COLUMN `chat_since` DATETIME(3) NULL AFTER `completed_at`;
