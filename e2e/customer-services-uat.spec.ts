import { expect, test } from '@playwright/test';
import { loginAs } from './fixtures/movabi-mocks';

test.describe('customer service acceptance', () => {
  test('customer can open every service from the dashboard', async ({ page }) => {
    await loginAs(page, 'customer');

    await page.getByRole('button', { name: /book a ride/i }).click();
    await expect(page).toHaveURL(/type=ride|\/customer\/request/);
    await expect(page.getByText(/Ride Request/i).first()).toBeVisible();

    await page.goto('/customer');
    await page.getByRole('button', { name: /^Open Shop services$/i }).click();
    await expect(page.getByText('Shop', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Choose vehicle/i).first()).toBeVisible();
    await page.locator('form').getByRole('button', { name: /^shop & deliver$/i }).click();
    await expect(page.getByRole('textbox', { name: /items to buy/i })).toBeEnabled();
    await expect(page.getByRole('textbox', { name: /item cost budget/i })).toBeEnabled();

    await page.goto('/customer');
    await page.getByRole('button', { name: /^Open Delivery services$/i }).click();
    await expect(page.getByText('Deliver', { exact: true }).first()).toBeVisible();

    await page.goto('/customer');
    await page.getByRole('button', { name: /^Open Move services$/i }).click();
    await expect(page).toHaveURL(/\/customer\/request\?type=van-moving/);
    await expect(page.getByText('Move', { exact: true }).first()).toBeVisible();
  });

  test('customer address finder supports places near a typed postcode across service fields', async ({ page }) => {
    await loginAs(page, 'customer');

    await page.getByRole('button', { name: /^Open Shop services$/i }).click();
    const pickup = page.getByRole('textbox', { name: /pickup address/i });
    await pickup.fill('Asda near bl2 2pu');
    await expect(page.getByText(/Asda, Moss Bank Way, Bolton/i).first()).toBeVisible();

    await page.getByText(/Asda, Moss Bank Way, Bolton/i).first().click();
    await expect(pickup).toHaveValue(/Asda, Moss Bank Way, Bolton/i);

    const dropoff = page.getByRole('textbox', { name: /where should we deliver/i });
    await dropoff.fill('McDonald near bl2 2pu');
    await expect(page.getByText(/McDonald's, Manchester Road, Bolton/i).first()).toBeVisible();
  });
});
