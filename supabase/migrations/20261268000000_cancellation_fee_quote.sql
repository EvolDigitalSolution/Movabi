-- Cancellation fee: one server-side quote from the published policy, frozen with the cancellation.
--
-- Fixes (found 2026-11-12): the API read jobs.cancellation_fee, a column the deployed jobs table does not
-- have, so no cancellation fee was ever quoted, captured or recorded; and a published policy version
-- could never become active (publish inserts enabled=false and nothing enabled it).
--
-- Rule (from the recorded design: late cancellation charges; early cancellation or no assigned driver
-- does not; grace_seconds / fee_minor / fee_cap_minor are policy fields). A fee is DUE only when:
--   * the CUSTOMER cancels (driver, admin and system cancellations never charge the customer — D9);
--   * an enabled, effective policy exists for the booking's tenant + market;
--   * the market's currency equals the booking currency (otherwise fail closed: no fee);
--   * a driver is assigned and accepted the booking more than grace_seconds before the cancellation.
-- Amount = least(fee_minor, fee_cap_minor, booking fare) in the booking currency's minor units.
-- exempt_reasons are NOT matched against the customer's free-text reason (it would let anyone avoid the
-- fee by typing a code); structured exemption is an open item.

create or replace function public.cancellation_fee_quote(
  p_job uuid, p_actor_role text, p_at timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare j public.jobs%rowtype; p public.cancellation_policies; v_market_currency text; v_exp int;
        v_fee bigint; v_fare_minor bigint; v_grace_until timestamptz; v_code text;
begin
  select * into j from public.jobs where id = p_job;
  if not found then return jsonb_build_object('due', false, 'reasonCode', 'job_not_found', 'feeMinor', 0); end if;
  p := public.active_cancellation_policy(j.tenant_id, j.country_code);
  select upper(supported_currency) into v_market_currency from public.market_availability
   where country_code = j.country_code order by market_city nulls first limit 1;
  v_exp := public.wallet_currency_minor_exponent(j.currency_code);
  if p.id is not null and j.accepted_at is not null then
    v_grace_until := j.accepted_at + make_interval(secs => p.grace_seconds);
  end if;
  v_fee := case when p.id is null then 0 else least(p.fee_minor, coalesce(p.fee_cap_minor, p.fee_minor)) end;
  if coalesce(j.total_price, j.price) is not null and v_exp is not null then
    v_fare_minor := round(coalesce(j.total_price, j.price) * power(10::numeric, v_exp))::bigint;
    v_fee := least(v_fee, greatest(v_fare_minor, 0));
  end if;
  v_code := case
    when p.id is null then 'no_active_policy'
    when v_market_currency is null or v_market_currency <> upper(j.currency_code) or v_exp is null then 'currency_mismatch'
    when coalesce(p_actor_role, '') <> 'customer' then 'not_customer'
    when coalesce(j.driver_id, j.accepted_driver_id) is null then 'no_driver'
    when j.accepted_at is null then 'no_acceptance_time'
    when p_at <= v_grace_until then 'within_grace'
    when v_fee <= 0 then 'zero_fee'
    else 'due' end;
  return jsonb_build_object(
    'due', v_code = 'due',
    'reasonCode', v_code,
    'feeMinor', case when v_code = 'due' then v_fee else 0 end,
    'policyFeeMinor', coalesce(v_fee, 0),
    'currency', upper(j.currency_code),
    'exponent', v_exp,
    'policyVersion', p.version,
    'graceSeconds', p.grace_seconds,
    'graceUntil', v_grace_until,
    'driverAssigned', coalesce(j.driver_id, j.accepted_driver_id) is not null,
    'quotedAt', p_at);
end $$;
revoke all on function public.cancellation_fee_quote(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.cancellation_fee_quote(uuid, text, timestamptz) to service_role;

-- Same contract as 20261267000000, plus: the fee quote is computed under the row lock BEFORE the
-- status changes and frozen into metadata.cancellation_fee_quote in the same transaction.
create or replace function public.cancel_job_with_actor(
  p_job_id uuid, p_reason text, p_actor uuid, p_actor_role text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.jobs%rowtype; ok boolean; q jsonb;
begin
  if p_actor is null or p_actor_role is null or p_actor_role not in ('customer','driver','admin') then
    raise exception 'invalid cancellation actor' using errcode = '22023';
  end if;
  select * into strict j from public.jobs where id = p_job_id for update;
  if p_actor_role = 'driver' and j.driver_id is distinct from p_actor and j.accepted_driver_id is distinct from p_actor then
    raise exception 'cancellation actor is not the assigned driver' using errcode = '42501';
  end if;
  if p_actor_role = 'customer' and j.customer_id is distinct from p_actor then
    raise exception 'cancellation actor is not the customer' using errcode = '42501';
  end if;
  q := public.cancellation_fee_quote(p_job_id, p_actor_role, now());
  ok := public.cancel_job_safely(p_job_id, p_reason);
  if ok and j.status not in ('cancelled','canceled') then
    update public.jobs
       set metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
             'cancelled_by', p_actor, 'cancelled_by_role', p_actor_role,
             'cancelled_driver_id', coalesce(j.driver_id, j.accepted_driver_id),
             'cancellation_fee_quote', q)
     where id = p_job_id;
  end if;
  return ok;
end $$;
revoke all on function public.cancel_job_with_actor(uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function public.cancel_job_with_actor(uuid,text,uuid,text) to service_role;

-- Enabling/disabling a published version (service_role has no UPDATE on cancellation_policies).
-- The active policy stays "highest enabled version effective now"; history is never edited otherwise.
create or replace function public.set_cancellation_policy_enabled(p_policy uuid, p_tenant uuid, p_enabled boolean)
returns public.cancellation_policies language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.cancellation_policies;
begin
  update public.cancellation_policies set enabled = p_enabled
   where id = p_policy and tenant_id = p_tenant returning * into v;
  if not found then raise exception 'cancellation policy not found for tenant' using errcode = 'P0002'; end if;
  return v;
end $$;
revoke all on function public.set_cancellation_policy_enabled(uuid,uuid,boolean) from public, anon, authenticated;
grant execute on function public.set_cancellation_policy_enabled(uuid,uuid,boolean) to service_role;
