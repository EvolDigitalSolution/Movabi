import { getSupabaseAdmin } from './supabase.service';
import { Job, JobQueueItem, DispatchResult } from '../../src/app/shared/models/booking.model';
import { EventService } from './event.service';

export class DispatchService {
  private get supabase() {
    return getSupabaseAdmin();
  }

  /**
   * Main dispatch engine loop
   */
  async runDispatchEngine() {
    try {
      // 1. Fetch waiting jobs from queue
      const { data: queueItems, error: queueError } = await this.supabase
        .from('job_queue')
        .select(`
          *,
          job:job_id (*)
        `)
        .eq('status', 'waiting')
        .lt('expires_at', new Date().toISOString());

      if (queueError) throw queueError;
      if (!queueItems || queueItems.length === 0) return;

      for (const item of queueItems) {
        await this.dispatchJob(item);
      }
    } catch (error) {
      console.error('Dispatch Engine Error:', error);
    }
  }

  /**
   * Dispatch a single job
   */
  private async dispatchJob(item: any): Promise<DispatchResult> {
    const job = item.job as Job;
    const cityId = item.city_id;
    const tenantId = item.tenant_id;

    try {
      // 2. Find best driver using load balancing function
      const { data: driverId, error: rpcError } = await this.supabase
        .rpc('get_least_recently_assigned_driver', {
          p_city_id: cityId,
          p_tenant_id: tenantId
        });

      if (rpcError) throw rpcError;

      if (!driverId) {
        // No driver found, check if expired
        if (new Date(item.expires_at) < new Date()) {
          await this.supabase
            .from('job_queue')
            .update({ status: 'expired' })
            .eq('id', item.id);
        }
        return { success: false, job_id: job.id, message: 'No available drivers' };
      }

      // 3. Assign job to driver
      const { error: assignError } = await this.supabase
        .from('jobs')
        .update({ 
          driver_id: driverId,
          status: 'accepted' // Auto-accept for this driver
        })
        .eq('id', job.id);

      if (assignError) throw assignError;

      // 4. Update queue status
      await this.supabase
        .from('job_queue')
        .update({ status: 'assigned' })
        .eq('id', item.id);

      // 5. Update driver last active
      await this.supabase
        .from('profiles')
        .update({ last_active_at: new Date().toISOString() })
        .eq('id', driverId);

      // 6. Log dispatch event
      await EventService.logEvent('job_assigned', { 
        jobId: job.id, 
        driverId,
        cityId,
        tenantId
      }, tenantId, driverId);

      // 7. Create dispatch log for AI
      await this.supabase
        .from('dispatch_logs')
        .insert({
          job_id: job.id,
          driver_id: driverId,
          accepted: true,
          distance: job.estimated_distance
        });

      return { success: true, job_id: job.id, driver_id: driverId };
    } catch (error) {
      console.error(`Error dispatching job ${job.id}:`, error);
      return { success: false, job_id: job.id, message: String(error) };
    }
  }

  /**
   * Add a job to the dispatch queue
   */
  async enqueueJob(jobId: string, tenantId: string, cityId?: string, timeoutSeconds: number = 300) {
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + timeoutSeconds);

    const result = await this.supabase
      .from('job_queue')
      .insert({
        job_id: jobId,
        tenant_id: tenantId,
        city_id: cityId,
        status: 'waiting',
        expires_at: expiresAt.toISOString()
      });

    if (!result.error) {
      await EventService.logEvent('job_enqueued', { jobId, cityId, tenantId }, tenantId);
    }

    return result;
  }
}

export const dispatchService = new DispatchService();
