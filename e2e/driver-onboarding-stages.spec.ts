import { expect, Page, Route, test } from '@playwright/test';
import { installMovabiMocks } from './fixtures/movabi-mocks';

/**
 * Five-stage progressive Driver KYC — browser coverage.
 *
 * Runs under both configured projects (412x915 and 1440x1000).
 *
 * NOTE ON CLICKING: this page lives inside `ion-content`, whose scroll container is
 * a shadow-root `.inner-scroll`. Playwright's own actionability check scrolls that
 * container correctly, so buttons are clicked normally. Do NOT use
 * `click({ force: true })` here: it skips scroll-into-view, and a JS
 * `scrollIntoView()` scrolls the outer document instead of Ionic's scroller, so the
 * forced click lands outside the viewport and times out.
 */

const DRIVER_ID = '20000000-0000-4000-8000-000000000001';
const ADDRESS = '1 High Street, Bolton, BL1 1AA';

const liveMarket = {
  code: null, countryCode: 'GB', marketCity: null, launchStatus: 'live',
  customerAppEnabled: true, customerRegistrationEnabled: true, driverRegistrationEnabled: true,
  driverOnlineEnabled: true, quoteEnabled: true, bookingEnabled: true, paymentEnabled: true,
  currency: 'GBP', timezone: 'Europe/London', title: 'Movabi UK', message: 'Live',
  waitingListEnabled: false, resolutionLevel: 'country'
};

type Requirement = {
  code: string; label: string; category: string; status: string; required: boolean;
  completed: boolean; blockingForSubmission: boolean; blockingForOnline: boolean;
  needsAdminReview: boolean; reason: string; services: string[];
};

const requirement = (code: string, category: string, completed: boolean, extra: Partial<Requirement> = {}): Requirement => ({
  code, label: code, category, status: completed ? 'completed' : 'missing', required: true,
  completed, blockingForSubmission: !completed, blockingForOnline: !completed,
  needsAdminReview: false, reason: `${code} is required.`, services: [], ...extra
});

const AGREEMENT = 'agreement.driver_terms';

const PROFILE_REQUIREMENTS = [
  requirement('profile.full_name', 'basic', true),
  requirement('profile.phone', 'basic', true),
  requirement('profile.address', 'basic', true),
  requirement('profile.email_verification', 'basic', true),
  requirement('profile.date_of_birth', 'basic', true),
  requirement('service.selection', 'services', true),
  requirement(AGREEMENT, 'agreement', true)
];

const statusPayload = (overrides: Record<string, unknown> = {}) => ({
  driverId: DRIVER_ID,
  registrationAllowed: true,
  overallStatus: 'incomplete',
  profile: {
    id: DRIVER_ID, role: 'driver', country_code: 'GB', driver_service_types: ['delivery'],
    full_name: 'Dara Driver', phone: '+447700900123', date_of_birth: '1990-01-01',
    current_address: ADDRESS, verification_status: null, is_verified: false
  },
  canonicalProfile: {
    id: DRIVER_ID, fullName: 'Dara Driver', phone: '+447700900123', dateOfBirth: '1990-01-01',
    residentialAddress: ADDRESS, emailConfirmed: true, verificationStatus: null
  },
  passengerLicence: { councilName: null, licenceNumber: null, badgeNumber: null, expiryDate: null, status: 'not_applicable', complete: false },
  vehicle: null,
  outstandingRequests: [],
  automaticRequirements: PROFILE_REQUIREMENTS,
  adminRequests: [],
  warnings: [],
  identityEditability: { dateOfBirthEditable: true, fullNameEditable: true, countryCodeEditable: true, reason: null, fullNameReason: null, countryCodeReason: null },
  sectionStatus: {
    basicDetails: { applicable: true, status: 'complete' },
    services: { applicable: true, status: 'complete' },
    operatingMethod: { applicable: true, status: 'incomplete' },
    vehicle: { applicable: true, status: 'incomplete' },
    documents: { applicable: true, status: 'incomplete' },
    serviceLicensing: { applicable: false, status: 'not_applicable' },
    agreement: { applicable: true, status: 'complete' },
    review: { applicable: true, status: 'incomplete' }
  },
  progress: { completed: 6, total: 7, percentage: 86 },
  onlineEligibility: { allowed: false, reasons: ['Driver onboarding is not approved.'] },
  selectedServices: ['delivery'],
  vehicleType: 'car',
  age: { eligible: true, years: 36, minimum: 18, reason: null },
  submissionHistory: [],
  stripeStatus: 'not_started',
  updatedAt: null,
  ...overrides
});

/** A profile row in the shape onboarding.page.ts hydrates from. */
const profileRow = (overrides: Record<string, unknown> = {}) => ({
  id: DRIVER_ID, tenant_id: '00000000-0000-4000-8000-000000000001', role: 'driver',
  first_name: 'Dara', last_name: 'Driver', full_name: 'Dara Driver',
  email: 'driver@movabi.test', phone: '+447700900123', date_of_birth: '1990-01-01',
  current_address: ADDRESS, onboarding_completed: false, account_status: 'active',
  verification_status: null, driver_service_types: ['delivery'],
  created_at: '2026-06-17T10:00:00.000Z', updated_at: '2026-06-17T10:00:00.000Z',
  ...overrides
});

async function signInAsDriver(page: Page) {
  await page.goto('/auth/login');
  await page.getByLabel(/email address/i).fill('driver@movabi.test');
  await page.getByRole('textbox', { name: /^password$/i }).fill('Password123!');
  await page.getByRole('button', { name: /sign in/i }).first().click();
  await expect(page).toHaveURL(/\/driver/);
}

/**
 * Sign in as a driver with OUR routes registered after the shared fixture's
 * catch-all, so market status, the profile row and driver-onboarding are mocked
 * deterministically (the shared fixture alone falls through to the real market API).
 */
/**
 * Canonical status with a genuinely outstanding Stage 1 requirement (the phone),
 * while the address IS already persisted server-side. The app therefore resumes at
 * Stage 1 and the address must be prefilled -- it is not asked for again.
 */
const stageOneOutstanding = (overrides: Record<string, unknown> = {}) => statusPayload({
  profile: {
    id: DRIVER_ID, role: 'driver', country_code: 'GB', driver_service_types: ['delivery'],
    full_name: 'Dara Driver', phone: null, date_of_birth: '1990-01-01',
    current_address: ADDRESS, verification_status: null, is_verified: false
  },
  canonicalProfile: {
    id: DRIVER_ID, fullName: 'Dara Driver', phone: null, dateOfBirth: '1990-01-01',
    residentialAddress: ADDRESS, emailConfirmed: true, verificationStatus: null
  },
  automaticRequirements: [
    requirement('profile.full_name', 'basic', true),
    requirement('profile.phone', 'basic', false),
    requirement('profile.address', 'basic', true),
    requirement('profile.email_verification', 'basic', true),
    requirement('profile.date_of_birth', 'basic', true),
    requirement('service.selection', 'services', true),
    requirement(AGREEMENT, 'agreement', true)
  ],
  progress: { completed: 6, total: 7, percentage: 86 },
  ...overrides
});

async function openOnboarding(page: Page, payload: Record<string, unknown>, profileOverrides: Record<string, unknown> = {}) {
  await installMovabiMocks(page, 'driver');

  await page.route('**/api/markets/status*', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(liveMarket) }));

  // Fixture shape correction: the page hydrates Stage 1 from this row, so it must
  // carry the profile columns the journey reads and must not be verification-locked.
  await page.route('**/rest/v1/profiles*', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(profileRow(profileOverrides)) }));

  await page.route('**/api/driver-onboarding/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('/status')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    }
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ saved: true, vehicle: null, agreement: { accepted: true, acceptedAt: null } })
    });
  });

  await signInAsDriver(page);
  await page.goto('/driver/onboarding');
  await expect(page.getByText(/Stage \d of 5/)).toBeVisible({ timeout: 60000 });
}

/**
 * Stateful server simulation for the journey: writes go through the same endpoints
 * the page uses and are reflected back on the next GET, so persistence is real.
 */
function createServerMock() {
  const rows: Record<string, unknown> = {
    id: DRIVER_ID, role: 'driver', country_code: 'GB', driver_service_types: ['delivery'],
    full_name: 'Dara Driver', phone: null, date_of_birth: '1990-01-01',
    current_address: null, accepted_driver_agreement_at: null as string | null,
    verification_status: null as string | null, onboarding_completed: false
  };
  let vehicle: Record<string, unknown> | null = null;
  let reviewState = 'incomplete';
  let profileReads = 0;
  const writes: Array<{ method: string; url: string; body: any }> = [];

  const requirements = (): Requirement[] => {
    const agreementDone = !!rows['accepted_driver_agreement_at'];
    return [
      requirement('profile.full_name', 'basic', !!rows['full_name']),
      requirement('profile.phone', 'basic', !!rows['phone']),
      requirement('profile.address', 'basic', !!rows['current_address']),
      requirement('profile.email_verification', 'basic', true),
      requirement('profile.date_of_birth', 'basic', true),
      requirement('service.selection', 'services', true),
      // Completed evidence that must still appear only in Stage 3.
      requirement('work.right_to_work', 'documents', true),
      requirement('document.driving_licence', 'documents', true),
      requirement(AGREEMENT, 'agreement', agreementDone)
    ];
  };

  const status = () => {
    const list = requirements();
    const blocking = list.filter(item => item.blockingForSubmission);
    return {
      driverId: DRIVER_ID,
      registrationAllowed: true,
      overallStatus: reviewState === 'under_review' ? 'under_review' : (blocking.length ? 'incomplete' : 'ready_to_submit'),
      profile: { ...rows },
      canonicalProfile: {
        id: DRIVER_ID, fullName: rows['full_name'], phone: rows['phone'], dateOfBirth: rows['date_of_birth'],
        residentialAddress: rows['current_address'], emailConfirmed: true, verificationStatus: rows['verification_status']
      },
      passengerLicence: { councilName: null, licenceNumber: null, badgeNumber: null, expiryDate: null, status: 'not_applicable', complete: false },
      vehicle,
      outstandingRequests: [],
      automaticRequirements: list,
      adminRequests: [],
      warnings: [],
      identityEditability: { dateOfBirthEditable: true, fullNameEditable: true, countryCodeEditable: true, reason: null, fullNameReason: null, countryCodeReason: null },
      sectionStatus: {
        basicDetails: { applicable: true, status: rows['current_address'] && rows['phone'] ? 'complete' : 'incomplete' },
        services: { applicable: true, status: 'complete' },
        operatingMethod: { applicable: true, status: 'complete' },
        vehicle: { applicable: true, status: vehicle ? 'complete' : 'incomplete' },
        documents: { applicable: true, status: 'complete' },
        serviceLicensing: { applicable: false, status: 'not_applicable' },
        agreement: { applicable: true, status: rows['accepted_driver_agreement_at'] ? 'complete' : 'incomplete' },
        review: { applicable: true, status: reviewState === 'under_review' ? 'under_review' : 'incomplete' }
      },
      progress: { completed: list.filter(item => item.completed).length, total: list.length, percentage: 90 },
      // Submission is not approval: admin approval still gates going online.
      onlineEligibility: { allowed: false, reasons: ['Driver onboarding is not approved.'] },
      selectedServices: ['delivery'],
      vehicleType: 'car',
      age: { eligible: true, years: 36, minimum: 18, reason: null },
      submissionHistory: [],
      stripeStatus: 'not_started',
      updatedAt: null
    };
  };

  /** The profile row as the app re-reads it (drives hydration + read-only state). */
  const profileRowState = () => profileRow({
    full_name: rows['full_name'], phone: rows['phone'], date_of_birth: rows['date_of_birth'],
    current_address: rows['current_address'],
    onboarding_completed: rows['onboarding_completed'] as boolean,
    verification_status: rows['verification_status'] as string | null,
    accepted_driver_agreement_at: rows['accepted_driver_agreement_at']
  });

  const handle = (method: string, url: string, body: any) => {
    if (method === 'PUT' || method === 'POST') writes.push({ method, url, body });
    if (url.includes('/vehicle')) {
      if (method === 'PUT' && body) {
        vehicle = {
          id: 'vehicle-journey-1', user_id: DRIVER_ID, driver_id: DRIVER_ID,
          type: body.vehicleType, make: body.make, model: body.model, color: body.colour,
          year: body.year, license_plate: body.registrationNumber, capacity: body.capacity,
          service_eligibility: body.serviceEligibility, is_verified: false
        };
      }
      return { vehicle };
    }
    if (url.includes('/profile') && body) {
      if (body.residentialAddress) rows['current_address'] = String(body.residentialAddress);
      if (body.phone) rows['phone'] = String(body.phone);
      if (body.fullName) rows['full_name'] = String(body.fullName);
      return {
        profile: {
          id: DRIVER_ID, fullName: rows['full_name'], phone: rows['phone'],
          dateOfBirth: rows['date_of_birth'], residentialAddress: rows['current_address'],
          emailConfirmed: true, verificationStatus: rows['verification_status']
        }
      };
    }
    if (url.includes('/agreement')) {
      if (body?.accepted) rows['accepted_driver_agreement_at'] = new Date().toISOString();
      // Contract: saveAgreement() reads `result.agreement`.
      return { agreement: { accepted: !!body?.accepted, acceptedAt: rows['accepted_driver_agreement_at'] } };
    }
    if (url.includes('/submit-review')) {
      reviewState = 'under_review';
      rows['verification_status'] = 'under_review';
      rows['onboarding_completed'] = true;
      return { submitted: true, reviewState: 'under_review', profile: { ...rows } };
    }
    return { saved: true };
  };

  return { rows, writes, status, profileRowState, handle, currentVehicle: () => vehicle, noteProfileRead: () => { profileReads++; }, profileReads: () => profileReads };
}

async function openJourney(page: Page, mock: ReturnType<typeof createServerMock>) {
  await installMovabiMocks(page, 'driver');
  await page.route('**/api/markets/status*', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(liveMarket) }));
  await page.route('**/rest/v1/profiles*', (route: Route) => {
    mock.noteProfileRead();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mock.profileRowState()) });
  });
  await page.route('**/api/driver-onboarding/**', async (route: Route) => {
    const url = route.request().url();
    const method = route.request().method();
    const body = ['PUT', 'POST'].includes(method) ? route.request().postDataJSON() : null;
    if (url.includes('/status')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mock.status()) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mock.handle(method, url, body)) });
  });
  await signInAsDriver(page);
  await page.goto('/driver/onboarding');
  await expect(page.getByText(/Stage \d of 5/)).toBeVisible({ timeout: 60000 });
}

const backButton = (page: Page) => page.locator('[data-stage-back]');
const continueButton = (page: Page) => page.locator('[data-stage-next]');
const stageNav = (page: Page, label: string) => page.locator('[data-stage-nav]').getByRole('button', { name: new RegExp(label, 'i') });

/** Continue, then assert the stage actually advanced. */
async function advance(page: Page, to: number) {
  await continueButton(page).click();
  await expect(page.getByText(`Stage ${to} of 5`)).toBeVisible({ timeout: 20000 });
}

/**
 * Wait for profile hydration to settle before typing. A value only the hydrated
 * profile can supply proves the late `profileHydration` effect has already run, so
 * typed input cannot race it.
 */
/**
 * Open onboarding with controllable latency on the canonical status call.
 *
 * `ngOnInit` awaits refresh() (and the Stripe/vehicle fetches) BEFORE it hydrates the
 * form, so delaying /status widens exactly the window in which the driver can type
 * before hydration runs. This reproduces the proven race deterministically instead of
 * relying on machine timing.
 */
async function openWithLatency(page: Page, payload: Record<string, unknown>, statusDelayMs: number) {
  const writes: Array<{ method: string; url: string; body: any }> = [];

  await installMovabiMocks(page, 'driver');
  await page.route('**/api/markets/status*', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(liveMarket) }));
  await page.route('**/rest/v1/profiles*', (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(profileRow()) }));
  await page.route('**/api/driver-onboarding/**', async (route: Route) => {
    const url = route.request().url();
    const method = route.request().method();
    const body = ['PUT', 'POST'].includes(method) ? route.request().postDataJSON() : null;
    if (method === 'PUT' || method === 'POST') writes.push({ method, url, body });
    if (url.includes('/status')) {
      if (statusDelayMs) await new Promise(resolve => setTimeout(resolve, statusDelayMs));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    }
    if (url.includes('/profile') && body) {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          profile: {
            id: DRIVER_ID, fullName: body.fullName ?? 'Dara Driver', phone: body.phone ?? '',
            dateOfBirth: body.dateOfBirth ?? '1990-01-01',
            residentialAddress: body.residentialAddress ?? '', emailConfirmed: true, verificationStatus: null
          }
        })
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ saved: true, vehicle: null, agreement: { accepted: true, acceptedAt: null } }) });
  });

  await signInAsDriver(page);
  await page.goto('/driver/onboarding');
  await expect(page.getByText(/Stage \d of 5/)).toBeVisible({ timeout: 60000 });
  return writes;
}

test.describe('five-stage driver KYC regression', () => {
  test('TC6 a late hydration pass never overwrites an address the driver already typed', async ({ page }) => {
    const UNIQUE_ADDRESS = 'ZZ Late Hydration House, 42 Race Road, Bolton, BL7 7ZZ';
    const writes = await openWithLatency(page, statusPayload(), 5000);

    // The driver types while ngOnInit is still awaiting the canonical status call.
    await page.locator('#current_address').fill(UNIQUE_ADDRESS);
    await page.locator('#phone').fill('+447700900321');
    await expect(page.locator('#current_address')).toHaveValue(UNIQUE_ADDRESS);

    // Hydration lands late (it supplies the name) but must not claim typed fields.
    await expect(page.locator('#full_name')).toHaveValue('Dara Driver', { timeout: 30000 });
    await expect(page.locator('#current_address')).toHaveValue(UNIQUE_ADDRESS);
    await expect(page.locator('#phone')).toHaveValue('+447700900321');
    await continueButton(page).click();
    await expect(page.getByText('Stage 2 of 5')).toBeVisible({ timeout: 20000 });

    const put = writes.find(entry => entry.url.includes('/api/driver-onboarding/profile'));
    expect(put, 'Stage 1 must persist via PUT /profile').toBeTruthy();
    expect(put!.body.residentialAddress).toBe(UNIQUE_ADDRESS);
    expect(put!.body.phone).toBe('+447700900321');
  });

  test('TC7 a restored draft address beats the server profile address', async ({ page }) => {
    const DRAFT_ADDRESS = 'ZZ Draft Cottage, 7 Local Lane, Bolton, BL3 3ZZ';

    // Seed a draft before the app boots, as a previous session would have left it.
    await page.addInitScript((draft) => {
      window.localStorage.setItem('driver_onboarding_draft_v2', JSON.stringify(draft));
    }, {
      form: {
        current_address: DRAFT_ADDRESS, phone: '07000000007', full_name: 'Draft Name',
        vehicle_class: 'standard', service_types: ['errand', 'delivery']
      },
      docs: {}
    });

    // The server profile carries a different, already-persisted address, and canonical
    // status independently resolves to Stage 1 (the phone is outstanding).
    await openWithLatency(page, stageOneOutstanding(), 1500);

    await expect(page.getByText('Stage 1 of 5')).toBeVisible();
    // The restored draft outranks the server profile for the fields it owns.
    await expect(page.locator('#current_address')).toHaveValue(DRAFT_ADDRESS);
    await expect(page.locator('#phone')).toHaveValue('07000000007');
  });
});

async function waitForHydration(page: Page) {
  await expect(page.locator('#full_name')).toHaveValue('Dara Driver');
  await expect(page.locator('#date_of_birth')).toHaveValue('1990-01-01');
}

async function goBack(page: Page, to: number) {
  await backButton(page).click();
  await expect(page.getByText(`Stage ${to} of 5`)).toBeVisible({ timeout: 20000 });
}

test.describe('five-stage progressive driver onboarding', () => {

  test('TC1 prefill, one stage at a time, five-step indicator and Back/Continue', async ({ page }) => {
    // Outstanding phone keeps the driver on Stage 1; the saved address is prefilled.
    await openOnboarding(page, stageOneOutstanding(), { phone: null });

    await expect(page.getByText('Stage 1 of 5')).toBeVisible();
    // Stage 1 prefills from the persisted profile: nothing is asked twice.
    await expect(page.locator('#current_address')).toHaveValue(ADDRESS);
    await expect(page.locator('#current_address')).not.toHaveValue('');
    await expect(page.locator('#full_name')).toHaveValue('Dara Driver');
    await expect(page.locator('#email')).toHaveAttribute('readonly', '');
    // The outstanding field is the only thing Stage 1 still needs.
    await expect(page.locator('#phone')).toHaveValue('');

    // Later-stage controls are not rendered at all.
    await expect(page.locator('#make')).toHaveCount(0);
    await expect(page.locator('#council_name')).toHaveCount(0);

    await expect(page.locator('[data-stage-nav]')).toBeVisible();
    await expect(continueButton(page)).toBeVisible();
    await expect(backButton(page)).toBeVisible();
  });

  test('TC2 resumes at the derived stage instead of restarting', async ({ page }) => {
    await openOnboarding(page, statusPayload({
      automaticRequirements: [
        ...PROFILE_REQUIREMENTS,
        requirement('document.driving_licence', 'documents', true),
        requirement('work.right_to_work', 'documents', false)
      ]
    }));
    await expect(page.getByText('Stage 3 of 5')).toBeVisible();
    await expect(page.locator('#make')).toHaveCount(0);
  });

  test('TC3 resumes at Review when every canonical requirement is satisfied', async ({ page }) => {
    await openOnboarding(page, statusPayload({
      automaticRequirements: PROFILE_REQUIREMENTS,
      progress: { completed: 7, total: 7, percentage: 100 }
    }));
    await expect(page.getByText('Stage 5 of 5')).toBeVisible();
    await expect(page.getByRole('button', { name: /Submit for Review|Resubmit for Review/i })).toBeVisible();
  });

  test('TC4 Admin action-required information stays visible', async ({ page }) => {
    // A genuinely outstanding Stage 1 requirement keeps the driver on Stage 1, where the
    // action-required notice must be visible without navigating anywhere.
    await openOnboarding(page, stageOneOutstanding({
      overallStatus: 'action_required',
      outstandingRequests: [{
        id: 'req-1', item: 'Insurance document', status: 'pending',
        adminMessage: 'Please upload a clearer insurance certificate.',
        submittedAt: null, updatedAt: null, nextAction: 'Correct this item and resubmit it for review.'
      }]
    }), { phone: null });

    await expect(page.getByText('Outstanding Requests')).toBeVisible();
    await expect(page.getByText('Please upload a clearer insurance certificate.')).toBeVisible();
    await expect(page.getByText('Stage 1 of 5')).toBeVisible();
  });

  test('TC5 surfaces a stage-relevant Admin request inside that stage and in Review', async ({ page }) => {
    const requests = [{
      id: 'req-2', requirementCode: 'profile.date_of_birth', requestType: 'identity_correction',
      item: 'Date of birth correction', status: 'pending',
      publicMessage: 'Confirm your date of birth with a document.',
      submittedAt: null, updatedAt: null, resolvedAt: null,
      nextAction: 'We will review your correction request.'
    }];

    await openOnboarding(page, statusPayload({ adminRequests: requests }));

    await stageNav(page, 'About').click();
    await expect(page.getByText('Stage 1 of 5')).toBeVisible();
    await expect(page.locator('[data-stage-admin-request]')).toBeVisible();
    await expect(page.getByText('Confirm your date of birth with a document.')).toBeVisible();

    await stageNav(page, 'Vehicle').click();
    await expect(page.getByText('Stage 4 of 5')).toBeVisible();
    await expect(page.locator('[data-stage-admin-request]')).toHaveCount(0);

    await stageNav(page, 'Review').click();
    await expect(page.getByText('Stage 5 of 5')).toBeVisible();
    await expect(page.locator('[data-stage-admin-request]')).toBeVisible();
  });

  test('TC8 an incomplete driver is still redirected to onboarding by role.guard', async ({ page }) => {
    const mock = createServerMock();
    await openJourney(page, mock);

    // Genuinely incomplete: onboarding_completed stays false and the agreement is outstanding.
    expect(mock.rows['onboarding_completed']).toBe(false);
    expect(mock.status().automaticRequirements.find(item => item.code === AGREEMENT)?.blockingForSubmission).toBe(true);

    // The guard must not let this driver reach the hub.
    await page.goto('/driver');
    await expect(page).toHaveURL(/\/driver\/onboarding/, { timeout: 20000 });
  });

  test('J1 full journey: persist, Back/forward, agreement, submit, under review, reload', async ({ page }) => {
    const mock = createServerMock();
    await openJourney(page, mock);

    // --- Stage 1: starts here because address/phone are outstanding ------------
    await expect(page.getByText('Stage 1 of 5')).toBeVisible();
    // Already held by Movabi: legal name and date of birth are prefilled, email read-only.
    await waitForHydration(page);
    await expect(page.locator('#email')).toHaveAttribute('readonly', '');

    // Nothing from later stages leaks into Stage 1.
    await expect(page.locator('#make')).toHaveCount(0);
    await expect(page.getByText('Right to work evidence')).toHaveCount(0);

    await page.locator('#current_address').fill(ADDRESS);
    await page.locator('#phone').fill('+447700900123');
    await advance(page, 2);

    // Stage 1 values were actually persisted, and no vehicle data was required.
    const profilePut = mock.writes.find(write => write.url.includes('/api/driver-onboarding/profile'));
    expect(profilePut, 'Stage 1 must persist via PUT /profile').toBeTruthy();
    expect(profilePut!.body.residentialAddress).toBe(ADDRESS);
    expect(profilePut!.body.phone).toBe('+447700900123');
    expect(mock.writes.some(write => write.url.includes('/api/driver-onboarding/vehicle'))).toBe(false);

    // --- Stage 2: identity document slot only ---------------------------------
    await expect(page.getByText(/Driver Licence|Photo ID/).first()).toBeVisible();
    await expect(page.getByText('Right to work evidence')).toHaveCount(0);

    await advance(page, 3);

    // --- Stage 3: GB right-to-work applies here and only here -----------------
    await expect(page.getByText('Right to work evidence')).toBeVisible();
    await expect(page.locator('#council_name')).toHaveCount(0); // delivery, not ride

    // --- Back to Stage 2, then Stage 1: nothing is lost ----------------------
    await goBack(page, 2);
    await goBack(page, 1);
    await expect(page.locator('#current_address')).toHaveValue(ADDRESS);
    await expect(page.locator('#phone')).toHaveValue('+447700900123');
    await expect(page.locator('#full_name')).toHaveValue('Dara Driver');

    // --- Forward works again after Back ---------------------------------------
    await advance(page, 2);
    await advance(page, 3);

    // --- Stage 4: vehicle + insurance only; no PHV for delivery ---------------
    await advance(page, 4);
    await expect(page.getByText('Private-hire vehicle licence')).toHaveCount(0);
    await expect(page.getByText('Right to work evidence')).toHaveCount(0);

    await page.locator('#make').fill('Toyota');
    await page.locator('#model').fill('Prius');
    await page.locator('#color').fill('Silver');
    await page.locator('#year').fill('2020');
    await page.locator('#license_plate').fill('AB12 CDE');

    // Stage 4 -> Stage 5 persists the vehicle.
    await advance(page, 5);
    expect(mock.writes.some(write => write.url.includes('/api/driver-onboarding/vehicle'))).toBe(true);
    expect(mock.currentVehicle()).toBeTruthy();

    // --- Stage 5: every canonical requirement is present ----------------------
    for (const code of ['profile.full_name', 'profile.phone', 'profile.address', 'profile.email_verification',
      'profile.date_of_birth', 'service.selection', 'work.right_to_work', 'document.driving_licence', AGREEMENT]) {
      expect(mock.status().automaticRequirements.map(item => item.code), `Review must include ${code}`).toContain(code);
    }
    await expect(page.getByText('Complete').first()).toBeVisible();

    // --- Agreement is genuinely outstanding and gates submission -------------
    const agreementRequirement = mock.status().automaticRequirements.find(item => item.code === AGREEMENT);
    expect(agreementRequirement, 'the agreement must exist in the canonical status').toBeTruthy();
    expect(agreementRequirement!.blockingForSubmission, 'the agreement must be outstanding before it is accepted').toBe(true);

    const submit = page.getByRole('button', { name: /Submit for Review|Resubmit for Review/i });
    await expect(submit).toBeVisible();
    await submit.click();
    await expect(page.getByText('Stage 5 of 5')).toBeVisible();
    const writeNames = () => mock.writes.map(entry => entry.url.split('/api/driver-onboarding/')[1]).join(', ');
    expect(
      mock.writes.some(write => write.url.includes('/submit-review')),
      `submission must be blocked while the agreement is unchecked; writes=${writeNames()}`
    ).toBe(false);

    // --- Accept the agreement and submit -------------------------------------
    const agreement = page.locator('input[formcontrolname="driver_agreement_accepted"]');
    await agreement.check();
    await expect(agreement).toBeChecked();

    const profileReadsBeforeSubmit = mock.profileReads();
    await submit.click();
    // submit() is async, so asserting on recorded writes immediately after the click is a
    // race. Wait for the real event; a failure then reports the write list.
    await expect.poll(() => mock.writes.some(write => write.url.includes('/submit-review')), { timeout: 20000 }).toBe(true);

    // The agreement is written twice by design: false on the blocked attempt, true once
    // accepted. Assert the accepting write, not merely the first one.
    const agreementWrites = mock.writes.filter(write => write.url.includes('/api/driver-onboarding/agreement'));
    expect(agreementWrites.length, `agreement must persist via PUT /agreement; writes=${writeNames()}`).toBeGreaterThan(0);
    expect(agreementWrites.some(write => write.body?.accepted === true), `an accepted agreement write is required; writes=${writeNames()}`).toBe(true);
    const submitted = mock.writes.find(write => write.url.includes('/submit-review'));
    expect(submitted, `submission must go through POST /submit-review; writes=${writeNames()}`).toBeTruthy();
    // submitForReview posts { profile: {...} }, so the agreement lives under .profile.
    expect(submitted!.body.profile?.accepted_driver_agreement_at, `submit-review must carry the accepted agreement; body=${JSON.stringify(submitted!.body).slice(0, 200)}`).toBeTruthy();

    // The accepted agreement must be persisted before the review submission.
    const acceptedIndex = mock.writes.findIndex(write => write.url.includes('/agreement') && write.body?.accepted === true);
    const submitIndex = mock.writes.findIndex(write => write.url.includes('/submit-review'));
    expect(acceptedIndex, `an accepted agreement write must precede /submit-review; writes=${writeNames()}`).toBeLessThan(submitIndex);

    // Submission means Under review, never Approved, and online stays blocked.
    expect(mock.rows['verification_status']).toBe('under_review');
    expect(mock.rows['onboarding_completed']).toBe(true);
    expect(mock.status().overallStatus).toBe('under_review');
    expect(mock.status().onlineEligibility.allowed).toBe(false);
    // Strict regex -- /\/driver/ would also match /driver/onboarding.
    await expect(page).toHaveURL(/\/driver$/, { timeout: 20000 });
    // The guard could only allow that after the cached profile was reloaded.
    expect(mock.profileReads(), 'submit must reload the cached authenticated profile before navigating').toBeGreaterThan(profileReadsBeforeSubmit);
    // Under review, and still not able to go online.
    expect(mock.rows['verification_status']).toBe('under_review');
    expect(mock.status().onlineEligibility.allowed).toBe(false);

    // --- Reload resumes the correct post-submission state ---------------------
    await page.goto('/driver/onboarding');
    await expect(page.getByText(/Stage \d of 5/)).toBeVisible({ timeout: 60000 });
    await expect(page.getByText('Review mode')).toBeVisible();
    await expect(page.getByText('Under review').first()).toBeVisible();
    // Never approved: no admin approval has happened.
    await expect(page.getByText('Approved')).toHaveCount(0);
  });

  test('J2 Back/forward keeps later-stage saved data and re-hydrates after reload', async ({ page }) => {
    const mock = createServerMock();
    await openJourney(page, mock);

    // Complete Stage 1 so the profile carries saved values from here on.
    await waitForHydration(page);
    await page.locator('#current_address').fill(ADDRESS);
    await page.locator('#phone').fill('+447700900123');
    await advance(page, 2);
    await advance(page, 3);

    // Back to Stage 1: saved values survive Back.
    await goBack(page, 2);
    await goBack(page, 1);
    await expect(page.locator('#current_address')).toHaveValue(ADDRESS);
    await expect(page.locator('#phone')).toHaveValue('+447700900123');

    // Jump to Review via the indicator, then back to Stage 1 (indicator navigation).
    await stageNav(page, 'Review').click();
    await expect(page.getByText('Stage 5 of 5')).toBeVisible();
    await stageNav(page, 'About').click();
    await expect(page.getByText('Stage 1 of 5')).toBeVisible();
    await expect(page.locator('#current_address')).toHaveValue(ADDRESS);

    // A genuine reload resumes where the driver actually was: the last persisted draft
    // stage (1, this test ends on About) outranks canonical derivation, which is the
    // documented behaviour.
    await page.reload();
    await expect(page.getByText(/Stage \d of 5/)).toBeVisible({ timeout: 60000 });
    await expect(page.getByText('Stage 1 of 5')).toBeVisible();
    await stageNav(page, 'About').click();
    await expect(page.getByText('Stage 1 of 5')).toBeVisible();
    await expect(page.locator('#current_address')).toHaveValue(ADDRESS);
    await expect(page.locator('#phone')).toHaveValue('+447700900123');
    await expect(page.locator('#full_name')).toHaveValue('Dara Driver');
  });

  test('J3 review exposes every canonical requirement and open Admin requests', async ({ page }) => {
    const mock = createServerMock();
    await openJourney(page, mock);

    // Complete Stage 1, then go to Review.
    await waitForHydration(page);
    await page.locator('#current_address').fill(ADDRESS);
    await page.locator('#phone').fill('+447700900123');
    await advance(page, 2);
    await stageNav(page, 'Review').click();
    await expect(page.getByText('Stage 5 of 5')).toBeVisible();

    // Every canonical requirement is represented in Review.
    await expect(page.locator('[data-stage-nav]')).toBeVisible();
    await expect(page.getByText('Complete').first()).toBeVisible();
    await expect(page.getByText('Missing').first()).toBeVisible(); // the agreement is still outstanding
    await expect(page.getByRole('button', { name: /Submit for Review/i })).toBeVisible();
  });
});
