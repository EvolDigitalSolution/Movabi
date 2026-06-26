import { expect, Page, Route } from '@playwright/test';

export type E2ERole = 'customer' | 'driver' | 'admin';

export const ids = {
  tenant: '00000000-0000-4000-8000-000000000001',
  city: '00000000-0000-4000-8000-000000000002',
  customer: '10000000-0000-4000-8000-000000000001',
  driver: '20000000-0000-4000-8000-000000000001',
  admin: '30000000-0000-4000-8000-000000000001',
  rideService: '40000000-0000-4000-8000-000000000001',
  deliveryService: '40000000-0000-4000-8000-000000000002',
  errandService: '40000000-0000-4000-8000-000000000003',
  vanService: '40000000-0000-4000-8000-000000000004',
  rideJob: '50000000-0000-4000-8000-000000000001'
};

const now = '2026-06-17T10:00:00.000Z';

export const profiles = {
  customer: {
    id: ids.customer,
    tenant_id: ids.tenant,
    role: 'customer',
    first_name: 'Test',
    last_name: 'Customer',
    email: 'customer@movabi.test',
    onboarding_completed: true,
    account_status: 'active',
    created_at: now,
    updated_at: now
  },
  driver: {
    id: ids.driver,
    tenant_id: ids.tenant,
    role: 'driver',
    first_name: 'Dara',
    last_name: 'Driver',
    email: 'driver@movabi.test',
    phone: '+447700900123',
    onboarding_completed: true,
    account_status: 'active',
    is_verified: true,
    verification_status: 'approved',
    pricing_plan: 'starter',
    commission_rate: 15,
    stripe_connect_status: 'enabled',
    stripe_account_id: 'acct_driver_test',
    is_online: true,
    is_available: true,
    rating: 4.9,
    vehicles: [{
      id: 'vehicle-driver-1',
      driver_id: ids.driver,
      type: 'car',
      make: 'Toyota',
      model: 'Prius',
      color: 'Silver',
      year: 2022,
      license_plate: 'MV22 TST',
      capacity: '4 seats',
      is_verified: true
    }],
    created_at: now,
    updated_at: now
  },
  admin: {
    id: ids.admin,
    tenant_id: ids.tenant,
    role: 'admin',
    first_name: 'Admin',
    last_name: 'User',
    email: 'admin@movabi.test',
    onboarding_completed: true,
    account_status: 'active',
    created_at: now,
    updated_at: now
  }
};

export const serviceTypes = [
  { id: ids.rideService, slug: 'ride', name: 'Ride', description: 'Taxi services', icon: 'car', base_price: 2.5, price_per_km: 0.95, is_active: true },
  { id: ids.deliveryService, slug: 'delivery', name: 'Delivery', description: 'Delivery services', icon: 'cube', base_price: 2.25, price_per_km: 0.55, is_active: true },
  { id: ids.errandService, slug: 'errand', name: 'Errand', description: 'Errand services', icon: 'basket', base_price: 5, price_per_km: 0.95, is_active: true },
  { id: ids.vanService, slug: 'van-moving', name: 'Van Moving', description: 'Move services', icon: 'bus', base_price: 25, price_per_km: 1.6, is_active: true }
];

export const pricingConfig = [
  { service_type: 'ride', base_fare: 2.5, per_km: 0.95, per_min: 0.12, service_fee: 0.25, minimum_fare: 3.99, currency_code: 'GBP', is_active: true },
  { service_type: 'delivery', base_fare: 2.25, per_km: 0.55, per_min: 0.04, service_fee: 0.1, minimum_fare: 2.99, currency_code: 'GBP', is_active: true },
  { service_type: 'errand', base_fare: 5, per_km: 0.95, per_min: 0.12, service_fee: 0.5, minimum_fare: 6.5, currency_code: 'GBP', is_active: true },
  { service_type: 'van-moving', base_fare: 25, per_km: 1.6, per_min: 0.25, service_fee: 1.5, minimum_fare: 30, currency_code: 'GBP', is_active: true }
];

export const baseJob = {
  id: ids.rideJob,
  customer_id: ids.customer,
  driver_id: ids.driver,
  accepted_driver_id: ids.driver,
  service_type_id: ids.rideService,
  service_type: serviceTypes[0],
  service_slug: 'ride',
  status: 'accepted',
  payment_status: 'wallet_funded',
  payment_method: 'wallet',
  pickup_address: 'Back Skipton Street, Bolton',
  dropoff_address: 'Tonge Moor Primary Academy, Bolton',
  pickup_lat: 53.585,
  pickup_lng: -2.43,
  dropoff_lat: 53.592,
  dropoff_lng: -2.421,
  distance_km: 0.87,
  duration_minutes: 2,
  price: 3.5,
  total_price: 3.5,
  estimated_price: 3.5,
  currency_code: 'GBP',
  driver: profiles.driver,
  customer: profiles.customer,
  metadata: {
    completion_pin: '1234',
    completion_pin_required: true,
    service_vehicle_class: 'standard',
    ride_details: { passenger_count: 4, vehicle_class: 'standard' }
  },
  created_at: now,
  updated_at: now
};

export function roleFromEmail(email: string): E2ERole {
  if (email.includes('driver')) return 'driver';
  if (email.includes('admin')) return 'admin';
  return 'customer';
}

export async function installMovabiMocks(page: Page, role: E2ERole = 'customer') {
  let activeRole = role;
  let activeJob = { ...baseJob };
  const wallet = { id: 'wallet-1', user_id: ids.customer, available_balance: 42.5, reserved_balance: 3.5, currency_code: 'GBP' };

  await page.addInitScript(() => {
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
  });

  await page.route('**/*', async (route) => {
    const url = route.request().url();

    if (url.includes('api.maptiler.com/maps') && url.includes('style.json')) {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          version: 8,
          sources: {},
          layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f7efe2' } }]
        })
      });
    }

    if (url.includes('api.maptiler.com/geocoding')) {
      const requestUrl = new URL(url);
      const encodedQuery = requestUrl.pathname.split('/geocoding/')[1]?.replace(/\.json$/, '') || '';
      return json(route, { features: geocodeFeatures(decodeURIComponent(encodedQuery), requestUrl.searchParams.get('proximity')) });
    }

    if (url.includes('api.openrouteservice.org/geocode')) {
      const requestUrl = new URL(url);
      return json(route, { features: geocodeFeatures(requestUrl.searchParams.get('text') || '', `${requestUrl.searchParams.get('focus.point.lon')},${requestUrl.searchParams.get('focus.point.lat')}`) });
    }

    if (url.includes('api.maptiler.com') || url.includes('api.openrouteservice.org')) {
      return json(route, { features: [], routes: [{ summary: { distance: 870, duration: 128 }, geometry: { coordinates: [[-2.43, 53.585], [-2.421, 53.592]] } }] });
    }

    if (url.includes('/auth/v1/token')) {
      const body = route.request().postDataJSON() as { email?: string } | null;
      activeRole = roleFromEmail(body?.email || `${activeRole}@movabi.test`);
      return json(route, sessionFor(activeRole));
    }

    if (url.includes('/auth/v1/user')) {
      return json(route, userFor(activeRole));
    }

    if (url.includes('/rest/v1/profiles')) {
      if (url.includes(`id=eq.${ids.driver}`)) return json(route, profiles.driver);
      if (url.includes(`id=eq.${ids.admin}`)) return json(route, profiles.admin);
      if (url.includes(`id=eq.${ids.customer}`)) return json(route, profiles.customer);
      return json(route, profiles[activeRole]);
    }

    if (url.includes('/rest/v1/service_types')) {
      if (route.request().method() === 'PATCH') {
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        const updated = { ...serviceTypes.find((item) => item.slug === payload['slug']) || serviceTypes[1], ...payload };
        return json(route, updated);
      }

      if (route.request().method() === 'POST') {
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        return json(route, { id: 'service-new', ...payload }, 201);
      }

      return json(route, serviceTypes);
    }

    if (url.includes('/rest/v1/pricing_config')) {
      if (['POST', 'PATCH'].includes(route.request().method())) {
        return json(route, route.request().postDataJSON() || {});
      }

      return json(route, pricingConfig);
    }
    if (url.includes('/rest/v1/wallets')) return json(route, wallet);
    if (url.includes('/rest/v1/wallet_transactions')) return json(route, [
      { id: 'txn-1', user_id: ids.customer, amount: 25, transaction_type: 'topup', description: 'Card top up', created_at: now }
    ]);
    if (url.includes('/rest/v1/vehicles')) return json(route, profiles.driver.vehicles);
    if (url.includes('/rest/v1/driver_locations')) return json(route, [
      { id: ids.driver, driver_id: ids.driver, lat: 53.586, lng: -2.429, heading: 90, updated_at: now }
    ]);
    if (url.includes('/rest/v1/ride_details')) return json(route, { id: 'ride-details-1', job_id: activeJob.id, passenger_count: 4 });
    if (url.includes('/rest/v1/ratings')) return json(route, { id: 'rating-1', job_id: activeJob.id, rating: 5 });

    if (url.includes('/rest/v1/jobs')) {
      if (route.request().method() === 'POST') {
        activeJob = {
          ...activeJob,
          id: '60000000-0000-4000-8000-000000000001',
          driver_id: null,
          accepted_driver_id: null,
          status: 'searching',
          payment_status: 'pending'
        };
        return json(route, [activeJob], 201);
      }

      if (route.request().method() === 'PATCH') {
        activeJob = { ...activeJob, ...route.request().postDataJSON() };
        return json(route, [activeJob]);
      }

      if (url.includes('driver_id=is.null') || url.includes('status=in')) {
        return json(route, [{ ...baseJob, driver_id: null, accepted_driver_id: null, status: 'searching' }]);
      }

      return json(route, activeJob);
    }

    if (url.includes('/rest/v1/rpc/accept_searching_job') || url.includes('/rest/v1/rpc/accept_job') || url.includes('/rest/v1/rpc/accept_job_request')) {
      activeJob = { ...activeJob, driver_id: ids.driver, accepted_driver_id: ids.driver, status: 'accepted' };
      return json(route, activeJob);
    }

    if (url.includes('/api/payment/calculate-price')) return json(route, { amount: 3.5, price: 3.5, total: 3.5, totalPrice: 3.5 });
    if (url.includes('/api/payment/create-intent')) return json(route, { clientSecret: 'pi_test_secret_mock', paymentIntentId: 'pi_test' });
    if (url.includes('/api/wallet/pay-job')) return json(route, { ok: true, payment_status: 'wallet_funded', wallet });
    if (url.includes('/api/wallet/top-up')) return json(route, { clientSecret: 'pi_topup_secret_mock', paymentIntentId: 'pi_topup' });
    if (url.includes('/api/booking/confirm-payment')) {
      activeJob = { ...activeJob, payment_status: 'wallet_funded' };
      return json(route, activeJob);
    }
    if (url.includes('/api/booking/cancel')) {
      activeJob = { ...activeJob, status: 'cancelled' };
      return json(route, { job: activeJob, refund: { amount: 3.5 } });
    }
    if (url.includes('/api/booking/complete') || url.includes('/api/logistics/complete')) {
      const payload = route.request().postDataJSON() as { completionPin?: string } | null;
      const expectedPin = String((activeJob.metadata as any)?.completion_pin || '');

      if (url.includes('/api/logistics/complete') && expectedPin && payload?.completionPin !== expectedPin) {
        return json(route, { error: 'The customer PIN is incorrect. Ask the customer for the current 4-digit PIN and try again.' }, 400);
      }

      activeJob = { ...activeJob, status: 'completed', payment_status: 'paid', driver_payout: 2.98, stripe_transfer_id: 'tr_test' };
      return json(route, activeJob);
    }
    if (url.includes('/api/logistics/enqueue')) return json(route, { job: activeJob, status: 'queued' });
    if (url.includes('/api/connect/status')) return json(route, { onboarding_complete: true, status: 'enabled' });
    if (url.includes('/api/connect/account-link')) return json(route, { url: 'https://connect.stripe.test/onboarding' });
    if (url.includes('/api/admin') || url.includes('/rest/v1/subscription')) return json(route, []);

    return route.continue();
  });
}

export async function loginAs(page: Page, role: E2ERole) {
  await installMovabiMocks(page, role);
  await page.goto('/auth/login');
  await page.getByLabel(/email address/i).fill(`${role}@movabi.test`);
  await page.getByRole('textbox', { name: /^password$/i }).fill('Password123!');
  await page.getByRole('button', { name: /sign in/i }).click();

  if (role === 'customer') await expect(page).toHaveURL(/\/customer/);
  if (role === 'driver') await expect(page).toHaveURL(/\/driver/);
  if (role === 'admin') await expect(page).toHaveURL(/\/dashboard|\/admin/);
}

function userFor(role: E2ERole) {
  const profile = profiles[role];
  return {
    id: profile.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: profile.email,
    user_metadata: {
      role: profile.role,
      tenant_id: profile.tenant_id,
      onboarding_completed: true
    },
    app_metadata: {},
    created_at: now
  };
}

function sessionFor(role: E2ERole) {
  return {
    access_token: `token-${role}`,
    token_type: 'bearer',
    expires_in: 3600,
    refresh_token: `refresh-${role}`,
    user: userFor(role)
  };
}

async function json(route: Route, data: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(data)
  });
}

function geocodeFeatures(query: string, proximity?: string | null) {
  const normalized = String(query || '').toLowerCase();
  const isBoltonIntent = normalized.includes('bolton') || normalized.includes('bl2') || String(proximity || '').includes('-2.43');

  if (normalized.includes('mcdonald') || normalized.includes('asda')) {
    const label = normalized.includes('mcdonald')
      ? (isBoltonIntent ? 'McDonald\'s, Manchester Road, Bolton, United Kingdom' : 'McDonald\'s, Charing Cross, London, United Kingdom')
      : (isBoltonIntent ? 'Asda, Moss Bank Way, Bolton BL1 8QG, United Kingdom' : 'Asda, Old Kent Road, London, United Kingdom');
    const coordinates: [number, number] = isBoltonIntent ? [-2.429, 53.590] : [-0.127, 51.5074];
    return [
      {
        place_name: label,
        text: label,
        properties: { label, name: label },
        center: coordinates,
        geometry: { coordinates }
      }
    ];
  }

  const label = isBoltonIntent
    ? 'Back Skipton Street, Bolton, England, United Kingdom'
    : 'Waterloo Station, London, United Kingdom';
  const coordinates: [number, number] = isBoltonIntent ? [-2.43, 53.585] : [-0.113, 51.503];

  return [
    {
      place_name: label,
      text: label,
      properties: { label, name: label },
      center: coordinates,
      geometry: { coordinates }
    }
  ];
}
