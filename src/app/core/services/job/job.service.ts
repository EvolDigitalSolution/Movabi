import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { Job, JobStatus, JobEstimate, DispatchCandidate, City, JobEventType } from '@shared/models/booking.model';
import { RealtimeChannel } from '@supabase/supabase-js';
import { JobEventService } from './job-event.service';
import { ApiUrlService } from '../api-url.service';

@Injectable({
  providedIn: 'root'
})
export class JobService {
  private supabase = inject(SupabaseService);
  private eventService = inject(JobEventService);
  private apiUrlService = inject(ApiUrlService);

  /**
   * Calculate price via Node backend
   */
  async calculatePrice(pickup: { lat: number, lng: number }, dropoff: { lat: number, lng: number }) {
    const url = this.apiUrlService.getApiUrl('/api/logistics/calculate-price');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pickup, dropoff })
    });
    if (!response.ok) throw new Error('Failed to calculate price');
    return await response.json() as JobEstimate;
  }

  /**
   * Suggest nearest drivers via Node backend
   */
  async suggestDrivers(lat: number, lng: number, tenantId: string) {
    const url = this.apiUrlService.getApiUrl('/api/logistics/suggest-drivers');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng, tenant_id: tenantId })
    });
    if (!response.ok) throw new Error('Failed to suggest drivers');
    return await response.json() as DispatchCandidate[];
  }

  async createJob(job: Partial<Job>) {
    const payload = {
      ...job,
      scheduled_time: job.scheduled_time || new Date().toISOString()
    };
    const { data, error } = await this.supabase
      .from('jobs')
      .insert(payload)
      .select()
      .single();

    if (error) {
      console.error('Error creating job:', error);
      throw error;
    }
    return data as Job;
  }

  async getAvailableJobs() {
    const { data, error } = await this.supabase
      .from('jobs')
      .select('*, customer:profiles(*)')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as Job[];
  }

  async getDriverJobs(driverId: string) {
    const { data, error } = await this.supabase
      .from('jobs')
      .select('*, customer:profiles(*)')
      .eq('driver_id', driverId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as Job[];
  }

  async acceptJob(jobId: string, driverId: string) {
    const { data, error } = await this.supabase
      .from('jobs')
      .update({ 
        status: 'accepted', 
        driver_id: driverId 
      })
      .eq('id', jobId)
      .eq('status', 'pending')
      .select()
      .single();
    if (error) throw error;
    
    await this.eventService.logEvent(jobId, 'driver_accepted', 'Job accepted via backend dispatch');
    
    return data as Job;
  }

  async updateJobStatus(jobId: string, status: JobStatus) {
    const { data, error } = await this.supabase
      .from('jobs')
      .update({ status })
      .eq('id', jobId)
      .select()
      .single();
    if (error) throw error;

    const eventTypeMap: Partial<Record<JobStatus, JobEventType>> = {
      'arrived': 'driver_arrived',
      'in_progress': 'job_started',
      'completed': 'job_completed',
      'cancelled': 'job_cancelled'
    };

    const eventType = eventTypeMap[status];
    if (eventType) {
      await this.eventService.logEvent(jobId, eventType, `Status updated to ${status}`);
    }

    return data as Job;
  }

  async getJobById(jobId: string) {
    const { data, error } = await this.supabase
      .from('jobs')
      .select('*, customer:profiles(*), driver:profiles(*)')
      .eq('id', jobId)
      .single();
    if (error) throw error;
    return data as Job;
  }

  async getAllJobs() {
    const { data, error } = await this.supabase
      .from('jobs')
      .select('*, customer:profiles(*), driver:profiles(*)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as Job[];
  }

  async getCities() {
    const { data, error } = await this.supabase
      .from('cities')
      .select('*')
      .order('name', { ascending: true });
    if (error) throw error;
    return data as City[];
  }

  async enqueueJob(jobId: string, tenantId: string, cityId?: string) {
    const url = this.apiUrlService.getApiUrl('/api/logistics/enqueue');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, tenantId, cityId })
    });
    if (!response.ok) throw new Error('Failed to enqueue job');
    
    await this.eventService.logEvent(jobId, 'driver_assigned', 'Job enqueued for dispatching');
    
    return await response.json();
  }

    subscribeToJobs(callback: () => void): RealtimeChannel {
        return this.supabase
            .channel('jobs-changes')
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'jobs'
                },
                () => callback()
            )
            .subscribe();
    }

  async retryDispatch(jobId: string, tenantId: string) {
    const { data: job } = await this.supabase
      .from('jobs')
      .select('status, payment_status')
      .eq('id', jobId)
      .single();

    if (job?.payment_status !== 'paid') {
      throw new Error('Cannot dispatch unpaid job');
    }

    await this.updateJobStatus(jobId, 'searching');
    await this.eventService.logEvent(jobId, 'admin_action', 'Manual dispatch retry initiated by admin');
    return this.enqueueJob(jobId, tenantId);
  }

  async markForReview(jobId: string, notes: string) {
    await this.eventService.logEvent(jobId, 'admin_action', `Marked for manual review: ${notes}`);
  }

  async forceCancel(jobId: string, reason: string) {
    const { data, error } = await this.supabase
      .from('jobs')
      .update({ status: 'cancelled' })
      .eq('id', jobId)
      .select()
      .single();
    
    if (error) throw error;
    
    await this.eventService.logEvent(jobId, 'job_cancelled', `Force cancelled by admin: ${reason}`);
    return data as Job;
  }

  async updateLocation(jobId: string, driverId: string, lat: number, lng: number) {
    const { error } = await this.supabase
      .from('job_locations')
      .insert({ job_id: jobId, driver_id: driverId, lat, lng });
    if (error) throw error;
  }

  subscribeToJobLocations(jobId: string, callback: (payload: Record<string, unknown>) => void): RealtimeChannel {
    return this.supabase.client
      .channel(`job_locations_${jobId}`)
      .on('postgres_changes', { 
        event: 'INSERT', 
        schema: 'public', 
        table: 'job_locations',
        filter: `job_id=eq.${jobId}`
      }, callback)
      .subscribe();
  }
}
