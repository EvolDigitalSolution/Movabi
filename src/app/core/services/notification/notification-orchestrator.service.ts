import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from '../auth/auth.service';
import { NativePlatformService } from '../native/native-platform.service';
import { OneSignalService } from './onesignal.service';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { BehaviorSubject } from 'rxjs';
import { RealtimeChannel } from '@supabase/supabase-js';

export type NotificationEventType = 
  | 'new_chat_message'
  | 'driver_accepted'
  | 'driver_arrived'
  | 'trip_started'
  | 'shopping_completed'
  | 'items_collected'
  | 'driver_en_route'
  | 'trip_completed'
  | 'customer_cancelled'
  | 'driver_cancelled'
  | 'extra_budget_requested'
  | 'extra_budget_approved'
  | 'receipt_uploaded'
  | 'payment_completed';

export interface NotificationEvent {
  id: string;
  type: NotificationEventType;
  jobId: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  timestamp: string;
  senderId?: string;
}

@Injectable({
  providedIn: 'root'
})
export class NotificationOrchestratorService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);
  private nativePlatform = inject(NativePlatformService);
  private oneSignal = inject(OneSignalService);

  private activeJobSubscriptions = new Map<string, RealtimeChannel>();
  private seenEventIds = new Set<string>();
  private currentUserId: string | null = null;

  // Badge count subject for UI components
  private badgeCountSubject = new BehaviorSubject<Map<string, number>>(new Map());
  public badgeCount$ = this.badgeCountSubject.asObservable();

  constructor() {
    // Initialize current user
    const user = this.auth.currentUser();
    if (user) {
      this.currentUserId = user.id;
    }
  }

  /**
   * Subscribe to notifications for a specific job
   */
  subscribeToJob(jobId: string): void {
    if (!this.currentUserId) return;

    // Check for existing subscription to prevent duplicates
    const existing = this.activeJobSubscriptions.get(jobId);
    if (existing) {
      console.log(`[NotificationOrchestrator] Already subscribed to job: ${jobId}`);
      return;
    }

    console.log(`[NotificationOrchestrator] Subscribing to job: ${jobId}`);

    // Create single channel and register ALL handlers before subscribe
    const channel = this.supabase.client
      .channel(`job_notifications:${jobId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'job_messages',
          filter: `job_id=eq.${jobId}`
        },
        (payload) => {
          this.handleJobMessage(payload.new as any, jobId);
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'bookings',
          filter: `id=eq.${jobId}`
        },
        (payload) => {
          this.handleBookingStatusChange(payload.new as any, jobId);
        }
      );

    // Subscribe only after all handlers are registered
    channel.subscribe((status) => {
      console.log('[NotificationOrchestrator] channel status', jobId, status);
    });

    // Store channel reference
    this.activeJobSubscriptions.set(jobId, channel);
  }

  /**
   * Unsubscribe from notifications for a specific job
   */
  unsubscribeFromJob(jobId: string): void {
    const channel = this.activeJobSubscriptions.get(jobId);
    if (!channel) return;

    this.supabase.client.removeChannel(channel);
    this.activeJobSubscriptions.delete(jobId);
    console.log(`[NotificationOrchestrator] Unsubscribed from job: ${jobId}`);
  }

  /**
   * Get unread message count for a specific job
   */
  async getUnreadCount(jobId: string): Promise<number> {
    if (!this.currentUserId) return 0;

    try {
      const { data, error } = await this.supabase
        .from('job_messages')
        .select('id')
        .eq('job_id', jobId)
        .eq('receiver_id', this.currentUserId)
        .is('read_at', null);

      if (error) throw error;
      return data?.length || 0;
    } catch (error) {
      console.error('[NotificationOrchestrator] Failed to get unread count:', error);
      return 0;
    }
  }

  /**
   * Mark all messages as read for a specific job
   */
  async markAsRead(jobId: string): Promise<void> {
    if (!this.currentUserId) return;

    try {
      const { error } = await this.supabase
        .from('job_messages')
        .update({ read_at: new Date().toISOString() })
        .eq('job_id', jobId)
        .eq('receiver_id', this.currentUserId)
        .is('read_at', null);

      if (error) throw error;

      // Update badge count
      this.updateBadgeCount(jobId, 0);
      console.log(`[NotificationOrchestrator] Marked messages as read for job: ${jobId}`);
    } catch (error) {
      console.error('[NotificationOrchestrator] Failed to mark messages as read:', error);
    }
  }

  /**
   * Get badge count for a specific job
   */
  getBadgeCount(jobId: string): number {
    const badgeCounts = this.badgeCountSubject.value;
    return badgeCounts.get(jobId) || 0;
  }

  /**
   * Handle new job message
   */
  private async handleJobMessage(message: any, jobId: string): Promise<void> {
    if (!this.currentUserId) return;

    // Ignore messages from current user
    if (message.sender_id === this.currentUserId) return;

    const eventId = this.generateEventId('job_messages', 'INSERT', message.id, message.created_at);
    if (this.seenEventIds.has(eventId)) return;

    this.seenEventIds.add(eventId);

    // Update badge count
    const currentCount = await this.getUnreadCount(jobId);
    this.updateBadgeCount(jobId, currentCount);

    // Show notification
    await this.showNotification({
      id: eventId,
      type: 'new_chat_message',
      jobId,
      title: 'New message',
      body: message.message,
      data: { messageId: message.id, senderId: message.sender_id },
      timestamp: message.created_at,
      senderId: message.sender_id
    });
  }

  /**
   * Handle booking status change
   */
  private async handleBookingStatusChange(booking: any, jobId: string): Promise<void> {
    if (!this.currentUserId) return;

    const status = booking.status;
    const eventType = this.mapStatusToEventType(status);
    if (!eventType) return;

    const eventId = this.generateEventId('bookings', 'UPDATE', booking.id, booking.updated_at);
    if (this.seenEventIds.has(eventId)) return;

    this.seenEventIds.add(eventId);

    // Show notification
    await this.showNotification({
      id: eventId,
      type: eventType,
      jobId,
      title: this.getNotificationTitle(eventType),
      body: this.getNotificationBody(eventType),
      data: { status },
      timestamp: booking.updated_at
    });
  }

  /**
   * Show notification with sound and vibration
   */
  private async showNotification(event: NotificationEvent): Promise<void> {
    console.log(`[NotificationOrchestrator] Showing notification:`, event);

    // Play sound and vibrate
    await this.playNotificationFeedback(event.type);

    // Show in-app notification
    await this.oneSignal.showLocalStatusNotification(
      event.title,
      event.body,
      {
        type: event.type,
        jobId: event.jobId,
        open: event.type === 'new_chat_message' ? 'booking_chat' : 'booking_tracking',
        role: 'customer' // This should be determined based on user role
      }
    );
  }

  /**
   * Play notification sound and vibration
   */
  private async playNotificationFeedback(eventType: NotificationEventType): Promise<void> {
    try {
      // Different haptic feedback for different event types
      if (eventType === 'new_chat_message') {
        await Haptics.impact({ style: ImpactStyle.Light });
      } else {
        await Haptics.impact({ style: ImpactStyle.Medium });
      }
    } catch (error) {
      console.warn('[NotificationOrchestrator] Haptic feedback failed:', error);
    }

    // Play distinct sound for each lifecycle event
    await this.playEventSound(eventType);
  }

  private async playEventSound(eventType: NotificationEventType): Promise<void> {
    const soundMap: Partial<Record<NotificationEventType, string>> = {
      driver_accepted: 'booking-accepted.mp3',
      driver_en_route: 'driver-arrived.mp3',
      driver_arrived: 'driver-arrived.mp3',
      trip_started: 'driver-arrived.mp3',
      shopping_completed: 'request-notification.mp3',
      items_collected: 'request-notification.mp3',
      trip_completed: 'trip-completed.mp3',
      driver_cancelled: 'message-notification.mp3',
      customer_cancelled: 'message-notification.mp3'
    };

    const filename = soundMap[eventType];
    if (!filename) return;

    try {
      const audio = new Audio(`/assets/sounds/${filename}`);
      await audio.play();
    } catch (error) {
      console.warn('[NotificationOrchestrator] Could not play event sound', eventType, error);
    }
  }

  /**
   * Update badge count for a job
   */
  private updateBadgeCount(jobId: string, count: number): void {
    const currentBadgeCounts = new Map(this.badgeCountSubject.value);
    currentBadgeCounts.set(jobId, count);
    this.badgeCountSubject.next(currentBadgeCounts);
  }

  /**
   * Generate unique event ID for deduplication
   */
  private generateEventId(table: string, eventType: string, rowId: string, timestamp: string): string {
    return `${table}:${eventType}:${rowId}:${timestamp}`;
  }

  /**
   * Map booking status to notification event type
   */
  private mapStatusToEventType(status: string): NotificationEventType | null {
    const statusMap: Record<string, NotificationEventType> = {
      'accepted': 'driver_accepted',
      'arrived': 'driver_arrived',
      'in_progress': 'trip_started',
      'shopping_in_progress': 'shopping_completed',
      'collected': 'items_collected',
      'en_route_to_customer': 'driver_en_route',
      'completed': 'trip_completed',
      'cancelled': 'customer_cancelled',
      'canceled': 'customer_cancelled',
      'over_budget_requested': 'extra_budget_requested',
      'over_budget_approved': 'extra_budget_approved'
    };

    return statusMap[status] || null;
  }

  /**
   * Get notification title for event type
   */
  private getNotificationTitle(eventType: NotificationEventType): string {
    const titles: Record<NotificationEventType, string> = {
      'new_chat_message': 'New message',
      'driver_accepted': 'Driver accepted your offer',
      'driver_arrived': 'Driver has arrived',
      'trip_started': 'Trip started',
      'shopping_completed': 'Shopping has started',
      'items_collected': 'Your shopping has been collected',
      'driver_en_route': 'Driver is arriving',
      'trip_completed': 'Trip completed',
      'customer_cancelled': 'Booking cancelled',
      'driver_cancelled': 'Driver cancelled',
      'extra_budget_requested': 'Extra budget requested',
      'extra_budget_approved': 'Extra budget approved',
      'receipt_uploaded': 'Receipt uploaded',
      'payment_completed': 'Payment completed'
    };

    return titles[eventType] || 'Update';
  }

  /**
   * Get notification body for event type
   */
  private getNotificationBody(eventType: NotificationEventType): string {
    const bodies: Record<NotificationEventType, string> = {
      'new_chat_message': 'You have a new message',
      'driver_accepted': 'Your driver has been assigned and is on the way',
      'driver_arrived': 'Your driver has arrived at the pickup location',
      'trip_started': 'Your trip has started',
      'shopping_completed': 'Your driver has started shopping',
      'items_collected': 'Your shopping has been collected and is on the way',
      'driver_en_route': 'Your driver is arriving at your location',
      'trip_completed': 'Your trip has been completed successfully',
      'customer_cancelled': 'Booking was cancelled',
      'driver_cancelled': 'Driver cancelled the booking',
      'extra_budget_requested': 'Extra budget has been requested',
      'extra_budget_approved': 'Extra budget has been approved',
      'receipt_uploaded': 'Receipt has been uploaded',
      'payment_completed': 'Payment has been completed'
    };

    return bodies[eventType] || 'Update';
  }

  /**
   * Clear all subscriptions and reset state
   */
  clearAll(): void {
    // Unsubscribe from all jobs
    for (const [jobId] of this.activeJobSubscriptions) {
      this.unsubscribeFromJob(jobId);
    }

    // Clear state
    this.seenEventIds.clear();
    this.badgeCountSubject.next(new Map());
  }
}
