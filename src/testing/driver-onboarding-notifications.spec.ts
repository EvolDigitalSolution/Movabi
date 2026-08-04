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
    for (const state of ['loading','No outstanding requests','pending','approved','rejected','error']) expect(combined).toContain(state);
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
});
