import { Injectable, inject, signal, effect } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { CommunicationService } from '../communication/communication.service';
import { AuthService } from '../auth/auth.service';
import { JobMessage } from '@shared/models/communication.model';
import { SupabaseService } from '../supabase/supabase.service';
import { RealtimeChannel } from '@supabase/supabase-js';

export interface UnreadCount {
  jobId: string;
  count: number;
  lastMessage?: JobMessage;
}

@Injectable({
  providedIn: 'root'
})
export class UnreadCounterService {
  private commService = inject(CommunicationService);
  private auth = inject(AuthService);
  private supabase = inject(SupabaseService);

  private unreadCounts = new Map<string, UnreadCount>();
  private unreadCountsSubject = new BehaviorSubject<Map<string, UnreadCount>>(new Map());
  public unreadCounts$ = this.unreadCountsSubject.asObservable();

  private messageSubscriptions = new Map<string, RealtimeChannel>();
  private polling = new Map<string, ReturnType<typeof setInterval>>();
  private currentUserId: string | null = null;

  readonly totalUnreadCount = signal(0);

  constructor() {
    effect(() => {
      const id = this.auth.currentUser()?.id || null;
      if (id !== this.currentUserId) { this.clearAllCounts(); this.currentUserId = id; }
    });
  }

  /**
   * Get unread count for a specific job
   */
  getUnreadCount(jobId: string): number {
    return this.unreadCounts.get(jobId)?.count || 0;
  }

  /**
   * Get last message for a specific job
   */
  getLastMessage(jobId: string): JobMessage | undefined {
    return this.unreadCounts.get(jobId)?.lastMessage;
  }

  /**
   * Get total unread count across all jobs
   */
  getTotalUnreadCount(): number {
    let total = 0;
    for (const count of this.unreadCounts.values()) {
      total += count.count;
    }
    return total;
  }

  /**
   * Mark messages as read for a specific job
   */
  async markAsRead(jobId: string, through?: string): Promise<void> {
    if (!through) return;
    try { await this.commService.markMessagesRead(jobId, through); await this.calculateInitialUnreadCount(jobId); }
    catch (error) { console.warn('Message read acknowledgement failed', error); }
  }

  /**
   * Subscribe to message updates for a specific job
   */
  subscribeToJob(jobId: string): void {
    this.currentUserId = this.auth.currentUser()?.id || null;
    if (!this.currentUserId) return;

    // Unsubscribe from existing subscription for this job
    this.unsubscribeFromJob(jobId);

    // Get initial unread count
    this.calculateInitialUnreadCount(jobId);

    // Subscribe to new messages
    const subscription = this.supabase.client
      .channel(`unread_counter:${jobId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'job_messages',
          filter: `job_id=eq.${jobId}`
        },
        (payload) => {
          const newMessage = payload.new as JobMessage;
          this.handleNewMessage(jobId, newMessage);
        }
      )
      .subscribe();

    this.messageSubscriptions.set(jobId, subscription);
    this.polling.set(jobId, setInterval(() => { void this.calculateInitialUnreadCount(jobId); }, 10000));
  }

  /**
   * Unsubscribe from message updates for a specific job
   */
  unsubscribeFromJob(jobId: string): void {
    const timer = this.polling.get(jobId); if (timer) clearInterval(timer); this.polling.delete(jobId);
    const subscription = this.messageSubscriptions.get(jobId);
    if (subscription) {
      subscription.unsubscribe();
      this.messageSubscriptions.delete(jobId);
    }
  }

  /**
   * Clear all unread counts (called on logout)
   */
  clearAllCounts(): void {
    this.polling.forEach(timer => clearInterval(timer)); this.polling.clear();
    this.unreadCounts.clear();
    this.messageSubscriptions.forEach(sub => sub.unsubscribe());
    this.messageSubscriptions.clear();
    this.updateSubject();
  }

  /**
   * Calculate initial unread count for a job
   */
  private async calculateInitialUnreadCount(jobId: string): Promise<void> {
    if (!this.currentUserId) return;

    try {
      const userId = this.auth.currentUser()?.id;
      const counts = await this.commService.getMessageCounts(jobId);
      if (userId !== this.auth.currentUser()?.id) return;
      this.unreadCounts.set(jobId, { jobId, count: counts.unread });
      this.updateSubject();
    } catch (error) {
      console.warn('[UnreadCounter] refresh unavailable; retaining last known count:', error);
    }
  }

  /**
   * Handle new message and update unread count
   */
  private handleNewMessage(jobId: string, message: JobMessage): void {
    if (!this.currentUserId) return;

    void this.calculateInitialUnreadCount(jobId);
  }

  /**
   * Update the BehaviorSubject and total count signal
   */
  private updateSubject(): void {
    this.unreadCountsSubject.next(new Map(this.unreadCounts));
    this.totalUnreadCount.set(this.getTotalUnreadCount());
  }
}
