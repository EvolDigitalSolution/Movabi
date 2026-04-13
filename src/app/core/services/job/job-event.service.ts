import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { JobEvent, JobEventType } from '@shared/models/booking.model';
import { AuthService } from '../auth/auth.service';

@Injectable({
  providedIn: 'root'
})
export class JobEventService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);

  /**
   * Log a job event to the database.
   * Lightweight and non-blocking.
   */
  async logEvent(
    jobId: string, 
    eventType: JobEventType, 
    notes?: string, 
    metadata: Record<string, unknown> = {}
  ) {
    const user = this.auth.currentUser();
    const role = this.auth.userRole();

    const event = {
      job_id: jobId,
      event_type: eventType,
      actor_id: user?.id,
      actor_role: role || 'system',
      notes,
      metadata
    };

    // Fire and forget (mostly) to keep it non-blocking
    this.supabase.from('job_events').insert(event).then(({ error }) => {
      if (error) {
        console.warn('Failed to log job event:', error);
      }
    });
  }

  /**
   * Get all events for a specific job.
   */
  async getJobEvents(jobId: string): Promise<JobEvent[]> {
    const { data, error } = await this.supabase
      .from('job_events')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data as JobEvent[];
  }

  /**
   * Subscribe to real-time events for a job.
   */
  subscribeToJobEvents(jobId: string, callback: (event: JobEvent) => void) {
    return this.supabase.client
      .channel(`job_events:${jobId}`)
      .on('postgres_changes', { 
        event: 'INSERT', 
        schema: 'public', 
        table: 'job_events',
        filter: `job_id=eq.${jobId}`
      }, (payload) => {
        callback(payload.new as JobEvent);
      })
      .subscribe();
  }
}
