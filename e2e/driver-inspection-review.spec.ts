import { expect, Page, Route, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installMovabiMocks, ids } from './fixtures/movabi-mocks';

/**
 * Review screen: "Vehicle details" and "Vehicle inspection" are separate, and inspection reads
 * "Missing photos" until every required slot has a valid saved upload (2026-11-13).
 *
 * The readiness responses are NOT hand-written: they are the real /api/driver-onboarding/status
 * bodies produced by src/testing/vehicle-inspection-readiness.integration.spec.ts on a real backend
 * (postgres 15.1 with develop's live schema + release, GoTrue, PostgREST, real routers). Only the
 * driver id is replaced by the signed-in mock driver's id.
 */
const fixture = (name: string) => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), 'e2e/fixtures/inspection-readiness', name + '.json'), 'utf8'));
  return JSON.parse(JSON.stringify(raw).split(raw.driverId).join(ids.driver));
};
const liveMarket = {
  code: null, countryCode: 'GB', marketCity: null, launchStatus: 'live', customerAppEnabled: true, customerRegistrationEnabled: true,
  driverRegistrationEnabled: true, driverOnlineEnabled: true, quoteEnabled: true, bookingEnabled: true, paymentEnabled: true,
  currency: 'GBP', timezone: 'Europe/London', title: 'Movabi UK', message: 'Live', waitingListEnabled: false, resolutionLevel: 'country'
};

async function openReview(page: Page, status: any) {
  await installMovabiMocks(page, 'driver');
  await page.route('**/api/markets/status*', (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(liveMarket) }));
  // Dashboard calls made on the way to onboarding (not under test): neutral answers.
  await page.route('**/api/market-safety/driver-wallet*', (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ provider: 'stripe', countryCode: 'GB', currency: 'GBP', payoutIntegrationAvailable: true, message: '' }) }));
  await page.route('**/api/driver-payment-account/status*', (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ provider: 'stripe', state: 'completed', available: true, reason: null, setupAvailable: false }) }));
  await page.route('**/api/verification/inspection-requirements-preview*', (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ requirements: [], market: 'GB', slots: ['front', 'rear', 'dashboard', 'seats_interior', 'left_side', 'right_side'] }) }));
  await page.route('**/api/verification/inspection-photos*', (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ slots: [] }) }));
  await page.route('**/api/booking/offer-metrics*', (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assignments: 0, cancelled: 0, rate: null }) }));
  await page.route('**/rest/v1/profiles*', (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...status.profile, email: 'driver@movabi.test' }) }));
  await page.route('**/api/driver-onboarding/**', (route: Route) => route.request().url().includes('/status')
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) })
    : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ saved: true }) }));
  await page.goto('/auth/login');
  await page.getByLabel(/email address/i).fill('driver@movabi.test');
  await page.getByRole('textbox', { name: /^password$/i }).fill('Password123!');
  await page.getByRole('button', { name: /sign in/i }).first().click();
  await expect(page).toHaveURL(/\/driver/);
  await page.goto('/driver/onboarding');
  await expect(page.getByText(/Stage \d of 5/)).toBeVisible({ timeout: 60000 });
  await page.locator('[data-stage-nav]').getByRole('button', { name: /Review/i }).click();
  await expect(page.getByText('Stage 5 of 5')).toBeVisible();
}
const card = (page: Page, title: string) => page.locator('div.rounded-2xl', { has: page.getByRole('heading', { name: title, exact: true }) }).first();

// [fixture, inspection section label, expected text (incomplete rows show " — reason"), text that must NOT appear]
const cases: Array<[string, string, string[], string[]]> = [
  ['zero-images', 'Missing photos', ['Inspection photos — Missing photos: front, rear, dashboard, seats interior, left side, right side (0 of 6 uploaded).', 'Inspection review — Admin review starts once every required photo is uploaded.'], []],
  ['partial-uploads', 'Missing photos', ['Inspection photos — Missing photos: seats interior, left side, right side (3 of 6 uploaded).', 'Inspection review — Admin review starts once'], []],
  ['removed-image', 'Missing photos', ['Inspection photos — Missing photos: front (5 of 6 uploaded).', 'Inspection review — Admin review starts once'], []],
  ['all-uploaded-awaiting-review', 'Under review', ['Inspection review — Awaiting admin review (0 of 6 approved).'], ['Missing photos']],
  ['all-approved', 'Complete', ['Inspection photos', 'Inspection review'], ['Missing photos', 'Awaiting admin review']],
];

for (const [name, sectionLabel, present, absent] of cases) {
  test(`review screen, ${name}: Vehicle details and Vehicle inspection shown separately`, async ({ page }) => {
    await openReview(page, fixture(name));
    // The old combined heading is gone.
    await expect(page.getByRole('heading', { name: 'Vehicle / Bicycle requirements' })).toHaveCount(0);
    // Vehicle details: complete in every case (the saved vehicle is fully described).
    await expect(card(page, 'Vehicle details')).toContainText('Complete');
    await expect(card(page, 'Vehicle details')).not.toContainText('Inspection');
    // Vehicle inspection: its own status and rows, from the real readiness response.
    const inspection = card(page, 'Vehicle inspection');
    await expect(inspection.locator('span.text-xs.font-bold').first()).toHaveText(sectionLabel);
    for (const text of present) await expect(inspection).toContainText(text);
    for (const text of absent) await expect(inspection).not.toContainText(text);
    await card(page, 'Vehicle details').screenshot({ path: `.temp/playwright-inspection-review/${name}-vehicle-details.png` });
    await inspection.screenshot({ path: `.temp/playwright-inspection-review/${name}-vehicle-inspection.png` });
  });
}
