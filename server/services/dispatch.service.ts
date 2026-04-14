import { getSupabaseAdmin } from './supabase.service';
import { Job, JobQueueItem, DispatchResult } from '../../src/app/shared/models/booking.model';
import { EventService } from './event.service';
import { NotificationService } from './notification.service';

export class DispatchService {
  private get supabase() {
    return getSupabaseAdmin();
  }

  /**
   * Main dispatch engine loop
   */
  async runDispatchEngine() {
    try {
      // 1. Cleanup stale bookings
      await this.cleanupStaleBookings();

      // 2. Fetch waiting jobs from queue
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
   * Cleanup stale bookings that are stuck in searching or assigned without progress
   */
  private async cleanupStaleBookings() {
    const searchingThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 mins
    const assignedThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 mins

    // 1. Handle stale searching bookings
    const { data: staleSearching } = await this.supabase
      .from('jobs')
      .select('id, payment_intent_id')
      .eq('status', 'searching')
      .lt('created_at', searchingThreshold);

    if (staleSearching && staleSearching.length > 0) {
      console.log(`[DispatchService] Cleaning up ${staleSearching.length} stale searching bookings`);
      for (const job of staleSearching) {
        await this.supabase
          .from('jobs')
          .update({ 
            status: 'no_driver_found',
            updated_at: new Date().toISOString()
          })
          .eq('id', job.id);
        
        // Log event
        await EventService.logEvent('job_cleanup', { jobId: job.id, reason: 'searching_timeout' });
      }
    }

    // 2. Handle stale assigned bookings (no progress)
    const { data: staleAssigned } = await this.supabase
      .from('jobs')
      .select('id')
      .eq('status', 'assigned')
      .lt('accepted_at', assignedThreshold);

    if (staleAssigned && staleAssigned.length > 0) {
      console.log(`[DispatchService] Cleaning up ${staleAssigned.length} stale assigned bookings`);
      for (const job of staleAssigned) {
        await this.supabase
          .from('jobs')
          .update({ 
            status: 'cancelled',
            cancellation_reason: 'System cleanup: Stale assignment',
            updated_at: new Date().toISOString()
          })
          .eq('id', job.id);
      }
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
      // 2. Find best driver using geo-aware bounding box + load balancing
      // We look for drivers within ~5km (0.05 degrees)
      const { data: drivers, error: driverError } = await this.supabase
        .from('profiles')
        .select('id')
        .eq('role', 'driver')
        .eq('is_available', true)
        .gte('lat', job.pickup_lat - 0.05)
        .lte('lat', job.pickup_lat + 0.05)
        .gte('lng', job.pickup_lng - 0.05)
        .lte('lng', job.pickup_lng + 0.05)
        .limit(10);

      if (driverError) throw driverError;

      let driverId = null;
      if (drivers && drivers.length > 0) {
        // For simplicity in this version, we take the first one.
        // In a more advanced version, we'd use the RPC to pick the least recently assigned among these.
        driverId = drivers[0].id;
      }

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

      // 6.5 Send Notifications
      await NotificationService.notifyJobStatusUpdate(job.customer_id, job.id, 'accepted');
      await NotificationService.sendNotification({
        userId: driverId,
        title: 'Job Assigned',
        body: 'You have been assigned a new booking. Please check the app.',
        type: 'booking_update',
        data: { jobId: job.id }
      });

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
      
      // Notify nearby drivers
      const { data: job } = await this.supabase.from('jobs').select('pickup_lat, pickup_lng').eq('id', jobId).single();
      if (job) {
        const { data: drivers } = await this.supabase
          .from('profiles')
          .select('id')
          .eq('role', 'driver')
          .eq('is_available', true)
          .gte('lat', job.pickup_lat - 0.05)
          .lte('lat', job.pickup_lat + 0.05)
          .gte('lng', job.pickup_lng - 0.05)
          .lte('lng', job.pickup_lng + 0.05)
          .limit(20);

        if (drivers) {
          for (const driver of drivers) {
            await NotificationService.notifyNewJob(driver.id, jobId);
          }
        }
      }
    }

    return result;
  }

  /**
   * Get demand and supply stats for an area
   */
  async getAreaStats(lat: number, lng: number, radius: number = 0.05) {
    const { count: demand } = await this.supabase
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'searching')
      .gte('pickup_lat', lat - radius)
      .lte('pickup_lat', lat + radius)
      .gte('pickup_lng', lng - radius)
      .lte('pickup_lng', lng + radius);

    const { count: supply } = await this.supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('role', 'driver')
      .eq('is_available', true)
      .gte('lat', lat - radius)
      .lte('lat', lat + radius)
      .gte('lng', lng - radius)
      .lte('lng', lng + radius);

    return { demand: demand || 0, supply: supply || 0 };
  }
}

export const dispatchService = new DispatchService();
