import { Injectable, effect, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { RealtimeChannel } from '@supabase/supabase-js';
import { LocalNotifications } from '@capacitor/local-notifications';
import { SupabaseService } from './supabase/supabase.service';
import { AuthService } from './auth/auth.service';
import { Notification } from '../../shared/models/booking.model';
import { NativePlatformService } from './native/native-platform.service';
import { OneSignalService } from './notification/onesignal.service';

@Injectable({
  providedIn: 'root'
})
export class NotificationService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);
  private nativePlatform = inject(NativePlatformService);
  private oneSignal = inject(OneSignalService);
  private initialized = signal(false);
  private channel?: RealtimeChannel;
  private notificationPermissionRequested = false;
  private soundedNotificationKeys = new Set<string>();

  notifications = signal<Notification[]>([]);
  unreadCount = signal(0);

  constructor() {
    effect(() => {
      const user = this.auth.currentUser();
      const role = this.auth.userRole();
      if (!this.initialized()) return;

      if (user) {
        void this.fetchNotifications();
        this.subscribeToNotifications();
        void this.syncOneSignalIdentity(role);
      } else {
        this.channel?.unsubscribe();
        this.channel = undefined;
        this.notifications.set([]);
        this.unreadCount.set(0);
        void this.oneSignal.logout();
      }
    });
  }

  initialize(): void {
    if (this.initialized()) return;
    this.initialized.set(true);
    this.nativePlatform.pushToken$.subscribe(token => void this.savePushToken(token));
    void this.oneSignal.init();
  }

  async fetchNotifications() {
    const user = this.auth.currentUser();
    if (!user) return;

    const { data, error } = await this.supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    this.notifications.set(data || []);
    this.updateUnreadCount();
  }

  async markAsRead(id: string) {
    const { error } = await this.supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id);

    if (error) throw error;
    
    this.notifications.update(list => 
      list.map(n => n.id === id ? { ...n, is_read: true } : n)
    );
    this.updateUnreadCount();
  }

  private updateUnreadCount() {
    const count = this.notifications().filter(n => !n.is_read).length;
    this.unreadCount.set(count);
  }

  /**
   * Helper to create a notification (usually called from server or other services)
   */
  async notify(userId: string, title: string, body: string, type: Notification['type'] = 'system', metadata?: Record<string, unknown>) {
    const { error } = await this.supabase
      .from('notifications')
      .insert({
        user_id: userId,
        title,
        body,
        type,
        metadata
      });

    if (error) console.error('Failed to send notification:', error);
  }

  subscribeToNotifications() {
    const user = this.auth.currentUser();
    if (!user) return;

    this.channel?.unsubscribe();
    this.channel = this.supabase
      .channel(`notifications-${user.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${user.id}`
      }, payload => {
        const newNotif = payload.new as Notification;
        const routeData = this.getNotificationRouteData(newNotif);
        this.notifications.update(list => [newNotif, ...list]);
        this.updateUnreadCount();
        void this.playNotificationToneOnce(newNotif);
        void this.nativePlatform.showForegroundNotification(
          newNotif.title,
          newNotif.body,
          routeData
        );
      })
      .subscribe();
  }

  async enableNativeNotifications(): Promise<boolean> {
    return this.oneSignal.requestPermission();
  }

  private async savePushToken(token: string): Promise<void> {
    const user = this.auth.currentUser();
    if (!user || !token) return;

    const { error } = await this.supabase
      .from('device_push_tokens')
      .upsert({
        user_id: user.id,
        token,
        provider: 'capacitor',
        external_id: user.id,
        platform: Capacitor.getPlatform(),
        enabled: true,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, { onConflict: 'token' });

    if (error) console.warn('[NotificationService] Could not save push token', error);
  }

  private async syncOneSignalIdentity(role?: string | null): Promise<void> {
    const user = this.auth.currentUser();
    if (!user?.id) return;

    await this.oneSignal.login(user.id);
    await this.oneSignal.setUserTags({
      role: role || 'unknown',
      platform: Capacitor.getPlatform(),
      appName: 'Movabi'
    });
  }

  private async ensureNativeNotificationPermission(): Promise<void> {
    if (this.notificationPermissionRequested) return;
    this.notificationPermissionRequested = true;
    await this.enableNativeNotifications().catch(error => {
      console.warn('[NotificationService] Notification permission was not enabled', error);
    });
  }

  private getNotificationRouteData(notification: Notification): Record<string, unknown> {
    const data = ((notification as any).metadata || (notification as any).data || {}) as Record<string, unknown>;
    const route = (notification as any).route || data['route'];

    return {
      ...data,
      ...(route ? { route } : {})
    };
  }

  private shouldPlayTone(notification: Notification): boolean {
    const data = this.getNotificationRouteData(notification);
    const action = String(data['action'] || '').toLowerCase();
    const type = String(notification.type || '').toLowerCase();

    return (
      type === 'driver_review_action_required' ||
      type === 'booking_update' ||
      action === 'new_job' ||
      action === 'driver_review_action_required' ||
      action.includes('status')
    );
  }

  private async playNotificationToneOnce(notification: Notification): Promise<void> {
    if (!this.shouldPlayTone(notification)) return;

    const data = this.getNotificationRouteData(notification);
    const key = String(
      notification.id ||
      data['jobId'] ||
      data['job_id'] ||
      `${notification.type}:${notification.title}:${notification.created_at || notification.body}`
    );

    if (this.soundedNotificationKeys.has(key)) return;
    this.soundedNotificationKeys.add(key);

    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      const context = new AudioContextClass();
      await this.playTone(context, 880, 0.12, 0);
      await this.playTone(context, 660, 0.1, 0.14);
      window.setTimeout(() => void context.close?.(), 400);
    } catch (error) {
      console.warn('[NotificationService] Could not play notification tone', error);
    }
  }

  async showLocalNotification(title: string, body: string, data?: any): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      console.log('[NotificationService] Web platform - using in-app notification only');
      return;
    }

    try {
      // Check permissions first
      const permissionStatus = await LocalNotifications.checkPermissions();
      console.log('[NotificationService] Local notification permission status:', permissionStatus);

      if (permissionStatus.display !== 'granted') {
        const requested = await LocalNotifications.requestPermissions();
        console.log('[NotificationService] Local notification permission requested:', requested);
        
        if (requested.display !== 'granted') {
          console.warn('[NotificationService] Local notification permission denied');
          return;
        }
      }

      const notificationId = Date.now().toString();
      
      await LocalNotifications.schedule({
        notifications: [
          {
            id: parseInt(notificationId),
            title,
            body,
            extra: data || {},
            sound: 'default',
            smallIcon: 'ic_stat_movabi',
            iconColor: '#F59E0B',
            schedule: { at: new Date() }
          }
        ]
      });

      console.log('[NotificationService] Local notification scheduled:', {
        id: notificationId,
        title,
        body,
        hasData: !!data
      });
    } catch (error) {
      console.error('[NotificationService] Failed to show local notification:', error);
    }
  }

  private playTone(context: AudioContext, frequency: number, durationSeconds: number, offsetSeconds: number): Promise<void> {
    return new Promise(resolve => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const startAt = context.currentTime + offsetSeconds;
      const stopAt = startAt + durationSeconds;

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.18, startAt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(startAt);
      oscillator.stop(stopAt);
      window.setTimeout(resolve, Math.ceil((offsetSeconds + durationSeconds) * 1000) + 20);
    });
  }
}
