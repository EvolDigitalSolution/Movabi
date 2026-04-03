import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from '../auth/auth.service';
import { DriverLocation } from '@shared/models/booking.model';
import { RealtimeChannel } from '@supabase/supabase-js';

@Injectable({
  providedIn: 'root'
})
export class LocationService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);

  private updateInterval: any;

  /**
   * Start tracking driver location and sending updates to Supabase
   */
  startTracking(tenantId: string) {
    if (this.updateInterval) return;

    // Initial update
    this.trackOnce(tenantId);

    this.updateInterval = setInterval(() => {
      this.trackOnce(tenantId);
    }, 10000); // Send every 10 seconds as per performance rules
  }

  private trackOnce(tenantId: string) {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const { latitude, longitude, heading, speed } = position.coords;
          await this.updateDriverLocation(tenantId, latitude, longitude, heading || undefined, speed || undefined);
        },
        (error) => console.error('Geolocation error:', error),
        { enableHighAccuracy: true }
      );
    }
  }

  stopTracking() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  private async updateDriverLocation(tenantId: string, lat: number, lng: number, heading?: number, speed?: number) {
    const user = this.auth.currentUser();
    if (!user) return;

    const { error } = await this.supabase
      .from('driver_locations')
      .upsert({
        driver_id: user.id,
        tenant_id: tenantId,
        lat,
        lng,
        heading,
        speed,
        updated_at: new Date().toISOString()
      }, { onConflict: 'driver_id' });

    if (error) console.error('Failed to update driver location:', error);
  }

  /**
   * Subscribe to a specific driver's location updates
   */
  subscribeToDriverLocation(driverId: string, callback: (location: DriverLocation) => void): RealtimeChannel {
    return this.supabase.client
      .channel(`driver-location:${driverId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'driver_locations',
        filter: `driver_id=eq.${driverId}`
      }, (payload) => {
        callback(payload.new as DriverLocation);
      })
      .subscribe();
  }

  /**
   * Subscribe to ALL driver location updates for a tenant (Admin only)
   */
  subscribeToAllTenantLocations(tenantId: string, callback: (location: DriverLocation) => void): RealtimeChannel {
    return this.supabase.client
      .channel(`tenant-locations:${tenantId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'driver_locations',
        filter: `tenant_id=eq.${tenantId}`
      }, (payload) => {
        callback(payload.new as DriverLocation);
      })
      .subscribe();
  }
}
