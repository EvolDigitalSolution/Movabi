import { expect, test } from '@playwright/test';
import { installMovabiMocks } from './fixtures/movabi-mocks';

test.describe('authentication', () => {
  test('customer, driver, and admin can sign in and land on the correct area', async ({ page }) => {
    for (const role of ['customer', 'driver', 'admin'] as const) {
      await page.context().clearCookies();
      await page.evaluate(() => localStorage.clear()).catch(() => undefined);
      await installMovabiMocks(page, role);

      await page.goto('/auth/login');
      await page.getByLabel(/email address/i).fill(`${role}@movabi.test`);
      await page.getByRole('textbox', { name: /^password$/i }).fill('Password123!');
      await page.getByRole('button', { name: /sign in/i }).click();

      if (role === 'customer') {
        await expect(page).toHaveURL(/\/customer/);
        await expect(page.getByText(/Movabi/i).first()).toBeVisible();
      }

      if (role === 'driver') {
        await expect(page).toHaveURL(/\/driver/);
        await expect(page.getByText(/Driver Hub/i)).toBeVisible();
      }

      if (role === 'admin') {
        await expect(page).toHaveURL(/\/dashboard|\/admin/);
        await expect(page.getByText(/Dashboard|Admin/i).first()).toBeVisible();
      }
    }
  });
});
