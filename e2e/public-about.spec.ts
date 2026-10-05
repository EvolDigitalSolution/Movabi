import { expect, test } from '@playwright/test';
import { installMovabiMocks } from './fixtures/movabi-mocks';

const ABOUT_HEADLINE = /your everyday move, made simple/i;
const ABOUT_EYEBROW = /local transport made simpler/i;

test.describe('public About Movabi page', () => {
  test('signed-out visitor opens /about-movabi directly and can refresh', async ({ page }) => {
    await installMovabiMocks(page, 'customer');
    await page.goto('/about-movabi');
    await page.evaluate(() => localStorage.clear()).catch(() => undefined);

    await page.goto('/about-movabi');
    await expect(page).toHaveURL(/\/about-movabi$/);
    await expect(page.getByRole('heading', { name: ABOUT_HEADLINE })).toBeVisible();
    await expect(page.getByText(ABOUT_EYEBROW)).toBeVisible();

    // Direct refresh / deep link must not bounce to login or registration.
    await page.reload();
    await expect(page).toHaveURL(/\/about-movabi$/);
    await expect(page.getByRole('heading', { name: ABOUT_HEADLINE })).toBeVisible();
  });

  test('landing page About link targets the public route', async ({ page }) => {
    await installMovabiMocks(page, 'customer');
    await page.goto('/');
    await page.getByRole('link', { name: /about movabi/i }).click();

    await expect(page).toHaveURL(/\/about-movabi$/);
    await expect(page.getByRole('heading', { name: ABOUT_HEADLINE })).toBeVisible();
  });

  test('signed-in customer opens /about-movabi without being redirected', async ({ page }) => {
    await installMovabiMocks(page, 'customer');
    await page.goto('/auth/login');
    await page.getByLabel(/email address/i).fill('customer@movabi.test');
    await page.getByRole('textbox', { name: /^password$/i }).fill('Password123!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/customer/);

    await page.goto('/about-movabi');
    await expect(page).toHaveURL(/\/about-movabi$/);
    await expect(page.getByRole('heading', { name: ABOUT_HEADLINE })).toBeVisible();

    // Still public after a refresh while signed in.
    await page.reload();
    await expect(page).toHaveURL(/\/about-movabi$/);
    await expect(page.getByRole('heading', { name: ABOUT_HEADLINE })).toBeVisible();
  });

  test('pending-registration visitor opens /about-movabi without a registration redirect', async ({ page }) => {
    await installMovabiMocks(page, 'customer');
    // This identity is authenticated but not yet registration-activated.
    await page.route('**/markets/registration-status*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          activated: false,
          pending: true,
          registrationCountryCode: null,
          registrationMarketCity: null,
          activatedAt: null
        })
      });
    });

    await page.goto('/auth/login');
    await page.getByLabel(/email address/i).fill('customer@movabi.test');
    await page.getByRole('textbox', { name: /^password$/i }).fill('Password123!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/auth\/registration/);

    await page.goto('/about-movabi');
    await expect(page).toHaveURL(/\/about-movabi$/);
    await expect(page.getByRole('heading', { name: ABOUT_HEADLINE })).toBeVisible();
  });

  test('protected application routes still require authentication', async ({ page }) => {
    await installMovabiMocks(page, 'customer');
    await page.goto('/about-movabi');
    await page.evaluate(() => localStorage.clear()).catch(() => undefined);

    await page.goto('/driver');
    await expect(page).not.toHaveURL(/\/driver$/);
  });
});
