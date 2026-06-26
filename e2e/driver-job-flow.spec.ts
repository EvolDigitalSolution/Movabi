import { expect, test } from '@playwright/test';
import { loginAs } from './fixtures/movabi-mocks';

test.describe('driver request lifecycle', () => {
  test('driver can see a request, accept it, and reach completion actions', async ({ page }) => {
    await loginAs(page, 'driver');

    const availableRequests = page.locator('section, div').filter({ hasText: /Available Requests/i }).first();
    await expect(availableRequests.getByText(/Available Requests/i)).toBeVisible();
    await expect(availableRequests.getByText('Back Skipton Street, Bolton', { exact: true }).last()).toBeVisible();

    const accept = page.getByRole('button', { name: /accept/i }).first();
    await expect(accept).toBeVisible();
    await accept.click();

    await expect(page).toHaveURL(/\/driver\/job-details/);
    await expect(page.getByText(/Request Details|Pickup Navigation/i).first()).toBeVisible();

    const completeOrNext = page.getByRole('button', { name: /complete|arrived|start|collected|en route/i }).first();
    await expect(completeOrNext).toBeVisible();
  });
});
