import { expect, test } from '@playwright/test';
import { loginAs, lastBookingCreateBody, setWalletBalance } from './fixtures/movabi-mocks';

/** Open the ride request form and select distinct pickup/drop-off suggestions. */
async function startRideRequest(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /book a ride/i }).click();
  await expect(page).toHaveURL(/\/customer\/request/);
  await expect(page.getByText(/Ride Request/i).first()).toBeVisible();

  // Dismiss the geolocation-permission prompt to reveal the manual address form.
  const manual = page.getByRole('button', { name: /continue with manual address/i });
  if (await manual.isVisible().catch(() => false)) {
    await manual.click();
  }

  // Pickup and drop-off resolve to DISTINCT mocked places with different coordinates,
  // so a real route (nonzero distance/duration) and a quote can be produced.
  await page.getByRole('textbox', { name: /pickup address/i }).fill('Back Skipton Street, Bolton');
  await page.getByRole('button', { name: /Back Skipton Street/i }).first().click();

  await page.getByRole('textbox', { name: /where should we deliver/i }).fill('Tonge Moor Primary Academy, Bolton');
  await page.getByRole('button', { name: /Tonge Moor Primary Academy/i }).first().click();

  await expect(page.getByRole('textbox', { name: /pickup address/i })).toHaveValue(/Back Skipton Street/i);
  await expect(page.getByRole('textbox', { name: /where should we deliver/i })).toHaveValue(/Tonge Moor Primary Academy/i);
}

test.describe('customer booking and payment', () => {
  test('funded wallet submits a ride request and reaches the tracking success state', async ({ page }) => {
    setWalletBalance(null); // £42.50 available — covers the £3.50 quoted ride.

    await loginAs(page, 'customer');
    await startRideRequest(page);

    const walletButton = page.getByRole('button', { name: /request with wallet/i });
    await expect(walletButton).toBeEnabled({ timeout: 20_000 });
    await expect(page.getByText(/secure wallet reservation/i)).toBeVisible();
    await walletButton.click();

    // 1) The booking request is submitted to the real create endpoint.
    await expect.poll(() => lastBookingCreateBody, { timeout: 15_000 }).not.toBeNull();

    // 2) Payload matches the real contract (client posts { booking: insertPayload }).
    const booking = (lastBookingCreateBody?.['booking'] || {}) as Record<string, unknown>;
    const breakdown = (booking['fare_breakdown'] || {}) as Record<string, unknown>;
    const metadata = (booking['metadata'] || {}) as Record<string, unknown>;
    const quoteRef = metadata['quote_id'] || breakdown['quoteId'];

    expect(String(booking['pickup_address'])).toMatch(/Back Skipton Street/i);
    expect(String(booking['dropoff_address'])).toMatch(/Tonge Moor Primary Academy/i);
    expect(Number(booking['total_price'])).toBeCloseTo(3.5, 2);
    expect(quoteRef).toBe('quote-no-show-test');

    // 3) Booking success state: the customer lands on live tracking for the new job.
    await expect(page).toHaveURL(/\/customer\/tracking\/booking-test/, { timeout: 15_000 });
  });

  test('insufficient wallet requires card payment instead of submitting', async ({ page }) => {
    setWalletBalance(0.5); // Below the £3.50 quoted ride.

    await loginAs(page, 'customer');
    await startRideRequest(page);

    // Card fallback is required, so the wallet CTA is never offered and submit stays
    // gated on a completed card (which does not exist in this mocked environment).
    const cardButton = page.getByRole('button', { name: /request & pay by card/i });
    await expect(cardButton).toBeVisible({ timeout: 20_000 });
    await expect(cardButton).toBeDisabled();
    await expect(page.getByText(/secure card fallback/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /request with wallet/i })).toHaveCount(0);
  });

  test('customer wallet top-up flow exposes secure card action', async ({ page }) => {
    setWalletBalance(null);

    await loginAs(page, 'customer');

    await page.goto('/customer/wallet');
    await expect(page.getByText(/Available Balance/i)).toBeVisible();
    await expect(page.getByText(/£42\.50|42\.50/)).toBeVisible();

    await page.getByRole('button', { name: /top up now/i }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: /top up now/i })).toBeVisible();
  });
});
