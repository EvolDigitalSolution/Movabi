-- ============================================================================
-- CAMPAIGN DISCOUNT REPLAY ORDER FIX
-- 20261255800000 checks per-user cap before the idempotent same-quote replay,
-- so re-applying the same (campaign, customer, quote) raised campaign_cap_reached
-- instead of returning the existing application. Reorder replay before cap.
-- ============================================================================
CREATE OR REPLACE FUNCTION apply_campaign_discount(
  p_campaign uuid, p_customer uuid, p_quote text, p_fare_minor bigint)
returns campaign_discount_applications language plpgsql security definer set search_path=public as $$
declare c campaigns; v campaign_discount_applications; used int; discount bigint;
begin
  select * into c from campaigns where id=p_campaign for update;
  if not found or not c.enabled or c.kind<>'customer_discount' then raise exception 'campaign_unavailable'; end if;
  if c.valid_from is not null and c.valid_from>now() then raise exception 'campaign_not_started'; end if;
  if c.valid_until is not null and c.valid_until<=now() then raise exception 'campaign_expired'; end if;

  if coalesce((c.qualification->>'firstBookingOnly')::boolean,false) then
    if exists(select 1 from jobs where customer_id=p_customer
              and status in ('completed','delivered','settled')
              and payment_status in ('paid','succeeded','cash_due','cash_pending')) then
      raise exception 'campaign_first_booking_only';
    end if;
  end if;
  if c.qualification->>'min_qualifying_fare_minor' is not null
     and p_fare_minor < (c.qualification->>'min_qualifying_fare_minor')::bigint then
    raise exception 'campaign_fare_below_minimum';
  end if;

  -- Idempotent replay first: same (campaign, customer, quote) returns existing.
  select * into v from campaign_discount_applications
   where campaign_id=p_campaign and customer_id=p_customer and quote_reference=p_quote;
  if found then return v; end if;

  select count(*) into used from campaign_discount_applications
   where campaign_id=p_campaign and customer_id=p_customer and status in ('applied','consumed');
  if used>=c.per_user_cap then raise exception 'campaign_cap_reached'; end if;

  discount := case when c.value_type='percent' then least(floor(p_fare_minor * c.value / 100), p_fare_minor)
                   when c.value_type='fixed_minor' then least(c.value::bigint, p_fare_minor)
                   else 0 end;
  if c.qualification->>'max_discount_minor' is not null
     and discount > (c.qualification->>'max_discount_minor')::bigint then
    discount := (c.qualification->>'max_discount_minor')::bigint;
  end if;
  if discount <= 0 then raise exception 'campaign_no_discount'; end if;
  if c.budget_minor>0 and not campaign_spend(c.id, discount) then raise exception 'campaign_budget_exhausted'; end if;
  insert into campaign_discount_applications(tenant_id,campaign_id,customer_id,quote_reference,discount_minor)
    values(c.tenant_id,p_campaign,p_customer,p_quote,discount) returning * into v;
  return v;
end$$;
