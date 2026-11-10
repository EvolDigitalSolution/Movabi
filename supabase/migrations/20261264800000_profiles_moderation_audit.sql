-- =============================================================================
-- Profiles moderation audit column.
-- The admin account-status endpoint already writes `moderated_by` (who set the
-- suspension/closure/reinstatement), but the deployed profiles table lacks the
-- column, so a real moderation write failed with "column _.moderated_by does
-- not exist". Additive; no existing data is changed.
-- =============================================================================
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS moderated_by uuid;
