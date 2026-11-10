import { pollRetryDelay } from '@shared/utils/poll-retry-delay';
import { ToastController } from '@ionic/angular/standalone';
import { Router } from '@angular/router';
import { CommunicationService } from '../communication/communication.service';
import { Injectable, inject, effect, signal } from '@angular/core';
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
  | 'extra_budget_rejected'
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
  private chatCommunication = inject(CommunicationService);
  private auth = inject(AuthService);
  private nativePlatform = inject(NativePlatformService);
  private oneSignal = inject(OneSignalService);
  private toastController = inject(ToastController);
  private router = inject(Router);
  private badgeCounts = signal<Map<string, number>>(new Map());
  private badgePolling = new Map<string, ReturnType<typeof setInterval>>();
  private chatRecoveryBusy = new Map<string, symbol>();
  private chatStartedAt = new Map<string, number>();
  private chatRecoveryRetry=new Map<string,number>();
  private pendingChatSound: { owner: string; jobId: string; at: number } | null = null;
  private chatSoundUnlock: (() => void) | null = null;
  private clearChatSoundUnlock(): void {
    if (this.chatSoundUnlock && typeof document !== 'undefined') {
      document.removeEventListener('pointerdown',this.chatSoundUnlock);
      document.removeEventListener('keydown',this.chatSoundUnlock);
    }
    this.chatSoundUnlock=null;this.pendingChatSound=null;
  }
  private async recoverChat(jobId: string): Promise<void> {
    if (this.chatRecoveryBusy.has(jobId) || Date.now()<(this.chatRecoveryRetry.get(jobId)||0)) return;
    const owner=this.auth.currentUser()?.id,channel=this.activeJobSubscriptions.get(jobId);
    if (!owner || !channel) return;
    const token=Symbol();this.chatRecoveryBusy.set(jobId,token);
    const current=()=>owner===this.auth.currentUser()?.id && owner===this.currentUserId && channel===this.activeJobSubscriptions.get(jobId);
    try {
      const counts=await this.chatCommunication.getMessageCounts(jobId);
      if (!current()) return;
      this.chatRecoveryRetry.delete(jobId);
      this.updateBadgeCount(jobId,counts.unread);
      {
        const rows=await this.chatCommunication.getJobMessages(jobId);
        if (!current()) return;
        // Alert only messages arriving during this subscription, not old unread history.
        const fresh=rows.filter(row=>row.job_id===jobId && row.receiver_id===owner && row.sender_id!==owner
          && Date.parse(row.created_at)>=(this.chatStartedAt.get(jobId) || Date.now()));
        for (const row of fresh.slice(0,-1)) this.seenEventIds.add(this.generateEventId('job_messages','INSERT',row.id,row.created_at));
        const newest=fresh[fresh.length-1];if(newest&&current())await this.handleJobMessage(newest,jobId);
      }
    } catch(error:any) {
      if(current())this.chatRecoveryRetry.set(jobId,Date.now()+pollRetryDelay(error));
      if (current() && error?.status===403) this.unsubscribeFromJob(jobId);
    } finally { if (this.chatRecoveryBusy.get(jobId)===token) this.chatRecoveryBusy.delete(jobId); }
  }


  private activeJobSubscriptions = new Map<string, RealtimeChannel>();
  readonly budgetBadges = signal<Map<string, number>>(new Map());
  private fundingTimers = new Map<string, ReturnType<typeof setInterval>>();
  private fundingBusy = new Set<string>();
  getBudgetBadgeCount(jobId: string): number { return this.budgetBadges().get(jobId) || 0; }
  markBudgetRead(jobId: string): void {
    if (!this.budgetBadges().has(jobId)) return;
    this.budgetBadges.update(current => { const next = new Map(current); next.delete(jobId); return next; });
  }
  private async recoverFunding(jobId: string): Promise<void> {
    if (this.fundingBusy.has(jobId) || !this.activeJobSubscriptions.has(jobId)) return;
    this.fundingBusy.add(jobId);
    try {
      const { data,error } = await this.supabase.client.from('errand_funding').select('*').eq('job_id',jobId)
        .abortSignal(AbortSignal.timeout(8000)).maybeSingle();
      if (!error && data && this.activeJobSubscriptions.has(jobId)) await this.handleFundingChange(data,jobId);
    } catch { /* Keep realtime active; recover on the next poll. */ }
    finally { this.fundingBusy.delete(jobId); }
  }
  private seenEventIds = new Set<string>();
  private currentUserId: string | null = null;

  // Badge count subject for UI components
  private badgeCountSubject = new BehaviorSubject<Map<string, number>>(new Map());
  public badgeCount$ = this.badgeCountSubject.asObservable();

  constructor() {
    effect(() => {
      const id = this.auth.currentUser()?.id || null;
      if (id !== this.currentUserId) { this.clearAll(); this.currentUserId = id; }
    });
  }

  /**
   * Subscribe to notifications for a specific job
   */
  subscribeToJob(jobId: string): void {
    this.currentUserId = this.auth.currentUser()?.id || null;
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
          table: 'jobs',
          filter: `id=eq.${jobId}`
        },
        (payload) => {
          this.handleBookingStatusChange(payload.new as any, jobId);
        }
      );

    channel.on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'errand_funding', filter: `job_id=eq.${jobId}`
    }, payload => { void this.handleFundingChange(payload.new as any, jobId); });

    // Subscribe only after all handlers are registered
    channel.subscribe((status) => {
      console.log('[NotificationOrchestrator] channel status', jobId, status);
    });

    // Store channel reference
    this.activeJobSubscriptions.set(jobId, channel);
    this.fundingTimers.set(jobId,setInterval(() => { void this.recoverFunding(jobId); },5000));
    void this.recoverFunding(jobId);
    this.chatStartedAt.set(jobId,Date.now());
    void this.recoverChat(jobId);
    this.badgePolling.set(jobId, setInterval(() => { if(typeof document==='undefined'||document.visibilityState!=='hidden')void this.recoverChat(jobId); }, 15000));
  }

  /**
   * Unsubscribe from notifications for a specific job
   */
  unsubscribeFromJob(jobId: string): void {
    this.chatStartedAt.delete(jobId);this.chatRecoveryBusy.delete(jobId);this.chatRecoveryRetry.delete(jobId);
    if (this.pendingChatSound?.jobId===jobId) this.clearChatSoundUnlock();
    const fundingTimer = this.fundingTimers.get(jobId);
    if (fundingTimer) clearInterval(fundingTimer);
    this.fundingTimers.delete(jobId);
    const timer = this.badgePolling.get(jobId);
    if (timer) clearInterval(timer);
    this.badgePolling.delete(jobId);
    const channel = this.activeJobSubscriptions.get(jobId);
    if (!channel) return;

    this.supabase.client.removeChannel(channel);
    this.activeJobSubscriptions.delete(jobId);
    console.log(`[NotificationOrchestrator] Unsubscribed from job: ${jobId}`);
  }

  /**
   * Get unread message count for a specific job
   */
  async getUnreadCount(jobId: string, fresh = false): Promise<number> {
    const owner = this.auth.currentUser()?.id;
    try {
      const result = await this.chatCommunication.getMessageCounts(jobId,fresh);
      return owner === this.auth.currentUser()?.id ? result.unread : 0;
    }
    catch (error) {
      if (owner !== this.auth.currentUser()?.id) return 0;
      if (Number((error as { status?: number })?.status) === 403) {
        this.unsubscribeFromJob(jobId);
        this.updateBadgeCount(jobId, 0);
        this.markBudgetRead(jobId);
        return 0;
      }
      console.warn('Message count unavailable', error);
      return this.getBadgeCount(jobId);
    }
  }

  /**
   * Mark all messages as read for a specific job
   */
  async markAsRead(jobId: string): Promise<void> {
    // Opening a tab is not evidence that history loaded. The chat panel acknowledges
    // the actual displayed messages through its last received timestamp.
    const userId = this.currentUserId;
    const count = await this.getUnreadCount(jobId);
    if (userId && userId === this.currentUserId) this.updateBadgeCount(jobId, count);
  }

  /**
   * Get badge count for a specific job
   */
  getBadgeCount(jobId: string): number {
    const badgeCounts = this.badgeCounts();
    return badgeCounts.get(jobId) || 0;
  }

  /**
   * Handle new job message
   */
  private async handleFundingChange(funding: any, jobId: string): Promise<void> {
    const userId = this.currentUserId;
    const status = String(funding?.over_budget_status || '');
    if (!userId || !['requested','approved','rejected'].includes(status)) return;
    try {
      const { data: job, error } = await this.supabase.client.from('jobs')
        .select('customer_id,driver_id,accepted_driver_id').eq('id',jobId).maybeSingle();
      if (error || !job || userId !== this.currentUserId) return;
      const recipient = status === 'requested' ? job.customer_id : (job.driver_id || job.accepted_driver_id);
      if (recipient !== userId) return;
      const request = funding.metadata?.budget_request_id || `${funding.requested_over_budget_amount}:${funding.over_budget_reason || ''}`;
      const eventId = `budget:${jobId}:${request}:${status}`;
      if (this.seenEventIds.has(eventId)) return;
      this.seenEventIds.add(eventId);
      this.budgetBadges.update(current => { const next = new Map(current); next.set(jobId,1); return next; });
      const type: NotificationEventType = status === 'requested' ? 'extra_budget_requested'
        : status === 'approved' ? 'extra_budget_approved' : 'extra_budget_rejected';
      await this.showNotification({ id:eventId,type,jobId,
        title:status === 'requested' ? 'Shopping budget increase requested' : status === 'approved' ? 'Shopping budget increase approved' : 'Shopping budget increase rejected',
        body:status === 'requested' ? 'Your driver needs your approval. Open Payment to review the amount and reason.'
          : status === 'approved' ? 'The customer approved the increased shopping budget. Open the job to check card availability.'
          : 'The customer rejected the increase. Contact them before spending more.',
        timestamp:funding.updated_at || new Date().toISOString() });
    } catch (error) { console.warn('[NotificationOrchestrator] budget alert unavailable',error); }
  }

  private async handleJobMessage(message: any, jobId: string): Promise<void> {
    if (!this.currentUserId || this.currentUserId!==this.auth.currentUser()?.id || !this.activeJobSubscriptions.has(jobId)) return;

    // Ignore messages from current user
    if (message.sender_id === this.currentUserId || message.receiver_id !== this.currentUserId) return;

    const eventId = this.generateEventId('job_messages', 'INSERT', message.id, message.created_at);
    if (this.seenEventIds.has(eventId)) return;

    this.seenEventIds.add(eventId);

    // Update badge count
    const owner=this.currentUserId,channel=this.activeJobSubscriptions.get(jobId);
    this.updateBadgeCount(jobId,this.getBadgeCount(jobId)+1);
    const currentCount = await this.getUnreadCount(jobId,true);
    if (owner!==this.currentUserId || owner!==this.auth.currentUser()?.id || channel!==this.activeJobSubscriptions.get(jobId)) return;
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

    const participants = [booking.customer_id, booking.driver_id || booking.accepted_driver_id];
    if (!participants.includes(this.currentUserId)) {
      this.unsubscribeFromJob(jobId);
      this.updateBadgeCount(jobId, 0);
      return;
    }
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

    void this.playNotificationFeedback(event.type,event.jobId);
    const role = this.auth.profileService.profile()?.role === 'driver' ? 'driver' : 'customer';
    if (event.type === 'new_chat_message') {
      const route = role === 'driver' ? `/driver/job-details/${event.jobId}?chat=1` : `/customer/tracking/${event.jobId}?tab=chat&message=${encodeURIComponent(String(event.data?.['messageId'] || event.id))}`;
      const toast = await this.toastController.create({
        header: 'New message', message: 'You have a new booking message.',
        duration: 5000, position: 'top',
        buttons: [{ text: 'Open chat', handler: () => { void this.router.navigateByUrl(route); } }]
      });
      await toast.present();
    }

    if (['extra_budget_requested','extra_budget_approved','extra_budget_rejected'].includes(event.type)) {
      const route = role === 'driver' ? `/driver/job-details/${event.jobId}` : `/customer/tracking/${event.jobId}?tab=payment`;
      const toast = await this.toastController.create({ header:event.title,message:event.body,
        duration:7000,position:'top',buttons:[{text:'Review',handler:()=>{void this.router.navigateByUrl(route);}}] });
      await toast.present();
    }
    // Play sound and vibrate
    // Feedback starts independently above, so toast errors cannot suppress it.

    // Show in-app notification
    await this.oneSignal.showLocalStatusNotification(
      event.title,
      event.body,
      {
        type: event.type,
        jobId: event.jobId,
        open: event.type === 'new_chat_message' ? 'booking_chat' : 'booking_tracking',
        role
      }
    );
  }

  /**
   * Play notification sound and vibration
   */
  private async playNotificationFeedback(eventType: NotificationEventType, jobId?: string): Promise<void> {
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
    await this.playEventSound(eventType,jobId);
  }

  private async playEventSound(eventType: NotificationEventType, jobId?: string): Promise<void> {
    const soundMap: Partial<Record<NotificationEventType, string>> = {
      extra_budget_requested: 'request-notification.mp3',
      extra_budget_approved: 'booking-accepted.mp3',
      extra_budget_rejected: 'message-notification.mp3',
      new_chat_message: 'message-notification.mp3',
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
      if (eventType==='new_chat_message' && jobId && (error as any)?.name==='NotAllowedError' && typeof document!=='undefined') {
        this.pendingChatSound={owner:this.currentUserId || '',jobId,at:Date.now()};
        if (!this.chatSoundUnlock) {
          this.chatSoundUnlock=()=>{
            const pending=this.pendingChatSound;this.clearChatSoundUnlock();
            if (pending && pending.owner===this.auth.currentUser()?.id && this.activeJobSubscriptions.has(pending.jobId)
                && Date.now()-pending.at<10000 && this.getBadgeCount(pending.jobId)>0) void this.playEventSound('new_chat_message',pending.jobId);
          };
          document.addEventListener('pointerdown',this.chatSoundUnlock);
          document.addEventListener('keydown',this.chatSoundUnlock);
        }
      }
    }
  }

  /**
   * Update badge count for a job
   */
  private updateBadgeCount(jobId: string, count: number): void {
    const currentBadgeCounts = new Map(this.badgeCountSubject.value);
    currentBadgeCounts.set(jobId, count);
    this.badgeCounts.set(currentBadgeCounts);
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
      'extra_budget_rejected': 'Extra budget rejected',
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
      'extra_budget_rejected': 'Extra budget has been rejected',
      'receipt_uploaded': 'Receipt has been uploaded',
      'payment_completed': 'Payment has been completed'
    };

    return bodies[eventType] || 'Update';
  }

  /**
   * Clear all subscriptions and reset state
   */
  clearAll(): void {
    this.clearChatSoundUnlock();
    // Unsubscribe from all jobs
    for (const [jobId] of this.activeJobSubscriptions) {
      this.unsubscribeFromJob(jobId);
    }

    // Clear state
    this.seenEventIds.clear();
    this.budgetBadges.set(new Map());
    this.badgeCounts.set(new Map());
    this.badgeCountSubject.next(new Map());
  }
}
