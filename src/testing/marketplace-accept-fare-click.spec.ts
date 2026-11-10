/**
 * REGRESSION — "Accept Fare & Pay" silently did nothing.
 *
 * TRACE: the template binds `(click)="acceptSuggestedFare()"`. That handler called
 * `lockAgreedFare(job.id, fare)` — which is a DELIBERATE NO-OP ("the client is never
 * authoritative for agreed_fare") — and then, because `hybridEnabled` is true for an
 * errand, unconditionally entered the in-place Stripe branch:
 *
 *     if (this.hybridEnabled) { await this.loadBooking(job.id); await this.initializeStripe(); return; }
 *
 * `initializeStripe()` begins with:
 *
 *     if (this.booking()?.status !== 'fare_agreed') return;
 *
 * Nothing moves `jobs.status` to 'fare_agreed' when a customer merely accepts the
 * authoritative SUGGESTED fare (only driver_accept_customer_offer /
 * customer_accept_driver_counter do, and the deferred accept_original_fare RPC does
 * not exist). So the job stayed 'pending_fare_confirmation', initializeStripe()
 * returned at its guard, and the click produced no navigation, no payment UI, no
 * toast, no error and no HTTP request.
 *
 * These are source-contract assertions, consistent with the repo's existing specs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');

const PAGE_PATH = 'src/app/apps/mobile/features/customer/marketplace-fare/marketplace-fare.page.ts';
const NEG_PATH = 'src/app/core/services/marketplace/marketplace-negotiation.service.ts';

const PAGE = read(PAGE_PATH);
const NEG = read(NEG_PATH);

/** Slice a method body from its signature to the next named member. */
const bodyOf = (name: string, nextAnchor: string): string => {
  const start = PAGE.indexOf(`async ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = PAGE.indexOf(nextAnchor, start);
  expect(end, `anchor "${nextAnchor}" not found after ${name}`).toBeGreaterThan(start);
  return PAGE.slice(start, end);
};

describe('regression — acceptSuggestedFare must not silently no-op', () => {
  const body = bodyOf('acceptSuggestedFare', 'openHybridOfferInput()');

  it('template still binds the button to acceptSuggestedFare()', () => {
    expect(PAGE).toContain('(click)="acceptSuggestedFare()"');
  });

  it('in-place Stripe init is gated on an authoritative agreement', () => {
    const hybridIdx = body.indexOf('if (this.hybridEnabled)');
    const guardIdx = body.indexOf("this.booking()?.status === 'fare_agreed'");
    const stripeIdx = body.indexOf('await this.initializeStripe();');

    expect(hybridIdx).toBeGreaterThan(-1);
    expect(guardIdx, 'fare_agreed gate missing').toBeGreaterThan(hybridIdx);
    expect(stripeIdx, 'initializeStripe call missing').toBeGreaterThan(guardIdx);
  });

  it('falls through to the existing payment route when no agreement exists', () => {
    expect(body).toContain("await this.router.navigate(['/customer/marketplace-payment', job.id]);");
    // navigation must come AFTER the guarded Stripe attempt, i.e. it is the fallback
    const stripeIdx = body.indexOf('await this.initializeStripe();');
    const navIdx = body.indexOf("marketplace-payment");
    expect(navIdx).toBeGreaterThan(stripeIdx);
  });

  it('the fallback route is a real, unguarded-by-fare_agreed destination', () => {
    expect(read('src/app/apps/mobile/mobile.routes.ts')).toContain("path: 'marketplace-payment/:id'");
    const paymentPage = read('src/app/apps/mobile/features/customer/marketplace-payment/marketplace-payment.page.ts');
    // Entry is NOT gated on the job being fare_agreed, so this remains the correct
    // fallback destination. The page now READS the negotiation session's status
    // (and payment_deadline) only to derive the authoritative payment window.
    const init = paymentPage.slice(paymentPage.indexOf('async ngOnInit()'), paymentPage.indexOf('async ngAfterViewInit()'));
    expect(init).not.toContain('fare_agreed');
    expect(paymentPage).toContain("from('marketplace_negotiation_sessions')");
  });

  it('no silent early return remains in the handler', () => {
    expect(body).not.toMatch(/if \(!job\)\s*return;/);
    expect(body).not.toMatch(/if \(fare === null\)\s*return;/);
    expect(body).toContain('Unable to load this booking');
    expect(body).toContain('We cannot confirm a fare');
  });

  it('initializeStripe keeps its precondition (the guard was right; entering it was wrong)', () => {
    const start = PAGE.indexOf('private async initializeStripe(');
    expect(start).toBeGreaterThan(-1);
    expect(PAGE.slice(start, start + 400)).toContain("if (this.booking()?.status !== 'fare_agreed') return;");
  });

  it('lockAgreedFare is a documented no-op — which is why fare_agreed can never come from it', () => {
    const start = NEG.indexOf('async lockAgreedFare(');
    expect(start).toBeGreaterThan(-1);
    const lock = NEG.slice(start, NEG.indexOf('async driverAcceptOffer('));
    expect(lock).toContain('void jobId;');
    expect(lock).toContain('void amount;');
    expect(lock).not.toContain('this.http.');
    expect(lock).not.toContain('.rpc(');
  });
});
