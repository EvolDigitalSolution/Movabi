-- Synthetic pre-2D attempts, directly seeded to model historical in-flight data.
INSERT INTO public.wallet_topup_attempts(attempt_key,tenant_id,owner_id,country_code,currency_code,amount_minor,destination_account_purpose,payment_provider,merchant_account_ref,provider_idempotency_identity,status,provider_reference)
VALUES('legacy-test-stripe','11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','GB','GBP',100,'customer_credit','stripe','synthetic-stripe','legacy-stripe','provider_pending','legacy-stripe-ref'),
('legacy-test-kora','11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','NG','NGN',100,'customer_credit','kora','synthetic-kora','legacy-kora','provider_pending','legacy-kora-ref');
