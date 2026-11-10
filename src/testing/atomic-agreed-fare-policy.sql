BEGIN;

CREATE SCHEMA movabi_subscription_policy_test;
SET search_path=movabi_subscription_policy_test;
CREATE TABLE profiles(id uuid PRIMARY KEY,tenant_id uuid);
CREATE TABLE subscriptions(user_id uuid,tenant_id uuid,status text,stripe_subscription_id text,current_period_end timestamptz);
CREATE TABLE quote_market_adjustments(quote_reference text);
CREATE TABLE jobs(id integer PRIMARY KEY, driver_id uuid, fare_breakdown jsonb,driver_payout numeric,commission_fee numeric,commission_rate_used numeric,pricing_plan_used text,platform_fee numeric,total_price numeric,price numeric,agreed_fare numeric,status text);
INSERT INTO profiles VALUES ('11111111-1111-1111-1111-111111111111',NULL),('22222222-2222-2222-2222-222222222222',NULL),('33333333-3333-3333-3333-333333333333',NULL);
INSERT INTO subscriptions VALUES ('11111111-1111-1111-1111-111111111111',NULL,'active','sub_test',now()+interval '1 day'),('22222222-2222-2222-2222-222222222222',NULL,'inactive','sub_inactive',now()+interval '1 day'),('33333333-3333-3333-3333-333333333333',NULL,'active','sub_expired',now()-interval '1 day');
CREATE FUNCTION movabi_subscription_policy_test.guard_booking_payment_margin() RETURNS trigger LANGUAGE plpgsql SET search_path=movabi_subscription_policy_test,pg_temp AS $$
DECLARE policy jsonb; charge numeric; driver_amount numeric; budget numeric; cost numeric; contribution numeric; original numeric; fee numeric; rate numeric;
BEGIN
 policy:=OLD.fare_breakdown->'paymentMargin'->'policy';
 IF policy IS NULL THEN RETURN NEW; END IF; -- Existing agreed bookings retain their original terms.
 IF NEW.agreed_fare IS DISTINCT FROM OLD.agreed_fare AND NEW.agreed_fare IS NOT NULL THEN
   original:=coalesce(OLD.total_price,OLD.price);
   IF original IS NULL OR original<=0 OR NEW.agreed_fare<=0 THEN RAISE EXCEPTION 'Invalid agreed fare'; END IF;
   charge:=NEW.agreed_fare;
   fee:=round(coalesce((OLD.fare_breakdown->>'platformFeeAmount')::numeric,OLD.platform_fee,0)*charge/original,2);
   rate:=coalesce(OLD.commission_rate_used,(OLD.fare_breakdown->>'commissionPercent')::numeric,0);
   driver_amount:=round(charge-fee-round((charge-fee)*rate/100,2),2);
 ELSIF NEW.fare_breakdown IS DISTINCT FROM OLD.fare_breakdown THEN
   IF NEW.fare_breakdown->'paymentMargin'->'policy' IS DISTINCT FROM policy THEN RAISE EXCEPTION 'Frozen payment cost policy cannot change'; END IF;
   charge:=(NEW.fare_breakdown->>'customerCharge')::numeric;
   driver_amount:=(NEW.fare_breakdown->>'driverEntitlement')::numeric;
 ELSE RETURN NEW;
 END IF;
 budget:=coalesce((NEW.fare_breakdown->>'shoppingBudget')::numeric,0);
 IF charge IS NULL OR driver_amount IS NULL OR charge::text='NaN' OR driver_amount::text='NaN' OR driver_amount<0 OR budget<0 THEN RAISE EXCEPTION 'Invalid protected fare'; END IF;
 cost:=ceil(((charge+budget)*(policy->>'paymentPercent')::numeric/100+(policy->>'paymentFixed')::numeric)*100)/100;
 contribution:=round(charge-driver_amount-cost-(policy->>'operatingAllowance')::numeric,2);
 IF contribution IS NULL OR contribution<(policy->>'minimumContribution')::numeric THEN RAISE EXCEPTION 'Agreed fare is below the protected booking minimum'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_booking_payment_margin BEFORE UPDATE OF agreed_fare,fare_breakdown ON movabi_subscription_policy_test.jobs FOR EACH ROW EXECUTE FUNCTION movabi_subscription_policy_test.guard_booking_payment_margin();
ALTER TABLE movabi_subscription_policy_test.quote_market_adjustments ADD COLUMN IF NOT EXISTS protected_fare_snapshot jsonb;
-- Billing evidence and authoritative quote snapshots are backend-managed.
-- Old broad policies must not let a browser manufacture a commission waiver.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON movabi_subscription_policy_test.subscriptions,movabi_subscription_policy_test.quote_market_adjustments FROM PUBLIC,anon,authenticated;
GRANT ALL ON movabi_subscription_policy_test.subscriptions,movabi_subscription_policy_test.quote_market_adjustments TO service_role;
-- Only API quotes carrying this new policy enter the assignment-time freeze.
-- No UPDATE/backfill: existing quotes, agreed jobs and completions are unchanged.
CREATE OR REPLACE FUNCTION movabi_subscription_policy_test.freeze_subscription_driver_commission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=movabi_subscription_policy_test,pg_temp AS $$
DECLARE b jsonb; policy jsonb; subscribed boolean; standard_amount numeric; standard_rate numeric;
 base numeric; fee numeric; charge numeric; commission numeric; entitlement numeric;
BEGIN
 IF NEW.driver_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.driver_id IS NOT DISTINCT FROM OLD.driver_id THEN RETURN NEW; END IF;
 b:=NEW.fare_breakdown;
 policy:=b->'driverCommissionPolicy';
 IF policy->>'version' IS DISTINCT FROM 'subscription-commission-v1' THEN RETURN NEW; END IF;
 IF b->>'policyVersion' IS DISTINCT FROM 'fare-split-v1' THEN RAISE EXCEPTION 'Frozen fare split requires reconciliation'; END IF;
 charge:=(b->>'customerCharge')::numeric;
 fee:=(b->>'platformFeeAmount')::numeric;
 base:=(b->>'driverBase')::numeric;
 standard_amount:=(policy->>'standardCommissionAmount')::numeric;
 standard_rate:=(policy->>'standardCommissionPercent')::numeric;
 IF charge IS NULL OR fee IS NULL OR base IS NULL OR standard_amount IS NULL OR standard_rate IS NULL
 OR charge::text IN ('NaN','Infinity','-Infinity') OR fee::text IN ('NaN','Infinity','-Infinity')
 OR base::text IN ('NaN','Infinity','-Infinity') OR standard_amount::text IN ('NaN','Infinity','-Infinity')
 OR standard_rate::text IN ('NaN','Infinity','-Infinity') OR charge<=0 OR fee<0 OR base<=0
 OR standard_amount<0 OR standard_amount>=base OR standard_rate<0 OR standard_rate>=100
 OR abs(charge-fee-base)>0.000001 THEN RAISE EXCEPTION 'Invalid frozen commission terms'; END IF;
 -- Backend subscription records, never a client-supplied pricing_plan label.
 SELECT EXISTS(SELECT 1 FROM subscriptions s JOIN profiles p ON p.id=NEW.driver_id
 WHERE s.user_id=p.id AND s.tenant_id IS NOT DISTINCT FROM p.tenant_id
 AND s.status='active' AND s.stripe_subscription_id IS NOT NULL
 AND (s.current_period_end IS NULL OR s.current_period_end>now())) INTO subscribed;
 commission:=CASE WHEN subscribed THEN 0 ELSE standard_amount END;
 entitlement:=base-commission;
 b:=b||jsonb_build_object('driverCommissionAmount',commission,'commissionFee',commission,
  'commissionAmount',commission,'commissionPercent',CASE WHEN subscribed THEN 0 ELSE standard_rate END,
  'driverEntitlement',entitlement,'driverNetEarnings',entitlement,'grossRevenue',fee+commission,'isPro',subscribed,
  'driverCommissionPolicy',policy||jsonb_build_object('frozen',true,'driverId',NEW.driver_id,
    'subscriptionActive',subscribed,'frozenAt',now()));
 NEW.fare_breakdown:=b;
 NEW.driver_payout:=entitlement;
 NEW.commission_fee:=commission;
 NEW.commission_rate_used:=CASE WHEN subscribed THEN 0 ELSE standard_rate END;
 NEW.pricing_plan_used:=CASE WHEN subscribed THEN 'pro' ELSE 'starter' END;
 RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION movabi_subscription_policy_test.freeze_subscription_driver_commission() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_freeze_subscription_driver_commission ON movabi_subscription_policy_test.jobs;
CREATE TRIGGER trg_freeze_subscription_driver_commission
 BEFORE INSERT OR UPDATE OF driver_id ON movabi_subscription_policy_test.jobs
 FOR EACH ROW EXECUTE FUNCTION movabi_subscription_policy_test.freeze_subscription_driver_commission();
-- Keep the existing margin policy, evaluated without depending on commission
-- for new-policy quotes. Legacy booking behaviour remains byte-for-byte unchanged.
DO $upgrade$
DECLARE definition text; original text;
BEGIN
 original:=pg_get_functiondef('movabi_subscription_policy_test.guard_booking_payment_margin()'::regprocedure);
 IF position('THEN round(charge-fee,2)' in original)>0 AND position('THEN (NEW.fare_breakdown' in original)>0 AND position('subscription-commission-v1' in original)>0 THEN RETURN;END IF;
 definition:=replace(original,
 'driver_amount:=round(charge-fee-round((charge-fee)*rate/100,2),2);',
 'driver_amount:=CASE WHEN OLD.fare_breakdown->''driverCommissionPolicy''->>''version''=''subscription-commission-v1'' THEN round(charge-fee,2) ELSE round(charge-fee-round((charge-fee)*rate/100,2),2) END;');
 definition:=replace(definition,
 'driver_amount:=(NEW.fare_breakdown->>''driverEntitlement'')::numeric;',
 'driver_amount:=CASE WHEN NEW.fare_breakdown->''driverCommissionPolicy''->>''version''=''subscription-commission-v1'' THEN (NEW.fare_breakdown->>''driverBase'')::numeric ELSE (NEW.fare_breakdown->>''driverEntitlement'')::numeric END;');
 IF definition=original OR position('THEN round(charge-fee,2)' in definition)=0 OR position('THEN (NEW.fare_breakdown' in definition)=0 THEN
 RAISE EXCEPTION 'Payment margin guard differs; review migration before applying'; END IF;
 EXECUTE definition;
END;$upgrade$;
NOTIFY pgrst,'reload schema';


SET search_path=movabi_subscription_policy_test;
INSERT INTO jobs(id,fare_breakdown,driver_payout,commission_fee,commission_rate_used,pricing_plan_used,platform_fee,total_price,price)
SELECT i,'{"paymentMargin":{"policy":{"paymentPercent":3.25,"paymentFixed":0.2,"operatingAllowance":0.1,"minimumContribution":0.5}},"policyVersion":"fare-split-v1","customerCharge":20,"driverBase":15,"platformFeeAmount":5,"driverEntitlement":12,"driverCommissionAmount":3,"commissionPercent":20,"driverCommissionPolicy":{"version":"subscription-commission-v1","frozen":false,"standardCommissionAmount":3,"standardCommissionPercent":20}}'::jsonb,12,3,20,'starter',5,20,20 FROM generate_series(1,4) i;
UPDATE jobs SET driver_id='11111111-1111-1111-1111-111111111111' WHERE id=1;
UPDATE jobs SET driver_id='22222222-2222-2222-2222-222222222222' WHERE id=2;
UPDATE jobs SET driver_id='33333333-3333-3333-3333-333333333333' WHERE id=3;
-- A profile label is not subscription evidence: profile has no pricing_plan field here.
DO $test$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM jobs WHERE id=1 AND driver_payout=15 AND commission_fee=0 AND pricing_plan_used='pro' AND fare_breakdown->>'isPro'='true') THEN RAISE EXCEPTION 'Active subscription waiver failed';END IF;
 IF NOT EXISTS(SELECT 1 FROM jobs WHERE id=2 AND driver_payout=12 AND commission_fee=3 AND pricing_plan_used='starter') THEN RAISE EXCEPTION 'Standard commission failed';END IF;
 IF NOT EXISTS(SELECT 1 FROM jobs WHERE id=3 AND driver_payout=12 AND commission_fee=3) THEN RAISE EXCEPTION 'Expired subscription waived commission';END IF;
END;$test$;
UPDATE subscriptions SET status='inactive' WHERE user_id='11111111-1111-1111-1111-111111111111';
UPDATE jobs SET driver_id=driver_id,status='completed' WHERE id=1;
DO $test$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM jobs WHERE id=1 AND driver_payout=15 AND commission_fee=0) THEN RAISE EXCEPTION 'Later subscription change rewrote frozen terms';END IF;
END;$test$;
INSERT INTO jobs(id,fare_breakdown,driver_payout,commission_fee,pricing_plan_used) VALUES (5,'{"customerCharge":20,"driverEntitlement":12}',12,3,'starter');
UPDATE jobs SET driver_id='22222222-2222-2222-2222-222222222222' WHERE id=5;
DO $test$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM jobs WHERE id=5 AND driver_payout=12 AND commission_fee=3) THEN RAISE EXCEPTION 'Legacy quote changed';END IF;
END;$test$;
-- A reassignment uses the preserved configured commission for the new driver.
UPDATE jobs SET driver_id='22222222-2222-2222-2222-222222222222' WHERE id=1;
DO $test$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM jobs WHERE id=1 AND driver_payout=12 AND commission_fee=3) THEN RAISE EXCEPTION 'Reassignment failed';END IF;
END;$test$;
DO $test$
DECLARE rejected boolean:=false;
BEGIN
 BEGIN UPDATE jobs SET agreed_fare=3.5 WHERE id=2;
 EXCEPTION WHEN OTHERS THEN
 IF position('protected booking minimum' in SQLERRM)=0 THEN RAISE;END IF;
 rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'Negotiation relied on commission to cover payment costs'; END IF;
END;$test$;
SELECT 'SUBSCRIPTION_COMMISSION_SQL_TESTS=PASSED' AS result;


SET search_path=movabi_subscription_policy_test;
ALTER TABLE jobs ADD COLUMN estimated_price numeric, ADD COLUMN payment_status text, ADD COLUMN stripe_transfer_id text, ADD COLUMN settlement_status text;
-- Alphabetically precedes margin/subscription guards; all ownership, vehicle,
-- compliance and payment checks still execute in this same transaction.
CREATE OR REPLACE FUNCTION movabi_subscription_policy_test.sync_agreed_fare_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path=movabi_subscription_policy_test,pg_temp AS $$
DECLARE b jsonb; policy jsonb; charge numeric; original numeric; fee numeric;
 base numeric; rate numeric; commission numeric; payout numeric; budget numeric;
 previous_base numeric;
BEGIN
 IF NEW.agreed_fare IS NULL THEN RETURN NEW; END IF;
 b:=OLD.fare_breakdown;
 IF b->>'policyVersion' IS DISTINCT FROM 'fare-split-v1' THEN
   RAISE EXCEPTION 'Agreed fare requires a verified financial snapshot';
 END IF;
 charge:=round(NEW.agreed_fare,2); original:=(b->>'customerCharge')::numeric;
 IF charge IS NULL OR original IS NULL OR charge::text IN ('NaN','Infinity','-Infinity')
 OR original::text IN ('NaN','Infinity','-Infinity') OR charge<=0 OR original<=0 THEN
   RAISE EXCEPTION 'Invalid agreed fare snapshot';
 END IF;
 IF NEW.agreed_fare IS NOT DISTINCT FROM OLD.agreed_fare AND charge=original THEN RETURN NEW; END IF;
 IF OLD.payment_status IN ('paid','captured','wallet_funded')
 OR OLD.status IN ('completed','settled','cancelled') OR OLD.stripe_transfer_id IS NOT NULL
 OR OLD.settlement_status IN ('claimed','unknown','transferred','reversed') THEN
   RAISE EXCEPTION 'Settled or funded fare requires explicit reconciliation';
 END IF;
 IF NEW.agreed_fare IS DISTINCT FROM OLD.agreed_fare AND OLD.payment_status='authorized' THEN
   RAISE EXCEPTION 'Existing authorization must be reconciled before re-agreement';
 END IF;
 fee:=round((b->>'platformFeeAmount')::numeric*charge/original,2);
 base:=charge-fee; rate:=(b->>'commissionPercent')::numeric;
 budget:=coalesce((b->>'shoppingBudget')::numeric,0);
 IF fee IS NULL OR rate IS NULL OR fee::text IN ('NaN','Infinity','-Infinity')
 OR rate::text IN ('NaN','Infinity','-Infinity') OR budget::text IN ('NaN','Infinity','-Infinity')
 OR fee<0 OR base<=0 OR rate<0 OR rate>=100 OR budget<0 THEN
   RAISE EXCEPTION 'Invalid frozen fee or commission basis';
 END IF;
 commission:=round(base*rate/100,2); payout:=base-commission;
 policy:=b->'driverCommissionPolicy';
 IF policy->>'version'='subscription-commission-v1' THEN
   previous_base:=(b->>'driverBase')::numeric;
   IF previous_base IS NULL OR previous_base<=0 OR previous_base::text IN ('NaN','Infinity','-Infinity') THEN
     RAISE EXCEPTION 'Invalid frozen standard commission basis';
   END IF;
   policy:=policy||jsonb_build_object('standardCommissionAmount',
     round((policy->>'standardCommissionAmount')::numeric*base/previous_base,2));
   b:=b||jsonb_build_object('driverCommissionPolicy',policy);
 END IF;
 b:=b||jsonb_build_object('customerCharge',charge,'customerServiceTotal',charge,
   'total',charge,'serviceFare',charge,'totalAuthorisation',charge+budget,
   'platformFeeAmount',fee,'platformFee',fee,'baseServiceFare',base,
   'serviceFareBeforePlatformFee',base,'driverBase',base,'driverGrossEarnings',base,
   'driverCommissionAmount',commission,'commissionFee',commission,'commissionAmount',commission,
   'driverEntitlement',payout,'driverPayout',payout,'driverNetEarnings',payout,
   'grossRevenue',fee+commission,'reconciliationValid',true);
 NEW.fare_breakdown:=b;
 NEW.price:=charge; NEW.total_price:=charge; NEW.estimated_price:=charge;
 NEW.platform_fee:=fee; NEW.driver_payout:=payout;
 NEW.commission_fee:=commission; NEW.commission_rate_used:=rate;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION movabi_subscription_policy_test.sync_agreed_fare_snapshot() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS a_sync_agreed_fare_snapshot ON movabi_subscription_policy_test.jobs;
CREATE TRIGGER a_sync_agreed_fare_snapshot BEFORE UPDATE OF agreed_fare ON movabi_subscription_policy_test.jobs
FOR EACH ROW EXECUTE FUNCTION movabi_subscription_policy_test.sync_agreed_fare_snapshot();
-- Finalize display aliases after subscription waiver and other BEFORE triggers.
CREATE OR REPLACE FUNCTION movabi_subscription_policy_test.finalize_agreed_fare_aliases()
RETURNS trigger LANGUAGE plpgsql SET search_path=movabi_subscription_policy_test,pg_temp AS $$
DECLARE b jsonb; charge numeric; payout numeric; fee numeric; commission numeric;
BEGIN
 b:=NEW.fare_breakdown;
 IF b->>'policyVersion' IS DISTINCT FROM 'fare-split-v1' THEN RETURN NEW; END IF;
 charge:=(b->>'customerCharge')::numeric; payout:=(b->>'driverEntitlement')::numeric;
 fee:=(b->>'platformFeeAmount')::numeric; commission:=(b->>'driverCommissionAmount')::numeric;
 IF charge IS NULL OR payout IS NULL OR fee IS NULL OR commission IS NULL
 OR charge::text IN ('NaN','Infinity','-Infinity') OR payout::text IN ('NaN','Infinity','-Infinity')
 OR fee::text IN ('NaN','Infinity','-Infinity') OR commission::text IN ('NaN','Infinity','-Infinity')
 OR charge<=0 OR payout<=0 OR fee<0 OR commission<0 OR charge<>payout+fee+commission
 OR (NEW.agreed_fare IS NOT NULL AND charge<>round(NEW.agreed_fare,2)) THEN
   RAISE EXCEPTION 'Agreed fare settlement snapshot requires reconciliation';
 END IF;
 NEW.fare_breakdown:=b||jsonb_build_object('customerServiceTotal',charge,'driverPayout',payout,
   'driverNetEarnings',payout,'commissionAmount',commission,'commissionFee',commission,
   'grossRevenue',fee+commission);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION movabi_subscription_policy_test.finalize_agreed_fare_aliases() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS zz_finalize_agreed_fare_aliases ON movabi_subscription_policy_test.jobs;
CREATE TRIGGER zz_finalize_agreed_fare_aliases BEFORE UPDATE OF agreed_fare,fare_breakdown,driver_id ON movabi_subscription_policy_test.jobs
FOR EACH ROW EXECUTE FUNCTION movabi_subscription_policy_test.finalize_agreed_fare_aliases();
NOTIFY pgrst,'reload schema';

SET search_path=movabi_subscription_policy_test;
INSERT INTO jobs(id,driver_id,fare_breakdown,total_price,price,commission_fee,commission_rate_used,status)
SELECT i,'22222222-2222-2222-2222-222222222222','{"policyVersion":"fare-split-v1","customerCharge":6.71,"customerServiceTotal":6.71,"total":6.71,"serviceFare":6.71,"totalAuthorisation":6.71,"shoppingBudget":0,"driverBase":6.39,"platformFeeAmount":0.32,"commissionPercent":15,"driverCommissionAmount":0.96,"driverEntitlement":5.43,"paymentMargin":{"policy":{"paymentPercent":3.25,"paymentFixed":0.2,"operatingAllowance":0.1,"minimumContribution":0.5}}}',6.71,6.71,0,NULL,'negotiating' FROM generate_series(10,16) i;
UPDATE jobs SET agreed_fare=6.04 WHERE id=10;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM jobs WHERE id=10 AND total_price=6.04 AND platform_fee=.29 AND commission_fee=.86 AND driver_payout=4.89 AND commission_rate_used=15 AND (fare_breakdown->>'customerCharge')::numeric=6.04) THEN RAISE EXCEPTION 'Observed negotiated split failed'; END IF;
END $$;
UPDATE jobs SET agreed_fare=6.04 WHERE id=10;
DO $$ BEGIN IF (SELECT driver_payout FROM jobs WHERE id=10)<>4.89 THEN RAISE EXCEPTION 'Replay changed earnings'; END IF;END $$;
-- Legacy already-authorized stale snapshot: repair only the matching agreement.
UPDATE jobs SET payment_status='authorized',agreed_fare=NULL WHERE id=11;
ALTER TABLE jobs DISABLE TRIGGER a_sync_agreed_fare_snapshot;
ALTER TABLE jobs DISABLE TRIGGER zz_finalize_agreed_fare_aliases;
UPDATE jobs SET agreed_fare=6.04 WHERE id=11;
ALTER TABLE jobs ENABLE TRIGGER a_sync_agreed_fare_snapshot;
ALTER TABLE jobs ENABLE TRIGGER zz_finalize_agreed_fare_aliases;
UPDATE jobs SET agreed_fare=agreed_fare WHERE id=11;
DO $$ BEGIN IF (SELECT total_price FROM jobs WHERE id=11)<>6.04 THEN RAISE EXCEPTION 'Legacy repair failed'; END IF;END $$;
UPDATE jobs SET payment_status='paid' WHERE id=12;
DO $$ BEGIN BEGIN UPDATE jobs SET agreed_fare=6.04 WHERE id=12;RAISE EXCEPTION 'Expected rejection';EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%explicit reconciliation%' THEN RAISE;END IF;END;END $$;
UPDATE jobs SET payment_status='authorized' WHERE id=13;
DO $$ BEGIN BEGIN UPDATE jobs SET agreed_fare=6.04 WHERE id=13;RAISE EXCEPTION 'Expected rejection';EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%authorization must%' THEN RAISE;END IF;END;END $$;
DO $$ BEGIN BEGIN UPDATE jobs SET agreed_fare=1 WHERE id=14;RAISE EXCEPTION 'Expected rejection';EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%protected booking minimum%' THEN RAISE;END IF;END;END $$;
UPDATE jobs SET fare_breakdown=jsonb_set(jsonb_set(fare_breakdown,'{shoppingBudget}','2'),'{totalAuthorisation}','8.71') WHERE id=15;
-- Larger shopping processing allowance still needs to pass the frozen margin.
UPDATE jobs SET agreed_fare=6.71 WHERE id=15;
DO $$ BEGIN IF (SELECT (fare_breakdown->>'totalAuthorisation')::numeric FROM jobs WHERE id=15)<>8.71 THEN RAISE EXCEPTION 'Shopping budget changed'; END IF;END $$;

UPDATE subscriptions SET status='active' WHERE user_id='11111111-1111-1111-1111-111111111111';
INSERT INTO jobs(id,fare_breakdown,total_price,price,status)
SELECT 20,fare_breakdown,20,20,'negotiating' FROM jobs WHERE id=4;
UPDATE jobs SET driver_id='11111111-1111-1111-1111-111111111111',agreed_fare=18 WHERE id=20;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM jobs WHERE id=20 AND driver_payout=13.5 AND commission_fee=0 AND (fare_breakdown->>'driverPayout')::numeric=13.5 AND (fare_breakdown->>'driverEntitlement')::numeric=13.5) THEN RAISE EXCEPTION 'Subscription waiver alias or agreement failed'; END IF;END $$;
SELECT 'ATOMIC_AGREED_FARE_SQL_TESTS=PASSED' AS result;

ROLLBACK;