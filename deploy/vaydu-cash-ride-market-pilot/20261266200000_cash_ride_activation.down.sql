-- Rollback of 20261266200000_cash_ride_activation: restores the deployed jobs SELECT policy exactly and drops the
-- activation function.
BEGIN;

DROP POLICY "Users can view relevant jobs" ON public.jobs;
CREATE POLICY "Users can view relevant jobs" ON public.jobs FOR SELECT USING (((auth.uid() = customer_id) OR (auth.uid() = driver_id) OR ((driver_id IS NULL) AND (status = ANY (ARRAY['pending'::text, 'requested'::text, 'searching'::text])) AND (payment_status = ANY (ARRAY['pending'::text, 'authorized'::text, 'wallet_funded'::text, 'paid'::text])) AND ((driver_search_expires_at IS NULL) OR (driver_search_expires_at > now()))) OR (EXISTS ( SELECT 1
   FROM public.tenant_users
  WHERE ((tenant_users.user_id = auth.uid()) AND (tenant_users.role = 'admin'::text) AND (tenant_users.tenant_id = jobs.tenant_id))))));

DROP FUNCTION public.activate_cash_ride_v1e(uuid, uuid, text, text, bigint, text);

COMMIT;
