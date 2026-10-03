import { expect, test } from '@playwright/test';
import { loginAs } from './fixtures/movabi-mocks';

test.describe('driver request lifecycle', () => {
  test('driver can see a request, accept it, and reach completion actions', async ({ page }) => {
    await loginAs(page, 'driver');

    // The dashboard auto-presents a newly available request (it selects the
    // newest opportunity and raises the sheet), so the request may appear as
    // either the "Available Requests" list or its auto-shown detail view.
    // Assert the request itself is offered, then accept it.
    await expect(page.getByText('Back Skipton Street, Bolton', { exact: true }).last()).toBeVisible();

    const accept = page.getByRole('button', { name: /accept/i }).first();
    await expect(accept).toBeVisible();
    await accept.click();

    // Accepting no longer auto-navigates: the request is promoted to the ACTIVE
    // job on the dashboard, and the driver continues via "Continue Job".
    const continueJob = page.getByRole('button', { name: /continue job/i });
    await expect(continueJob).toBeVisible({ timeout: 15000 });
    await continueJob.click();

    await expect(page).toHaveURL(/\/driver\/job-details/);
    await expect(page.getByText(/Request Details|Pickup Navigation/i).first()).toBeVisible();

    const completeOrNext = page.getByRole('button', { name: /complete|arrived|start|collected|en route/i }).first();
    await expect(completeOrNext).toBeVisible();
  });

  test('driver can browse multiple available requests and return to the list', async ({ page }) => {
    // Back must be entirely client-side: no RPC, no write of any kind.
    const mutations: string[] = [];
    page.on('request', r => {
      const u = r.url();
      const isWrite = u.includes('/rest/v1/') && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method());
      if (isWrite || u.includes('/rpc/')) mutations.push(r.method() + ' ' + u.split('?')[0]);
    });

    await loginAs(page, 'driver');

    // A newest request is auto-presented; the lightweight Back control must
    // return to the Available Requests list without rejecting or refetching.
    const back = page.getByRole('button', { name: 'Back to Available Requests' });
    await expect(back).toBeVisible();
    const baseline = mutations.length;
    await back.click();
    await page.waitForTimeout(700);
    expect(mutations.length, 'Back must not mutate server state').toBe(baseline);

    // The list must expose BOTH eligible requests, each independently clickable.
    const cardA = page.getByRole('button').filter({ hasText: 'Back Skipton Street, Bolton' });
    const cardB = page.getByRole('button').filter({ hasText: 'Deansgate, Manchester' });
    await expect(cardA.first()).toBeVisible();
    await expect(cardB.first()).toBeVisible();

    // A -> its own detail -> Back -> list preserved.
    await cardA.first().click();
    await expect(page.getByText('Back Skipton Street, Bolton', { exact: true })).toBeVisible();
    await back.click();
    await expect(cardB.first()).toBeVisible();

    // B -> ITS detail (not A's) -> Back -> nothing was removed by viewing.
    await cardB.first().click();
    await expect(page.getByText('Deansgate, Manchester', { exact: true })).toBeVisible();
    await back.click();
    await expect(cardA.first()).toBeVisible();
    await expect(cardB.first()).toBeVisible();

    // Browsing must still have caused zero server mutations.
    expect(mutations.length, 'browsing must not mutate server state').toBe(baseline);

    // The already-certified acceptance path must still work after browsing.
    await cardA.first().click();
    await page.getByRole('button', { name: 'Accept Request', exact: true }).click();
    await expect.poll(() => mutations.some(m => m.includes('accept_searching_job')), { timeout: 15000 }).toBe(true);
    const continueJob = page.getByRole('button', { name: /continue job/i });
    await expect(continueJob).toBeVisible({ timeout: 15000 });
    await continueJob.click();
    await expect(page).toHaveURL(/\/driver\/job-details/);
  });
});
