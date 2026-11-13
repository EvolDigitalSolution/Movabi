import { expect, Page, test } from '@playwright/test';
import { ids, loginAs, setNoShowJob } from './fixtures/movabi-mocks';

/**
 * Area 1c (2026-11-13): the customer's "no driver" message is the server's recorded availability
 * decision (`jobs.no_driver_reason`, written by dispatch.service.ts and the handoff route), not a
 * client guess. The three dispatch reasons are the exact server strings; a missing reason falls back
 * to the generic status text. A driver handoff never shows the driver's own words to the customer.
 */
const SERVER_REASONS = {
  none_nearby: 'No eligible drivers are nearby right now.',
  busy: 'Drivers nearby are currently busy — retrying shortly.',
  timeout: 'The booking offer timed out before a driver accepted.',
  handoff: 'Your previous driver could not continue. Finding another driver.',
};
const neutral = { driver_id: null, accepted_driver_id: null, driver: null, accepted_at: null };

test.afterEach(() => setNoShowJob(null));

/** Endpoints the tracking page also calls that are not under test: the answers develop gives today. */
async function openTracking(page: Page) {
  await loginAs(page, 'customer');
  // Early stop is off on develop (VAYDU_EARLY_STOP_PILOT_V23 unset), so the API answers 404.
  await page.route('**/api/booking/early-stop/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Early stop is unavailable.' }) }));
  await page.goto(`/customer/tracking/${ids.rideJob}`);
}

for (const [name, reason] of Object.entries(SERVER_REASONS)) {
  const status = name === 'handoff' ? 'searching' : 'no_driver_found';
  test(`tracking shows the server reason: ${name} (${status})`, async ({ page }) => {
    setNoShowJob({ ...neutral, status, no_driver_reason: reason });
    await openTracking(page);
    await expect(page.getByText(reason, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    // The generic client text is not shown in place of the server's decision.
    await expect(page.getByText('No driver available.', { exact: true })).toHaveCount(0);
  });
}

test('tracking falls back to the generic text when the server recorded no reason', async ({ page }) => {
  setNoShowJob({ ...neutral, status: 'no_driver_found', no_driver_reason: null });
  await openTracking(page);
  await expect(page.getByText('No driver available.', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
});
