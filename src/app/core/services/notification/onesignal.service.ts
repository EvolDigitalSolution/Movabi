import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { SupabaseService } from '../supabase/supabase.service';
import { NativePlatformService } from '../native/native-platform.service';

declare global {
  interface Window {
    OneSignal?: any;
    OneSignalDeferred?: Array<(oneSignal: any) => void | Promise<void>>;
    plugins?: {
      OneSignal?: any;
    };
  }
}

const ONESIGNAL_APP_ID = '952c6d19-656c-4dab-90f3-6e253e2c9151';
const REGISTRATION_CONFIRMED_KEY = 'onesignal_registration_confirmed';

@Injectable({ providedIn: 'root' })
export class OneSignalService {
  private supabase = inject(SupabaseService);
  private nativePlatform = inject(NativePlatformService);
  private initialized = false;
  private loggedInUserId: string | null = null;
  private subscriptionObserverAttached = false;

  readonly appId = ONESIGNAL_APP_ID;
  readonly platform = Capacitor.getPlatform();

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (Capacitor.isNativePlatform()) {
      await this.initNative();
      return;
    }

    await this.initWeb();
  }

  async login(userId: string): Promise<void> {
    if (!userId) return;

    await this.init();
    this.loggedInUserId = userId;

    const oneSignal = await this.getOneSignal();

    try {
      if (typeof oneSignal?.login === 'function') {
        await oneSignal.login(userId);
      } else if (typeof oneSignal?.setExternalUserId === 'function') {
        await oneSignal.setExternalUserId(userId);
      }
    } catch (error) {
      console.warn('[OneSignal] login failed', error);
    }

    await this.setUserTags({
      platform: this.platform,
      appName: 'Movabi'
    });
    await this.evaluateSubscription();
  }

  async logout(): Promise<void> {
    this.loggedInUserId = null;

    const oneSignal = await this.getOneSignal().catch(() => null);

    try {
      if (typeof oneSignal?.logout === 'function') {
        await oneSignal.logout();
      } else if (typeof oneSignal?.removeExternalUserId === 'function') {
        await oneSignal.removeExternalUserId();
      }
    } catch (error) {
      console.warn('[OneSignal] logout failed', error);
    }
  }

  async setUserTags(tags: Record<string, string | number | boolean | null | undefined>): Promise<void> {
    const cleanTags = Object.entries(tags)
      .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
      .reduce<Record<string, string>>((result, [key, value]) => {
        result[key] = String(value);
        return result;
      }, {});

    if (!Object.keys(cleanTags).length) return;

    const oneSignal = await this.getOneSignal().catch(() => null);

    try {
      if (typeof oneSignal?.User?.addTags === 'function') {
        oneSignal.User.addTags(cleanTags);
      } else if (typeof oneSignal?.sendTags === 'function') {
        await oneSignal.sendTags(cleanTags);
      }
    } catch (error) {
      console.warn('[OneSignal] tag update failed', error);
    }
  }

  async requestPermission(): Promise<boolean> {
    await this.init();
    const oneSignal = await this.getOneSignal();

    try {
      if (typeof oneSignal?.Notifications?.requestPermission === 'function') {
        return await oneSignal.Notifications.requestPermission(true);
      }

      if (typeof oneSignal?.promptForPushNotificationsWithUserResponse === 'function') {
        return await oneSignal.promptForPushNotificationsWithUserResponse();
      }
    } catch (error) {
      console.warn('[OneSignal] permission request failed', error);
    }

    return this.nativePlatform.requestNotificationPermission();
  }

  async getSubscriptionId(): Promise<string | null> {
    const oneSignal = await this.getOneSignal().catch(() => null);

    try {
      const id =
        oneSignal?.User?.PushSubscription?.id ||
        oneSignal?.User?.pushSubscription?.id ||
        (typeof oneSignal?.User?.PushSubscription?.getId === 'function'
          ? oneSignal.User.PushSubscription.getId()
          : null) ||
        (typeof oneSignal?.User?.pushSubscription?.getId === 'function'
          ? oneSignal.User.pushSubscription.getId()
          : null) ||
        (typeof oneSignal?.getUserId === 'function'
          ? await oneSignal.getUserId()
          : null);

      const value = String(id || '').trim();
      return value && !value.startsWith('local-') ? value : null;
    } catch {
      return null;
    }
  }

  async showLocalStatusNotification(title: string, body: string, data?: Record<string, unknown>): Promise<void> {
    await this.nativePlatform.showForegroundNotification(title, body, data).catch(() => undefined);
  }

  async notifyNewJob(serviceName: string, priceLabel: string, jobId: string): Promise<void> {
    await this.showLocalStatusNotification(
      'New Movabi request',
      `${serviceName} nearby - ${priceLabel}`,
      { route: '/driver', jobId, type: 'new_job_request' }
    );
  }

  async notifyVerificationActionRequired(): Promise<void> {
    await this.showLocalStatusNotification(
      'Verification action required',
      'Your Movabi driver verification needs more information.',
      { route: '/driver/settings', type: 'driver_review_action_required' }
    );
  }

  private async initNative(): Promise<void> {
    const oneSignal = await this.getOneSignal();

    try {
      if (typeof oneSignal?.initialize === 'function') {
        oneSignal.initialize(ONESIGNAL_APP_ID);
      } else if (typeof oneSignal?.setAppId === 'function') {
        oneSignal.setAppId(ONESIGNAL_APP_ID);
      }

      this.attachSubscriptionObserver(oneSignal);
    } catch (error) {
      console.warn('[OneSignal] native init failed', error);
    }
  }

  private async initWeb(): Promise<void> {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    await this.loadWebSdk();

    window.OneSignalDeferred.push(async (oneSignal) => {
      if (typeof oneSignal?.init === 'function') {
        await oneSignal.init({
          appId: ONESIGNAL_APP_ID,
          serviceWorkerParam: { scope: '/' },
          serviceWorkerPath: 'OneSignalSDKWorker.js'
        });
      }
      this.attachSubscriptionObserver(oneSignal);
      await this.evaluateSubscription();
    });
  }

  private async loadWebSdk(): Promise<void> {
    if (document.querySelector('script[data-onesignal-sdk="true"]')) return;

    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
      script.async = true;
      script.defer = true;
      script.dataset['onesignalSdk'] = 'true';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('OneSignal Web SDK failed to load'));
      document.head.appendChild(script);
    }).catch((error) => {
      console.warn('[OneSignal] web SDK load failed', error);
    });
  }

  private async getOneSignal(): Promise<any> {
    if (Capacitor.isNativePlatform()) {
      return window.plugins?.OneSignal || window.OneSignal;
    }

    if (window.OneSignal) return window.OneSignal;

    return new Promise((resolve) => {
      window.OneSignalDeferred = window.OneSignalDeferred || [];
      window.OneSignalDeferred.push((oneSignal) => resolve(oneSignal));
      window.setTimeout(() => resolve(null), 3000);
    });
  }

  private attachSubscriptionObserver(oneSignal: any): void {
    if (this.subscriptionObserverAttached || !oneSignal) return;
    this.subscriptionObserverAttached = true;

    try {
      const subscription = oneSignal.User?.PushSubscription || oneSignal.User?.pushSubscription;

      if (typeof subscription?.addEventListener === 'function') {
        subscription.addEventListener('change', () => void this.evaluateSubscription());
      } else if (typeof oneSignal.addSubscriptionObserver === 'function') {
        oneSignal.addSubscriptionObserver(() => void this.evaluateSubscription());
      }
    } catch (error) {
      console.warn('[OneSignal] subscription observer failed', error);
    }

    void this.evaluateSubscription();
  }

  private async evaluateSubscription(): Promise<void> {
    const subscriptionId = await this.getSubscriptionId();
    if (!subscriptionId || !this.loggedInUserId) return;

    console.log('[OneSignal] push subscription ready:', subscriptionId);

    if (localStorage.getItem(REGISTRATION_CONFIRMED_KEY) !== 'true') {
      localStorage.setItem(REGISTRATION_CONFIRMED_KEY, 'true');
    }

    await this.saveSubscription(subscriptionId);
  }

  private async saveSubscription(subscriptionId: string): Promise<void> {
    if (!this.loggedInUserId || !subscriptionId) return;

    const now = new Date().toISOString();

    const { error } = await this.supabase
      .from('device_push_tokens')
      .upsert({
        user_id: this.loggedInUserId,
        token: subscriptionId,
        provider: 'onesignal',
        subscription_id: subscriptionId,
        external_id: this.loggedInUserId,
        platform: this.platform,
        enabled: true,
        last_seen_at: now,
        updated_at: now
      }, { onConflict: 'token' });

    if (error) {
      console.warn('[OneSignal] could not save subscription', error);
    }
  }
}
