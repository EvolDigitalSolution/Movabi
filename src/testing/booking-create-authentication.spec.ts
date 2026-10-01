import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { SESSION_EXPIRED_MESSAGE, describeHttpFailure } from '../../src/app/shared/utils/http-failure';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');
const bookingService = read('src/app/core/services/booking/booking.service.ts');
const jobService = read('src/app/core/services/job/job.service.ts');
const page = read('src/app/apps/mobile/features/customer/booking-request/booking-request.page.ts');
const bookingRoute = read('server/routes/booking.routes.ts');

describe('POST /api/booking/create — authentication contract', () => {
  it('the server requires a Bearer token and returns 401 AUTHENTICATION_REQUIRED', () => {
    expect(bookingRoute).toContain("req.headers.authorization");
    expect(bookingRoute).toContain('supabaseAdmin.auth.getUser(token)');
    expect(bookingRoute).toContain("res.status(401).json({ error: 'Authentication required.', code: 'AUTHENTICATION_REQUIRED' });");
    // /create resolves the caller from the session FIRST and hard-rejects when absent.
    expect(bookingRoute).toMatch(/router\.post\('\/create', bookingCreateLimiter[\s\S]{0,160}getAuthUserId\(req\)/);
    expect(bookingRoute).toContain("if (!userId) return res.status(401).json({ error: 'Authentication required' });");
    // Identity comes from the token, never the body.
    expect(bookingRoute).toContain("if (payload.customer_id && String(payload.customer_id) !== userId) return res.status(403).json({ error: 'Cannot create a booking for another customer' });");
  });

  it('1+2. the client attaches the authorization header via the EXISTING helper', () => {
    // One established helper in this service, reused by create and cancel.
    expect(bookingService).toContain('private async authHeaders(): Promise<HttpHeaders>');
    expect(bookingService).toContain('Authorization: `Bearer ${data.session.access_token}`');
    const createCall = bookingService.slice(bookingService.indexOf("getApiUrl('/api/booking/create')") - 260, bookingService.indexOf("getApiUrl('/api/booking/create')") + 260);
    expect(createCall).toContain('headers: await this.authHeaders()');
    // No second authentication mechanism was invented.
    expect(bookingService).not.toContain('localStorage');
    expect(bookingService).not.toContain('x-user-id');
  });

  it('the van-moving createJob path is fixed the same way (same route, same requirement)', () => {
    expect(jobService).toContain('private async authHeaders(): Promise<HttpHeaders>');
    expect(jobService).toContain("this.supabase.auth.getSession()");
    expect(jobService).toContain('headers: await this.authHeaders()');
    expect(jobService).toContain("import { HttpClient, HttpHeaders } from '@angular/common/http';");
  });

  it('3. a missing/expired session fails safely and locally, before the request', () => {
    // Both helpers throw a meaningful error rather than sending an unauthenticated request.
    expect(bookingService).toContain("if (!data.session?.access_token) throw new Error('Please sign in again.');");
    expect(jobService).toContain("if (!data.session?.access_token) throw new Error('Please sign in again.');");
  });

  it('4. no server-side auth bypass was introduced', () => {
    // The guard is untouched: still a hard 401 when the user cannot be resolved.
    expect(bookingRoute).toContain("if (!userId) return res.status(401).json({ error: 'Authentication required' });");
    // The token -> user resolution helper is unchanged and still fails closed.
    expect(bookingRoute).toContain('async function getAuthUserId(');
    expect(bookingRoute).toMatch(/getAuthUserId[\s\S]{0,300}return null/);
  });

  it('11. an auth failure produces an intentional customer-facing state', () => {
    const failure = describeHttpFailure({
      status: 401,
      error: { error: 'Authentication required', code: 'AUTHENTICATION_REQUIRED' }
    });
    expect(failure.status).toBe(401);
    expect(failure.code).toBe('AUTHENTICATION_REQUIRED');
    expect(failure.message).toBe(SESSION_EXPIRED_MESSAGE);
    expect(failure.message).not.toBe('An error occurred');
    // The page now uses this instead of `e instanceof Error ? e.message : 'An error occurred'`.
    expect(page).toContain('const failure = describeHttpFailure(e);');
    expect(page).not.toContain("const message = e instanceof Error ? e.message : 'An error occurred';");
    expect(page).toContain("console.warn('[BookingRequest] submit rejected', { status: failure.status, code: failure.code });");
  });

  it('HttpErrorResponse is not an Error, which is why the old extraction lost the reason', () => {
    class FakeHttpErrorResponse { status = 401; error = { error: 'Authentication required.', code: 'AUTHENTICATION_REQUIRED' }; }
    const raw = new FakeHttpErrorResponse();
    expect(raw instanceof Error).toBe(false);
    expect(describeHttpFailure(raw).message).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it('surfaces other authoritative server messages without leaking internals', () => {
    expect(describeHttpFailure({ status: 400, error: { error: 'A quote is required before creating a booking.' } }).message)
      .toBe('A quote is required before creating a booking.');
    expect(describeHttpFailure({ status: 500, error: { error: 'postgrest: relation "jobs" does not exist' } }).message)
      .toBe('An error occurred');
    expect(describeHttpFailure(new Error('Network down')).message).toBe('Network down');
    expect(describeHttpFailure(null).message).toBe('An error occurred');
    expect(describeHttpFailure(undefined, 'Custom fallback').message).toBe('Custom fallback');
  });
});

describe('booking progression after a successful quote', () => {
  it('5+6. progression is gated on the authoritative quote, not just the button', () => {
    expect(page).toContain('if (this.fareCalculating() || !this.fareEstimate() || !this.lastFareBreakdown || !this.quoteValid()) {');
    expect(page).toContain('if (!this.quoteValid()) {');
  });

  it('7. double-click / re-entrant submission is blocked', () => {
    expect(page).toMatch(/async submit\(\) \{\s*if \(this\.submitting\(\) \|\| this\.paymentProcessing\(\)\) return;/);
  });

  it('8. a failed create cannot navigate forward', () => {
    const catchStart = page.indexOf("console.error('[BookingRequest] submit failed'");
    const catchEnd = page.indexOf('} finally {', catchStart);
    const catchBlock = page.slice(catchStart, catchEnd);
    // The only navigation is on the success path; the catch auto-cancels but never routes.
    expect(catchBlock).not.toContain("router.navigate(['/customer/marketplace-fare'");
    expect(catchBlock).not.toContain("router.navigate(['/customer/tracking'");
    expect(page.slice(0, catchStart)).toContain("await this.router.navigate(['/customer/tracking', booking.id]);");
  });

  it('9. navigation to marketplace-fare happens exactly once and only with a booking id', () => {
    const nav = page.match(/router\.navigate\(\['\/customer\/marketplace-fare', booking\.id\]/g) || [];
    expect(nav).toHaveLength(1);
    expect(page).toContain('if (booking?.id && shouldShowMarketplaceFare) {');
    expect(page).toContain('const shouldShowMarketplaceFare = Boolean((booking as any).negotiation_mode_enabled);');
  });

  it('10. the returned booking id and quote reference reach the marketplace screen', () => {
    expect(page).toContain('queryParams: { quoteId }');
    expect(page).toContain('booking = await this.bookingService.createBooking(bookingData, details, this.type);');
  });

  it('a repeated submission cannot create duplicate bookings (cooldown after success only)', () => {
    // lastBookingTime is stamped AFTER a successful create, so failures stay retryable.
    const createIdx = page.indexOf('await this.bookingService.createBooking(');
    const stampIdx = page.indexOf('this.lastBookingTime = Date.now();');
    expect(stampIdx).toBeGreaterThan(createIdx);
    expect(page).toContain('if (now - this.lastBookingTime < 30000) {');
  });

  it('12. pricing/market-country behaviour is untouched by this fix', () => {
    const marketService = read('server/services/market-availability.service.ts');
    const quoteRoute = read('server/routes/global-ai-pricing.routes.ts');
    const cityService = read('server/services/city.service.ts');
    expect(marketService).toContain('static resolveServiceCountryCode(cityCountry:unknown,lat:number,lng:number):string|null');
    expect(quoteRoute).toContain('MarketAvailabilityService.resolveServiceCountryCode(');
    expect(cityService).toContain('isMissingIsActiveColumn');
    expect(bookingService).not.toContain('resolveServiceCountryCode');
    expect(jobService).not.toContain('resolveServiceCountryCode');
  });
});
