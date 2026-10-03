/**
 * BOOKING REQUEST FRESH-RESET regression.
 *
 * A previous request must never bleed into a new service. The reset is owned by
 * BookingRequestPage.resetRequestState(), invoked from applyRequestedType whenever
 * the route resolves a DIFFERENT service type.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');
const PAGE = read('src/app/apps/mobile/features/customer/booking-request/booking-request.page.ts');

const resetFn = () => PAGE.slice(PAGE.indexOf('private resetRequestState(): void {'), PAGE.indexOf('ngOnDestroy()'));
const applyFn = () => PAGE.slice(PAGE.indexOf('private applyRequestedType('), PAGE.indexOf('private async autoPrefillPickupOnce()'));

describe('BookingRequestPage fresh-request reset', () => {
  it('A/B/C. reset clears fare/route/quote + draft pickup/dropoff (no leak)', () => {
    const fn = resetFn();
    expect(fn).toContain('this.fareEstimate.set(null);');
    expect(fn).toContain('this.estimatedPrice.set(0);');
    expect(fn).toContain('this.routeResult.set(null);');
    expect(fn).toContain('this.lastFareBreakdown = null;');
    expect(fn).toContain('this.lastQuoteReference = null;');
    expect(fn).toContain('this.lastQuoteExpiresAt = null;');
    // draft locations reset so previous pickup/dropoff never leak
    expect(fn).toContain("this.pickupLocation = { source: 'manual', address: '' };");
    expect(fn).toContain("this.dropoffLocation = { source: 'manual', address: '' };");
    expect(fn).toContain('this.pickupManuallyChanged.set(false);');
  });

  it('D. map markers + route geometry are cleared without a browser reload', () => {
    const fn = resetFn();
    expect(fn).toContain("this.mapComponent?.removeMarker('pickup');");
    expect(fn).toContain("this.mapComponent?.removeMarker('dropoff');");
    expect(fn).toContain('this.mapComponent?.clearRoute();');
  });

  it('the reset is invoked when the route resolves a DIFFERENT service type', () => {
    const fn = applyFn();
    expect(fn).toContain('this.resetRequestState();');
    // it runs after resolving/committing the new type and before initForm
    const commit = fn.indexOf('this.type = nextType;');
    const reset = fn.indexOf('this.resetRequestState();');
    const initForm = fn.indexOf('this.initForm();');
    expect(reset).toBeGreaterThan(commit);
    expect(reset).toBeLessThan(initForm);
  });

  it('same-type navigation is still a no-op (preserves live draft)', () => {
    const fn = applyFn();
    expect(fn).toContain('const changed = this.lastResolvedType !== nextType;');
    expect(fn).toContain('if (!changed) return;');
    // the reset is only reachable AFTER the changed guard
    expect(fn.indexOf('if (!changed) return;')).toBeLessThan(fn.indexOf('this.resetRequestState();'));
  });

  it('does not use browser reload / setTimeout / localStorage.clear / auth wipe', () => {
    expect(resetFn()).not.toContain('window.location.reload');
    expect(resetFn()).not.toContain('setTimeout');
    expect(resetFn()).not.toContain('localStorage.clear');
    expect(resetFn()).not.toContain('this.auth.');
    expect(resetFn()).not.toContain('sessionStorage.clear');
  });

  it('service type resolution is unchanged (slug still derives from this.type)', () => {
    expect(PAGE).toContain('private getServiceSlug(): ServiceTypeSlug {');
    const fn = PAGE.slice(PAGE.indexOf('private getServiceSlug(): ServiceTypeSlug {'));
    expect(fn).toContain('case ServiceTypeEnum.ERRAND:');
    expect(fn).toContain("return 'errand';");
  });

  it('the title/header still derives from this.type (correct after reset)', () => {
    expect(PAGE).toContain('getTitle(): string {');
    const fn = PAGE.slice(PAGE.indexOf('getTitle(): string {'), PAGE.indexOf('getIcon(): string {'));
    expect(fn).toContain('case ServiceTypeEnum.RIDE:');
    expect(fn).toContain("return 'Ride Request';");
    expect(fn).toContain('case ServiceTypeEnum.ERRAND:');
    expect(fn).toContain("return 'Shop';");
  });

  it('the MapRenderer rebuild-on-service-change fix is preserved', () => {
    const mapr = read('src/app/core/services/maps/map-renderer.service.ts');
    expect(mapr).toContain('_movabiServiceType');
    expect(mapr).toContain('const changed = serviceType !== prevServiceType || kind !== prevKind');
  });
});

describe('Quote authority/dedupe reset (23505 fix)', () => {
  const reset = () => PAGE.slice(PAGE.indexOf('private resetRequestState(): void {'), PAGE.indexOf('ngOnDestroy()'));

  it('clears the complete quote authority/dedupe state', () => {
    const fn = reset();
    expect(fn).toContain('this.lastQuotedSignature = null;');
    expect(fn).toContain('this.quoteInFlightSignature = null;');
    expect(fn).toContain('this.currentQuoteSignature.set(null);');
    expect(fn).toContain('this.authoritativeQuote.set(null);');
    expect(fn).toContain('this.lastQuoteReference = null;');
    expect(fn).toContain('this.lastFareBreakdown = null;');
    expect(fn).toContain('this.lastQuoteExpiresAt = null;');
  });

  it('fareRequestSequence is MONOTONICALLY advanced, never reset to zero', () => {
    const fn = reset();
    expect(fn).toContain('this.fareRequestSequence += 1;');
    expect(fn).not.toContain('this.fareRequestSequence = 0;');
  });

  it('the stale-response guard still compares the captured generation to the live one', () => {
    expect(PAGE).toContain('const requestId = ++this.fareRequestSequence;');
    expect(PAGE).toContain('if (requestId !== this.fareRequestSequence) return;');
  });

  it('a single submit is serialised (submitting guard before any await)', () => {
    const submit = PAGE.slice(PAGE.indexOf('async submit() {'), PAGE.indexOf('private recordLocalServicePreference()'));
    expect(submit).toContain('if (this.submitting() || this.paymentProcessing()) return;');
    // submitting is set true synchronously BEFORE the network mutation, so a
    // re-entrant submit() hits the guard and returns.
    const setTrue = submit.indexOf('this.submitting.set(true);');
    const createAwait = submit.indexOf('await this.bookingService.createBooking(');
    expect(setTrue).toBeGreaterThan(-1);
    expect(createAwait).toBeGreaterThan(setTrue);
    // and it is always released in finally
    expect(submit).toContain('this.submitting.set(false);');
  });
});
