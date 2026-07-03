import { Injectable, inject, signal } from '@angular/core';
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
    private webPushSkipped = false;
    private loggedInUserId: string | null = null;
    private subscriptionObserverAttached = false;

    readonly appId = ONESIGNAL_APP_ID;
    readonly platform = Capacitor.getPlatform();
    readonly diagnostics = signal({
        platform: this.platform,
        oneSignalUserId: '',
        subscriptionId: '',
        permissionStatus: 'unknown',
        tokenSaved: false,
        lastPushAttempt: ''
    });

    async init(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;

        try {
            if (this.isNativePlatform()) {
                await this.initNative();
                return;
            }

            if (!this.shouldInitWebPush()) {
                this.webPushSkipped = true;
                console.info('[OneSignal] Web push skipped: unsupported local/dev origin');
                return;
            }

            await this.initWeb();
        } catch (error) {
            console.warn('[OneSignal] init skipped/failed safely', error);
        }
    }

    async login(userId: string): Promise<void> {
        if (!userId) return;

        await this.init();
        this.loggedInUserId = userId;

        const oneSignal = await this.getOneSignal().catch(() => null);
        if (!oneSignal) return;

        try {
            if (typeof oneSignal.login === 'function') {
                await oneSignal.login(userId);
            } else if (typeof oneSignal.setExternalUserId === 'function') {
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
        if (!oneSignal) return;

        try {
            if (typeof oneSignal.logout === 'function') {
                await oneSignal.logout();
            } else if (typeof oneSignal.removeExternalUserId === 'function') {
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
        if (!oneSignal) return;

        try {
            if (typeof oneSignal.User?.addTags === 'function') {
                oneSignal.User.addTags(cleanTags);
            } else if (typeof oneSignal.sendTags === 'function') {
                await oneSignal.sendTags(cleanTags);
            }
        } catch (error) {
            console.warn('[OneSignal] tag update failed', error);
        }
    }

    async requestPermission(): Promise<boolean> {
        await this.init();

        const oneSignal = await this.getOneSignal().catch(() => null);

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
        if (!oneSignal) {
            console.warn('[OneSignal] getSubscriptionId: OneSignal instance not available');
            return null;
        }

        try {
            console.log('[OneSignal] Getting subscription ID, checking multiple paths...');
            
            const subscription = oneSignal?.User?.PushSubscription || oneSignal?.User?.pushSubscription;
            console.log('[OneSignal] Subscription object found:', !!subscription);
            
            let id = '';
            
            // Try direct ID property
            if (subscription?.id) {
                id = subscription.id;
                console.log('[OneSignal] Found subscription ID via direct property:', id);
            }
            
            // Try getId method
            if (!id && typeof subscription?.getId === 'function') {
                id = await subscription.getId();
                console.log('[OneSignal] Found subscription ID via getId():', id);
            }
            
            // Try getUserId as fallback
            if (!id && typeof oneSignal?.getUserId === 'function') {
                id = await oneSignal.getUserId();
                console.log('[OneSignal] Using getUserId as fallback:', id);
            }

            const value = String(id || '').trim();
            const finalId = value && !value.startsWith('local-') ? value : null;
            
            if (finalId) {
                console.log('[OneSignal] Subscription ID retrieved successfully:', {
                    subscriptionId: finalId,
                    platform: this.platform,
                    userId: this.loggedInUserId
                });
                return finalId;
            } else {
                console.warn('[OneSignal] No valid subscription ID found - user may not have granted permission');
                return null;
            }
        } catch (error) {
            console.error('[OneSignal] getSubscriptionId failed:', error);
            return null;
        }
    }

    async getDiagnostics(): Promise<ReturnType<OneSignalService['diagnostics']>> {
        await this.init();
        const oneSignal = await this.getOneSignal().catch(() => null);
        const subscriptionId = await this.getSubscriptionId();
        let oneSignalUserId = '';
        let permissionStatus = 'unknown';

        try {
            oneSignalUserId = String(
                oneSignal?.User?.onesignalId ||
                oneSignal?.User?.id ||
                (typeof oneSignal?.getUserId === 'function' ? await oneSignal.getUserId() : '') ||
                ''
            );
        } catch { }

        try {
            permissionStatus = String(
                oneSignal?.Notifications?.permissionNative ||
                oneSignal?.Notifications?.permission ||
                (typeof oneSignal?.getNotificationPermission === 'function' ? await oneSignal.getNotificationPermission() : '') ||
                'unknown'
            );
        } catch { }

        const snapshot = {
            platform: this.platform,
            oneSignalUserId,
            subscriptionId: subscriptionId || '',
            permissionStatus,
            tokenSaved: localStorage.getItem(REGISTRATION_CONFIRMED_KEY) === 'true',
            lastPushAttempt: localStorage.getItem('movabi_last_push_attempt') || ''
        };

        if (this.isNativePlatform() && !subscriptionId) {
            console.warn('[OneSignal] no native push subscription yet');
        }

        this.diagnostics.set(snapshot);
        return snapshot;
    }

    async showLocalStatusNotification(title: string, body: string, data?: Record<string, unknown>): Promise<void> {
        localStorage.setItem('movabi_last_push_attempt', new Date().toISOString());
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
        const oneSignal = await this.getOneSignal().catch(() => null);

        if (!oneSignal) {
            console.warn('[OneSignal] native plugin not available; native push skipped');
            return;
        }

        try {
            if (typeof oneSignal.initialize === 'function') {
                oneSignal.initialize(ONESIGNAL_APP_ID);
            } else if (typeof oneSignal.setAppId === 'function') {
                oneSignal.setAppId(ONESIGNAL_APP_ID);
            } else {
                console.warn('[OneSignal] native plugin found but no initialize method exists');
                return;
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
            try {
                if (typeof oneSignal?.init === 'function') {
                    await oneSignal.init({
                        appId: ONESIGNAL_APP_ID,
                        serviceWorkerParam: { scope: '/' },
                        serviceWorkerPath: 'OneSignalSDKWorker.js'
                    });
                }

                this.attachSubscriptionObserver(oneSignal);
                await this.evaluateSubscription();
            } catch (error) {
                console.warn('[OneSignal] web init failed safely', error);
            }
        });
    }

    private async loadWebSdk(): Promise<void> {
        if (window.OneSignal) return;
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
        if (this.webPushSkipped) return null;

        if (this.isNativePlatform()) {
            return window.plugins?.OneSignal || window.OneSignal || null;
        }

        if (window.OneSignal) return window.OneSignal;

        if (!this.shouldInitWebPush()) return null;

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
        if (!subscriptionId) {
            if (this.isNativePlatform()) console.warn('[OneSignal] no native push subscription yet');
            return;
        }
        if (!this.loggedInUserId) return;

        console.log('[OneSignal] push subscription ready:', subscriptionId);

        if (localStorage.getItem(REGISTRATION_CONFIRMED_KEY) !== 'true') {
            localStorage.setItem(REGISTRATION_CONFIRMED_KEY, 'true');
        }

        await this.saveSubscription(subscriptionId);
        await this.getDiagnostics().catch(() => undefined);
    }

    private async saveSubscription(subscriptionId: string): Promise<void> {
        if (!this.loggedInUserId || !subscriptionId) {
            console.warn('[OneSignal] Cannot save subscription - missing userId or subscriptionId', {
                userId: this.loggedInUserId,
                subscriptionId: !!subscriptionId
            });
            return;
        }

        console.log('[OneSignal] Saving push subscription:', {
            userId: this.loggedInUserId,
            subscriptionId,
            platform: this.platform,
            timestamp: new Date().toISOString()
        });

        const now = new Date().toISOString();

        const { error, data } = await this.supabase
            .from('device_push_tokens')
            .upsert(
                {
                    user_id: this.loggedInUserId,
                    token: subscriptionId,
                    provider: 'onesignal',
                    subscription_id: subscriptionId,
                    external_id: this.loggedInUserId,
                    platform: this.platform,
                    enabled: true,
                    last_seen_at: now,
                    updated_at: now
                },
                { onConflict: 'token' }
            )
            .select()
            .single();

        if (error) {
            console.error('[OneSignal] Failed to save subscription to database:', {
                error: error.message,
                code: error.code,
                details: error.details,
                userId: this.loggedInUserId,
                subscriptionId
            });
        } else {
            console.log('[OneSignal] Subscription saved successfully:', {
                subscriptionId,
                userId: this.loggedInUserId,
                platform: this.platform,
                dbRecord: data
            });
        }
    }

    private isNativePlatform(): boolean {
        return Capacitor.isNativePlatform();
    }

    private shouldInitWebPush(): boolean {
        if (this.isNativePlatform()) return false;

        const host = window.location.hostname;
        const protocol = window.location.protocol;

        const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0'];

        return protocol === 'https:' && !blockedHosts.includes(host);
    }
}
