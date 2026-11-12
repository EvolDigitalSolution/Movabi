import { expect, test, type Page } from '@playwright/test';
import { loginAs, lastBookingCreateBody, setWalletBalance } from './fixtures/movabi-mocks';

// Customer cash Ride (pilot markets): the option appears only when the server offers cash for
// the quote; the card is HELD (not charged) for the fee terms; the server confirms the hold and
// starts the search. Stripe.js is a stub here: the card is complete and the hold authorises.
const STRIPE_STUB = `window.Stripe=function(){return{
  elements:function(){return{create:function(){var h={};return{
    mount:function(el){var i=document.createElement('input');i.setAttribute('aria-label','Stub card number');el.appendChild(i);
      setTimeout(function(){h.ready&&h.ready();h.change&&h.change({complete:true});},0);},
    on:function(n,f){h[n]=f;},unmount:function(){},destroy:function(){}};}};},
  confirmCardPayment:async function(secret,data){window.__holdConfirm={secret:secret,hasCard:!!(data&&data.payment_method&&data.payment_method.card)};
    return{paymentIntent:{id:'pi_cashhold1',status:'requires_capture'}};}};};`;

async function startRideRequest(page: Page) {
  await page.getByRole('button', { name: /book a ride/i }).click();
  await expect(page).toHaveURL(/\/customer\/request/);
  const manual = page.getByRole('button', { name: /continue with manual address/i });
  if (await manual.isVisible().catch(() => false)) await manual.click();
  await page.getByRole('textbox', { name: /pickup address/i }).fill('Back Skipton Street, Bolton');
  await page.getByRole('button', { name: /Back Skipton Street/i }).first().click();
  await page.getByRole('textbox', { name: /where should we deliver/i }).fill('Tonge Moor Primary Academy, Bolton');
  await page.getByRole('button', { name: /Tonge Moor Primary Academy/i }).first().click();
}
async function mockCash(page: Page, available: boolean) {
  const calls: { path: string; body: any }[] = [];
  await page.route('**/api/booking/cash/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/booking/cash', '');
    calls.push({ path, body: route.request().postDataJSON() });
    if (path === '/availability') return route.fulfill({ json: available
      ? { available: true, holdAmountMinor: 500, currency: 'GBP', provider: 'stripe', noShowFeeMinor: 175, lateCancelFeeMinor: 500 }
      : { available: false, code: 'CASH_MARKET_NOT_ENABLED', reason: 'Cash rides are not available in this market' } });
    if (path === '/booking-test/fee-hold') return route.fulfill({ json: { jobId: 'booking-test', provider: 'stripe', clientSecret: 'pi_cashhold1_secret_stub', amountMinor: 500, currency: 'GBP' } });
    if (path === '/booking-test/fee-hold/confirm') return route.fulfill({ json: { success: true, result: 'activated', booking: { id: 'booking-test', status: 'searching', payment_method: 'cash', payment_status: 'cash_due' } } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route(/^https:\/\/js\.stripe\.com\//, r => r.fulfill({ contentType: 'application/javascript', body: STRIPE_STUB }));
  // Address search and routing go through the authenticated /api/maps-v23 API (the shared fixture
  // still mocks the retired direct providers). Same Bolton places as the fixture.
  const places = [
    { label: 'Back Skipton Street, Bolton, England, United Kingdom', primaryText: 'Back Skipton Street', secondaryText: 'Bolton', lat: 53.590, lng: -2.429, countryCode: 'GB' },
    { label: 'Tonge Moor Primary Academy, Bolton, England, United Kingdom', primaryText: 'Tonge Moor Primary Academy', secondaryText: 'Bolton', lat: 53.5985, lng: -2.4155, countryCode: 'GB' },
  ];
  await page.route('**/api/booking/early-stop/**', r => r.fulfill({ status: 404, json: {} }));
  await page.route('**/api/maps-v23/**', async r => {
    const op = new URL(r.request().url()).pathname.split('/').pop();
    if (op === 'configuration') return r.fulfill({ json: { search: true, routing: true } });
    const body = r.request().postDataJSON() || {};
    if (op === 'search') { const q = String(body.query || '').toLowerCase(); return r.fulfill({ json: { attribution: 'test', results: places.filter(p => q.split(/[ ,]+/).some((w: string) => w.length > 3 && p.label.toLowerCase().includes(w))) } }); }
    if (op === 'reverse') return r.fulfill({ json: { label: places[0].label, countryCode: 'GB' } });
    if (op === 'route') { const s = body.start, e = body.end; return r.fulfill({ json: { coordinates: [[s.lng, s.lat], [e.lng, e.lat]], steps: [], distanceMeters: 1800, durationSeconds: 360,
      geometry: { type: 'LineString', coordinates: [[s.lng, s.lat], [e.lng, e.lat]] }, bounds: [[Math.min(s.lng, e.lng), Math.min(s.lat, e.lat)], [Math.max(s.lng, e.lng), Math.max(s.lat, e.lat)]] } }); }
    return r.fulfill({ status: 404, json: {} });
  });
  return calls;
}

test.describe('customer cash ride (pilot market)', () => {
  test('cash offered by the server: card held (not charged), hold confirmed, ride activated', async ({ page }) => {
    setWalletBalance(0.5);
    await loginAs(page, 'customer');
    const calls = await mockCash(page, true);
    await startRideRequest(page);
    const cash = page.getByRole('radio', { name: 'Pay the driver in cash', exact: true });
    await expect(cash).toBeVisible({ timeout: 20_000 });
    await cash.check();
    await expect(page.getByRole('note', { name: 'Cash payment terms' })).toContainText('Your card is not charged for the ride');
    await expect(page.getByRole('note', { name: 'Cash payment terms' })).toContainText('£5.00');
    await expect(page.getByText('Card hold (not charged)')).toBeVisible();
    const submit = page.getByRole('button', { name: /request cash ride/i });
    await expect(submit).toBeEnabled({ timeout: 20_000 });
    await submit.click();
    await expect(page).toHaveURL(/\/customer\/tracking\/booking-test/, { timeout: 20_000 });
    const metadata = ((lastBookingCreateBody?.['booking'] || {}) as any).metadata || {};
    expect(metadata.payment_choice).toBe('cash');
    expect(calls.map(c => c.path)).toEqual(['/availability', '/booking-test/fee-hold', '/booking-test/fee-hold/confirm']);
    expect(calls[0].body).toEqual({ quoteId: 'quote-no-show-test' });
    expect(await page.evaluate(() => (window as any).__holdConfirm)).toEqual({ secret: 'pi_cashhold1_secret_stub', hasCard: true });
  });

  test('cash not offered by the server: no cash option; card flow unchanged', async ({ page }) => {
    setWalletBalance(0.5);
    await loginAs(page, 'customer');
    const calls = await mockCash(page, false);
    await startRideRequest(page);
    await expect(page.getByRole('button', { name: /request & pay by card/i })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => calls.length).toBe(1);
    await expect(page.getByRole('radio', { name: 'Pay the driver in cash', exact: true })).toHaveCount(0);
    await expect(page.getByText('Card hold (not charged)')).toHaveCount(0);
  });
});
