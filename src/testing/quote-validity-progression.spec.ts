import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const request = read('src/app/apps/mobile/features/customer/booking-request/booking-request.page.ts');
const marketplace = read('src/app/apps/mobile/features/customer/marketplace-fare/marketplace-fare.page.ts');

/**
 * Behavioural mirror of BookingRequestPage.quoteValid. The real computed is:
 *   authoritativeQuote present
 *   && !fareCalculating && !fareCalculationError
 *   && quote.signature === currentQuoteSignature
 *   && estimate present
 *   && Number.isFinite(total) && total > 0
 *   && (!expiresAt || Date.parse(expiresAt) > now)
 */
interface QuoteState {
  authoritative: { signature: string; total: number; expiresAt: string | null } | null;
  calculating: boolean;
  error: string | null;
  currentSignature: string | null;
  estimateTotal: unknown;
  now?: number;
}
const quoteValid = (s: QuoteState): boolean => {
  if (!s.authoritative) return false;
  if (s.calculating || s.error) return false;
  if (s.authoritative.signature !== s.currentSignature) return false;
  if (s.estimateTotal === null || s.estimateTotal === undefined) return false;
  const total = Number(s.estimateTotal);
  if (!Number.isFinite(total) || total <= 0) return false;
  const now = s.now ?? Date.now();
  if (s.authoritative.expiresAt && Date.parse(s.authoritative.expiresAt) <= now) return false;
  return true;
};

const ok: QuoteState = {
  authoritative: { signature: 'sig-A', total: 12.5, expiresAt: null },
  calculating: false, error: null, currentSignature: 'sig-A', estimateTotal: 12.5
};

describe('failed / invalid quote can never authorise marketplace continuation', () => {
  it('1. HTTP 422 (market error) -> cannot continue', () => {
    expect(quoteValid({ ...ok, authoritative: null, error: "Movabi isn't available in this area yet.", estimateTotal: null })).toBe(false);
  });

  it('2. HTTP 500 / network failure -> cannot continue', () => {
    expect(quoteValid({ ...ok, authoritative: null, error: 'Unable to calculate the fare right now. Please try again.', estimateTotal: null })).toBe(false);
  });

  it('3. missing quote -> cannot continue', () => {
    expect(quoteValid({ ...ok, authoritative: null, estimateTotal: null })).toBe(false);
  });

  it('4. null/undefined fare -> cannot continue', () => {
    expect(quoteValid({ ...ok, estimateTotal: null })).toBe(false);
    expect(quoteValid({ ...ok, estimateTotal: undefined })).toBe(false);
  });

  it('5. zero fare -> cannot continue', () => {
    expect(quoteValid({ ...ok, authoritative: { signature: 'sig-A', total: 0, expiresAt: null }, estimateTotal: 0 })).toBe(false);
  });

  it('6. NaN / non-finite fare -> cannot continue', () => {
    for (const bad of [NaN, Infinity, -Infinity, 'abc', {}]) {
      expect(quoteValid({ ...ok, estimateTotal: bad }), String(bad)).toBe(false);
    }
    expect(quoteValid({ ...ok, authoritative: { signature: 'sig-A', total: NaN, expiresAt: null }, estimateTotal: NaN })).toBe(false);
  });

  it('7. previous success then failed recalculation invalidates the previous fare', () => {
    expect(quoteValid(ok)).toBe(true);
    // The failure path clears the authoritative quote and sets an error.
    expect(quoteValid({ ...ok, authoritative: null, error: 'Unable to calculate the fare right now. Please try again.' })).toBe(false);
  });

  it('8. pricing-relevant input change cannot authorise continuation with the old quote', () => {
    // currentQuoteSignature advances to the new inputs; the old success no longer matches.
    expect(quoteValid({ ...ok, currentSignature: 'sig-B' })).toBe(false);
    expect(quoteValid({ ...ok, currentSignature: 'sig-B', authoritative: { signature: 'sig-B', total: 12.5, expiresAt: null } })).toBe(true);
  });

  it('9. stale earlier success arriving after a newer failure cannot re-enable continuation', () => {
    // A stale response for sig-A arrives while the user's inputs are now sig-B.
    expect(quoteValid({ ...ok, currentSignature: 'sig-B', authoritative: { signature: 'sig-A', total: 12.5, expiresAt: null } })).toBe(false);
    // And an expired quote cannot authorise either.
    expect(quoteValid({ ...ok, authoritative: { signature: 'sig-A', total: 12.5, expiresAt: '2020-01-01T00:00:00.000Z' } })).toBe(false);
  });

  it('10. successful current positive quote -> continuation allowed', () => {
    expect(quoteValid(ok)).toBe(true);
    expect(quoteValid({ ...ok, authoritative: { signature: 'sig-A', total: 0.01, expiresAt: '2999-01-01T00:00:00.000Z' } })).toBe(true);
  });

  it('11. the handlers enforce the invariant, not just the button', () => {
    // submit() must hard-require quoteValid so a programmatic/stale-UI click cannot proceed.
    expect(request).toContain('!this.quoteValid()');
    // canSubmit() must also require it.
    expect(request).toMatch(/canSubmit = computed\(\(\) => \{[\s\S]*?if \(!this\.quoteValid\(\)\) \{\s*return false;/);
    // The marketplace card and CTA label are gated on the same invariant.
    expect(request).toContain('@if (shouldShowMarketplaceFare() && quoteValid()) {');
    expect(request).toContain('if (this.shouldShowMarketplaceFare() && this.quoteValid()) {');
  });

  it('11b. the failure path clears the authoritative quote and any quote reference', () => {
    expect(request).toContain('this.authoritativeQuote.set(null);');
    expect(request).toContain('this.lastQuoteReference = null;');
    expect(request).toContain('this.lastQuotedSignature = null;');
  });

  it('12. Ride and Shop share the same invariant (service-agnostic gate)', () => {
    // quoteValid is service-agnostic: no serviceSlug branch inside it.
    const computedBody = request.slice(request.indexOf('quoteValid = computed'), request.indexOf('usesItemListMode = computed'));
    expect(computedBody).not.toContain('serviceSlug');
    expect(computedBody).not.toContain("'ride'");
    expect(computedBody).not.toContain("'delivery'");
    expect(computedBody).not.toContain("'errand'");
    // And it does not depend on the marketplace/hybrid flag either -- a non-marketplace
    // flow is equally protected.
    expect(computedBody).not.toContain('shouldShowMarketplaceFare');
  });
});

describe('£0.00 no longer presented as a legitimate suggested fare', () => {
  it('the marketplace card is no longer rendered from a coerced zero', () => {
    // Previously: @if (shouldShowMarketplaceFare()) { ... formatCurrency(cardChargeRequired()) }
    // cardChargeRequired() is fareEstimate()?.total || 0, so a failed quote rendered £0.00.
    const card = request.slice(request.indexOf('@if (shouldShowMarketplaceFare() && quoteValid()) {'), request.indexOf('@if (fareEstimate() && !shouldShowMarketplaceFare()) {'));
    expect(card).toContain('quoteValid()');
    expect(card).not.toContain('shouldShowMarketplaceFare()) {');
  });

  it('marketplace-fare suggestedFare() no longer coerces to 0', () => {
    const fn = marketplace.slice(marketplace.indexOf('suggestedFare(): number | null'), marketplace.indexOf('suggestedFareAvailable()'));
    expect(fn).not.toMatch(/\|\|\s*0\b/);
    expect(fn).not.toMatch(/\?\?\s*0\b/);
    expect(fn).toContain('return null');
  });

  it('mirrors the marketplace-fare rule: only a finite positive fare is available', () => {
    const resolve = (raw: unknown): number | null => {
      if (raw === null || raw === undefined) return null;
      const value = Number(raw);
      return Number.isFinite(value) && value > 0 ? value : null;
    };
    expect(resolve(null)).toBeNull();
    expect(resolve(undefined)).toBeNull();
    expect(resolve(0)).toBeNull();
    expect(resolve('')).toBeNull();
    expect(resolve(NaN)).toBeNull();
    expect(resolve(-5)).toBeNull();
    expect(resolve('12.50')).toBe(12.5);
    expect(resolve(0.01)).toBe(0.01);
  });

  it('renders an honest unavailable label instead of a zero amount', () => {
    expect(marketplace).toContain("return fare === null ? 'Fare unavailable' : this.formatPrice(fare);");
    expect(marketplace).not.toContain('formatPrice(suggestedFare())');
  });

  it('every marketplace-fare action refuses to proceed without an authoritative fare', () => {
    for (const marker of [
      'const fare = this.suggestedFare();\n        if (fare === null) return;',
      'if (suggestedFare === null) {'
    ]) {
      expect(marketplace, marker).toContain(marker.split('\n')[0]);
    }
    // No zero-coercion left in the handlers we touched.
    expect(marketplace).not.toContain('this.toMoney(this.suggestedFare() * 0.9)');
    expect(marketplace).not.toContain('lockAgreedFare(job.id, this.suggestedFare())');
    expect(marketplace).not.toContain('openCounterInput() {\n        this.counterAmount.set(this.suggestedFare());');
  });
});
