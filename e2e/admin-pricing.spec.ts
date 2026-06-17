import { expect, test } from '@playwright/test';
import { loginAs } from './fixtures/movabi-mocks';

test.describe('admin pricing', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('admin can open delivery pricing and save dynamic price changes', async ({ page }) => {
    await loginAs(page, 'admin');

    await page.goto('/admin/pricing');
    await expect(page.getByRole('heading', { name: /Pricing Rules/i })).toBeVisible();
    await expect(page.getByText(/Delivery/i).first()).toBeVisible();

    await page.locator('div').filter({ hasText: /^Delivery/ }).getByTitle('Edit').first().click();
    await expect(page.getByText(/Edit Pricing Rule/i)).toBeVisible();

    const modal = page.locator('.fixed').filter({ hasText: /Edit Pricing Rule/ });
    await modal.getByRole('spinbutton').nth(0).fill('2.10');
    await modal.getByRole('spinbutton').nth(1).fill('0.50');
    await modal.getByRole('spinbutton').nth(4).fill('2.75');

    const saveRequest = page.waitForRequest((request) =>
      request.method() === 'PATCH' &&
      request.url().includes('/rest/v1/service_types')
    );

    await page.getByRole('button', { name: /save changes/i }).click();

    await saveRequest;
    await expect(page.getByText(/saved|updated|changes/i).first()).toBeVisible();
  });
});
