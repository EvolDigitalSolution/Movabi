import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from '../auth/auth.service';
import { ApiUrlService } from '../api-url.service';
import { NotificationManagerService } from '../notification/notification-manager.service';
import { JobMessage, JobMessageType } from '@shared/models/communication.model';
import { BehaviorSubject } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { RealtimeChannel } from '@supabase/supabase-js';

@Injectable({
  providedIn: 'root'
})
export class CommunicationService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);
  private http = inject(HttpClient);
  private apiUrlService = inject(ApiUrlService);
  private notificationManager = inject(NotificationManagerService);
  
  private messagesSubject = new BehaviorSubject<JobMessage[]>([]);
  public messages$ = this.messagesSubject.asObservable();
  
  private subscription: RealtimeChannel | null = null;
  private activeJobId: string | null = null;
  private countRequests = new Map<string, { expires: number; value?: {total:number;unread:number}; pending?: Promise<{total:number;unread:number}>; error?: unknown }>();

  async getJobMessages(jobId: string): Promise<JobMessage[]> {
    const userId = this.auth.currentUser()?.id;
    const messages = await firstValueFrom(this.http.get<JobMessage[]>(
      this.apiUrlService.getApiUrl('/api/communication/messages/' + encodeURIComponent(jobId)),
      { headers: await this.chatHeaders() }));
    if (!userId || userId !== this.auth.currentUser()?.id) throw new Error('Session changed. Reload messages.');
    if (this.activeJobId === jobId) this.messagesSubject.next(messages);
    return messages;
  }

  private async chatHeaders(): Promise<{ Authorization: string }> {
    const { data: { session } } = await this.supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Please sign in again.');
    return { Authorization: `Bearer ${session.access_token}` };
  }
  async getMessageCounts(jobId: string): Promise<{total: number; unread: number}> {
    const userId = this.auth.currentUser()?.id;
    if (!userId) throw new Error('Please sign in again.');
    const key = `${userId}:${jobId}`;
    const existing = this.countRequests.get(key);
    if (existing?.pending) return existing.pending;
    if (existing && existing.expires > Date.now()) {
      if (existing.error) throw existing.error;
      if (existing.value) return existing.value;
    }
    const entry: {expires:number;value?:{total:number;unread:number};pending?:Promise<{total:number;unread:number}>;error?:unknown} = {expires:0};
    const request = (async () => {
      try {
        const result = await firstValueFrom(this.http.get<{total:number;unread:number}>(
          this.apiUrlService.getApiUrl('/api/communication/messages/' + encodeURIComponent(jobId) + '/counts'),
          {headers: await this.chatHeaders()}));
        entry.value = result; entry.expires = Date.now() + 15000;
        return result;
      } catch (error: any) {
        entry.error = error;
        const retry = Number(error?.headers?.get('Retry-After'));
        entry.expires = Date.now() + (error?.status === 429 ? Math.max(60000, Number.isFinite(retry) ? retry * 1000 : 0) : 15000);
        throw error;
      } finally { entry.pending = undefined; }
    })();
    entry.pending = request; this.countRequests.set(key, entry);
    if (this.countRequests.size > 50) this.countRequests.delete(this.countRequests.keys().next().value!);
    return request;
  }
  async markMessagesRead(jobId: string, through: string): Promise<void> {
    await firstValueFrom(this.http.post(this.apiUrlService.getApiUrl('/api/communication/messages/' + encodeURIComponent(jobId) + '/read'),
      {through}, {headers: await this.chatHeaders()}));
    this.countRequests.delete(`${this.auth.currentUser()?.id}:${jobId}`);
  }
  async sendMessage(jobId: string, receiverId: string, message: string, type: JobMessageType = 'text') {
    const user = this.auth.currentUser();
    if (!user) throw new Error('Not authenticated');
    const { data: { session } } = await this.supabase.auth.getSession();
    const token = session?.access_token;

    if (!token) {
      throw new Error('Please sign in again before sending a message.');
    }

    const response = await firstValueFrom(this.http.post<{ message: JobMessage }>(
      this.apiUrlService.getApiUrl('/api/communication/messages'),
      {
        jobId,
        receiverId,
        message,
        messageType: type
      },
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    ));

    if (!response?.message) {
      throw new Error('Message was not sent.');
    }

    const currentMessages = this.messagesSubject.value;
    if (this.activeJobId === jobId && !currentMessages.find(m => m.id === response.message.id)) {
      this.messagesSubject.next([...currentMessages, response.message]);
    }

    return response.message;
  }

  async sendQuickMessage(jobId: string, receiverId: string, message: string) {
    return this.sendMessage(jobId, receiverId, message, 'quick');
  }

  subscribeToJobMessages(jobId: string) {
    if (this.activeJobId !== jobId) this.messagesSubject.next([]);
    this.activeJobId = jobId;
    if (this.subscription) {
      this.subscription.unsubscribe();
    }

    this.subscription = this.supabase.client
      .channel(`job_messages:${jobId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'job_messages',
          filter: `job_id=eq.${jobId}`
        },
        (payload) => {
          if (this.activeJobId !== jobId) return;
          const newMessage = payload.new as JobMessage;
          const currentMessages = this.messagesSubject.value;
          
          // Avoid duplicates if we just sent it
          if (!currentMessages.find(m => m.id === newMessage.id)) {
            this.messagesSubject.next([...currentMessages, newMessage]);
            
            // Trigger chat notification for new messages from others
            this.triggerChatNotification(newMessage, jobId);
          }
        }
      )
      .subscribe();
      
    return this.subscription;
  }

  unsubscribeFromJobMessages() {
    this.activeJobId = null;
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
    this.messagesSubject.next([]);
  }

  private async triggerChatNotification(message: JobMessage, jobId: string): Promise<void> {
    const currentUser = this.auth.currentUser();
    if (!currentUser || message.sender_id === currentUser.id) {
      return; // Don't notify for own messages
    }

    try {
      // Get sender name (use default for now, could be enhanced to fetch from user profile)
      const senderName = 'Driver';
      
      await this.notificationManager.triggerChatNotification(
        jobId,
        senderName,
        message.message
      );
    } catch (error) {
      console.warn('[CommunicationService] Failed to trigger chat notification:', error);
    }
  }
}
