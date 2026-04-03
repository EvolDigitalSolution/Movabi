import { Injectable, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { RealtimeChannel } from '@supabase/supabase-js';
import { Observable, Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class RealtimeService {
  private supabase = inject(SupabaseService);
  private channels: Map<string, RealtimeChannel> = new Map();

  subscribeToTable<T>(table: string, filter: string, callback: (payload: any) => void): RealtimeChannel {
    const channelKey = `${table}-${filter}`;
    if (this.channels.has(channelKey)) {
      return this.channels.get(channelKey)!;
    }

    const channel = this.supabase
      .channel(channelKey)
      .on('postgres_changes', { 
        event: '*', 
        schema: 'public', 
        table,
        filter
      }, payload => {
        callback(payload);
      })
      .subscribe();

    this.channels.set(channelKey, channel);
    return channel;
  }

  unsubscribe(channelKey: string) {
    const channel = this.channels.get(channelKey);
    if (channel) {
      channel.unsubscribe();
      this.channels.delete(channelKey);
    }
  }

  trackDriverLocation(driverId: string): Observable<{ lat: number, lng: number }> {
    const locationSubject = new Subject<{ lat: number, lng: number }>();
    
    this.subscribeToTable<{ lat: number, lng: number }>('driver_locations', `driver_id=eq.${driverId}`, (payload) => {
      if (payload.new) {
        locationSubject.next(payload.new);
      }
    });

    return locationSubject.asObservable();
  }

  async updateLocation(driverId: string, lat: number, lng: number) {
    const { error } = await this.supabase
      .from('driver_locations')
      .upsert({
        driver_id: driverId,
        lat,
        lng,
        updated_at: new Date().toISOString()
      });
    
    if (error) throw error;
  }

  cleanup() {
    this.channels.forEach(channel => channel.unsubscribe());
    this.channels.clear();
  }
}
