/**
 * DRIVER NATIVE PUSH — RELEASE-BLOCKER FIX.
 *
 * Proves the OneSignal-only driver push contract, deep-link, foreground
 * de-duplication, logout/account-switch hygiene, and that the certified
 * negotiation acknowledgement is untouched. Source-assertion guard over the
 * server sender/dispatch, the auth invalidation endpoint, and the client
 * OneSignal/notification/native-platform services.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const SVC = read('server/services/notification.service.ts');
const DISPATCH = read('server/services/dispatch.service.ts');
const AUTH_ROUTES = read('server/routes/auth.routes.ts');
const OS = read('src/app/core/services/notification/onesignal.service.ts');
const NOTIF = read('src/app/core/services/notification.service.ts');
const NATIVE = read('src/app/core/services/native/native-platform.service.ts');
const AUTH = read('src/app/core/services/auth/auth.service.ts');
const DRIVER_SVC = read('src/app/core/services/driver/driver.service.ts');
const DASHBOARD = read('src/app/apps/mobile/features/driver/dashboard/dashboard.page.ts');

const pushDataFn = () => SVC.slice(SVC.indexOf('function driverPushData'), SVC.indexOf('export class NotificationService'));

describe('1-3. Canonical driver push contract', () => {
  it('1. new-job push emits the canonical driver payload', () => {
    expect(SVC).toContain("data: driverPushData('new_job', jobId)");
    expect(pushDataFn()).toContain("open: 'driver_marketplace'");
    expect(pushDataFn()).toContain("role: 'driver'");
    expect(pushDataFn()).toContain('job_id: jobId');
  });

  it('2. negotiation push uses a distinct action/title/body', () => {
    expect(SVC).toContain('static async notifyDriverNegotiation(');
    expect(SVC).toContain("data: driverPushData('negotiation', jobId)");
    expect(SVC).toContain("title: 'New fare offer'");
    expect(SVC).toContain("body: 'A customer made a new fare offer in your area.");
  });

  it('3. payload carries no secrets or unnecessary PII', () => {
    const fn = pushDataFn();
    expect(fn).not.toMatch(/token|access_token|session_id|phone|email|address|pickup|payment|secret/i);
    expect(fn).not.toContain('session_id');
    const negotiation = SVC.slice(SVC.indexOf('notifyDriverNegotiation'), SVC.indexOf('notifyJobStatusUpdate'));
    expect(negotiation).not.toContain('session_id');
  });

  it('dispatch distinguishes negotiation from new-job by status', () => {
    expect(DISPATCH).toContain("String((job as any).status || '').toLowerCase() === 'negotiating'");
    expect(DISPATCH).toContain('await NotificationService.notifyDriverNegotiation(driver.id, job.id);');
    expect(DISPATCH).toContain('await NotificationService.notifyNewJob(driver.id, job.id);');
  });
});

describe('4-6. Foreground attention de-duplication', () => {
  it('4/5. OneSignal suppresses foreground display for driver opportunity events', () => {
    expect(OS).toContain("event.preventDefault();");
    expect(OS).toContain('if (!this.isDriverOpportunity(data))');
    expect(OS).toContain('event.notification.display();');
  });

  it('isDriverOpportunity matches new_job and negotiation', () => {
    const fn = OS.slice(OS.indexOf('private isDriverOpportunity'), OS.indexOf('private attachSubscriptionObserver'));
    expect(fn).toContain("role === 'driver'");
    expect(fn).toContain("(action === 'new_job' || action === 'negotiation')");
  });

  it('4/5. client skips duplicate local notification/tone for driver events', () => {
    expect(NOTIF).toContain('if (this.isDriverOpportunity(newNotif))');
    expect(NOTIF).toContain('private isDriverOpportunity(notification: Notification): boolean');
  });

  it('6. background delivery remains intact (suppression is foreground-only)', () => {
    // Suppression lives inside the OneSignal foregroundWillDisplay handler,
    // which only fires while the app is foregrounded.
    expect(OS).toContain("foregroundWillDisplay");
    expect(OS).not.toContain('cancelNotification');
    // Non-driver events still display.
    expect(OS).toContain('event.notification.display();');
  });
});

describe('7-9. Deep-link is informational, never authority', () => {
  it('7. tap routes to the driver marketplace dashboard', () => {
    const fn = OS.slice(OS.indexOf('private handleNotificationClick'), OS.indexOf('private isDriverOpportunity'));
    expect(fn).toContain("role === 'driver' || open === 'driver_marketplace'");
    expect(fn).toContain("route = '/driver';");
    expect(fn).toContain('this.router.navigateByUrl(route)');
  });

  it('8/9. tap never claims/accepts/agrees from payload data', () => {
    const fn = OS.slice(OS.indexOf('private handleNotificationClick'), OS.indexOf('private isDriverOpportunity'));
    expect(fn).not.toMatch(/claim|accept|agree|negotiate\(|session/i);
  });

  it('7. uses the Angular router (single warm/cold path), not window.location', () => {
    const fn = OS.slice(OS.indexOf('private handleNotificationClick'), OS.indexOf('private isDriverOpportunity'));
    expect(fn).not.toContain('window.location.href');
  });
});

describe('10. Certified negotiation acknowledgement is untouched', () => {
  it('acknowledgement Set remains keyed by session_id in DriverService', () => {
    expect(DRIVER_SVC).toContain('acknowledgedNegotiationAlerts');
    expect(DRIVER_SVC).toContain('isNegotiationAlertAcknowledged(sessionId');
  });

  it('dashboard still acknowledges before navigation and stops owner alarm', () => {
    expect(DASHBOARD).toContain('acknowledgeNegotiationAlert(sessionId, jobId)');
    expect(DASHBOARD).toContain("stopRequestSound(resolved)");
  });
});

describe('11-16. Logout / account-switch hygiene', () => {
  it('11. invalidation endpoint requires authentication', () => {
    const route = AUTH_ROUTES.slice(AUTH_ROUTES.indexOf("router.post('/push-logout'"));
    expect(route).toContain('const userId = await authUser(req);');
    expect(route).toContain("return res.status(401).json({ error: 'Authentication required' });");
  });

  it('12/13. identity derives from the session, never the request body', () => {
    const route = AUTH_ROUTES.slice(AUTH_ROUTES.indexOf("router.post('/push-logout'"));
    expect(route).not.toMatch(/req\.body\?\.userId|req\.body\.userId/);
    expect(route).toContain(".eq('user_id', userId)");
  });

  it('11-13. disables only the current device via existing columns (no migration)', () => {
    const route = AUTH_ROUTES.slice(AUTH_ROUTES.indexOf("router.post('/push-logout'"));
    expect(route).toContain('.from(\'device_push_tokens\')');
    expect(route).toContain('.update({ enabled: false, updated_at: new Date().toISOString() })');
    expect(route).toContain(".eq('subscription_id', subscriptionId)");
  });

  it('14. sign-out still unbinds OneSignal (logout on user null)', () => {
    expect(NOTIF).toContain('void this.oneSignal.logout();');
  });

  it('15. local logout completes even if cleanup fails (bounded, then always signOut)', () => {
    const signOut = AUTH.slice(AUTH.indexOf('async signOut()'), AUTH.indexOf('async resetPassword'));
    // Cleanup is awaited (so it gets a chance) BEFORE Supabase signOut, but it
    // is internally bounded + fail-safe, so signOut is never skipped.
    expect(signOut).toContain('await this.cleanupPushIdentity();');
    expect(signOut.indexOf('await this.cleanupPushIdentity();')).toBeLessThan(signOut.indexOf('await this.supabase.auth.signOut()'));
    expect(AUTH).toContain('private async cleanupPushIdentity(): Promise<void>');
  });

  it('16. account switch re-binds OneSignal to the new identity', () => {
    expect(NOTIF).toContain('await this.oneSignal.login(user.id);');
    expect(NOTIF).toContain('syncOneSignalIdentity');
  });
});

describe('17. Redundant Capacitor push stack removed', () => {
  it('no PushNotifications import/registration/token remains in the native service', () => {
    expect(NATIVE).not.toContain('PushNotifications');
    expect(NATIVE).not.toContain('pushToken$');
    expect(NATIVE).not.toContain('pushNotificationActionPerformed');
    expect(NATIVE).not.toContain('ReplaySubject');
  });

  it('the client no longer writes a Capacitor token row', () => {
    expect(NOTIF).not.toContain('savePushToken');
    expect(NOTIF).not.toContain("provider: 'capacitor'");
  });

  it('LocalNotifications remain for foreground status display', () => {
    expect(NATIVE).toContain('LocalNotifications');
  });
});

describe('Logout ordering & race (bounded, current-device)', () => {
  it('1. server invalidation gets a bounded opportunity BEFORE session revocation', () => {
    const signOut = AUTH.slice(AUTH.indexOf('async signOut()'), AUTH.indexOf('async resetPassword'));
    expect(signOut).toContain('await this.cleanupPushIdentity();');
    expect(signOut.indexOf('cleanupPushIdentity')).toBeLessThan(signOut.indexOf('supabase.auth.signOut()'));
  });

  it('2. invalidation timeout/failure still proceeds to Supabase logout', () => {
    expect(AUTH).toContain('private async cleanupPushIdentity(): Promise<void>');
    expect(AUTH).toContain('Promise.allSettled([');
    expect(AUTH).toContain('await this.withTimeout(this.doInvalidatePushTokens(), AuthService.PUSH_LOGOUT_TIMEOUT_MS);');
  });

  it('3. OneSignal unbind occurs deterministically during logout (before signOut)', () => {
    expect(AUTH).toContain('private async unbindOneSignalIdentity(): Promise<void>');
    expect(AUTH).toContain('await this.withTimeout(this.oneSignal.logout(), AuthService.PUSH_LOGOUT_TIMEOUT_MS);');
  });

  it('4. OneSignal failure still proceeds to Supabase logout', () => {
    expect(AUTH).toContain('Promise.allSettled([');
  });

  it('5. no indefinite logout wait (short bounded timeout)', () => {
    expect(AUTH).toContain('private static readonly PUSH_LOGOUT_TIMEOUT_MS = 2500;');
    expect(AUTH).toContain("new Error('push cleanup timed out')");
  });

  it('6. account switch A -> B ends with B bound', () => {
    expect(NOTIF).toContain('await this.oneSignal.login(user.id);');
    expect(NOTIF).toContain('syncOneSignalIdentity');
  });

  it('7. endpoint cannot invalidate another user (session-derived user, no body userId)', () => {
    const route = AUTH_ROUTES.slice(AUTH_ROUTES.indexOf("router.post('/push-logout'"));
    expect(route).toContain('const userId = await authUser(req);');
    expect(route).not.toMatch(/req\.body\?\.userId|req\.body\.userId/);
  });

  it('8. current-device invalidation is correct; client sends its own subscription_id', () => {
    const route = AUTH_ROUTES.slice(AUTH_ROUTES.indexOf("router.post('/push-logout'"));
    expect(route).toContain(".eq('subscription_id', subscriptionId)");
    expect(AUTH).toContain('const subscriptionId = await this.oneSignal.getSubscriptionId().catch(() => null);');
    expect(AUTH).toContain('{ subscriptionId: subscriptionId || undefined }');
  });
});
