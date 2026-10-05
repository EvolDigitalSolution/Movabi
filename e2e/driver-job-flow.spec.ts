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
    // Guarantee under test: Back — and browsing — must not issue a driver
    // action mutation.
    //
    // A DISCOVERY refetch is not a driver action. `fetch_hybrid_opportunities`
    // is a discovery RPC that is NOT read-only: it may perform server-side
    // expiry convergence (expiring lapsed unpaid fare agreements via
    // expire_unpaid_fare_agreement, and releasing stale claimed leases via
    // release_stale_negotiation_lease) for rows whose deadline has already
    // passed. It is also re-triggered by the `marketplace_negotiation_sessions`
    // realtime subscription, independently of any tap. It is therefore
    // classified separately from driver action mutations and excluded here,
    // while every other RPC call and every POST/PATCH/PUT/DELETE REST write
    // stays tracked.
    const RPC_PATH_PREFIX = '/rest/v1/rpc/';
    const DISCOVERY_RPCS = new Set(['fetch_hybrid_opportunities']);
    const REST_WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

    const driverActionMutations: string[] = [];
    const discoveryRefetches: string[] = [];

    page.on('request', request => {
      const { pathname } = new URL(request.url());

      // RPC calls are classified by EXACT function name, never by substring.
      if (pathname.startsWith(RPC_PATH_PREFIX)) {
        const rpcName = pathname.slice(RPC_PATH_PREFIX.length);
        const entry = `${request.method()} ${pathname}`;
        if (DISCOVERY_RPCS.has(rpcName)) {
          discoveryRefetches.push(entry);
        } else {
          driverActionMutations.push(entry);
        }
        return;
      }

      // Non-RPC REST writes are always driver action mutations.
      if (pathname.startsWith('/rest/v1/') && REST_WRITE_METHODS.has(request.method())) {
        driverActionMutations.push(`${request.method()} ${pathname}`);
      }
    });

    await loginAs(page, 'driver');

    // A newest request is auto-presented; the lightweight Back control must
    // return to the Available Requests list without rejecting or refetching.
    const back = page.getByRole('button', { name: 'Back to Available Requests' });
    await expect(back).toBeVisible();
    const baseline = driverActionMutations.length;
    await back.click();
    await page.waitForTimeout(700);
    expect(driverActionMutations.length, 'Back must not issue a driver action mutation').toBe(baseline);

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

    // Browsing must still have issued no driver action mutation.
    expect(driverActionMutations.length, 'browsing must not issue a driver action mutation').toBe(baseline);

    // The discovery exclusion is exercised, not vacuous: discovery refetches did
    // occur (POSTs to the EXACT discovery RPC path) and none were classified as
    // a driver action mutation.
    expect(discoveryRefetches.length, 'expected the discovery refetch to be exercised').toBeGreaterThan(0);
    expect(
      discoveryRefetches.every(entry => entry === `POST ${RPC_PATH_PREFIX}fetch_hybrid_opportunities`)
    ).toBe(true);

    // The already-certified acceptance path must still work after browsing.
    await cardA.first().click();
    await page.getByRole('button', { name: 'Accept Request', exact: true }).click();
    await expect.poll(() => driverActionMutations.some(m => m.includes('accept_searching_job')), { timeout: 15000 }).toBe(true);
    const continueJob = page.getByRole('button', { name: /continue job/i });
    await expect(continueJob).toBeVisible({ timeout: 15000 });
    await continueJob.click();
    await expect(page).toHaveURL(/\/driver\/job-details/);
  });
});
