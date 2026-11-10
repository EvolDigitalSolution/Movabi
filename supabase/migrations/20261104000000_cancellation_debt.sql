-- Versioned cancellation policy + explicit customer receivables.
-- Receivables are DEBT, never wallet credit; unpaid fees must not be faked
-- as payment success. Policies stay disabled until commercially configured.
create table if not exists cancellation_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  market_code text not null,
  version int not null,
  enabled boolean not null default false,
  grace_seconds int not null default 300 check (grace_seconds >= 0),
  fee_minor bigint not null default 0 check (fee_minor >= 0),
  fee_cap_minor bigint check (fee_cap_minor is null or fee_cap_minor >= 0),
  responsibility_rules jsonb not null default '{}'::jsonb,
  driver_compensation_percent numeric not null default 0 check (driver_compensation_percent between 0 and 100),
  compensation_funding text not null default 'on_collection' check (compensation_funding in ('on_collection','advanced')),
  debt_threshold_minor bigint not null default 0,
  exempt_reasons text[] not null default '{}',
  effective_from timestamptz not null default now(),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, market_code, version)
);
create index if not exists cp_market on cancellation_policies(tenant_id, market_code, enabled, version desc);
alter table cancellation_policies enable row level security;
drop policy if exists cp_service on cancellation_policies;
create policy cp_service on cancellation_policies for all using ((auth.jwt() ->> 'role') = 'service_role');
grant select, insert on cancellation_policies to service_role;

-- Active policy for a market: highest enabled version effective now.
create or replace function active_cancellation_policy(p_tenant uuid, p_market text)
returns cancellation_policies language plpgsql stable security definer set search_path=public as $$
declare v cancellation_policies;
begin
  select * into v from cancellation_policies
   where tenant_id=p_tenant and market_code=p_market and enabled and effective_from<=now()
   order by version desc limit 1;
  return v;
end$$;
revoke all on function active_cancellation_policy(uuid,text) from public, anon, authenticated;
grant execute on function active_cancellation_policy(uuid,text) to service_role;

-- Customer receivables: unpaid cancellation/no-show/adjustment fees.
create table if not exists customer_receivables (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  customer_id uuid not null,
  job_id uuid,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  amount_minor bigint not null check (amount_minor > 0),
  reason text not null check (reason in ('cancellation_fee','no_show_fee','fare_adjustment','manual')),
  status text not null default 'open' check (status in ('open','disputed','paid','waived','written_off')),
  policy_version int,
  payment_reference text,
  dispute_reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid
);
create index if not exists cr_customer_open on customer_receivables(customer_id, status) where status in ('open','disputed');
create index if not exists cr_tenant on customer_receivables(tenant_id, status, created_at desc);
alter table customer_receivables enable row level security;
drop policy if exists cr_owner_read on customer_receivables;
create policy cr_owner_read on customer_receivables for select
  using (customer_id = auth.uid() or (auth.jwt() ->> 'role') = 'service_role');
grant select on customer_receivables to authenticated;
grant select, insert, update on customer_receivables to service_role;

-- Open-debt total for a customer (server-side booking gate).
create or replace function customer_open_debt_minor(p_customer uuid)
returns bigint language plpgsql stable security definer set search_path=public as $$
begin
  return coalesce((select sum(amount_minor) from customer_receivables
    where customer_id=p_customer and status in ('open','disputed')),0);
end$$;
revoke all on function customer_open_debt_minor(uuid) from public, anon, authenticated;
grant execute on function customer_open_debt_minor(uuid) to service_role;

-- Record a receivable idempotently per (job,reason); duplicate cancels reuse it.
create or replace function record_customer_receivable(
  p_tenant uuid, p_customer uuid, p_job uuid, p_currency text,
  p_amount bigint, p_reason text, p_policy_version int default null)
returns customer_receivables language plpgsql security definer set search_path=public as $$
declare v customer_receivables;
begin
  select * into v from customer_receivables
   where job_id=p_job and customer_id=p_customer and reason=p_reason and status in ('open','disputed','paid')
   order by created_at desc limit 1;
  if found then return v; end if;
  insert into customer_receivables(tenant_id,customer_id,job_id,currency_code,amount_minor,reason,policy_version)
    values(p_tenant,p_customer,p_job,p_currency,p_amount,p_reason,p_policy_version) returning * into v;
  return v;
end$$;
revoke all on function record_customer_receivable(uuid,uuid,uuid,text,bigint,text,int) from public, anon, authenticated;
grant execute on function record_customer_receivable(uuid,uuid,uuid,text,bigint,text,int) to service_role;

-- Atomic unique allocation: two concurrent 'paid' resolutions cannot settle
-- two receivables with the same provider reference — the index rejects the
-- second write at the database, not at the app-level check (TOCTOU).
do $$
declare dup record;
begin
  select payment_reference, count(*) into dup
    from customer_receivables
    where payment_reference is not null
    group by payment_reference having count(*) > 1 limit 1;
  if found then
    raise exception 'customer_receivables has duplicate payment_reference % across % rows — reconcile manually before creating the unique index', dup.payment_reference, dup.count;
  end if;
end $$;
create unique index if not exists customer_receivables_payment_reference_uniq
  on customer_receivables (payment_reference)
  where payment_reference is not null;
