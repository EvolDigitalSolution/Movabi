-- P3 approved 2026-11-14: one reminder after 24 hours, admin review after 30 days.
-- Separate future release: NOT part of the f949a14 tooling replacement. Enables nothing.
-- Existing receivable/notification columns checked against the committed live baseline.
BEGIN;
CREATE TABLE public.debt_followup_scopes (
  tenant_id uuid NOT NULL,
  market_code text NOT NULL CHECK (market_code = 'GB'),
  currency_code text NOT NULL CHECK (currency_code = 'GBP'),
  enabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, market_code, currency_code)
);
CREATE TABLE public.customer_debt_followups (
  receivable_id uuid NOT NULL REFERENCES public.customer_receivables(id),
  action text NOT NULL CHECK (action IN ('reminder_24h','review_30d')),
  tenant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  notification_id uuid REFERENCES public.notifications(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (receivable_id, action)
);
ALTER TABLE public.debt_followup_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_debt_followups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.debt_followup_scopes, public.customer_debt_followups FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.debt_followup_scopes, public.customer_debt_followups TO service_role;

-- A single transaction owns both deduplication and inbox persistence. Concurrent workers
-- lock receivables with SKIP LOCKED; a crash rolls back the action and its notification together.
-- Disputed debt is never chased by reminder; it still reaches admin review. No charges, interest,
-- balance, threshold, payment status, account status or compensation amounts are changed.
CREATE FUNCTION public.process_overdue_customer_debts(p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d public.customer_receivables; action_id uuid; notification uuid;
        reminders integer := 0; reviews integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid debt followup batch limit' USING ERRCODE='22023';
  END IF;
  FOR d IN
    SELECT r.* FROM public.customer_receivables r
    JOIN public.debt_followup_scopes s ON s.tenant_id=r.tenant_id
      AND s.market_code=r.market_code AND s.currency_code=r.currency_code AND s.enabled
    WHERE r.status IN ('open','disputed') AND (
      (r.status='open' AND r.created_at <= now()-interval '24 hours' AND NOT EXISTS
        (SELECT 1 FROM public.customer_debt_followups f WHERE f.receivable_id=r.id AND f.action='reminder_24h'))
      OR (r.created_at <= now()-interval '30 days' AND NOT EXISTS
        (SELECT 1 FROM public.customer_debt_followups f WHERE f.receivable_id=r.id AND f.action='review_30d')))
    ORDER BY r.created_at, r.id LIMIT p_limit FOR UPDATE OF r SKIP LOCKED
  LOOP
    IF d.status='open' AND d.created_at <= now()-interval '24 hours' THEN
      action_id := NULL;
      INSERT INTO public.customer_debt_followups(receivable_id,action,tenant_id,customer_id)
      VALUES(d.id,'reminder_24h',d.tenant_id,d.customer_id)
      ON CONFLICT DO NOTHING RETURNING receivable_id INTO action_id;
      IF action_id IS NOT NULL THEN
        notification := gen_random_uuid();
        INSERT INTO public.notifications(id,user_id,title,body,type,metadata,data,route)
        VALUES(notification,d.customer_id,'Outstanding booking charge',
          'You have an outstanding GBP '||to_char(d.amount_minor/100.0,'FM999999999999999990.00')||
          ' booking charge. Review, repay or dispute it in your wallet. No interest or late fee has been added.',
          'system_alert',jsonb_build_object('receivable_id',d.id,'tenant_id',d.tenant_id,'action','debt_reminder'),
          jsonb_build_object('receivable_id',d.id,'action','debt_reminder','route','/customer/wallet'),'/customer/wallet');
        UPDATE public.customer_debt_followups SET notification_id=notification
          WHERE receivable_id=d.id AND action='reminder_24h';
        reminders := reminders+1;
      END IF;
    END IF;
    IF d.created_at <= now()-interval '30 days' THEN
      action_id := NULL;
      INSERT INTO public.customer_debt_followups(receivable_id,action,tenant_id,customer_id)
      VALUES(d.id,'review_30d',d.tenant_id,d.customer_id)
      ON CONFLICT DO NOTHING RETURNING receivable_id INTO action_id;
      IF action_id IS NOT NULL THEN
        UPDATE public.customer_receivables SET review_required=true WHERE id=d.id;
        INSERT INTO public.audit_logs(action,entity_type,entity_id,metadata)
        VALUES('overdue_debt_review','customer_receivable',d.id,
          jsonb_build_object('tenant_id',d.tenant_id,'market_code',d.market_code,'age_days',30,'policy','P3'));
        reviews := reviews+1;
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('reminders',reminders,'reviews',reviews);
END $$;
REVOKE ALL ON FUNCTION public.process_overdue_customer_debts(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_overdue_customer_debts(integer) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
