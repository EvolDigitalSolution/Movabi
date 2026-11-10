import { expect, Page, Route, test } from '@playwright/test';

/**
 * Functional browser verification of the customer startup Market Rollout fix.
 * The market-status endpoint is mocked so the walkthrough is deterministic and
 * never depends on / mutates production rollout data.
 *
 * Runs under both configured projects (mobile-chromium 412x915 and
 * admin-chromium 1440x1000) so narrow and desktop layouts are both covered.
 */

const STORAGE_KEY = 'movabi_country_code';

type MarketStatus = Record<string, unknown>;

const ngBlocked: MarketStatus = {
  code: null, countryCode: 'NG', marketCity: null, launchStatus: 'live',
  customerAppEnabled: false, customerRegistrationEnabled: false, driverRegistrationEnabled: false,
  driverOnlineEnabled: false, quoteEnabled: false, bookingEnabled: false, paymentEnabled: false,
  currency: 'NGN', timezone: 'Africa/Lagos',
  title: 'Nigeria Operations / Live', message: 'This is becoming live',
  waitingListEnabled: true, resolutionLevel: 'country'
};

const gbBlocked: MarketStatus = {
  code: null, countryCode: 'GB', marketCity: null, launchStatus: 'coming_soon',
  customerAppEnabled: false, customerRegistrationEnabled: false, driverRegistrationEnabled: false,
  driverOnlineEnabled: false, quoteEnabled: false, bookingEnabled: false, paymentEnabled: false,
  currency: 'GBP', timezone: 'Europe/London',
  title: 'Movabi UK launch', message: 'Launching soon in the United Kingdom',
  waitingListEnabled: true, resolutionLevel: 'country'
};

const gbLive: MarketStatus = {
  ...gbBlocked, launchStatus: 'live', customerAppEnabled: true, customerRegistrationEnabled: true,
  driverRegistrationEnabled: true, driverOnlineEnabled: true, quoteEnabled: true,
  bookingEnabled: true, paymentEnabled: true, waitingListEnabled: false
};

function json(route: Route, data: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
}

async function seedCountry(page: Page, code: string) {
  await page.addInitScript(([key, value]) => {
    window.localStorage.setItem(key, value);
    class MockBroadcastChannel {
      name: string;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(name: string) { this.name = name; }
      postMessage() {}
      close() {}
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() { return true; }
    }
    window.BroadcastChannel = MockBroadcastChannel as unknown as typeof BroadcastChannel;
  }, [STORAGE_KEY, code] as [string, string]);
}

/** Route everything the startup gate touches; only the market status varies. */
async function installStartupMocks(
  page: Page,
  appBaseUrl: string,
  marketHandler: (route: Route, url: string) => Promise<unknown> | unknown
) {
  const appOrigin = new URL(appBaseUrl).origin;

  await page.route('**/*', async (route) => {
    const url = route.request().url();

    if (url.includes('/api/markets/status')) return marketHandler(route, url);

    // The app's own dev-server assets must load normally.
    if (new URL(url).origin === appOrigin) return route.continue();

    if (url.includes('api.maptiler.com') || url.includes('api.openrouteservice.org')) {
      return json(route, { features: [], version: 8, sources: {}, layers: [] });
    }
    if (url.includes('/auth/v1/')) return json(route, { error: 'not authenticated' }, 401);
    if (url.includes('/rest/v1/')) return json(route, []);

    return json(route, {});
  });
}

const overlay = (page: Page) => page.locator('section[aria-live="polite"]');
const locationSelect = (page: Page) => overlay(page).getByLabel('Change location');

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

test.describe('customer startup market rollout', () => {
  test('TC1 persisted NG renders Nigeria (never Australia) and requests countryCode=NG', async ({ page, baseURL }) => {
    const requests: string[] = [];
    await seedCountry(page, 'NG');
    await installStartupMocks(page, baseURL!, (route, url) => { requests.push(url); return json(route, ngBlocked); });

    await page.goto('/auth/signup');

    const select = locationSelect(page);
    await expect(select).toBeVisible();
    await expect(select).toHaveValue('NG');
    await expect(select.locator('option:checked')).toHaveText('Nigeria');
    await expect(select.locator('option:checked')).not.toHaveText('Australia');
    await expect(select.locator('option', { hasText: 'Australia' })).toHaveCount(1);

    expect(requests.filter((u) => u.includes('/api/markets/status')).length).toBeGreaterThan(0);
    expect(requests.some((u) => u.includes('countryCode=NG'))).toBe(true);
    expect(requests.some((u) => u.includes('countryCode=AU'))).toBe(false);
  });

  test('TC2 blocked NG market shows NG messaging and unclipped controls', async ({ page, baseURL }) => {
    await seedCountry(page, 'NG');
    await installStartupMocks(page, baseURL!, (route) => json(route, ngBlocked));
    await page.goto('/auth/signup');

    const panel = overlay(page);
    await expect(panel).toBeVisible();
    await expect(panel.locator('h1')).toHaveText('Nigeria Operations / Live');
    await expect(panel.locator('p').first()).toHaveText('This is becoming live');
    await expect(locationSelect(page)).toHaveValue('NG');
    await expect(locationSelect(page).locator('option:checked')).toHaveText('Nigeria');

    const controls: Array<[string, ReturnType<Page['getByRole']>]> = [
      ['Join', panel.getByRole('button', { name: 'Join' })],
      ['Retry', panel.getByRole('button', { name: 'Retry' })],
      ['Sign in', panel.getByRole('button', { name: 'Sign in' })]
    ];

    for (const [name, control] of controls) {
      await expect(control, `${name} visible`).toBeVisible();
      const metrics = await control.evaluate((node) => {
        const el = node as HTMLElement;
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          width: Number(rect.width.toFixed(2)),
          paddingTop: cs.paddingTop, paddingRight: cs.paddingRight,
          paddingBottom: cs.paddingBottom, paddingLeft: cs.paddingLeft,
          flexShrink: cs.flexShrink, whiteSpace: cs.whiteSpace,
          scrollWidth: el.scrollWidth, clientWidth: el.clientWidth
        };
      });
      console.log(`LAYOUT ${name} ${JSON.stringify(metrics)}`);

      expect(parseFloat(metrics.paddingLeft), `${name} left padding`).toBeGreaterThan(0);
      expect(parseFloat(metrics.paddingRight), `${name} right padding`).toBeGreaterThan(0);
      expect(parseFloat(metrics.paddingTop), `${name} top padding`).toBeGreaterThan(0);
      expect(parseFloat(metrics.paddingBottom), `${name} bottom padding`).toBeGreaterThan(0);
      expect(metrics.flexShrink, `${name} must not shrink`).toBe('0');
      expect(metrics.whiteSpace, `${name} must not wrap`).toBe('nowrap');
      expect(metrics.clientWidth, `${name} must not clip its label`).toBeGreaterThanOrEqual(metrics.scrollWidth - 1);
      expect(metrics.width, `${name} must not be unnaturally narrow`).toBeGreaterThan(60);
    }

    const email = panel.getByPlaceholder('Email for launch updates');
    const emailBox = await email.boundingBox();
    const joinBox = await panel.getByRole('button', { name: 'Join' }).boundingBox();
    const emailMid = emailBox!.y + emailBox!.height / 2;
    const joinMid = joinBox!.y + joinBox!.height / 2;
    expect(Math.abs(emailMid - joinMid), 'email input and Join must share a row baseline').toBeLessThan(6);
  });

  test('TC3 location switching re-resolves and clears the previous country messaging', async ({ page, baseURL }) => {
    const requests: string[] = [];
    await seedCountry(page, 'NG');
    await installStartupMocks(page, baseURL!, (route, url) => {
      requests.push(url);
      return json(route, url.includes('countryCode=GB') ? gbBlocked : ngBlocked);
    });

    await page.goto('/auth/signup');
    const panel = overlay(page);
    const select = locationSelect(page);

    await expect(panel.locator('h1')).toHaveText('Nigeria Operations / Live');
    await expect(select).toHaveValue('NG');

    await select.selectOption('GB');
    await expect(select).toHaveValue('GB');
    await expect(select.locator('option:checked')).toHaveText('United Kingdom');
    await expect(panel.locator('h1')).toHaveText('Movabi UK launch');
    await expect(panel.locator('p').first()).toHaveText('Launching soon in the United Kingdom');
    expect(requests.some((u) => u.includes('countryCode=GB'))).toBe(true);

    await select.selectOption('NG');
    await expect(select).toHaveValue('NG');
    await expect(select.locator('option:checked')).toHaveText('Nigeria');
    await expect(panel.locator('h1')).toHaveText('Nigeria Operations / Live');
    await expect(panel.locator('h1')).not.toHaveText('Movabi UK launch');
  });

  test('TC4 a failed market-status request must not retain the previous market', async ({ page, baseURL }) => {
    let calls = 0;
    await seedCountry(page, 'NG');
    await installStartupMocks(page, baseURL!, async (route) => {
      calls += 1;
      if (calls === 1) return json(route, ngBlocked);
      return json(route, { error: 'simulated outage' }, 500);
    });

    await page.goto('/auth/signup');
    const panel = overlay(page);
    const select = locationSelect(page);
    await expect(panel.locator('h1')).toHaveText('Nigeria Operations / Live');

    await select.selectOption('GB');

    await expect(panel.locator('h1')).toHaveText('Availability check failed');
    await expect(panel.locator('h1')).not.toHaveText('Nigeria Operations / Live');
    await expect(panel.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('TC5 fully-live market removes the blocking overlay (no NG messaging retained)', async ({ page, baseURL }) => {
    await seedCountry(page, 'NG');
    await installStartupMocks(page, baseURL!, (route, url) => json(route, url.includes('countryCode=GB') ? gbLive : ngBlocked));

    await page.goto('/auth/signup');
    await expect(overlay(page)).toBeVisible();

    await locationSelect(page).selectOption('GB');
    await expect(overlay(page)).toBeHidden();
    await expect(page.locator('text=Nigeria Operations / Live')).toHaveCount(0);
  });

  test('TC6 no console errors and no unexpected market-status requests', async ({ page, baseURL }) => {
    const errors = watchConsole(page);
    const requests: string[] = [];
    await seedCountry(page, 'NG');
    await installStartupMocks(page, baseURL!, (route, url) => { requests.push(url); return json(route, ngBlocked); });
    await page.goto('/auth/signup');
    await expect(overlay(page)).toBeVisible();
    await page.waitForTimeout(1500);

    const marketRequests = requests.filter((u) => u.includes('/api/markets/status'));
    expect(marketRequests.every((u) => u.includes('countryCode='))).toBe(true);
    expect(marketRequests.some((u) => u.includes('countryCode=NG'))).toBe(true);
    expect(marketRequests.some((u) => u.includes('countryCode=AU'))).toBe(false);
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
