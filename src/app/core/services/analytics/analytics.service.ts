import { Injectable, signal } from '@angular/core';

export type AnalyticsEvent = 
  | 'location_permission_requested'
  | 'location_permission_denied'
  | 'location_permission_timeout'
  | 'location_auto_mode_used'
  | 'location_manual_mode_selected'
  | 'location_map_selection_used'
  | 'location_manual_address_entered'
  | 'location_retry_clicked'
  | 'booking_created'
  | 'booking_created_with_gps'
  | 'booking_created_with_manual_address'
  | 'booking_created_with_map_selection';

@Injectable({
  providedIn: 'root'
})
export class AnalyticsService {
  private events = signal<{ name: string, payload: Record<string, unknown>, timestamp: string }[]>([]);

  /**
   * Track an event with optional payload
   */
  track(eventName: AnalyticsEvent, payload: Record<string, unknown> = {}) {
    const event = {
      name: eventName,
      payload,
      timestamp: new Date().toISOString()
    };

    // Log to console for debug visibility in dev
    console.log(`[Analytics] ${eventName}`, payload);

    // Store internally for potential debugging or batch sending
    this.events.update(prev => [...prev, event]);

    // Here you would typically send to a real provider like Mixpanel, PostHog, or Supabase
  }

  /**
   * Get all tracked events (useful for debugging)
   */
  getEvents() {
    return this.events();
  }
}
