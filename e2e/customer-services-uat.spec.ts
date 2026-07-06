import { expect, test } from '@playwright/test';
import { loginAs } from './fixtures/movabi-mocks';

test.describe('customer service acceptance', () => {
  test('customer can open every service from the dashboard', async ({ page }) => {
    await loginAs(page, 'customer');

    await page.getByRole('button', { name: /book a ride/i }).click();
    await expect(page).toHaveURL(/type=ride|\/customer\/request/);
    await expect(page.getByText(/Ride Request/i).first()).toBeVisible();

    await page.goto('/customer');
    await page.getByRole('button', { name: /run an errand/i }).click();
    await expect(page.getByText(/Errand Service/i).first()).toBeVisible();
    await expect(page.getByText(/Choose vehicle/i).first()).toBeVisible();
    await expect(page.getByText(/Items to Buy/i).first()).toBeVisible();
    await page.getByRole('button', { name: /shop & deliver/i }).click();
    await expect(page.getByRole('textbox', { name: /items to buy/i })).toBeEnabled();
    await expect(page.getByRole('textbox', { name: /item cost budget/i })).toBeEnabled();

    await page.goto('/customer');
    await page.getByRole('button', { name: /send a package/i }).click();
    await expect(page.getByText(/Package Delivery|Send a Package/i).first()).toBeVisible();

    await page.goto('/customer');
    await page.getByRole('button', { name: /van moving/i }).click();
    await expect(page).toHaveURL(/\/customer\/van-moving\/create/);
    await expect(page.getByText(/Book a Move|Van Moving/i).first()).toBeVisible();
  });

  test('customer address finder supports places near a typed postcode across service fields', async ({ page }) => {
    await loginAs(page, 'customer');

    await page.getByRole('button', { name: /run an errand/i }).click();
    const pickup = page.getByRole('textbox', { name: /pickup location/i });
    await pickup.fill('Asda near bl2 2pu');
    await expect(page.getByText(/Asda, Moss Bank Way, Bolton/i).first()).toBeVisible();

    await page.getByText(/Asda, Moss Bank Way, Bolton/i).first().click();
    await expect(pickup).toHaveValue(/Asda, Moss Bank Way, Bolton/i);

    const dropoff = page.getByRole('textbox', { name: /dropoff|delivery address|destination/i });
    await dropoff.fill('McDonald near bl2 2pu');
    await expect(page.getByText(/McDonald's, Manchester Road, Bolton/i).first()).toBeVisible();
  });
});
