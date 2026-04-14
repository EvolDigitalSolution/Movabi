import { supabaseAdmin } from './supabase.service';
import { eventService } from './event.service';

export interface NotificationPayload {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, any>;
  type: 'booking_update' | 'payment_success' | 'system_alert' | 'chat_message';
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
          type: payload.type,
          is_read: false
        });

      if (dbError) {
        // If table doesn't exist, we might get an error. 
        // In a real app, we'd ensure the table exists.
        console.warn('Failed to save notification to DB:', dbError.message);
      }

      // 2. Log event
      await eventService.logEvent(
        'system',
        'notification_sent',
        `Notification sent to ${payload.userId}: ${payload.title}`,
        payload
      );

      // 3. TODO: Integrate with Push Provider (FCM/OneSignal)
      // Example:
      // await fcm.send({
      //   token: userPushToken,
      //   notification: { title: payload.title, body: payload.body },
      //   data: payload.data
      // });

      console.log(`[Notification] To: ${payload.userId} | Title: ${payload.title} | Body: ${payload.body}`);
      
      return { success: true };
    } catch (error: any) {
      console.error('Error sending notification:', error);
      return { success: false, error: error.message };
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
}
