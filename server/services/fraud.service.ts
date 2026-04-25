import { supabaseAdmin } from './supabase.service';
import { EventService } from './event.service';

export class FraudService {
  /**
   * Check if a user is flagged for excessive cancellations
   */
  static async checkCancellationAbuse(
    userId: string
  ): Promise<{ isAbusing: boolean; reason?: string }> {
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('cancel_count, account_status')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      return { isAbusing: false };
    }

    if (profile.account_status === 'suspended') {
      return { isAbusing: true, reason: 'Account is already suspended' };
    }

    if ((profile.cancel_count || 0) >= 10) {
      return { isAbusing: true, reason: 'Excessive cancellations detected' };
    }

    return { isAbusing: false };
  }

  /**
   * Increment cancellation count and potentially suspend account
   */
  static async trackCancellation(userId: string) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('cancel_count')
      .eq('id', userId)
      .single();

    const newCount = (profile?.cancel_count || 0) + 1;

    await supabaseAdmin
      .from('profiles')
      .update({ cancel_count: newCount })
      .eq('id', userId);

    if (newCount >= 10) {
      await supabaseAdmin
        .from('profiles')
        .update({
          account_status: 'suspended',
          moderation_reason: 'Automatic suspension: Excessive cancellations'
        })
        .eq('id', userId);

    await EventService.logEvent(
   'system',
   'fraud_abuse_detected',
   `Cancellation abuse detected for user ${userId}`,
    JSON.stringify({
    userId,
    cancelCount: newCount
    })
    );      

    }
  }

  /**
   * Check for suspicious wallet activity
   */
  static async checkWalletAbuse(
    userId: string,
    amount: number
  ): Promise<{ isSuspicious: boolean; reason?: string }> {
    if (amount > 1000) {
      return { isSuspicious: true, reason: 'Single top-up exceeds limit' };
    }

    const oneHourAgo = new Date();
    oneHourAgo.setHours(oneHourAgo.getHours() - 1);

    const { count } = await supabaseAdmin
      .from('wallet_transactions')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('type', 'credit')
      .gte('created_at', oneHourAgo.toISOString());

    if ((count || 0) >= 5) {
      return { isSuspicious: true, reason: 'High frequency of wallet top-ups' };
    }

    return { isSuspicious: false };
  }
}
