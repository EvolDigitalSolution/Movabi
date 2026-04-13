-- Migration: Wallet RLS Policy Alignment
-- Issue: Prevent unsafe direct balance updates while allowing necessary access

-- 1. Enable RLS on wallets
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;

-- 2. Allow users to view their own wallet
DROP POLICY IF EXISTS "Users can view own wallet" ON public.wallets;
CREATE POLICY "Users can view own wallet" 
ON public.wallets
FOR SELECT
USING (auth.uid() = user_id);

-- 3. Allow users to insert their own wallet (initial creation)
DROP POLICY IF EXISTS "Users can create own wallet" ON public.wallets;
CREATE POLICY "Users can create own wallet" 
ON public.wallets
FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- 4. Prevent direct updates to balance from the client
-- Balance must only be updated via trusted RPC functions (SECURITY DEFINER)
DROP POLICY IF EXISTS "Users cannot update own balance" ON public.wallets;
CREATE POLICY "Users cannot update own balance" 
ON public.wallets
FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (
    -- Allow updates to non-balance fields if any (e.g., updated_at)
    -- But in practice, we want to be very strict
    (SELECT available_balance FROM wallets WHERE user_id = auth.uid()) = available_balance AND
    (SELECT reserved_balance FROM wallets WHERE user_id = auth.uid()) = reserved_balance
);

-- 5. Wallet Transactions RLS
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own transactions" ON public.wallet_transactions;
CREATE POLICY "Users can view own transactions" 
ON public.wallet_transactions
FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM wallets 
        WHERE id = wallet_id AND user_id = auth.uid()
    )
);
