import { stripe } from './stripe.service';
import { supabaseAdmin } from './supabase.service';

export class HealthService {
  private static status = {
    stripe: true,
    database: true,
    lastChecked: new Date()
  };

  /**
   * Perform health checks on external dependencies
   */
  static async checkHealth() {
    try {
      // Check Stripe
      await stripe.balance.retrieve();
      this.status.stripe = true;
    } catch (err) {
      console.error('[HealthService] Stripe health check failed:', err);
      this.status.stripe = false;
    }

    try {
      // Check Supabase
      const { error } = await supabaseAdmin.from('profiles').select('id').limit(1);
      this.status.database = !error;
    } catch (err) {
      console.error('[HealthService] Database health check failed:', err);
      this.status.database = false;
    }

    this.status.lastChecked = new Date();
    return this.status;
  }

  static getStatus() {
    return this.status;
  }

  /**
   * Returns true if any critical service is down
   */
  static isSystemDegraded() {
    return !this.status.stripe || !this.status.database;
  }
}
