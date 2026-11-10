-- ============================================================================
-- PROMO POLICY V2 — qualification rules + margin preview.
-- customer_discount campaigns now honour qualification jsonb:
--   {"firstBookingOnly": true,
--    "min_qualifying_fare_minor": <int>,
--    "max_discount_minor": <int>}
-- Discount is on the eligible service fare only (no taxes/tips/fees — the
-- caller passes the eligible fare, excluding separately disclosed charges).
-- Platform-funded: driver earnings are untouched (funding_party='platform').
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

  -- First-booking-only: reject if the customer has any prior completed/paid job.
  if coalesce((c.qualification->>'firstBookingOnly')::boolean,false) then
    if exists(select 1 from jobs where customer_id=p_customer
              and status in ('completed','delivered','settled')
              and payment_status in ('paid','succeeded','cash_due','cash_pending')) then
      raise exception 'campaign_first_booking_only';
    end if;
  end if;
  -- Market-configured minimum eligible fare.
  if c.qualification->>'min_qualifying_fare_minor' is not null
     and p_fare_minor < (c.qualification->>'min_qualifying_fare_minor')::bigint then
    raise exception 'campaign_fare_below_minimum';
  end if;

  select count(*) into used from campaign_discount_applications
   where campaign_id=p_campaign and customer_id=p_customer and status in ('applied','consumed');
  if used>=c.per_user_cap then raise exception 'campaign_cap_reached'; end if;
  select * into v from campaign_discount_applications
   where campaign_id=p_campaign and customer_id=p_customer and quote_reference=p_quote;
  if found then return v; end if;

  discount := case when c.value_type='percent' then least(floor(p_fare_minor * c.value / 100), p_fare_minor)
                   when c.value_type='fixed_minor' then least(c.value::bigint, p_fare_minor)
                   else 0 end;
  -- Market-configured maximum discount cap.
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
revoke all on function apply_campaign_discount(uuid,uuid,text,bigint) from public, anon, authenticated;
grant execute on function apply_campaign_discount(uuid,uuid,text,bigint) to service_role;

-- Margin preview: given a frozen fare split + an optional discount + optional
-- referral liability + a payment-processing estimate, return Vaydu's net
-- margin. Read-only; admin preview before enabling anything.
CREATE OR REPLACE FUNCTION preview_vaydu_margin(
  p_fare_snapshot jsonb,           -- fare-split-v1 terms
  p_discount_minor bigint default 0,
  p_referral_liability_minor bigint default 0,
  p_processing_minor bigint default 0)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare commission bigint; fee bigint; charge bigint; net bigint; margin bigint;
begin
  commission := (p_fare_snapshot->>'driverCommissionAmount')::bigint;
  fee := (p_fare_snapshot->>'platformFeeAmount')::bigint;
  charge := (p_fare_snapshot->>'customerCharge')::bigint;
  net := (p_fare_snapshot->>'driverEntitlement')::bigint;
  -- Vaydu's gross take is commission + platform fee; costs are the platform-
  -- funded discount, referral liability and payment processing.
  margin := commission + fee
          - coalesce(p_discount_minor,0)
          - coalesce(p_referral_liability_minor,0)
          - coalesce(p_processing_minor,0);
  return jsonb_build_object(
    'customerChargeMinor', charge,
    'driverEntitlementMinor', net,
    'grossRevenueMinor', commission + fee,
    'discountMinor', coalesce(p_discount_minor,0),
    'referralLiabilityMinor', coalesce(p_referral_liability_minor,0),
    'processingMinor', coalesce(p_processing_minor,0),
    'vayduMarginMinor', margin,
    'marginBps', case when charge>0 then (margin::numeric * 10000 / charge)::int else null end);
end$$;
revoke all on function preview_vaydu_margin(jsonb,bigint,bigint,bigint) from public, anon, authenticated;
grant execute on function preview_vaydu_margin(jsonb,bigint,bigint,bigint) to service_role;
