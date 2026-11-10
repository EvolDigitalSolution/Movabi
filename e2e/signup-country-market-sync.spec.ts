import { expect, Page, Route, test } from '@playwright/test';

/**
 * Regression coverage for signup country <-> market-availability synchronisation.
 *
 * The signup page owns a country dropdown that writes AppConfigService state.
 * The market banner/overlay is owned by the root App component. These tests prove
 * a country change re-resolves market availability WITHOUT a browser refresh, and
 * that stale/racing responses can never win.
 */

const STORAGE_KEY = 'movabi_country_code';

type MarketStatus = Record<string, unknown>;

/** NG: app enabled but bookings disabled -> root <aside> banner. */
const ngBanner: MarketStatus = {
  code: null, countryCode: 'NG', marketCity: null, launchStatus: 'live',
  customerAppEnabled: true, customerRegistrationEnabled: true, driverRegistrationEnabled: false,
  driverOnlineEnabled: false, quoteEnabled: false, bookingEnabled: false, paymentEnabled: false,
  currency: 'NGN', timezone: 'Africa/Lagos',
  title: 'Movabi is coming to NG', message: 'Bookings are not available in this area yet.',
  waitingListEnabled: true, resolutionLevel: 'country'
};

/** GB: fully live -> no banner, no overlay. */
const gbLive: MarketStatus = {
  ...ngBanner, countryCode: 'GB', currency: 'GBP', timezone: 'Europe/London',
  driverRegistrationEnabled: true, driverOnlineEnabled: true, quoteEnabled: true,
  bookingEnabled: true, paymentEnabled: true, waitingListEnabled: false,
  title: 'Movabi UK', message: 'Live in the United Kingdom'
};

function json(route: Route, data: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
}

async function seedCountry(page: Page, code: string) {
  await page.addInitScript(([key, value]) => {
    // Seed only when nothing is persisted yet, so a reload observes what the app
    // actually saved instead of the harness overwriting it.
    if (!window.localStorage.getItem(key)) window.localStorage.setItem(key, value);
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

async function installMocks(
  page: Page,
  appBaseUrl: string,
  marketHandler: (route: Route, url: string) => Promise<unknown> | unknown
) {
  const appOrigin = new URL(appBaseUrl).origin;
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/markets/status')) return marketHandler(route, url);
    if (new URL(url).origin === appOrigin) return route.continue();
    if (url.includes('api.maptiler.com') || url.includes('api.openrouteservice.org')) {
      return json(route, { features: [], version: 8, sources: {}, layers: [] });
    }
    if (url.includes('/auth/v1/')) return json(route, { error: 'not authenticated' }, 401);
    if (url.includes('/rest/v1/')) return json(route, []);
    return json(route, {});
  });
}

/** Drives the real signup country handler the same way Ionic's ion-select does. */
async function selectSignupCountry(page: Page, code: string) {
  await page.locator('#country').evaluate((element, value) => {
    const select = element as HTMLElement & { value: unknown };
    select.value = value;
    select.dispatchEvent(new CustomEvent('ionChange', { detail: { value } }));
  }, code);
}

const ngBannerText = (page: Page) => page.getByText('Movabi is coming to NG');

/** ion-select is a custom element, so read its value property directly. */
const signupCountry = (page: Page) =>
  page.locator('#country').evaluate((element) => String((element as HTMLElement & { value?: unknown }).value ?? ''));

test.describe('signup country -> market availability sync', () => {
  test('TC1 NG -> GB re-resolves market availability without a refresh', async ({ page, baseURL }) => {
    const requests: string[] = [];
    await seedCountry(page, 'NG');
    await installMocks(page, baseURL!, (route, url) => {
      requests.push(url);
      return json(route, url.includes('countryCode=GB') ? gbLive : ngBanner);
    });

    await page.goto('/auth/signup');
    await expect(ngBannerText(page)).toBeVisible();
    const initialRequests = requests.length;

    await selectSignupCountry(page, 'GB');

    // The new country must be requested immediately...
    await expect
      .poll(() => requests.filter((u) => u.includes('countryCode=GB')).length, { timeout: 5000 })
      .toBeGreaterThan(0);
    // ...and the previous country's banner must be gone.
    await expect(ngBannerText(page)).toBeHidden();
    expect(requests.some((u) => u.includes('countryCode=AU'))).toBe(false);
    expect(requests.length).toBeGreaterThan(initialRequests);
  });

  test('TC2 GB -> NG renders NG restrictions without a refresh', async ({ page, baseURL }) => {
    const requests: string[] = [];
    await seedCountry(page, 'GB');
    await installMocks(page, baseURL!, (route, url) => {
      requests.push(url);
      return json(route, url.includes('countryCode=NG') ? ngBanner : gbLive);
    });

    await page.goto('/auth/signup');
    await expect(ngBannerText(page)).toBeHidden();

    await selectSignupCountry(page, 'NG');

    await expect(ngBannerText(page)).toBeVisible({ timeout: 5000 });
    expect(requests.some((u) => u.includes('countryCode=NG'))).toBe(true);
    expect(requests.some((u) => u.includes('countryCode=AU'))).toBe(false);
  });

  test('TC3 rapid switching resolves the newest country, never an older response', async ({ page, baseURL }) => {
    await seedCountry(page, 'NG');
    await installMocks(page, baseURL!, async (route, url) => {
      if (url.includes('countryCode=GB')) {
        // Deliberately slow GB answer so an out-of-order resolution is possible.
        await new Promise((resolve) => setTimeout(resolve, 400));
        return json(route, gbLive);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      return json(route, ngBanner);
    });

    await page.goto('/auth/signup');
    await expect(ngBannerText(page)).toBeVisible();

    await selectSignupCountry(page, 'GB');
    await selectSignupCountry(page, 'NG');

    // Final selection is NG -> the NG banner must win even though GB resolved later.
    await expect(ngBannerText(page)).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(800);
    await expect(ngBannerText(page)).toBeVisible();
    await expect.poll(() => signupCountry(page)).toBe('NG');
  });

  test('TC4 selecting a different country clears the country-specific city', async ({ page, baseURL }) => {
    await seedCountry(page, 'GB');
    await installMocks(page, baseURL!, (route, url) => json(route, url.includes('countryCode=NG') ? ngBanner : gbLive));

    await page.goto('/auth/signup');
    const city = page.locator('#marketCity');
    await city.fill('London');

    await selectSignupCountry(page, 'NG');

    await expect.poll(() => signupCountry(page)).toBe('NG');
    await expect(city).toHaveValue('');
  });

  test('TC5 country persistence survives reload and resolves the persisted country', async ({ page, baseURL }) => {
    const requests: string[] = [];
    await seedCountry(page, 'GB');
    await installMocks(page, baseURL!, (route, url) => {
      requests.push(url);
      return json(route, url.includes('countryCode=NG') ? ngBanner : gbLive);
    });

    await page.goto('/auth/signup');
    await selectSignupCountry(page, 'NG');
    await expect.poll(() => signupCountry(page)).toBe('NG');

    await page.reload();
    await expect.poll(() => signupCountry(page)).toBe('NG');
    expect(requests.some((u) => u.includes('countryCode=NG'))).toBe(true);
    expect(requests.some((u) => u.includes('countryCode=AU'))).toBe(false);
  });

  test('TC6 a failed re-resolve fails closed without keeping the old country banner', async ({ page, baseURL }) => {
    let calls = 0;
    await seedCountry(page, 'NG');
    await installMocks(page, baseURL!, async (route) => {
      calls += 1;
      if (calls === 1) return json(route, ngBanner);
      return json(route, { error: 'simulated outage' }, 500);
    });

    await page.goto('/auth/signup');
    await expect(ngBannerText(page)).toBeVisible();

    await selectSignupCountry(page, 'GB');

    await expect(ngBannerText(page)).toBeHidden({ timeout: 5000 });
    await expect(page.getByText('Availability check failed')).toBeVisible();
  });
});
