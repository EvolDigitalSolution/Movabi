/**
 * PATCH 1A(b) — seven negotiation authority RPCs: SOURCE/CONTRACT tests.
 *
 * These assert STRUCTURE and CLIENT-CALL contracts. They do NOT execute PostgreSQL;
 * runtime semantics remain unverified until the migration is applied to a controlled
 * database (see the explicit limitation in the report).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');

const MIGRATION = read('supabase/migrations/20261231000000_negotiation_lifecycle_authority.sql');
const SERVICE = read('src/app/core/services/marketplace/marketplace-hybrid.service.ts');
const FARE_PAGE = read('src/app/apps/mobile/features/customer/marketplace-fare/marketplace-fare.page.ts');
const DRIVER_PAGE = read('src/app/apps/mobile/features/driver/hybrid-negotiation/hybrid-negotiation.page.ts');
const DASHBOARD = read('src/app/apps/mobile/features/driver/dashboard/dashboard.page.ts');
const RECONCILE = read('supabase_incremental_schema_reconcile.sql');

const SEVEN = [
  'create_customer_offer', 'customer_counter_offer', 'driver_counter_offer',
  'customer_cancel_offer', 'customer_decline_counter',
  'customer_accept_driver_counter', 'driver_accept_customer_offer'
];

describe('Patch 1A(b) — authority migration structure', () => {
  it('defines all seven transitions and no accept_original_fare', () => {
    for (const fn of SEVEN) {
      expect(MIGRATION, fn).toContain(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    }
    expect(MIGRATION).not.toContain('accept_original_fare');
  });

  it('every transition is SECURITY DEFINER with a locked search_path', () => {
    // 7 transitions + 1 turn helper = 8 SECURITY DEFINER functions minimum.
    const sd = (MIGRATION.match(/SECURITY DEFINER/g) ?? []).length;
    expect(sd).toBeGreaterThanOrEqual(8);
    const sp = (MIGRATION.match(/SET search_path = public/g) ?? []).length;
    expect(sp).toBeGreaterThanOrEqual(8);
  });

  it('every transition derives the actor from auth.uid() and rejects a null actor', () => {
    const auth = (MIGRATION.match(/auth\.uid\(\)/g) ?? []).length;
    expect(auth).toBeGreaterThanOrEqual(SEVEN.length + 1); // + helper/declarations
    expect(MIGRATION).toContain('v_actor UUID := auth.uid()');
    expect(MIGRATION).toContain("RAISE EXCEPTION 'Authentication required'");
  });

  it('mutation transitions lock the authoritative session row FOR UPDATE', () => {
    // 7 transitions; create_customer_offer locks the JOB (and session), the other 6 lock the session.
    const locks = (MIGRATION.match(/FOR UPDATE/g) ?? []).length;
    expect(locks).toBeGreaterThanOrEqual(7);
  });

  it('turn is derived from persisted state via ONE helper, not a turn column', () => {
    expect(MIGRATION).toContain('FUNCTION public.negotiation_live_proposal_role(');
    expect(MIGRATION).toContain("e.event_type IN (");
    // lifecycle events are excluded from the turn helper's fare set
    expect(MIGRATION).toContain("'customer_offer', 'driver_counter'");
    expect(MIGRATION).not.toContain('ADD COLUMN'); // no turn column is introduced
  });

  it('max-rounds uses the single authoritative get_marketplace_setting source', () => {
    expect(MIGRATION).toContain("get_marketplace_setting('hybrid_negotiation'");
    expect(MIGRATION).toContain('maxRounds');
    const maxRoundsUses = (MIGRATION.match(/->>'maxRounds'/g) ?? []).length;
    expect(maxRoundsUses).toBeGreaterThanOrEqual(2); // customer + driver counter
  });

  it('agreed fare is read from the persisted session, never a client amount', () => {
    expect(MIGRATION).toContain('v_agreed := v_session.driver_counter_offer'); // customer accept
    expect(MIGRATION).toContain('v_agreed := v_session.customer_offer');       // driver accept
    // accept RPCs take only p_session_id — no amount parameter
    expect(MIGRATION).toContain('FUNCTION public.customer_accept_driver_counter(\n  p_session_id UUID\n)');
    expect(MIGRATION).toContain('FUNCTION public.driver_accept_customer_offer(\n  p_session_id UUID\n)');
  });

  it('ACL is authenticated-only (never PUBLIC/anon)', () => {
    expect(MIGRATION).toContain('REVOKE EXECUTE ON FUNCTION public.create_customer_offer(UUID, NUMERIC) FROM anon;');
    expect(MIGRATION).toContain('GRANT EXECUTE ON FUNCTION public.driver_accept_customer_offer(UUID) TO authenticated;');
    expect(MIGRATION).toContain('GRANT EXECUTE ON FUNCTION public.negotiation_live_proposal_role(UUID) TO authenticated, service_role;');
  });

  it('removes broad lifecycle write authority but keeps participant SELECT', () => {
    expect(MIGRATION).toContain('DROP POLICY IF EXISTS hybrid_sessions_owner_write');
    expect(MIGRATION).toContain('DROP POLICY IF EXISTS hybrid_sessions_customer_insert');
    expect(MIGRATION).toContain('DROP POLICY IF EXISTS hybrid_events_participants_insert');
    // SELECT is deliberately untouched — use word boundaries so the INSERT policy's
    // name (`hybrid_events_participants_insert`) is not mistaken for the SELECT one.
    expect(MIGRATION).not.toMatch(/DROP POLICY IF EXISTS hybrid_sessions_owner_or_driver\b/);
    expect(MIGRATION).not.toMatch(/DROP POLICY IF EXISTS hybrid_events_participants\s+ON/);
  });

  it('cancel and decline-counter share event_type customer_decline but are distinguishable', () => {
    expect(MIGRATION).toContain("'Customer cancelled offer'");
    expect(MIGRATION).toContain("'Customer declined driver counter'");
    // cancel -> terminal customer_declined; decline-counter -> released
    expect(MIGRATION).toContain("status = 'customer_declined'");
    expect(MIGRATION).toContain("status = 'released'");
    // no new event type introduced
    expect(MIGRATION).not.toContain("'customer_cancel'");
    expect(MIGRATION).not.toContain("'customer_decline_counter'");
  });
});

describe('Patch 1A(b) — client service conversion', () => {
  it('no direct session INSERT/UPDATE/event INSERT remains', () => {
    expect(SERVICE).not.toMatch(/from\('marketplace_negotiation_sessions'\)\s*\.insert/);
    expect(SERVICE).not.toMatch(/from\('marketplace_negotiation_sessions'\)\s*\.update/);
    expect(SERVICE).not.toMatch(/from\('marketplace_negotiation_events'\)\s*\.insert/);
  });

  it('createCustomerOffer is RPC-only and takes no identity/reference-fare authority', () => {
    const body = SERVICE.slice(SERVICE.indexOf('async createCustomerOffer('), SERVICE.indexOf('async claimSession('));
    expect(body).toContain("rpc('create_customer_offer'");
    expect(body).toContain('p_job_id');
    expect(body).toContain('p_amount');
    expect(body).not.toContain('customer_id');
    expect(body).not.toContain('suggested_fare');
  });

  it('the customer->driver lockFare authority inversion is REMOVED', () => {
    const accept = SERVICE.slice(SERVICE.indexOf('async acceptDriverCounter('), SERVICE.indexOf('async acceptCustomerOffer('));
    expect(accept).toContain("rpc('customer_accept_driver_counter'");
    expect(accept).not.toContain('lockFare');
    expect(accept).not.toContain('p_driver_id');
  });

  it('driver accept uses the driver-authority transition', () => {
    const accept = SERVICE.slice(SERVICE.indexOf('async acceptCustomerOffer('), SERVICE.indexOf('private async notifyFareAgreed('));
    expect(accept).toContain("rpc('driver_accept_customer_offer'");
    expect(accept).not.toContain('lockFare');
  });

  it('cancel and decline-counter are separate authoritative transitions', () => {
    expect(SERVICE).toContain("rpc('customer_cancel_offer'");
    expect(SERVICE).toContain("rpc('customer_decline_counter'");
  });

  it('notification remains best-effort and AFTER the authoritative mutation', () => {
    expect(SERVICE).toContain('private async notifyFareAgreed(');
    // createCustomerOffer awaits notify after the RPC returns
    const create = SERVICE.slice(SERVICE.indexOf('async createCustomerOffer('), SERVICE.indexOf('async claimSession('));
    expect(create.indexOf("rpc('create_customer_offer'")).toBeLessThan(create.indexOf("notify({ action: 'notify_drivers'"));
  });
});

describe('Patch 1A(b) — UI wiring', () => {
  it('marketplace-fare consumes the canonical helper and gates Make an Offer', () => {
    // canonical helper invoked with the PERSISTED session+events; the trailing
    // wall-clock argument is a later, legitimate addition (lease expiry).
    expect(FARE_PAGE).toContain('getNegotiationState(this.hybridSession(), this.hybridEvents()');
    expect(FARE_PAGE).toContain("canCustomer('make_offer')");
    expect(FARE_PAGE).toContain("canCustomer('cancel_offer')");
  });

  it('Accept Original Fare is NOT exposed in the customer UI', () => {
    expect(FARE_PAGE).not.toMatch(/Accept Original Fare/i);
    expect(FARE_PAGE).not.toContain('accept_original_fare');
  });

  it('customer submit uses the 2-arg authoritative call (no identity / reference fare)', () => {
    expect(FARE_PAGE).toContain('createCustomerOffer(job.id, amount)');
    expect(FARE_PAGE).not.toContain("createCustomerOffer(\n                job.id,\n                this.auth.currentUser()?.id");
  });

  it('driver detail consumes the canonical helper and gates driver actions by turn', () => {
    expect(DRIVER_PAGE).toContain('getNegotiationState(this.session(), this.events()');
    expect(DRIVER_PAGE).toContain("canDriver('accept')");
  });

  it('dashboard surfaces claimed-session recovery WITHOUT re-claiming', () => {
    expect(DASHBOARD).toContain('recoverableNegotiations');
    expect(DASHBOARD).toContain('openRecoveredNegotiation(item.job_id)');
    expect(DASHBOARD).toContain("['/driver/hybrid-negotiation', jobId]");
    const open = DASHBOARD.slice(DASHBOARD.indexOf('openRecoveredNegotiation(jobId'), DASHBOARD.indexOf('openRecoveredNegotiation(jobId') + 300);
    expect(open).not.toContain('claimHybridSession');
  });
});

describe('Patch 1A(b) — reconcile convergence', () => {
  it('no longer recreates the broad owner UPDATE or participant event INSERT policies', () => {
    expect(RECONCILE).not.toContain('CREATE POLICY hybrid_sessions_owner_write');
    expect(RECONCILE).not.toContain('CREATE POLICY hybrid_events_participants_insert');
    expect(RECONCILE).toContain('DROP POLICY IF EXISTS hybrid_sessions_owner_write');
    expect(RECONCILE).toContain('DROP POLICY IF EXISTS hybrid_events_participants_insert');
  });

  it('participant SELECT is retained for Realtime', () => {
    expect(RECONCILE).toContain('CREATE POLICY hybrid_sessions_owner_or_driver');
    expect(RECONCILE).toContain('CREATE POLICY hybrid_events_participants');
  });

  it('the safe duration parser and identity guard are untouched', () => {
    expect(RECONCILE).toContain("BTRIM(j.metadata->>'duration_seconds') ~ '^[0-9]+(\\.[0-9]+)?$'");
    expect(RECONCILE).toContain("RAISE EXCEPTION 'You can only fetch your own opportunities';");
  });
});

describe('Patch 1A(b) closeout — released-row reuse and driver action gating', () => {
  it('reusing a released row clears stale lifecycle timestamps', () => {
    // A released row may have been claimed (claimed_at) or reached agreement
    // (payment_deadline) before returning to the pool; a fresh offer must not
    // leak those into the reopened negotiation.
    expect(MIGRATION).toContain('claimed_at = NULL');
    expect(MIGRATION).toContain('payment_deadline = NULL');
    expect(MIGRATION).toContain('agreed_fare = NULL');
    expect(MIGRATION).toContain('active_driver_id = NULL');
  });

  it('driver accept / counter / release are individually gated by the canonical helper', () => {
    expect(DRIVER_PAGE).toContain("canDriver('accept')");
    expect(DRIVER_PAGE).toContain("canDriver('counter')");
    expect(DRIVER_PAGE).toContain("canDriver('release')");
  });

  it('all three driver actions disable and re-enter guard while a mutation is busy', () => {
    expect(DRIVER_PAGE).toContain('mutationBusy');
    expect(DRIVER_PAGE).toContain('[disabled]="mutationBusy()"');
    expect(DRIVER_PAGE).toContain('mutationBusy() || !counterAmount()');
    expect(DRIVER_PAGE).toContain('if (this.mutationBusy()) return;');
    expect(DRIVER_PAGE).toContain('this.mutationBusy.set(false);');
  });

  it('post-success accept/counter reload persisted authoritative state', () => {
    expect(DRIVER_PAGE).toContain('await this.load();');
  });
});

describe('Patch 1A(b) — turn-authority correction (fail-closed)', () => {
  const helper = MIGRATION.slice(
    MIGRATION.indexOf('FUNCTION public.negotiation_live_proposal_role('),
    MIGRATION.indexOf('GRANT EXECUTE ON FUNCTION public.negotiation_live_proposal_role(UUID)')
  );

  it('helper fare-proposal filter is EXACTLY customer_offer and driver_counter', () => {
    expect(helper).toContain("event_type IN ('customer_offer', 'driver_counter')");
    // accept/decline/lifecycle events must never be fare-proposal owners
    for (const e of ['customer_accept', 'driver_accept', 'customer_decline', 'driver_decline',
                     'session_claimed', 'session_released', 'session_expired', 'payment_completed']) {
      expect(helper, e).not.toContain(`'${e}'`);
    }
  });

  it('driver counter and driver accept require POSITIVE customer-turn proof (fail closed)', () => {
    const driverSide = (MIGRATION.match(/IS DISTINCT FROM 'customer'/g) ?? []);
    expect(driverSide.length).toBeGreaterThanOrEqual(2); // driver_counter_offer + driver_accept_customer_offer
  });

  it('customer-side responses require POSITIVE driver-turn proof', () => {
    const customerSide = (MIGRATION.match(/IS DISTINCT FROM 'driver'/g) ?? []);
    expect(customerSide.length).toBeGreaterThanOrEqual(3); // counter, decline-counter, accept-counter
  });

  it('no transition uses a NULL-passing "= role" turn rejection', () => {
    expect(MIGRATION).not.toContain("= 'driver'");
    expect(MIGRATION).not.toContain("= 'customer'");
  });

  it('customer cancel expiry allowance is explicit, not accidental', () => {
    expect(MIGRATION).toContain('EXPIRY INTENT');
    expect(MIGRATION).toContain('Therefore NO expires_at check is applied here');
  });
});
