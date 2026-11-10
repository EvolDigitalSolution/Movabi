import {connectHarness,stripeReturnHarness} from './stripe-payout-test-harness';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const route = read('server/routes/driver-onboarding.routes.ts');
const notifications = read('server/services/driver-onboarding-notification.service.ts');
const migration = read('server/driver-onboarding-notifications-migration.txt');
const store = read('src/app/core/services/driver/driver-onboarding-status.service.ts');
const onboarding = read('src/app/apps/mobile/features/driver/onboarding/onboarding.page.ts');
const settings = read('src/app/apps/mobile/features/driver/settings.page.ts');
const connect = read('server/routes/connect.routes.ts');
const connectClient = read('src/app/core/services/stripe/connect.service.ts');
const driverService = read('src/app/core/services/driver/driver.service.ts');
const dashboard = read('src/app/apps/mobile/features/driver/dashboard/dashboard.page.ts');

describe('driver onboarding production flow', () => {
  it('supports the required mutation events', () => {
    for (const event of ['driver_registration_started','driver_onboarding_submitted','driver_vehicle_submitted','driver_vehicle_updated',
      'driver_document_uploaded','driver_document_replaced','driver_document_resubmitted','driver_stripe_connected','driver_profile_updated_for_review']) {
      expect(notifications).toContain(event);
    }
  });
  it('uses a unique outbox key and delivery states', () => {
    expect(migration).toContain('event_key varchar(180) NOT NULL UNIQUE');
    expect(migration).toContain("CHECK (status IN ('pending','processing','sent','failed'))");
    expect(notifications).toContain("insertError?.code === '23505'");
  });
  it('does not enqueue on status reads', () => {
    const statusHandler = route.slice(route.indexOf("router.get('/status'"), route.indexOf("router.post('/events'"));
    expect(statusHandler).not.toContain('NotificationService.enqueue');
  });
  it('persists before asynchronous delivery and does not expose document data', () => {
    expect(notifications).toContain('void this.deliver(data.id)');
    expect(notifications).not.toContain('document_url');
    expect(notifications).not.toContain('licence_number');
    expect(notifications).not.toContain('bank');
  });
  it('retries delivery at most three times', () => {
    expect(notifications).toContain('Number(row.attempt_count) >= 3');
    expect(notifications).toContain("attempt === 1 ? 30_000 : 300_000");
  });
  it('resolves market, country, then global recipients', () => {
    expect(notifications).toContain('DRIVER_ONBOARDING_MARKET_EMAILS');
    expect(notifications).toContain('DRIVER_ONBOARDING_ADMIN_EMAILS_');
    expect(notifications).toContain('DRIVER_ONBOARDING_ADMIN_EMAILS');
  });
  it('requires JWT authentication and only returns the caller status', () => {
    expect(route).toContain('supabaseAdmin.auth.getUser(token)');
    expect(route).toContain(".eq('id', driverId)");
    expect(route).toContain("status(401)");
  });
  it('refreshes an expired token once without a retry loop', () => {
    expect(store).toContain('authenticatedGet(false)');
    expect(store).toContain('authenticatedPost(path, body, false)');
    expect(store).not.toContain('retry(');
    expect(store).not.toContain('setInterval');
  });
  it('coalesces duplicate concurrent status requests', () => {
    expect(store).toContain('if (this.inFlight) return this.inFlight');
  });
  it('records a new registration once with a deterministic key', () => {
    expect(store).toContain('registrationStartRecorded');
    expect(store).toContain('eventKey: `registration:${status.driverId}`');
    expect(onboarding).toContain('recordRegistrationStartOnce');
  });
  it('removes repeated market registration POSTs from onboarding', () => {
    expect(onboarding).not.toContain('requireDriverRegistration');
    expect(onboarding).not.toContain('driver-registration/check');
  });
  it('refreshes only on explicit lifecycle and mutation triggers', () => {
    expect(onboarding).toContain('await this.onboardingStatus.refresh()');
    expect(onboarding).toContain('pullToRefresh');
    expect(settings).toContain('pullToRefresh');
  });
  it('shows loading, empty, pending, approved, rejected and error states', () => {
    const combined = onboarding + settings + store;
    for (const state of ['loading','No information requests','pending','approved','rejected','error']) expect(combined).toContain(state);
  });
  it('preserves Stripe Connect and emits its connected transition once', () => {
    expect(connect).toContain('driver_stripe_connected');
    expect(connect).toContain("previous?.stripe_connect_status !== 'connected'");
    expect(settings).toContain('setupStripeConnect');
  });
  it('does not trust a body userId on protected Connect endpoints', () => {
    expect(connect).not.toContain("String(req.body?.userId || '').trim() || null");
  });
  it('provides the Admin onboarding deep link and review route', () => {
    expect(notifications).toContain('/admin/drivers/${encodeURIComponent(driverId)}/onboarding');
    expect(read('src/app/apps/admin/admin-web.routes.ts')).toContain("path: 'drivers/:driverId/onboarding'");
  });

  it('uses ngOnInit only for local setup and refreshes cached pages on entry', () => {
    expect(settings).toContain('async ngOnInit(): Promise<void>');
    expect(settings).toContain('async ionViewWillEnter(): Promise<void>');
    const init = settings.slice(settings.indexOf('async ngOnInit()'), settings.indexOf('async ionViewWillEnter()'));
    expect(init).toContain('this.syncPersonalDraft()');
    expect(init).not.toContain('onboardingStatus.refresh()');
  });
  it('loads vehicle, Stripe and onboarding independently once per page entry', () => {
    expect(settings).toContain('const results = await Promise.allSettled([');
    expect(settings).toContain("const labels = ['vehicle', 'stripe', 'onboarding-status'] as const");
    expect(settings).not.toContain('await Promise.all([');
  });
  it('keeps onboarding failures out of the empty state and provides Retry', () => {
    expect(settings.indexOf('@else if(onboardingStatus.error())')).toBeLessThan(settings.indexOf("No information requests. You're all caught up."));
    expect(settings).toContain("{{onboardingStatus.error() ? 'Retry' : 'Refresh'}}");
    expect(settings).toContain('[disabled]="onboardingStatus.loading()"');
  });
  it('pull-to-refresh refreshes all three Settings sections', () => {
    expect(settings).toContain('async pullToRefresh(event: CustomEvent): Promise<void> { await this.refreshPageData(true)');
  });
  it('writes safe structured status request, success and failure logs', () => {
    expect(route).toContain("console.info('[DriverOnboarding] status request'");
    expect(route).toContain("console.info('[DriverOnboarding] status success'");
    expect(route).toContain("console.error('[DriverOnboarding] status failed'");
    expect(route).toContain('outstandingRequestCount: outstandingRequests.length');
    expect(route).toContain('if(error)throw error');
    expect(route).toContain(".eq('user_id',driverId)");
  });

  it('makes one shared payout-settings call on each Driver Settings entry', () => {
    const refreshPage = settings.slice(settings.indexOf('private async refreshPageData'), settings.indexOf('async refreshOnboardingStatus'));
    expect(refreshPage.match(/fetchStripeAccount\(/g)).toHaveLength(1);
    expect(refreshPage).toContain('Promise.allSettled');
  });
  it('coalesces concurrent payout-settings callers and briefly caches success', async () => {
    const h=connectHarness();const first=h.subject.getPayoutSettings();const second=h.subject.getPayoutSettings();
    await h.drain();expect(h.pending).toHaveLength(1);
    h.pending[0].resolve({...h.value});await Promise.all([first,second]);
    expect(await h.subject.getPayoutSettings()).toEqual(h.value);expect(h.pending).toHaveLength(1);
    h.advance(10001);const expired=h.subject.getPayoutSettings();await h.drain();expect(h.pending).toHaveLength(2);
    h.pending[1].resolve({...h.value});await expired;
    expect(driverService).toContain('getPayoutSettings(force)');
  });
  it('rejects an old owner response after switching accounts', async () => {
    const h=connectHarness();const old=h.subject.getPayoutSettings();const rejected=expect(old).rejects.toThrow('Account changed');
    await h.drain();h.setOwner('driver-two');const current=h.subject.getPayoutSettings();await h.drain();
    expect(h.pending).toHaveLength(2);h.pending[0].resolve({...h.value});await rejected;
    h.pending[1].resolve({...h.value,stripeAccountId:'acct_two'});expect((await current).stripeAccountId).toBe('acct_two');
    expect((await h.subject.getPayoutSettings()).stripeAccountId).toBe('acct_two');
  });
  it('coalesces repeated forced requests and refreshes Stripe exactly once', async () => {
    const h=connectHarness();const first=h.subject.getPayoutSettings(true);const second=h.subject.getPayoutSettings(true);
    await h.drain();expect(h.pending).toHaveLength(1);h.pending[0].resolve({...h.value});
    const result=await first;expect(await second).toEqual(result);expect(result.connectStatus).toBe('connected');expect(h.refreshes()).toBe(1);
  });
  it('queues one shared forced refresh behind a pending ordinary read', async () => {
    const h=connectHarness();const ordinary=h.subject.getPayoutSettings();const forced=h.subject.getPayoutSettings(true);const repeated=h.subject.getPayoutSettings(true);
    await h.drain();expect(h.pending).toHaveLength(1);h.pending[0].resolve({...h.value});await ordinary;await h.drain();
    expect(h.pending).toHaveLength(2);h.pending[1].resolve({...h.value});await Promise.all([forced,repeated]);expect(h.refreshes()).toBe(1);
  });
  it('uses one forced payout-settings request for explicit Settings refresh', () => {
    const refresh = settings.slice(settings.indexOf('async refreshStripe()'), settings.indexOf('async onCountryChange'));
    expect(refresh.match(/fetchStripeAccount\(true\)/g)).toHaveLength(1);
    expect(refresh).not.toContain('refreshStripeStatus');
  });
  it('uses one forced request when returning from Stripe Connect', async () => {
    const stripeReturn = onboarding.slice(onboarding.indexOf('async handleStripeReturn()'), onboarding.indexOf('async upload(type'));
    expect(stripeReturn.match(/fetchStripeAccount\(true\)/g)).toHaveLength(1);
    expect(stripeReturn).not.toContain('refreshStripeStatus');
    const h=stripeReturnHarness();await h.subject.handleStripeReturn();
    expect(h.calls.filter(c=>c[0]==='fetch')).toEqual([['fetch',true]]);
    expect(h.calls.filter(c=>c[0]==='ui')).toEqual([['ui',undefined]]);
    expect(h.calls.findIndex(c=>c[0]==='fetch')).toBeLessThan(h.calls.findIndex(c=>c[0]==='ui'));
    expect(h.calls.find(c=>c[0]==='navigate')[1].queryParams.stripe).toBe(null);
  });
  it('retains a forced status refresh when the driver app resumes', () => {
    const resume=dashboard.slice(dashboard.indexOf('const resumeSubscription = this.connectService.returnedToApp.subscribe'),dashboard.indexOf('destroyRef.onDestroy(() => resumeSubscription.unsubscribe())'));
    expect(resume).toContain('this.refreshStripeUiStateFromDb(true)');
  });
  it('shows recovery feedback and clears the callback after a failed Stripe return read', async () => {
    const h=stripeReturnHarness('success',true);await h.subject.handleStripeReturn();
    expect(h.calls.filter(c=>c[0]==='fetch')).toEqual([['fetch',true]]);expect(h.calls.filter(c=>c[0]==='ui')).toHaveLength(0);
    expect(h.calls.find(c=>c[0]==='toast')[1]).toContain('Could not refresh Stripe status');
    expect(h.calls.find(c=>c[0]==='navigate')[1].queryParams.stripe).toBe(null);
  });
  it('does not fetch Stripe status without a return callback', async () => {
    const h=stripeReturnHarness(null);await h.subject.handleStripeReturn();expect(h.calls).toHaveLength(0);
  });
  it('coalesces repeated forced taps while a request is pending', () => {
    expect(connectClient.indexOf('if (this.payoutSettingsInFlight)')).toBeLessThan(connectClient.indexOf('if (!force && this.payoutSettingsCache'));
    expect(settings).toContain('if (this.loadingStripe()) return');
  });
});
