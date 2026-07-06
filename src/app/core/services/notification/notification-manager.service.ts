import { Injectable, inject } from '@angular/core';
import { OneSignalService } from './onesignal.service';
import { NativePlatformService } from '../native/native-platform.service';
import { Router } from '@angular/router';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

export type NotificationEventType = 
  | 'new_chat_message'
  | 'driver_accepted_booking'
  | 'driver_arrived'
  | 'driver_started_trip'
  | 'driver_completed_shopping'
  | 'driver_collected_items'
  | 'driver_en_route'
  | 'driver_completed_trip'
  | 'customer_cancelled'
  | 'driver_cancelled'
  | 'extra_budget_requested'
  | 'extra_budget_approved'
  | 'receipt_uploaded'
  | 'payment_completed';

export interface NotificationData {
  type: NotificationEventType;
  jobId: string;
  title: string;
  body: string;
  route?: string;
  sound?: boolean;
  vibration?: 'short' | 'long';
  badge?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class NotificationManagerService {
  private oneSignal = inject(OneSignalService);
  private nativePlatform = inject(NativePlatformService);
  private router = inject(Router);

  private lastNotificationTime = new Map<NotificationEventType, number>();
  private readonly NOTIFICATION_COOLDOWN = 1000; // 1 second cooldown per event type

  /**
   * Trigger a notification with sound, vibration, and appropriate routing
   */
  async triggerNotification(data: NotificationData): Promise<void> {
    // Check cooldown to prevent duplicate notifications
    if (this.isInCooldown(data.type)) {
      console.log(`[NotificationManager] Skipping duplicate ${data.type} notification`);
      return;
    }

    console.log(`[NotificationManager] Triggering notification:`, data);

    // Play sound and vibrate
    await this.playNotificationFeedback(data.vibration || 'short');

    // Show appropriate notification based on app state
    if (this.nativePlatform.appIsActive()) {
      await this.showInAppNotification(data);
    } else {
      await this.showPushNotification(data);
    }

    // Update cooldown
    this.updateCooldown(data.type);
  }

  /**
   * Trigger chat-specific notification
   */
  async triggerChatNotification(jobId: string, senderName: string, message: string): Promise<void> {
    await this.triggerNotification({
      type: 'new_chat_message',
      jobId,
      title: `Message from ${senderName}`,
      body: message,
      route: `/customer/tracking/${jobId}`,
      sound: true,
      vibration: 'short',
      badge: true
    });
  }

  /**
   * Trigger booking status notification
   */
  async triggerBookingStatusNotification(
    type: NotificationEventType,
    jobId: string,
    status: string,
    route?: string
  ): Promise<void> {
    const titles: Record<NotificationEventType, string> = {
      'driver_accepted_booking': 'Driver Assigned',
      'driver_arrived': 'Driver Arrived',
      'driver_started_trip': 'Trip Started',
      'driver_completed_shopping': 'Shopping Complete',
      'driver_collected_items': 'Items Collected',
      'driver_en_route': 'On the Way',
      'driver_completed_trip': 'Trip Completed',
      'customer_cancelled': 'Booking Cancelled',
      'driver_cancelled': 'Driver Cancelled',
      'extra_budget_requested': 'Budget Increase Requested',
      'extra_budget_approved': 'Budget Approved',
      'receipt_uploaded': 'Receipt Uploaded',
      'payment_completed': 'Payment Completed',
      'new_chat_message': 'New Message'
    };

    await this.triggerNotification({
      type,
      jobId,
      title: titles[type] || 'Update',
      body: status,
      route: route || `/customer/tracking/${jobId}`,
      sound: true,
      vibration: type === 'new_chat_message' ? 'short' : 'long',
      badge: true
    });
  }

  /**
   * Play notification sound and vibration
   */
  private async playNotificationFeedback(vibrationType: 'short' | 'long'): Promise<void> {
    try {
      // Play haptic feedback
      if (vibrationType === 'short') {
        await Haptics.impact({ style: ImpactStyle.Light });
      } else {
        await Haptics.impact({ style: ImpactStyle.Medium });
      }
    } catch (error) {
      console.warn('[NotificationManager] Haptic feedback failed:', error);
    }

    // Note: Sound is handled by OneSignal or native notification system
  }

  /**
   * Show in-app notification when app is active
   */
  private async showInAppNotification(data: NotificationData): Promise<void> {
    // Use OneSignal's local notification for in-app display
    await this.oneSignal.showLocalStatusNotification(
      data.title,
      data.body,
      {
        type: data.type,
        jobId: data.jobId,
        route: data.route
      }
    );
  }

  /**
   * Show push notification when app is backgrounded
   */
  private async showPushNotification(data: NotificationData): Promise<void> {
    // OneSignal handles push notifications automatically when app is backgrounded
    // We just need to ensure the user is properly tagged for the job
    await this.oneSignal.setUserTags({
      [`job_${data.jobId}`]: 'active',
      last_notification_type: data.type
    });
  }

  /**
   * Check if notification type is in cooldown period
   */
  private isInCooldown(type: NotificationEventType): boolean {
    const lastTime = this.lastNotificationTime.get(type);
    if (!lastTime) return false;
    
    return Date.now() - lastTime < this.NOTIFICATION_COOLDOWN;
  }

  /**
   * Update cooldown timestamp for notification type
   */
  private updateCooldown(type: NotificationEventType): void {
    this.lastNotificationTime.set(type, Date.now());
  }

  /**
   * Handle notification tap/route navigation
   */
  async handleNotificationTap(data: { type: string; jobId: string; route?: string }): Promise<void> {
    const route = data.route || this.getDefaultRouteForNotification(data.type, data.jobId);
    
    if (route) {
      console.log(`[NotificationManager] Navigating to:`, route);
      await this.router.navigateByUrl(route);
    }
  }

  /**
   * Get default route for notification type
   */
  private getDefaultRouteForNotification(type: string, jobId: string): string {
    switch (type) {
      case 'new_chat_message':
        return `/customer/tracking/${jobId}?tab=chat`;
      case 'driver_accepted_booking':
      case 'driver_arrived':
      case 'driver_started_trip':
      case 'driver_completed_shopping':
      case 'driver_collected_items':
      case 'driver_en_route':
      case 'driver_completed_trip':
      case 'customer_cancelled':
      case 'driver_cancelled':
      case 'extra_budget_requested':
      case 'extra_budget_approved':
      case 'receipt_uploaded':
      case 'payment_completed':
        return `/customer/tracking/${jobId}`;
      default:
        return `/customer/tracking/${jobId}`;
    }
  }

  /**
   * Clear notification cooldowns (useful for testing)
   */
  clearCooldowns(): void {
    this.lastNotificationTime.clear();
  }
}
