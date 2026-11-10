import { supabaseAdmin } from './supabase.service';
import { stripe } from './stripe.service';
import { FareSplitService } from './fare-split.service';
export const historyTerminalStatuses = new Set(['completed','settled','cancelled','canceled','failed','expired','no_driver_found','refunded']);
export function assertBookingParticipant(job: any, userId: string): 'customer' | 'driver' {
  if (!job || !userId) throw Object.assign(new Error('Booking unavailable'), { status: 404 });
  if (job.customer_id === userId) return 'customer';
  if ((job.driver_id || job.accepted_driver_id) === userId) return 'driver';
  throw Object.assign(new Error('Only booking participants can view this record'), { status: 403 });
}
export class BookingHistoryService {
  static async participantJob(jobId: string, userId: string) {
    const result = await supabaseAdmin.from('jobs').select('*, service_type:service_types(name,slug)').eq('id',jobId).maybeSingle();
    if (result.error) throw new Error('Booking could not be loaded');
    assertBookingParticipant(result.data,userId);
    return result.data;
  }
  static async load(jobId: string, userId: string) {
    const j = await this.participantJob(jobId,userId);
    const viewer = assertBookingParticipant(j,userId);
    const driverId = j.driver_id || j.accepted_driver_id;
    const driver = driverId ? await supabaseAdmin.from('profiles').select('full_name').eq('id',driverId).maybeSingle() : null;
    const b = j.fare_breakdown || {};
    const currency = String(j.currency_code || b.currency || 'GBP').toUpperCase();
    const value = (v: any): number | null => v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null;
    let receipt: any = { verified: false, amount: null, currency };
    // The history page never creates, captures, refunds or transfers a payment.
    if (j.payment_intent_id) {
      try {
        const p = await stripe.paymentIntents.retrieve(j.payment_intent_id,{}, {timeout:8000,maxNetworkRetries:0});
        if (p.metadata?.jobId === j.id && p.currency.toUpperCase() === currency) {
          receipt = { verified: true, status: p.status, amount: p.status === 'succeeded' ? FareSplitService.fromMinor(p.amount_received,currency) : null, currency };
        }
      } catch { /* Persisted status remains visible; no invented receipt amount. */ }
    }
    let rating: any = null;
    if (viewer === 'customer') {
      let r = await supabaseAdmin.from('ratings').select('score,comment').eq('job_id',j.id).eq('customer_id',userId).maybeSingle();
      if (r.error?.code === '42703') r = await supabaseAdmin.from('ratings').select('score,comment').eq('booking_id',j.id).eq('customer_id',userId).maybeSingle();
      if (!r.error) rating = r.data;
    }
    const service = Array.isArray(j.service_type) ? j.service_type[0] : j.service_type;
    return {
      id:j.id,viewer,status:j.status,terminal:historyTerminalStatuses.has(String(j.status).toLowerCase()),
      serviceName:service?.name || j.service_slug || 'Booking',serviceSlug:service?.slug || j.service_slug || '',
      createdAt:j.created_at,completedAt:j.completed_at || null,cancelledAt:j.cancelled_at || null,
      pickupAddress:j.pickup_address || null,dropoffAddress:j.dropoff_address || j.destination_address || null,
      driverName:driver?.data?.full_name || null,
      cancellationReason:j.cancellation_reason || j.cancel_reason || j.metadata?.cancellation_reason || null,
      currency,serviceFare:value(j.agreed_fare) ?? value(b.customerCharge) ?? value(j.total_price),
      shoppingBudget:value(b.shoppingBudget),platformFee:value(b.platformFeeAmount),
      driverCommission:viewer==='driver'?value(b.driverCommissionAmount):null,
      driverEarnings:viewer==='driver'?value(j.driver_payout) ?? value(b.driverEntitlement):null,
      transferStatus:viewer==='driver'?String(j.stripe_transfer_status || j.settlement_status || 'pending'):null,
      paymentStatus:String(j.payment_status || 'pending'),paymentMethod:j.payment_method || null,
      refundedMinor:value(j.total_refunded_minor),refundedAmount:value(j.total_refunded_minor)!==null?FareSplitService.fromMinor(Number(j.total_refunded_minor),currency):null,receipt,rating,
      canRate:viewer==='customer' && ['completed','settled'].includes(j.status),
      canReportLostItem:viewer==='customer' && !!driverId && ['completed','settled'].includes(j.status)
    };
  }
}
