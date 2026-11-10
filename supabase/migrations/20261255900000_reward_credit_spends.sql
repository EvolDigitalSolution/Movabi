-- ============================================================================
-- REWARD-CREDIT SPENDING — canonical wallet authority only.
-- Non-withdrawable booking credit: reserved atomically against a booking,
-- settled on completion, released on cancellation, reversed on refund.
-- Owner/tenant/currency enforced inside the lock; concurrent applies
-- serialize on the credit row. No withdrawal path exists.
-- ============================================================================

CREATE TABLE IF NOT EXISTS reward_credit_spends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_id uuid NOT NULL REFERENCES reward_credits(id),
  job_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor > 0),
  status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','spent','released','reversed')),
  reserve_event_id uuid,
  resolution_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
-- Released/reversed spends are history; only the ACTIVE reservation is unique.
CREATE UNIQUE INDEX IF NOT EXISTS rcs_active_per_credit_job
  ON reward_credit_spends(credit_id, job_id) WHERE status='reserved';
-- Exactly one ACTIVE spend per booking.
CREATE UNIQUE INDEX IF NOT EXISTS rcs_one_active_per_job
  ON reward_credit_spends(job_id) WHERE status='reserved';
ALTER TABLE reward_credit_spends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON reward_credit_spends FROM PUBLIC,anon,authenticated;
GRANT SELECT ON reward_credit_spends TO authenticated;
GRANT SELECT,INSERT,UPDATE ON reward_credit_spends TO service_role;

-- Available = face amount minus reserved+spent allocations.
CREATE OR REPLACE FUNCTION reward_credit_available(p_credit uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT greatest(c.amount_minor - coalesce(sum(s.amount_minor)
       FILTER(WHERE s.status IN ('reserved','spent')),0),0)::bigint
    FROM reward_credits c
    LEFT JOIN reward_credit_spends s ON s.credit_id=c.id
   WHERE c.id=p_credit GROUP BY c.amount_minor;
$$;

-- Apply reward credit to a booking: atomic reserve. The caller supplies the
-- booking's eligible fare amount (minor); the server bounds it to the credit
-- balance and NEVER exceeds it. Owner/tenant/currency enforced.
CREATE OR REPLACE FUNCTION apply_reward_credit(
  p_credit uuid, p_job uuid, p_amount_minor bigint)
RETURNS reward_credit_spends LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c reward_credits; j jobs; v reward_credit_spends; avail bigint; amt bigint; ev uuid;
BEGIN
  SELECT * INTO c FROM reward_credits WHERE id=p_credit FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit_missing'; END IF;
  IF c.status<>'active' THEN RAISE EXCEPTION 'credit_not_active'; END IF;
  IF c.expires_at IS NOT NULL AND c.expires_at<=now() THEN
    UPDATE reward_credits SET status='expired' WHERE id=p_credit;
    RAISE EXCEPTION 'credit_expired';
  END IF;
  -- Retry-safe: a repeat apply for the same credit+job returns the existing
  -- reservation rather than violating the partial unique index.
  SELECT * INTO v FROM reward_credit_spends WHERE credit_id=p_credit AND job_id=p_job AND status='reserved';
  IF FOUND THEN RETURN v; END IF;
  SELECT * INTO j FROM jobs WHERE id=p_job FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_missing'; END IF;
  -- Owner/tenant/currency isolation.
  IF j.customer_id IS DISTINCT FROM c.owner_id THEN RAISE EXCEPTION 'credit_owner_mismatch'; END IF;
  IF j.tenant_id IS DISTINCT FROM c.tenant_id THEN RAISE EXCEPTION 'credit_tenant_mismatch'; END IF;
  IF j.currency_code IS DISTINCT FROM c.currency_code THEN RAISE EXCEPTION 'credit_currency_mismatch'; END IF;
  -- Bound to available balance — concurrent applies can't double-spend.
  SELECT reward_credit_available(p_credit) INTO avail;
  amt := least(greatest(coalesce(p_amount_minor,0),0), avail);
  IF amt<=0 THEN RAISE EXCEPTION 'credit_exhausted'; END IF;
  INSERT INTO reward_credit_spends(credit_id,job_id,tenant_id,amount_minor)
   VALUES(p_credit,p_job,c.tenant_id,amt) RETURNING * INTO v;
  RETURN v;
END $$;

-- Settle a reserved spend on completion: spend -> spent, credit -> used.
CREATE OR REPLACE FUNCTION settle_reward_credit_spend(p_job uuid)
RETURNS reward_credit_spends LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s reward_credit_spends;
BEGIN
  UPDATE reward_credit_spends SET status='spent',resolved_at=now()
   WHERE id=(SELECT id FROM reward_credit_spends
             WHERE job_id=p_job AND status='reserved'
             ORDER BY created_at DESC LIMIT 1) RETURNING * INTO s;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE reward_credits SET status='used'
   WHERE id=s.credit_id
     AND reward_credit_available(s.credit_id)=0;
  RETURN s;
END $$;

-- Release a reserved spend on cancellation: spend -> released, credit stays
-- active (available again).
CREATE OR REPLACE FUNCTION release_reward_credit_spend(p_job uuid)
RETURNS reward_credit_spends LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s reward_credit_spends;
BEGIN
  UPDATE reward_credit_spends SET status='released',resolved_at=now()
   WHERE id=(SELECT id FROM reward_credit_spends
             WHERE job_id=p_job AND status='reserved'
             ORDER BY created_at DESC LIMIT 1) RETURNING * INTO s;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN s;
END $$;

-- Reverse a SPENT credit on refund: spend -> reversed, credit reactivates
-- (amount restored) unless expired.
CREATE OR REPLACE FUNCTION reverse_reward_credit_spend(p_job uuid)
RETURNS reward_credit_spends LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s reward_credit_spends;
BEGIN
  UPDATE reward_credit_spends SET status='reversed',resolved_at=now()
   WHERE id=(SELECT id FROM reward_credit_spends
             WHERE job_id=p_job AND status='spent'
             ORDER BY created_at DESC LIMIT 1) RETURNING * INTO s;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE reward_credits SET status='active'
   WHERE id=s.credit_id AND (expires_at IS NULL OR expires_at>now());
  RETURN s;
END $$;

REVOKE ALL ON FUNCTION reward_credit_available(uuid),
  apply_reward_credit(uuid,uuid,bigint),
  settle_reward_credit_spend(uuid),
  release_reward_credit_spend(uuid),
  reverse_reward_credit_spend(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION reward_credit_available(uuid),
  apply_reward_credit(uuid,uuid,bigint),
  settle_reward_credit_spend(uuid),
  release_reward_credit_spend(uuid),
  reverse_reward_credit_spend(uuid) TO service_role;

-- Lifecycle trigger: settle on completion, release on cancellation, reverse
-- on refund — all inside the job transition transaction.
CREATE OR REPLACE FUNCTION enforce_reward_credit_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.status IN ('completed','delivered','settled') AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM settle_reward_credit_spend(NEW.id);
  ELSIF NEW.status IN ('cancelled','canceled','expired','failed','no_driver_found')
        AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM release_reward_credit_spend(NEW.id);
  END IF;
  -- Refund reversal: spent credit reverses and reactivates (unless expired).
  IF NEW.payment_status='refunded' AND OLD.payment_status IS DISTINCT FROM 'refunded' THEN
    PERFORM reverse_reward_credit_spend(NEW.id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reward_credit_lifecycle ON jobs;
CREATE TRIGGER reward_credit_lifecycle AFTER UPDATE OF status,payment_status
  ON jobs FOR EACH ROW EXECUTE FUNCTION enforce_reward_credit_lifecycle();

-- Expiry sweep: marks expired credits for display. Apply REJECTS expired
-- credit regardless (re-checked inside the lock) — this is cosmetic only;
-- a failed apply never persists 'expired' (exception rolls back).
CREATE OR REPLACE FUNCTION expire_reward_credits()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n int;
BEGIN
  UPDATE reward_credits SET status='expired'
   WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION expire_reward_credits() TO service_role;

-- Atomic reservation at job creation: the INSERT trigger calls
-- apply_reward_credit inside the same transaction. Failure rolls back the
-- booking — no orphan, no dispatchable-without-credit state. Eligible payable
-- = authoritative customerCharge minus any platform-funded discount; the
-- spend can never exceed what remains payable electronically.
CREATE OR REPLACE FUNCTION reserve_job_reward_credit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_credit uuid; v_discount bigint; v_charge bigint; v_payable bigint;
BEGIN
  IF NEW.metadata->>'reward_credit_id' IS NULL THEN RETURN NEW; END IF;
  v_credit := (NEW.metadata->>'reward_credit_id')::uuid;
  v_charge := coalesce((NEW.fare_breakdown->>'customerCharge')::bigint,
               (NEW.agreed_fare*100)::bigint,0);
  v_discount := coalesce((NEW.metadata->>'discount_minor')::bigint,0);
  v_payable := greatest(v_charge - v_discount,0);
  PERFORM apply_reward_credit(v_credit,NEW.id,v_payable);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reward_credit_reserve ON jobs;
CREATE TRIGGER reward_credit_reserve AFTER INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION reserve_job_reward_credit();

-- Remaining payable: the authoritative electronic-due figure.
--   customerCharge (eligible payable) - applied discount - reserved credit.
-- customerCharge does NOT already include the discount (discount lives in
-- metadata/discount_minor, never subtracted twice). Floor at 0: a fully
-- covered booking returns 0 and no payment intent should be created.
CREATE OR REPLACE FUNCTION job_remaining_payable_minor(p_job uuid)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE j jobs; charge bigint; discount bigint; credit bigint;
BEGIN
  SELECT * INTO j FROM jobs WHERE id=p_job;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_missing'; END IF;
  charge := coalesce((j.fare_breakdown->>'customerCharge')::bigint,(j.agreed_fare*100)::bigint,0);
  discount := coalesce((j.metadata->>'discount_minor')::bigint,0);
  SELECT coalesce(sum(amount_minor),0) INTO credit
    FROM reward_credit_spends WHERE job_id=p_job AND status='reserved';
  RETURN greatest(charge - discount - credit,0);
END $$;
REVOKE ALL ON FUNCTION job_remaining_payable_minor(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION job_remaining_payable_minor(uuid) TO service_role;

-- Accepted funding breakdown, persisted at booking creation — the payable
-- NEVER recomputes from mutable metadata across lifecycle states. Reserved
-- credit becoming spent does not change the accepted external due.
CREATE TABLE IF NOT EXISTS job_funding_breakdown (
  job_id uuid PRIMARY KEY REFERENCES jobs(id),
  tenant_id uuid NOT NULL,
  currency_code text NOT NULL,
  customer_charge_minor bigint NOT NULL,
  discount_minor bigint NOT NULL DEFAULT 0,
  reward_credit_minor bigint NOT NULL DEFAULT 0,
  external_due_minor bigint NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  CHECK(external_due_minor = greatest(customer_charge_minor - discount_minor - reward_credit_minor,0)),
  CHECK(discount_minor>=0 AND reward_credit_minor>=0)
);
ALTER TABLE job_funding_breakdown ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON job_funding_breakdown FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON job_funding_breakdown TO service_role;

-- Written by the INSERT trigger after the credit reservation: the accepted
-- snapshot is the single source for every downstream payment call.
CREATE OR REPLACE FUNCTION record_job_funding_breakdown() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_charge bigint; v_disc bigint; v_credit bigint;
BEGIN
  v_charge := coalesce((NEW.fare_breakdown->>'customerCharge')::bigint,(NEW.agreed_fare*100)::bigint,0);
  v_disc := coalesce((NEW.metadata->>'discount_minor')::bigint,0);
  SELECT coalesce(sum(amount_minor),0) INTO v_credit
    FROM reward_credit_spends WHERE job_id=NEW.id AND status='reserved';
  IF v_disc>0 OR v_credit>0 THEN
    INSERT INTO job_funding_breakdown(job_id,tenant_id,currency_code,
      customer_charge_minor,discount_minor,reward_credit_minor,external_due_minor)
    VALUES(NEW.id,NEW.tenant_id,NEW.currency_code,v_charge,v_disc,v_credit,
      greatest(v_charge-v_disc-v_credit,0));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS job_funding_breakdown_record ON jobs;
DROP TRIGGER IF EXISTS zz_job_funding_breakdown_record ON jobs;
CREATE TRIGGER zz_job_funding_breakdown_record AFTER INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION record_job_funding_breakdown();

-- Payable prefers the persisted breakdown; falls back to live derivation
-- only for rows that predate it.
CREATE OR REPLACE FUNCTION job_remaining_payable_minor(p_job uuid)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE b job_funding_breakdown; j jobs; charge bigint; discount bigint; credit bigint;
BEGIN
  SELECT * INTO b FROM job_funding_breakdown WHERE job_id=p_job;
  IF FOUND THEN RETURN b.external_due_minor; END IF;
  SELECT * INTO j FROM jobs WHERE id=p_job;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_missing'; END IF;
  charge := coalesce((j.fare_breakdown->>'customerCharge')::bigint,(j.agreed_fare*100)::bigint,0);
  discount := coalesce((j.metadata->>'discount_minor')::bigint,0);
  SELECT coalesce(sum(amount_minor),0) INTO credit
    FROM reward_credit_spends WHERE job_id=p_job AND status='reserved';
  RETURN greatest(charge - discount - credit,0);
END $$;
