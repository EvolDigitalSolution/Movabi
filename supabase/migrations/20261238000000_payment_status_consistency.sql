-- =============================================================================
-- 20261238000000_payment_status_consistency.sql
--
-- The application already writes two canonical payment states that the existing
-- jobs.payment_status CHECK constraint does NOT permit, so those writes fail
-- silently today:
--
--   * requires_refund - the customer cancelled a booking whose Stripe
--                       PaymentIntent was already CAPTURED (succeeded). The money
--                       must be refunded through the reviewed ADMIN refund path
--                       (never auto-refunded). This is distinct from 'refunded'
--                       (money already returned) and from 'failed'.
--
--   * requires_review - payment entered an anomalous state (e.g. a Stripe error
--                       raised during cancellation) and needs human/admin review.
--                       This is distinct from 'cancelled'/'failed'.
--
-- This migration EXTENDS the allow-list; it does NOT rename or remove any
-- existing state, does not change payment authority, Stripe timing, capture or
-- refund behaviour. Forward-only.
--
-- PATCH 1 note: this is validated against the local production schema lineage
-- but MUST NOT be applied to production until the operator review gate.
-- =============================================================================

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_payment_status_check;

ALTER TABLE public.jobs ADD CONSTRAINT jobs_payment_status_check CHECK (
    payment_status IS NULL OR payment_status = ANY (ARRAY[
        'pending', 'authorized', 'wallet_funded', 'paid',
        'cancelled', 'canceled', 'refunded', 'failed',
        'requires_refund', 'requires_review'
    ]::text[])
);
