import { Injectable, inject, signal } from '@angular/core';
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
  private currentUserId: string | null = null;

  readonly totalUnreadCount = signal(0);

  constructor() {
    // Initialize current user
    const user = this.auth.currentUser();
    if (user) {
      this.currentUserId = user.id;
    }

    // Note: Auth service changes would be handled by the components that use this service
    // The currentUserId is updated when the service is initialized
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
  markAsRead(jobId: string): void {
    const current = this.unreadCounts.get(jobId);
    if (current) {
      current.count = 0;
      this.unreadCounts.set(jobId, current);
      this.updateSubject();
    }
  }

  /**
   * Subscribe to message updates for a specific job
   */
  subscribeToJob(jobId: string): void {
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
  }

  /**
   * Unsubscribe from message updates for a specific job
   */
  unsubscribeFromJob(jobId: string): void {
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
      const { data: messages, error } = await this.supabase
        .from('job_messages')
        .select('*')
        .eq('job_id', jobId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const unreadMessages = (messages as JobMessage[]).filter(
        msg => msg.sender_id !== this.currentUserId
      );

      const lastMessage = unreadMessages[0] || messages[0];

      this.unreadCounts.set(jobId, {
        jobId,
        count: unreadMessages.length,
        lastMessage
      });

      this.updateSubject();
    } catch (error) {
      console.error('[UnreadCounter] Failed to calculate initial unread count:', error);
    }
  }

  /**
   * Handle new message and update unread count
   */
  private handleNewMessage(jobId: string, message: JobMessage): void {
    if (!this.currentUserId) return;

    const current = this.unreadCounts.get(jobId) || {
      jobId,
      count: 0,
      lastMessage: undefined
    };

    // Only increment if message is from someone else
    if (message.sender_id !== this.currentUserId) {
      current.count++;
    }

    // Update last message
    current.lastMessage = message;

    this.unreadCounts.set(jobId, current);
    this.updateSubject();
  }

  /**
   * Update the BehaviorSubject and total count signal
   */
  private updateSubject(): void {
    this.unreadCountsSubject.next(new Map(this.unreadCounts));
    this.totalUnreadCount.set(this.getTotalUnreadCount());
  }
}
