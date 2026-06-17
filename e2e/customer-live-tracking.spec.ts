import { expect, test } from '@playwright/test';
import { ids, loginAs } from './fixtures/movabi-mocks';

test.describe('customer live tracking', () => {
  test('customer sees accepted driver, transport details, and tracking controls', async ({ page }) => {
    await loginAs(page, 'customer');

    await page.goto(`/customer/tracking/${ids.rideJob}`);

    await expect(page.getByText(/Live Tracking/i)).toBeVisible();
    await expect(page.getByText(/Dara Driver|Driver/i).first()).toBeVisible();
    await expect(page.getByText(/Toyota|Prius|Silver|MV22/i).first()).toBeVisible();
    await expect(page.getByText(/Trip Route|Booking Details|Active Job/i).first()).toBeVisible();
  });
});
