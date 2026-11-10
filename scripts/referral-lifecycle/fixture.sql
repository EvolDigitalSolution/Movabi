-- Referral-lifecycle disposable-PG fixture.
-- Reproduces the campaign/referral schema + helpers that the canonical
-- earn_referral (migration 202612645) depends on, so the test exercises the
-- ACTUAL function against real PostgreSQL.

CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE authenticator NOINHERIT;
GRANT anon,authenticated,service_role TO authenticator;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.user',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('test.role',true) $$;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;

CREATE TABLE campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  code text not null,
  kind text not null check (kind in ('customer_discount','driver_incentive','referral')),
  market_code text not null,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  service_slug text not null,
  audience text not null default 'customer' check (audience in ('customer','driver','both')),
  enabled boolean not null default false,
  paused boolean not null default false,
  version int not null default 1,
  valid_from timestamptz, valid_until timestamptz,
  budget_minor bigint not null default 0 check (budget_minor >= 0),
  spent_minor bigint not null default 0 check (spent_minor >= 0),
  funding_party text not null default 'platform' check (funding_party in ('platform','merchant','partner')),
  qualification jsonb not null default '{}'::jsonb,
  per_user_cap int not null default 1 check (per_user_cap > 0),
  usage_limit int check (usage_limit is null or usage_limit > 0),
  stacking text not null default 'exclusive' check (stacking in ('exclusive','stackable')),
  value_type text check (value_type in ('percent','fixed_minor')),
  value numeric check (value is null or value >= 0),
  referral_reward_bps int not null default 500 check (referral_reward_bps between 0 and 10000),
  published_at timestamptz, published_by uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);

CREATE TABLE referrals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  campaign_id uuid references campaigns(id),
  referrer_id uuid not null,
  referee_id uuid not null,
  status text not null default 'pending' check (status in ('pending','earned','released','reversed','rejected')),
  qualifying_job_id uuid,
  reward_minor bigint,
  referral_kind text not null default 'customer' check (referral_kind in ('customer','driver')),
  reward_rate_bps int check (reward_rate_bps between 0 and 10000),
  reward_cap_minor bigint check (reward_cap_minor >= 0),
  qualifying_fare_minor bigint,
  qualifying_jobs_required int default 1,
  qualifying_window_days int,
  review_days int default 0,
  qualified_at timestamptz,
  release_at timestamptz,
  credit_expires_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  unique (campaign_id, referee_id),
  check (referrer_id <> referee_id)
);

CREATE TABLE jobs (
  id uuid primary key,
  customer_id uuid, tenant_id uuid, driver_id uuid, accepted_driver_id uuid,
  status text, payment_status text, payment_method text,
  country_code text, currency_code text,
  agreed_fare numeric, total_price numeric, price numeric,
  metadata jsonb default '{}', fare_breakdown jsonb default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz default now()
);

CREATE TABLE reward_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  source text NOT NULL CHECK (source IN ('customer_referral','driver_referral','campaign')),
  source_id uuid NOT NULL,
  withdrawable boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','expired','reversed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz
);

CREATE TABLE referral_driver_progress (
  referral_id uuid NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  job_id uuid PRIMARY KEY,
  fare_minor bigint NOT NULL CHECK (fare_minor >= 0),
  completed_at timestamptz NOT NULL DEFAULT now()
);

-- Atomic budget guard (enabled only; paused keeps enabled=true so existing
-- referrals still earn, disabled blocks via budget).
CREATE OR REPLACE FUNCTION campaign_spend(p_campaign uuid, p_amount bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v campaigns;
BEGIN
  update campaigns set spent_minor=spent_minor+p_amount
   where id=p_campaign and enabled and spent_minor+p_amount<=budget_minor
  returning * into v;
  return found;
END $$;
REVOKE ALL ON FUNCTION campaign_spend(uuid,bigint) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION campaign_spend(uuid,bigint) TO service_role;

CREATE OR REPLACE FUNCTION referral_monthly_count(p_referrer uuid, p_kind text)
RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT count(*)::int FROM referrals
   WHERE referrer_id=p_referrer AND referral_kind=p_kind
     AND status IN ('earned','released')
     AND resolved_at >= date_trunc('month', now());
$$;
REVOKE ALL ON FUNCTION referral_monthly_count(uuid,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION referral_monthly_count(uuid,text) TO service_role;

-- Reward-credit spending (canonical wallet authority subset).
CREATE TABLE reward_credit_spends (
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
CREATE UNIQUE INDEX rcs_active_per_credit_job ON reward_credit_spends(credit_id, job_id) WHERE status='reserved';

CREATE OR REPLACE FUNCTION reward_credit_available(p_credit uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT greatest(c.amount_minor - coalesce(sum(s.amount_minor)
       FILTER(WHERE s.status IN ('reserved','spent')),0),0)::bigint
    FROM reward_credits c
    LEFT JOIN reward_credit_spends s ON s.credit_id=c.id
   WHERE c.id=p_credit GROUP BY c.amount_minor;
$$;

CREATE OR REPLACE FUNCTION apply_reward_credit(p_credit uuid, p_job uuid, p_amount_minor bigint)
RETURNS reward_credit_spends LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c reward_credits; j jobs; v reward_credit_spends; avail bigint; amt bigint;
BEGIN
  SELECT * INTO c FROM reward_credits WHERE id=p_credit FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit_missing'; END IF;
  IF c.status<>'active' THEN RAISE EXCEPTION 'credit_not_active'; END IF;
  IF c.expires_at IS NOT NULL AND c.expires_at<=now() THEN
    UPDATE reward_credits SET status='expired' WHERE id=p_credit;
    RAISE EXCEPTION 'credit_expired';
  END IF;
  SELECT * INTO v FROM reward_credit_spends WHERE credit_id=p_credit AND job_id=p_job AND status='reserved';
  IF FOUND THEN RETURN v; END IF;
  SELECT * INTO j FROM jobs WHERE id=p_job FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_missing'; END IF;
  IF j.customer_id IS DISTINCT FROM c.owner_id THEN RAISE EXCEPTION 'credit_owner_mismatch'; END IF;
  IF j.tenant_id IS DISTINCT FROM c.tenant_id THEN RAISE EXCEPTION 'credit_tenant_mismatch'; END IF;
  IF j.currency_code IS DISTINCT FROM c.currency_code THEN RAISE EXCEPTION 'credit_currency_mismatch'; END IF;
  SELECT reward_credit_available(p_credit) INTO avail;
  amt := least(greatest(coalesce(p_amount_minor,0),0), avail);
  IF amt<=0 THEN RAISE EXCEPTION 'credit_exhausted'; END IF;
  INSERT INTO reward_credit_spends(credit_id,job_id,tenant_id,amount_minor)
   VALUES(p_credit,p_job,c.tenant_id,amt) RETURNING * INTO v;
  RETURN v;
END $$;

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
   WHERE id=s.credit_id AND reward_credit_available(s.credit_id)=0;
  RETURN s;
END $$;

-- Release driver referral rewards after the review window.
CREATE OR REPLACE FUNCTION release_referral_rewards()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n int := 0; r referrals;
BEGIN
  FOR r IN SELECT * FROM referrals
            WHERE status='earned' AND referral_kind='driver'
              AND release_at IS NOT NULL AND release_at<=now()
            FOR UPDATE SKIP LOCKED LOOP
    UPDATE referrals SET status='released' WHERE id=r.id;
    INSERT INTO reward_credits(tenant_id,owner_id,currency_code,amount_minor,source,source_id,withdrawable)
      SELECT r.tenant_id, r.referrer_id,
        (SELECT currency_code FROM campaigns WHERE id=r.campaign_id),
        r.reward_minor, 'driver_referral', r.id, false;
    n := n+1;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION release_referral_rewards() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION release_referral_rewards() TO service_role;
