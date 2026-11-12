// Generates supabase/migrations/20261269000000_merge_cash_pilot_with_roadmap_cash.sql and its rollback.
//
// Why: the cash-ride chain (20261266000000..300000) and the roadmap chain (20261255500000..
// 20261263000000) replace the same three functions from different bases, so whichever is applied
// second silently reverts the other. This migration runs AFTER BOTH (in either order) and installs one
// merged body per function. Every body is taken VERBATIM from the migration that last defined it; each
// edit below must match exactly once (asserted), so a drift in either source fails generation.
//
// Merged rules:
//  * Market-scoped pilot (cash): the global switch becomes driver_cash_credit_market_enabled_v1e(country,
//    currency) in the cash-credit trigger and the reserve function (it still requires the global switch).
//  * Restores the disabled-acquisition gate (20261255600000) that 20261255700000/20261263000000 dropped:
//    a cash job gaining a driver where cash is not enabled fails with CE001.
//  * Rides (cash plan, agreed 2026-11-12): acquisition only through cash_ride_acquirable_v1e (enabled
//    market, full cash custody, no PaymentIntent, authorised card fee hold).
//  * Courier cash (roadmap: delivery/errand, cash credit only, no card hold): kept, but OFF by default —
//    allowed only where driver_cash_credit_markets_v1e.courier_enabled is explicitly true. Whether courier
//    cash should be enabled anywhere is a business decision (matrix D10); nothing here enables it.
//
// Usage: node scripts/migration-merge/generate-cash-roadmap-merge.cjs
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '');

function fnBlock(text, name, file) {
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${file}`);
  const tail = text.slice(start);
  // Terminators used in the sources: "END $$;", "END $_$;", "END;\n$function$;", "$$;".
  const end = tail.search(/\n(END ?\$_?\$;|END;\n\$function\$;|\$\$;)/);
  if (end < 0) throw new Error(`${name}: end not found in ${file}`);
  const terminator = tail.slice(end).match(/^\n(END ?\$_?\$;|END;\n\$function\$;|\$\$;)/)[0];
  // A block must contain exactly one function definition.
  if ((tail.slice(0, end).match(/CREATE (OR REPLACE )?FUNCTION/g) || []).length !== 1) throw new Error(`${name}: block overran in ${file}`);
  return tail.slice(0, end + terminator.length).trim() + '\n';
}
function once(body, from, to, label) {
  const n = body.split(from).length - 1;
  if (n !== 1) throw new Error(`${label}: expected exactly one match, found ${n}`);
  return body.replace(from, to);
}

const ELIG_SRC = 'supabase/migrations/20261255500000_cash_acquisition_eligibility.sql';
const ROADMAP_SRC = 'supabase/migrations/20261263000000_courier_cash_reassignment.sql';
const CASH_PILOT_SRC = 'supabase/migrations/20261266000000_driver_cash_credit_market_pilot.sql';
const elig = fnBlock(read(ELIG_SRC), 'enforce_job_payment_eligibility', ELIG_SRC);
const trig = fnBlock(read(ROADMAP_SRC), 'enforce_ride_cash_credit_v1e', ROADMAP_SRC);
const reserve = fnBlock(read(ROADMAP_SRC), 'reserve_cash_job_credit_v1e', ROADMAP_SRC);

// 1) Payment eligibility: non-cash unchanged; cash rides via the cash plan; courier cash only if enabled.
const eligMerged = once(elig,
`        -- Cash custody is verified by enforce_ride_cash_credit_v1e; exempt it
        -- from the electronic-payment status gate.
        IF NEW.payment_method IS DISTINCT FROM 'cash'
           AND NEW.payment_status NOT IN (
               'paid', 'wallet_funded', 'authorized', 'requires_capture', 'succeeded', 'captured'
           ) THEN`,
`        -- Non-cash: the electronic-payment status gate (unchanged).
        -- Cash Ride: only through cash_ride_acquirable_v1e (cash-ride plan: enabled pilot market, full
        --   cash custody, no PaymentIntent, authorised card fee hold).
        -- Cash courier (delivery/errand): only where courier cash is explicitly enabled for the market;
        --   cash custody/credit is then verified by enforce_ride_cash_credit_v1e.
        IF (NEW.payment_method IS DISTINCT FROM 'cash'
            AND NEW.payment_status NOT IN (
                'paid', 'wallet_funded', 'authorized', 'requires_capture', 'succeeded', 'captured'
            ))
           OR (NEW.payment_method = 'cash' AND NOT public.cash_acquisition_allowed_v1e(NEW)) THEN`,
'eligibility gate');

// 2) Cash-credit trigger: market-scoped + restored disabled-acquisition gate.
const trigMerged = once(trig,
` IF NOT public.driver_cash_credit_enabled_v1e() OR NEW.payment_method IS DISTINCT FROM 'cash' THEN RETURN NEW; END IF;
 SELECT st.slug INTO slug FROM public.service_types st WHERE st.id=NEW.service_type_id;
 IF slug IS NULL OR slug NOT IN ('ride','delivery','errand') THEN RETURN NEW; END IF;`,
` IF NEW.payment_method IS DISTINCT FROM 'cash' THEN RETURN NEW; END IF;
 SELECT st.slug INTO slug FROM public.service_types st WHERE st.id=NEW.service_type_id;
 IF slug IS NULL OR slug NOT IN ('ride','delivery','errand') THEN RETURN NEW; END IF;
 IF NOT public.cash_service_enabled_v1e(slug,NEW.country_code,NEW.currency_code) THEN
  -- Restored disabled-acquisition gate (20261255600000, dropped by 20261255700000): a cash job
  -- gaining a driver where cash is not enabled must fail, not silently skip the reservation.
  driver:=coalesce(NEW.driver_id,NEW.accepted_driver_id);
  IF driver IS NOT NULL AND (TG_OP='INSERT' OR coalesce(OLD.driver_id,OLD.accepted_driver_id) IS NULL)
     AND NEW.status IN ('assigned','accepted','heading_to_pickup','driver_en_route','arrived','in_progress','completed','delivered','settled') THEN
   RAISE EXCEPTION 'Cash is not enabled for this service in this market' USING ERRCODE='CE001';
  END IF;
  RETURN NEW;
 END IF;`,
'cash-credit trigger');

// 3) Reserve: market-scoped pilot check (after the service is known).
let reserveMerged = once(reserve,
` IF NOT public.driver_cash_credit_enabled_v1e() THEN RAISE EXCEPTION 'Cash credit pilot disabled' USING ERRCODE='CE001'; END IF;
`, '', 'reserve global switch');
reserveMerged = once(reserveMerged,
`  RAISE EXCEPTION 'Cash credit supports Ride, delivery and errand only' USING ERRCODE='CE002'; END IF;
`,
`  RAISE EXCEPTION 'Cash credit supports Ride, delivery and errand only' USING ERRCODE='CE002'; END IF;
 IF NOT public.cash_service_enabled_v1e((SELECT slug FROM public.service_types WHERE id=j.service_type_id),j.country_code,j.currency_code) THEN
  RAISE EXCEPTION 'Cash credit pilot disabled for this service in this market' USING ERRCODE='CE001'; END IF;
`, 'reserve market check');

// 4) The cash pilot's status function (the roadmap never changed it): re-asserted verbatim.
const status = fnBlock(read(CASH_PILOT_SRC), 'driver_cash_credit_status_v1f', CASH_PILOT_SRC);

const NAME = '20261269000000_merge_cash_pilot_with_roadmap_cash';
const up = `-- ${NAME}
-- GENERATED by scripts/migration-merge/generate-cash-roadmap-merge.cjs — do not edit by hand.
-- Runs AFTER both the roadmap chain (through 20261263000000) and the cash-ride chain
-- (20261266000000..20261266300000), in either order, and installs one merged body for each function
-- both chains replace. Sources (verbatim, then asserted single edits):
--   enforce_job_payment_eligibility  <- ${ELIG_SRC}
--   enforce_ride_cash_credit_v1e     <- ${ROADMAP_SRC}
--   reserve_cash_job_credit_v1e      <- ${ROADMAP_SRC}
--   driver_cash_credit_status_v1f    <- ${CASH_PILOT_SRC}
-- Enables nothing: courier_enabled defaults to false and no market row is written.
BEGIN;
DO $pre$ BEGIN
  IF to_regclass('public.driver_cash_credit_markets_v1e') IS NULL OR to_regclass('public.cash_ride_fee_holds_v1e') IS NULL
     OR to_regprocedure('public.cash_ride_acquirable_v1e(public.jobs)') IS NULL THEN
    RAISE EXCEPTION 'merge requires the cash-ride chain (20261266000000..20261266300000) first';
  END IF;
  IF to_regprocedure('public.reassign_cash_job_credit_v1f(uuid,uuid)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.driver_cash_credit_holds_v1e'::regclass AND pg_get_constraintdef(oid) LIKE '%reassigned%') THEN
    RAISE EXCEPTION 'merge requires the roadmap cash chain (through 20261263000000) first';
  END IF;
END $pre$;

ALTER TABLE public.driver_cash_credit_markets_v1e ADD COLUMN IF NOT EXISTS courier_enabled boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.driver_cash_credit_markets_v1e.courier_enabled IS
  'Courier (delivery/errand) cash with cash credit and no card hold. Off unless explicitly enabled (business decision D10).';

-- Is cash enabled for this service in this market? Ride: the market pilot. Courier: the market pilot AND courier_enabled.
CREATE OR REPLACE FUNCTION public.cash_service_enabled_v1e(p_slug text, p_country text, p_currency text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce(public.driver_cash_credit_market_enabled_v1e(p_country,p_currency), false)
    AND CASE WHEN p_slug = 'ride' THEN true
             WHEN p_slug IN ('delivery','errand') THEN coalesce((SELECT m.courier_enabled FROM public.driver_cash_credit_markets_v1e m
                    WHERE m.country_code = p_country AND m.currency_code = p_currency), false)
             ELSE false END $$;
REVOKE ALL ON FUNCTION public.cash_service_enabled_v1e(text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cash_service_enabled_v1e(text,text,text) TO service_role;

-- May this cash job acquire a driver? Ride: the cash-ride plan rule. Courier: enabled + full cash custody.
CREATE OR REPLACE FUNCTION public.cash_acquisition_allowed_v1e(j public.jobs) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT coalesce(CASE (SELECT s.slug FROM public.service_types s WHERE s.id = j.service_type_id)
   WHEN 'ride' THEN public.cash_ride_acquirable_v1e(j)
   WHEN 'delivery' THEN public.cash_service_enabled_v1e('delivery', j.country_code, j.currency_code)
        AND j.payment_intent_id IS NULL AND j.metadata->>'cash_collection_mode' = 'full_customer_charge'
   WHEN 'errand' THEN public.cash_service_enabled_v1e('errand', j.country_code, j.currency_code)
        AND j.payment_intent_id IS NULL AND j.metadata->>'cash_collection_mode' = 'full_customer_charge'
   ELSE false END, false) $$;
REVOKE ALL ON FUNCTION public.cash_acquisition_allowed_v1e(public.jobs) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cash_acquisition_allowed_v1e(public.jobs) TO service_role;

${eligMerged}
${trigMerged}
${reserveMerged}
${status}
COMMIT;
`;

// Rollback: back to the state after the roadmap chain (its final bodies, verbatim) — the expected order is
// cash chain on develop first, then roadmap + this merge in one release, so rolling that release back
// also rolls back the roadmap chain. Recorded data (markets, holds) is kept.
const down = `-- Rollback for ${NAME} (GENERATED). Restores the roadmap-final bodies verbatim and removes the merge
-- helpers and the courier_enabled column. Roll back the roadmap chain too (see header of the up migration).
BEGIN;
${elig}
${trig}
${reserve}
DROP FUNCTION IF EXISTS public.cash_acquisition_allowed_v1e(public.jobs);
DROP FUNCTION IF EXISTS public.cash_service_enabled_v1e(text,text,text);
ALTER TABLE public.driver_cash_credit_markets_v1e DROP COLUMN IF EXISTS courier_enabled;
COMMIT;
`;

module.exports = { NAME, up, down };
if (require.main === module) {
  fs.writeFileSync(path.join(root, 'supabase', 'migrations', NAME + '.sql'), up);
  fs.writeFileSync(path.join(root, 'scripts', 'migration-merge', NAME + '.down.sql'), down);
  console.log('wrote', NAME);
}
