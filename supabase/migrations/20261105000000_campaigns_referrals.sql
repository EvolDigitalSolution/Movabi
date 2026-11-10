-- Campaigns, driver incentives and referrals. All activation stays disabled
-- until commercial settings are approved; rewards require qualifying
-- completed activity, never registration alone.
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  code text not null,
  kind text not null check (kind in ('customer_discount','driver_incentive','referral')),
  market_code text not null,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  service_slug text not null,
  audience text not null default 'customer' check (audience in ('customer','driver','both')),
  enabled boolean not null default false,
  valid_from timestamptz, valid_until timestamptz,
  budget_minor bigint not null default 0 check (budget_minor >= 0),
  spent_minor bigint not null default 0 check (spent_minor >= 0),
  funding_party text not null default 'platform' check (funding_party in ('platform','merchant','partner')),
  qualification jsonb not null default '{}'::jsonb,
  per_user_cap int not null default 1 check (per_user_cap > 0),
  stacking text not null default 'exclusive' check (stacking in ('exclusive','stackable')),
  value_type text check (value_type in ('percent','fixed_minor')),
  value numeric check (value is null or value >= 0),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);
create index if not exists campaigns_scope on campaigns(tenant_id, market_code, service_slug, enabled);
alter table campaigns enable row level security;
drop policy if exists campaigns_service on campaigns;
create policy campaigns_service on campaigns for all using ((auth.jwt() ->> 'role') = 'service_role');
grant select, insert, update on campaigns to service_role;

-- Referral links: unique code per referrer; self-referral impossible server-side.
create table if not exists referrals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  campaign_id uuid references campaigns(id),
  referrer_id uuid not null,
  referee_id uuid not null,
  status text not null default 'pending' check (status in ('pending','earned','released','reversed','rejected')),
  qualifying_job_id uuid,
  reward_minor bigint,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  unique (campaign_id, referee_id),
  check (referrer_id <> referee_id)
);
create index if not exists referrals_referrer on referrals(tenant_id, referrer_id, status);
alter table referrals enable row level security;
drop policy if exists referrals_owner on referrals;
create policy referrals_owner on referrals for select
  using (referrer_id = auth.uid() or referee_id = auth.uid() or (auth.jwt() ->> 'role') = 'service_role');
drop policy if exists referrals_service_write on referrals;
create policy referrals_service_write on referrals for all
  using ((auth.jwt() ->> 'role') = 'service_role');
grant select on referrals to authenticated;
grant select, insert, update on referrals to service_role;

-- Atomic budget guard: campaign spend never exceeds budget.
create or replace function campaign_spend(p_campaign uuid, p_amount bigint)
returns boolean language plpgsql security definer set search_path=public as $$
declare v campaigns;
begin
  update campaigns set spent_minor=spent_minor+p_amount
   where id=p_campaign and enabled and spent_minor+p_amount<=budget_minor
  returning * into v;
  return found;
end$$;
revoke all on function campaign_spend(uuid,bigint) from public, anon, authenticated;
grant execute on function campaign_spend(uuid,bigint) to service_role;

-- Earn a referral only after a qualifying COMPLETED booking with verified
-- payment (or confirmed cash settlement) — not registration alone.
create or replace function earn_referral(p_referral uuid, p_job uuid)
returns referrals language plpgsql security definer set search_path=public as $$
declare r referrals; j jobs; c campaigns;
begin
  select * into r from referrals where id=p_referral for update;
  if not found then raise exception 'referral_missing'; end if;
  if r.status <> 'pending' then return r; end if;
  select * into j from jobs where id=p_job;
  if not found or j.status not in ('completed','settled','delivered')
     or coalesce(j.payment_status,'') not in ('paid','succeeded','refunded','cash_due','cash_pending') then
    raise exception 'qualifying_activity_incomplete';
  end if;
  select * into c from campaigns where id=r.campaign_id;
  if not found or not c.enabled then raise exception 'campaign_inactive'; end if;
  if c.budget_minor>0 and not campaign_spend(c.id, coalesce(r.reward_minor,0)) then
    raise exception 'campaign_budget_exhausted';
  end if;
  update referrals set status='earned', qualifying_job_id=p_job, resolved_at=now()
   where id=p_referral returning * into r;
  return r;
end$$;
revoke all on function earn_referral(uuid,uuid) from public, anon, authenticated;
grant execute on function earn_referral(uuid,uuid) to service_role;

-- Discount applications: per-user cap enforcement + frozen quote linkage.
create table if not exists campaign_discount_applications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  campaign_id uuid not null references campaigns(id),
  customer_id uuid not null,
  quote_reference text,
  discount_minor bigint not null check (discount_minor >= 0),
  status text not null default 'applied' check (status in ('applied','consumed','reversed','expired')),
  created_at timestamptz not null default now(),
  unique (campaign_id, customer_id, quote_reference)
);
create index if not exists cda_customer on campaign_discount_applications(campaign_id, customer_id, status);
alter table campaign_discount_applications enable row level security;
drop policy if exists cda_owner on campaign_discount_applications;
create policy cda_owner on campaign_discount_applications for select
  using (customer_id = auth.uid() or (auth.jwt() ->> 'role') = 'service_role');
drop policy if exists cda_service on campaign_discount_applications;
create policy cda_service on campaign_discount_applications for all
  using ((auth.jwt() ->> 'role') = 'service_role');
grant select, insert, update on campaign_discount_applications to service_role;

-- Apply a customer discount to a quote: validates campaign enabled+scope,
-- per-user cap, then charges the atomic budget guard. Frozen to the quote.
create or replace function apply_campaign_discount(
  p_campaign uuid, p_customer uuid, p_quote text, p_fare_minor bigint)
returns campaign_discount_applications language plpgsql security definer set search_path=public as $$
declare c campaigns; v campaign_discount_applications; used int; discount bigint;
begin
  select * into c from campaigns where id=p_campaign for update;
  if not found or not c.enabled or c.kind<>'customer_discount' then raise exception 'campaign_unavailable'; end if;
  if c.valid_from is not null and c.valid_from>now() then raise exception 'campaign_not_started'; end if;
  if c.valid_until is not null and c.valid_until<=now() then raise exception 'campaign_expired'; end if;
  select count(*) into used from campaign_discount_applications
   where campaign_id=p_campaign and customer_id=p_customer and status in ('applied','consumed');
  if used>=c.per_user_cap then raise exception 'campaign_cap_reached'; end if;
  select * into v from campaign_discount_applications
   where campaign_id=p_campaign and customer_id=p_customer and quote_reference=p_quote;
  if found then return v; end if;
  discount := case when c.value_type='percent' then least(floor(p_fare_minor * c.value / 100), p_fare_minor)
                   when c.value_type='fixed_minor' then least(c.value::bigint, p_fare_minor)
                   else 0 end;
  if discount <= 0 then raise exception 'campaign_no_discount'; end if;
  if c.budget_minor>0 and not campaign_spend(c.id, discount) then raise exception 'campaign_budget_exhausted'; end if;
  insert into campaign_discount_applications(tenant_id,campaign_id,customer_id,quote_reference,discount_minor)
    values(c.tenant_id,p_campaign,p_customer,p_quote,discount) returning * into v;
  return v;
end$$;
revoke all on function apply_campaign_discount(uuid,uuid,text,bigint) from public, anon, authenticated;
grant execute on function apply_campaign_discount(uuid,uuid,text,bigint) to service_role;

-- Remove an applied-but-unconsumed discount: releases the application and
-- refunds the campaign budget so an abandoned code never burns the cap.
create or replace function cancel_campaign_application(
  p_campaign uuid, p_customer uuid, p_quote text)
returns boolean language plpgsql security definer set search_path=public as $$
declare v campaign_discount_applications;
begin
  delete from campaign_discount_applications
   where campaign_id=p_campaign and customer_id=p_customer
     and quote_reference=p_quote and status='applied'
  returning * into v;
  if not found then return false; end if;
  update campaigns set spent_minor=greatest(0,spent_minor-v.discount_minor)
   where id=p_campaign;
  return true;
end$$;
revoke all on function cancel_campaign_application(uuid,uuid,text) from public, anon, authenticated;
grant execute on function cancel_campaign_application(uuid,uuid,text) to service_role;
