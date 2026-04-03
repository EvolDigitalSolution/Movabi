import { getSupabaseAdmin } from './supabase.service';

export class EventService {
  private static get supabase() {
    return getSupabaseAdmin();
  }

  /**
   * Log an event to the database
   */
  static async logEvent(type: string, payload: any, tenantId?: string, userId?: string) {
    try {
      const { error } = await this.supabase
        .from('events')
        .insert({
          type,
          payload,
          tenant_id: tenantId,
          user_id: userId
        });
      
      if (error) throw error;
    } catch (error) {
      console.error('Event Logging Error:', error);
    }
  }
}
