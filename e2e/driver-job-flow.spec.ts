import { expect, test } from '@playwright/test';
import { loginAs } from './fixtures/movabi-mocks';

test.describe('driver request lifecycle', () => {
  test('driver can see a request, accept it, and reach completion actions', async ({ page }) => {
    await loginAs(page, 'driver');

    const sheet = page.getByRole('dialog', { name: 'Available driver requests' });
    await expect(sheet).toBeVisible();
    await expect(page.getByText('Back Skipton Street, Bolton', { exact: true })).toBeVisible();
    const accept = page.getByRole('button', { name: /^Accept request$/i });
    await expect(accept).toBeEnabled();
    await accept.click();
    // Current request feed confirms ownership, closes its sheet and opens job details.
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

    const sheet = page.getByRole('dialog', { name: 'Available driver requests' });
    await expect(sheet).toBeVisible();
    const baseline = driverActionMutations.length;
    await page.getByRole('button', { name: 'Ride · 2', exact: true }).click();
    await expect(page.getByText('Deansgate, Manchester', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Ride · 1', exact: true }).click();
    await expect(page.getByText('Back Skipton Street, Bolton', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(sheet).not.toBeVisible();
    await page.getByRole('button', { name: /^2 requests · View$/ }).click();
    await expect(sheet).toBeVisible();
    await expect(page.getByText('Back Skipton Street, Bolton', { exact: true })).toBeVisible();
    expect(driverActionMutations.length, 'Browsing, closing and reopening must not perform driver action mutations').toBe(baseline);
  });
});
