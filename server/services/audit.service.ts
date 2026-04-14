import { supabaseAdmin } from './supabase.service';

export class AuditService {
  /**
   * Log an action to the audit_logs table
   */
  static async log(params: {
    userId?: string;
    action: string;
    entityType: string;
    entityId?: string;
    metadata?: any;
  }) {
    try {
      const { error } = await supabaseAdmin
        .from('audit_logs')
        .insert({
          user_id: params.userId,
          action: params.action,
          entity_type: params.entityType,
          entity_id: params.entityId,
          metadata: params.metadata || {}
        });

      if (error) {
        console.error('[AuditService] Error logging audit event:', error);
      }
    } catch (err) {
      console.error('[AuditService] Unexpected error:', err);
    }
  }

  /**
   * Helper for payment events
   */
  static async logPayment(userId: string, action: string, paymentIntentId: string, metadata?: any) {
    return this.log({
      userId,
      action,
      entityType: 'payment',
      entityId: paymentIntentId,
      metadata
    });
  }

  /**
   * Helper for booking events
   */
  static async logBooking(userId: string, action: string, bookingId: string, metadata?: any) {
    return this.log({
      userId,
      action,
      entityType: 'booking',
      entityId: bookingId,
      metadata
    });
  }

  /**
   * Helper for admin actions
   */
  static async logAdminAction(adminId: string, action: string, entityType: string, entityId: string, metadata?: any) {
    return this.log({
      userId: adminId,
      action: `admin_${action}`,
      entityType,
      entityId,
      metadata
    });
  }
}
