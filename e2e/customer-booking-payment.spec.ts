import { expect, test } from '@playwright/test';
import { loginAs } from './fixtures/movabi-mocks';

test.describe('customer booking and payment', () => {
  test('customer can start a ride request and see wallet/card payment action clearly', async ({ page }) => {
    await loginAs(page, 'customer');

    await page.getByRole('button', { name: /book a ride/i }).click();
    await expect(page).toHaveURL(/\/customer\/request/);
    await expect(page.getByText(/Ride Request/i).first()).toBeVisible();

    await page.getByRole('textbox', { name: /pickup location/i }).fill('Back Skipton Street, Bolton');
    await page.getByRole('textbox', { name: /dropoff|delivery address|destination/i }).fill('Tonge Moor Primary Academy, Bolton');

    const requestButton = page.getByRole('button', { name: /request .*card|request .*wallet/i });
    await expect(requestButton).toBeVisible();
    await expect(requestButton).toBeDisabled();
    await expect(page.getByText(/secure card fallback|secure wallet reservation/i)).toBeVisible();
  });

  test('customer wallet top-up flow exposes secure card action', async ({ page }) => {
    await loginAs(page, 'customer');

    await page.goto('/customer/wallet');
    await expect(page.getByText(/Available Balance/i)).toBeVisible();
    await expect(page.getByText(/£42\.50|42\.50/)).toBeVisible();

    await page.getByRole('button', { name: /top up now/i }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: /top up now/i })).toBeVisible();
  });
});
