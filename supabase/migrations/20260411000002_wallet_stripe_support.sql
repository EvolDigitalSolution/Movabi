-- Migration: Add Stripe support to wallet transactions
-- Date: 2026-04-11

BEGIN;

-- Add stripe_payment_intent_id to wallet_transactions
ALTER TABLE public.wallet_transactions 
ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;

-- Add unique constraint to prevent duplicate top-ups
-- We only care about uniqueness for top-ups
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transactions_topup_stripe_id 
ON public.wallet_transactions (stripe_payment_intent_id) 
WHERE type = 'topup';

COMMIT;
