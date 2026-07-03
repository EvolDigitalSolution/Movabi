import { supabaseAdmin } from './supabase.service';
import { EventService } from './event.service';

export interface NotificationPayload {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  type: 'booking_update' | 'payment_success' | 'system_alert' | 'chat_message' | 'driver_review_action_required';
}

export class NotificationService {
  /**
   * Send a notification to a user
   * Currently logs to database and events, ready for FCM/OneSignal integration
   */
  static async sendNotification(payload: NotificationPayload) {
    try {
      // 1. Log to database for in-app notification center
      const { error: dbError } = await supabaseAdmin
        .from('notifications')
        .insert({
          user_id: payload.userId,
          title: payload.title,
          body: payload.body,
          data: payload.data || {},
          metadata: payload.data || {},
          route: payload.data?.route || payload.data?.url || null,
          type: payload.type,
          is_read: false
        });

      if (dbError) {
        // If table doesn't exist, we might get an error. 
        // In a real app, we'd ensure the table exists.
        console.warn('Failed to save notification to DB:', dbError.message);
      }

      // 2. Log event
      await EventService.logEvent(
  'notification_sent',
  {
    userId: payload.userId,
    title: payload.title,
    body: payload.body,
    type: payload.type,
    data: payload.data
  },
  undefined,
  payload.userId
);

      // 3. Optional native push. OneSignal uses the app user id as external_id,
      // so the same call works for customer and driver devices after app login.
      await this.sendOneSignalPush(payload);

      console.log(`[Notification] To: ${payload.userId} | Title: ${payload.title} | Body: ${payload.body}`);
      
      return { success: true };
    } catch (error: any) {
      console.error('Error sending notification:', error);
      return { success: false, error: error.message };
    }
  }

  private static async sendOneSignalPush(payload: NotificationPayload): Promise<void> {
    // TODO: Move this to a secured server-only settings store once admin
    // configuration endpoints enforce authorization. Never expose the REST key.
    const appId = process.env.ONESIGNAL_APP_ID || '952c6d19-656c-4dab-90f3-6e253e2c9151';
    const apiKey = process.env.ONESIGNAL_REST_API_KEY;

    if (!apiKey) {
      console.warn('[OneSignal] REST API key missing; push skipped.');
      return;
    }

    try {
      const response = await fetch('https://onesignal.com/api/v1/notifications', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${apiKey}`
        },
        body: JSON.stringify({
          app_id: appId,
          include_external_user_ids: [payload.userId],
          channel_for_external_user_ids: 'push',
          headings: { en: payload.title },
          contents: { en: payload.body },
          data: payload.data || {},
          android_channel_id: process.env.ONESIGNAL_ANDROID_CHANNEL_ID || undefined
        })
      });

      const responseText = await response.text();
      let responseData: any = {};
      
      try {
        responseData = JSON.parse(responseText);
      } catch {
        // Response is not JSON, use as-is
      }

      if (!response.ok) {
        console.warn('[Notification] OneSignal push failed:', {
          status: response.status,
          statusText: response.statusText,
          body: responseText,
          parsedData: responseData,
          userId: payload.userId,
          appId: appId
        });
      } else {
        console.log('[Notification] OneSignal push accepted:', {
          status: response.status,
          body: responseText,
          parsedData: responseData,
          userId: payload.userId,
          recipients: responseData?.recipients || 'unknown'
        });
      }
    } catch (error: any) {
      console.warn('[Notification] OneSignal push error:', error?.message || error);
    }
  }

  /**
   * Check if user has active push subscriptions
   */
  static async validateUserPushSubscription(userId: string): Promise<{
    hasSubscription: boolean;
    subscriptions: any[];
    details: any;
  }> {
    try {
      const { data: subscriptions, error } = await supabaseAdmin
        .from('device_push_tokens')
        .select('*')
        .eq('user_id', userId)
        .eq('enabled', true);

      if (error) {
        console.warn('[Notification] Failed to validate push subscription:', error);
        return { hasSubscription: false, subscriptions: [], details: { error: error.message } };
      }

      const hasSubscription = Array.isArray(subscriptions) && subscriptions.length > 0;
      
      console.log('[Notification] Push subscription validation:', {
        userId,
        hasSubscription,
        subscriptionCount: subscriptions?.length || 0,
        platforms: subscriptions?.map(s => s.platform) || [],
        subscriptionIds: subscriptions?.map(s => s.subscription_id) || []
      });

      return {
        hasSubscription,
        subscriptions: subscriptions || [],
        details: {
          userId,
          subscriptionCount: subscriptions?.length || 0,
          platforms: subscriptions?.map(s => ({ platform: s.platform, enabled: s.enabled, lastSeen: s.last_seen_at })) || []
        }
      };
    } catch (error: any) {
      console.error('[Notification] Error validating push subscription:', error);
      return { hasSubscription: false, subscriptions: [], details: { error: error.message } };
    }
  }

  /**
   * Notify driver of a new job
   */
  static async notifyNewJob(driverId: string, jobId: string) {
    return this.sendNotification({
      userId: driverId,
      title: 'New Job Available!',
      body: 'A new booking is available in your area. Open the app to accept.',
      type: 'booking_update',
      data: { jobId, action: 'new_job' }
    });
  }

  /**
   * Notify customer of job status update
   */
  static async notifyJobStatusUpdate(userId: string, jobId: string, status: string) {
    let title = 'Booking Update';
    let body = `Your booking status is now: ${status}`;

    if (status === 'accepted') {
      title = 'Driver Found!';
      body = 'A driver has accepted your booking and is on the way.';
    } else if (status === 'arrived') {
      title = 'Driver Arrived';
      body = 'Your driver has arrived at the pickup location.';
    } else if (status === 'completed') {
      title = 'Booking Completed';
      body = 'Thank you for using Movabi! Please rate your experience.';
    }

    return this.sendNotification({
      userId,
      title,
      body,
      type: 'booking_update',
      data: { jobId, status }
    });
  }

  static async notifyChatMessage(userId: string, jobId: string, senderId: string, message: string) {
    const preview = message.length > 90 ? `${message.slice(0, 87)}...` : message;

    return this.sendNotification({
      userId,
      title: 'New message',
      body: preview || 'You have a new message.',
      type: 'chat_message',
      data: { jobId, senderId, action: 'open_chat' }
    });
  }

  static async notifyDriverReviewActionRequired(userId: string, blockers: string[], message: string) {
    const body = message?.trim() || 'Your Movabi driver verification needs more information.';

    return this.sendNotification({
      userId,
      title: 'Verification action required',
      body,
      type: 'driver_review_action_required',
      data: {
        route: '/driver/settings',
        blockers,
        message: body,
        action: 'driver_review_action_required'
      }
    });
  }
}
