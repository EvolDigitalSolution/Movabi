import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from '../auth/auth.service';
import { JobMessage, JobMessageType } from '@shared/models/communication.model';
import { BehaviorSubject } from 'rxjs';
import { RealtimeChannel } from '@supabase/supabase-js';

@Injectable({
  providedIn: 'root'
})
export class CommunicationService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);
  
  private messagesSubject = new BehaviorSubject<JobMessage[]>([]);
  public messages$ = this.messagesSubject.asObservable();
  
  private subscription: RealtimeChannel | null = null;

  async getJobMessages(jobId: string): Promise<JobMessage[]> {
    const { data, error } = await this.supabase
      .from('job_messages')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    
    const messages = data as JobMessage[];
    this.messagesSubject.next(messages);
    return messages;
  }

  async sendMessage(jobId: string, receiverId: string, message: string, type: JobMessageType = 'text') {
    const user = this.auth.currentUser();
    const tenantId = this.auth.tenantId();
    if (!user) throw new Error('Not authenticated');

    const { data, error } = await this.supabase
      .from('job_messages')
      .insert({
        job_id: jobId,
        tenant_id: tenantId,
        sender_id: user.id,
        receiver_id: receiverId,
        message,
        message_type: type
      })
      .select()
      .single();

    if (error) throw error;
    return data as JobMessage;
  }

  async sendQuickMessage(jobId: string, receiverId: string, message: string) {
    return this.sendMessage(jobId, receiverId, message, 'quick');
  }

  subscribeToJobMessages(jobId: string) {
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
          const newMessage = payload.new as JobMessage;
          const currentMessages = this.messagesSubject.value;
          // Avoid duplicates if we just sent it
          if (!currentMessages.find(m => m.id === newMessage.id)) {
            this.messagesSubject.next([...currentMessages, newMessage]);
          }
        }
      )
      .subscribe();
      
    return this.subscription;
  }

  unsubscribeFromJobMessages() {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
    this.messagesSubject.next([]);
  }
}
