import { expect, test } from '@playwright/test';
import { loginAs } from './fixtures/movabi-mocks';

test.describe('admin pricing', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('admin can save delivery pricing and reload the persisted values', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/admin/pricing');
    await expect(page.getByRole('heading', { name: /Pricing Rules/i })).toBeVisible();
    const editDelivery = () => page.locator('div').filter({ hasText: /^Delivery/ }).getByTitle('Edit').first();
    await editDelivery().click();
    const modal = page.locator('.fixed').filter({ hasText: /Edit Pricing Rule/ });
    await expect(modal).toBeVisible();
    await modal.locator('[formcontrolname="base_price"]').fill('2.10');
    await modal.locator('[formcontrolname="price_per_km"]').fill('0.50');
    await modal.locator('[formcontrolname="minimum_fare"]').fill('2.75');
    const save = modal.getByRole('button', { name: /^Save$/i });
    await expect(save).toBeEnabled();
    const [response] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/rest/v1/pricing_config'),
      save.click()
    ]);
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toMatchObject({
      service_type: 'delivery', country_code: 'GB', base_fare: 2.1, per_km: 0.5, minimum_fare: 2.75
    });
    await expect(page.getByText('Pricing rule updated.', { exact: true })).toBeVisible();
    await expect(modal).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: /Pricing Rules/i })).toBeVisible();
    await editDelivery().click();
    await expect(modal.locator('[formcontrolname="base_price"]')).toHaveValue('2.1');
    await expect(modal.locator('[formcontrolname="price_per_km"]')).toHaveValue('0.5');
    await expect(modal.locator('[formcontrolname="minimum_fare"]')).toHaveValue('2.75');
  });
});
