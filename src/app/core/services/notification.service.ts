import { Injectable, effect, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { RealtimeChannel } from '@supabase/supabase-js';
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
        this.notifications.update(list => [newNotif, ...list]);
        this.updateUnreadCount();
        void this.nativePlatform.showForegroundNotification(
          newNotif.title,
          newNotif.body,
          newNotif.metadata
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
}
