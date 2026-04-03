import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { Job, JobStatus, JobEstimate, DispatchCandidate } from '@shared/models/booking.model';
import { RealtimeChannel } from '@supabase/supabase-js';

@Injectable({
  providedIn: 'root'
})
export class JobService {
  private supabase = inject(SupabaseService);

  /**
   * Calculate price via Node backend
   */
  async calculatePrice(pickup: { lat: number, lng: number }, dropoff: { lat: number, lng: number }) {
    const response = await fetch('/api/logistics/calculate-price', {
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
    const response = await fetch('/api/logistics/suggest-drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng, tenant_id: tenantId })
    });
    if (!response.ok) throw new Error('Failed to suggest drivers');
    return await response.json() as DispatchCandidate[];
  }

  async createJob(job: Partial<Job>) {
    const { data, error } = await this.supabase
      .from('jobs')
      .insert(job)
      .select()
      .single();
    if (error) throw error;
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
    return data as any[];
  }

  async enqueueJob(jobId: string, tenantId: string, cityId?: string) {
    const response = await fetch('/api/logistics/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, tenantId, cityId })
    });
    if (!response.ok) throw new Error('Failed to enqueue job');
    return await response.json();
  }

  subscribeToJobs(callback: (payload: any) => void): RealtimeChannel {
    return this.supabase.client
      .channel('public:jobs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, callback)
      .subscribe();
  }

  async updateLocation(jobId: string, driverId: string, lat: number, lng: number) {
    const { error } = await this.supabase
      .from('job_locations')
      .insert({ job_id: jobId, driver_id: driverId, lat, lng });
    if (error) throw error;
  }

  subscribeToJobLocations(jobId: string, callback: (payload: any) => void): RealtimeChannel {
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
