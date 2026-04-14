import { getSupabaseAdmin } from './supabase.service';
import { EventEmitter } from 'events';

export class EventService extends EventEmitter {
  private static instance: EventService;
  
  private constructor() {
    super();
  }

  static getInstance(): EventService {
    if (!EventService.instance) {
      EventService.instance = new EventService();
    }
    return EventService.instance;
  }

  private static get supabase() {
    return getSupabaseAdmin();
  }

  /**
   * Log an event to the database and emit it locally
   */
  static async logEvent(type: string, payload: any, tenantId?: string, userId?: string) {
    try {
      // 1. Persist to DB
      const { error } = await this.supabase
        .from('events')
        .insert({
          type,
          payload,
          tenant_id: tenantId,
          user_id: userId
        });
      
      if (error) throw error;

      // 2. Emit locally for background workers
      EventService.getInstance().emit(type, { payload, tenantId, userId });
      
    } catch (error) {
      console.error('Event Logging Error:', error);
    }
  }

  /**
   * Simple background task runner (Lightweight Queue)
   */
  static async runBackgroundTask(name: string, task: () => Promise<void>) {
    console.log(`[Queue] Starting task: ${name}`);
    // Use setImmediate to run in next tick, not blocking current request
    setImmediate(async () => {
      try {
        await task();
        console.log(`[Queue] Task completed: ${name}`);
      } catch (error) {
        console.error(`[Queue] Task failed: ${name}`, error);
      }
    });
  }
}
