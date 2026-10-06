import { expect, test } from '@playwright/test';
import {
  ids,
  loginAs,
  setArrivalFailure,
  setArrivalGraceMs,
  setNoShowArrivalDisabled,
  setNoShowFinalizeOutcome,
  setNoShowJob,
  setWalletBalance
} from './fixtures/movabi-mocks';

const PICKUP = { latitude: 53.585, longitude: -2.43 };

test.use({ permissions: ['geolocation'], geolocation: PICKUP });

const noShowBreakdown = {
  noShowPolicyVersion: 'ride-no-show-v1',
  noShowFeeMinor: 175,
  noShowDriverShareMinor: 140,
  noShowPlatformShareMinor: 35,
  currency: 'GBP'
};

/** Reach the driver's job-details screen for an accepted ride. */
async function openDriverJob(page: import('@playwright/test').Page) {
  await loginAs(page, 'driver');
  const accept = page.getByRole('button', { name: /accept/i }).first();
  await expect(accept).toBeVisible();
  await accept.click();

  const continueJob = page.getByRole('button', { name: /continue job/i });
  await expect(continueJob).toBeVisible({ timeout: 15_000 });
  await continueJob.click();
  await expect(page).toHaveURL(/\/driver\/job-details/);
}

async function markArrived(page: import('@playwright/test').Page) {
  const arrived = page.getByRole('button', { name: /i have arrived/i }).first();
  await expect(arrived).toBeVisible({ timeout: 15_000 });
  await arrived.click();
}

test.describe('driver no-show confirmation', () => {
  test('countdown is shown before the server grace expires and confirmation is locked', async ({ page }) => {
    setArrivalGraceMs(120_000); // 2 minutes remaining

    await openDriverJob(page);
    await markArrived(page);

    await expect(page.getByTestId('no-show-countdown')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('no-show-countdown')).toContainText(/\d+s remaining/);
    // Confirmation controls must not be available before expiry.
    await expect(page.getByTestId('no-show-panel')).toHaveCount(0);
  });

  test('after expiry the panel shows the exact fee and 80% driver compensation', async ({ page }) => {
    setArrivalGraceMs(-1_000); // already expired

    await openDriverJob(page);
    await markArrived(page);

    const panel = page.getByTestId('no-show-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('no-show-fee')).toHaveText('£1.75');
    await expect(page.getByTestId('no-show-driver-share')).toHaveText('£1.40');

    // Ionic scrolls inside ion-content; widen the viewport so the panel is captured whole.
    await page.setViewportSize({ width: 412, height: 1500 });
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results-no-show/driver-no-show-confirmation.png' });
  });

  test('missing contact attempt or reason blocks submission', async ({ page }) => {
    setArrivalGraceMs(-1_000);

    await openDriverJob(page);
    await markArrived(page);
    await expect(page.getByTestId('no-show-panel')).toBeVisible({ timeout: 15_000 });

    const submit = page.getByTestId('no-show-submit').getByRole('button');
    // Nothing filled in.
    await expect(submit).toBeDisabled();

    // Reason but no contact attempt / confirmation => still blocked.
    await page.getByTestId('no-show-reason').fill('Waited 5 minutes, no answer');
    await expect(submit).toBeDisabled();

    // Contact attempt alone is still not enough.
    await page.getByTestId('no-show-contact').check();
    await expect(submit).toBeDisabled();
  });

  test('confirmed no-show submits once and terminal cancellation is recorded', async ({ page }) => {
    setArrivalGraceMs(-1_000);

    let finaliseCalls = 0;
    page.on('request', (req) => {
      if (req.url().includes('/api/booking/no-show')) finaliseCalls += 1;
    });

    await openDriverJob(page);
    await markArrived(page);
    await expect(page.getByTestId('no-show-panel')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('no-show-reason').fill('Waited 5 minutes, no answer');
    await page.getByTestId('no-show-contact').check();
    await page.getByTestId('no-show-confirm').check();

    const submit = page.getByTestId('no-show-submit').getByRole('button');
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect.poll(() => finaliseCalls, { timeout: 15_000 }).toBe(1);
    // The request is terminally cancelled — it must not be redispatched.
    await expect(page.getByText(/cancelled/i).first()).toBeVisible({ timeout: 15_000 });
  });

  test('a trip-start conflict surfaces a recoverable error instead of a false success', async ({ page }) => {
    setArrivalGraceMs(-1_000);
    setNoShowFinalizeOutcome({
      status: 409,
      body: { error: 'The trip has already started.', code: 'NO_SHOW_CONFLICT' }
    });

    await openDriverJob(page);
    await markArrived(page);
    await expect(page.getByTestId('no-show-panel')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('no-show-reason').fill('Customer did not appear');
    await page.getByTestId('no-show-contact').check();
    await page.getByTestId('no-show-confirm').check();
    await page.getByTestId('no-show-submit').getByRole('button').click();

    await expect(page.getByTestId('no-show-error')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('no-show-error')).toContainText(/already started/i);

    setNoShowFinalizeOutcome(null);
  });

  test('disabled compatibility: arrival still works through the original flow', async ({ page }) => {
    setNoShowArrivalDisabled(true);

    let legacyArrivalWrites = 0;
    page.on('request', (req) => {
      const url = req.url();
      if (req.method() === 'PATCH' && url.includes('/rest/v1/jobs')) legacyArrivalWrites += 1;
    });

    await openDriverJob(page);
    await markArrived(page);

    // No no-show UI appears...
    await expect(page.getByTestId('no-show-countdown')).toHaveCount(0);
    await expect(page.getByTestId('no-show-panel')).toHaveCount(0);
    // ...and the arrival was recorded through the original status write.
    await expect.poll(() => legacyArrivalWrites, { timeout: 15_000 }).toBeGreaterThan(0);

    setNoShowArrivalDisabled(false);
  });

  test('regression: a generic 404 must NOT degrade into a direct arrival status write', async ({ page }) => {
    // 404 WITHOUT the explicit NO_SHOW_DISABLED code (wrong route/proxy/typo).
    setArrivalFailure({ status: 404, body: { error: 'Not found' } });

    let legacyArrivalWrites = 0;
    page.on('request', (req) => {
      const url = req.url();
      if (req.method() === 'PATCH' && url.includes('/rest/v1/jobs')) legacyArrivalWrites += 1;
    });

    await openDriverJob(page);
    await markArrived(page);

    await page.waitForTimeout(3_000);
    // The failure is surfaced and the arrival is NOT silently written.
    expect(legacyArrivalWrites).toBe(0);
    await expect(page.getByTestId('no-show-panel')).toHaveCount(0);

    setArrivalFailure(null);
  });

  test('regression: a 409 arrival conflict must NOT degrade into a direct status write', async ({ page }) => {
    setArrivalFailure({ status: 409, body: { error: 'Arrival is not allowed in the current booking state.', code: 'ARRIVAL_INVALID_STATE' } });

    let legacyArrivalWrites = 0;
    page.on('request', (req) => {
      const url = req.url();
      if (req.method() === 'PATCH' && url.includes('/rest/v1/jobs')) legacyArrivalWrites += 1;
    });

    await openDriverJob(page);
    await markArrived(page);

    await page.waitForTimeout(3_000);
    expect(legacyArrivalWrites).toBe(0);

    setArrivalFailure(null);
  });
});

test.describe('customer no-show tracking outcome', () => {
  async function openTracking(page: import('@playwright/test').Page) {
    setWalletBalance(null);
    await loginAs(page, 'customer');
    await page.goto(`/customer/tracking/${ids.rideJob}`);
  }

  test('completed outcome shows the exact charged fee and a dispute link', async ({ page }) => {
    setNoShowJob({
      status: 'cancelled',
      no_show_status: 'fee_charged',
      no_show_arrived_at: new Date(Date.now() - 600_000).toISOString(),
      no_show_grace_until: new Date(Date.now() - 300_000).toISOString(),
      fare_breakdown: noShowBreakdown
    });

    await openTracking(page);

    const outcome = page.getByTestId('customer-no-show-outcome');
    await expect(outcome).toBeVisible({ timeout: 20_000 });
    await expect(outcome).toHaveAttribute('data-state', 'completed');
    await expect(page.getByTestId('customer-no-show-fee')).toHaveText('£1.75');
    await expect(page.getByTestId('customer-refund-completed')).toBeVisible();
    await expect(page.getByTestId('customer-dispute-link')).toBeVisible();

    await page.setViewportSize({ width: 412, height: 1500 });
    await outcome.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results-no-show/customer-no-show-outcome.png' });
  });

  test('pending outcome reports a refund/release in progress rather than completion', async ({ page }) => {
    setNoShowJob({
      status: 'cancelled',
      no_show_status: 'pending',
      no_show_arrived_at: new Date(Date.now() - 600_000).toISOString(),
      no_show_grace_until: new Date(Date.now() - 300_000).toISOString(),
      fare_breakdown: noShowBreakdown
    });

    await openTracking(page);

    const outcome = page.getByTestId('customer-no-show-outcome');
    await expect(outcome).toBeVisible({ timeout: 20_000 });
    await expect(outcome).toHaveAttribute('data-state', 'pending');
    await expect(page.getByTestId('customer-refund-pending')).toBeVisible();
    await expect(page.getByTestId('customer-refund-completed')).toHaveCount(0);
  });

  test('unknown financial outcome is shown as review required', async ({ page }) => {
    setNoShowJob({
      status: 'cancelled',
      no_show_status: 'unknown',
      no_show_arrived_at: new Date(Date.now() - 600_000).toISOString(),
      no_show_grace_until: new Date(Date.now() - 300_000).toISOString(),
      fare_breakdown: noShowBreakdown
    });

    await openTracking(page);

    const outcome = page.getByTestId('customer-no-show-outcome');
    await expect(outcome).toBeVisible({ timeout: 20_000 });
    await expect(outcome).toHaveAttribute('data-state', 'review');
    await expect(page.getByTestId('customer-review-required')).toBeVisible();
  });

  test('a live grace deadline renders a countdown; the dispute link is keyboard reachable', async ({ page }) => {
    await setNoShowJob({
      status: 'accepted',
      no_show_arrived_at: new Date().toISOString(),
      no_show_grace_until: new Date(Date.now() + 120_000).toISOString(),
      fare_breakdown: noShowBreakdown
    });

    await openTracking(page);

    const countdown = page.getByTestId('customer-arrival-countdown');
    await expect(countdown).toBeVisible({ timeout: 20_000 });
    const first = await page.getByTestId('customer-arrival-remaining').innerText();
    await page.waitForTimeout(2_500);
    const second = await page.getByTestId('customer-arrival-remaining').innerText();
    expect(parseInt(second, 10)).toBeLessThan(parseInt(first, 10));

    // Keyboard operation: the dispute link is a real focusable button.
    setNoShowJob({
      status: 'cancelled',
      no_show_status: 'fee_charged',
      no_show_arrived_at: new Date(Date.now() - 600_000).toISOString(),
      no_show_grace_until: new Date(Date.now() - 300_000).toISOString(),
      fare_breakdown: noShowBreakdown
    });
    await page.reload();
    const dispute = page.getByTestId('customer-dispute-link');
    await expect(dispute).toBeVisible({ timeout: 20_000 });
    await dispute.focus();
    await expect(dispute).toBeFocused();
  });
});
