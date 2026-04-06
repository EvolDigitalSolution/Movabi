import { Injectable, inject, signal } from '@angular/core';
import { SupabaseService } from './supabase/supabase.service';
import { AuthService } from './auth/auth.service';
import { Notification } from '../../shared/models/booking.model';

@Injectable({
  providedIn: 'root'
})
export class NotificationService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);

  notifications = signal<Notification[]>([]);
  unreadCount = signal(0);

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

    this.supabase
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
        // Here we could trigger a local browser/mobile notification
      })
      .subscribe();
  }
}
