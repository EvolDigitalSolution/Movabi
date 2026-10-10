import { supabaseAdmin } from './supabase.service';
import type { FinanceBooking, FinancePayout, FinanceReport } from '../../src/app/shared/models/admin-finance.model';

export function dayInZone(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const get = (key: string) => parts.find(p => p.type === key)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function reportBounds(date: string, timezone: string) {
  new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid report date');
  const stamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== date) throw new Error('Invalid report date');
  // Broad UTC envelope includes local midnight in every timezone, including DST.
  // Rows are then matched to the exact local completion date.
  return { start: new Date(stamp - 36 * 3600000).toISOString(), end: new Date(stamp + 60 * 3600000).toISOString() };
}
const amount = (v: unknown) => v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const currencyCode = (v: unknown) => /^[A-Za-z]{3}$/.test(String(v || '')) ? String(v).toUpperCase() : 'UNKNOWN';
export function financeBooking(row: Record<string, unknown>): FinanceBooking {
  const total = amount(row.total_price ?? row.price);
  const commission = amount(row.commission_fee);
  const platform = amount(row.platform_fee);
  const driver = amount(row.driver_payout);
  const currency = currencyCode(row.currency_code);
  const digits = currency === 'UNKNOWN' ? 2 : new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  const factor = 10 ** digits;
  const splitValid = [total, commission, platform, driver].every(v => v !== null && v >= 0)
    && Math.abs(Math.round(total! * factor) - Math.round(commission! * factor) - Math.round(platform! * factor) - Math.round(driver! * factor)) <= 1;
  return {
    id: String(row.id), tenantId: String(row.tenant_id || 'UNKNOWN'), country: String(row.country_code || 'UNKNOWN').toUpperCase(), currency,
    completedAt: String(row.completed_at), paymentMethod: String(row.payment_method || 'unknown'), paymentStatus: String(row.payment_status || 'unknown'),
    customerPayments: total ?? 0, commission: commission ?? 0, platformFee: platform ?? 0,
    platformIncome: (commission ?? 0) + (platform ?? 0), driverEarnings: driver ?? 0,
    serviceRefunds: Number(row.total_service_refunded_minor || 0) / factor,
    splitValid, transferStatus: String(row.stripe_transfer_status || 'not recorded'), transferId: row.stripe_transfer_id ? String(row.stripe_transfer_id) : null
  };
}
export class AdminFinanceService {
  static async report(date: string, timezone: string): Promise<FinanceReport> {
    const bounds = reportBounds(date, timezone);
    const { count: undatedCount, error: undatedError } = await supabaseAdmin.from('jobs')
      .select('id', { count: 'exact', head: true }).eq('status', 'completed').is('completed_at', null);
    if (undatedError) throw undatedError;
    const bookings: FinanceBooking[] = [];
    for (let offset = 0; ; offset += 500) {
      if (offset >= 20000) throw new Error('Report exceeds 20,000 bookings; contact support for an export');
      const { data, error } = await supabaseAdmin.from('jobs')
        .select('id,tenant_id,country_code,currency_code,completed_at,payment_method,payment_status,total_price,price,commission_fee,platform_fee,driver_payout,total_service_refunded_minor,stripe_transfer_status,stripe_transfer_id')
        .eq('status', 'completed').gte('completed_at', bounds.start).lt('completed_at', bounds.end)
        .order('completed_at').order('id').range(offset, offset + 499);
      if (error) throw error;
      for (const row of data || []) if (dayInZone(row.completed_at, timezone) === date) bookings.push(financeBooking(row));
      if (!data || data.length < 500) break;
    }
    const outstandingPayouts: FinancePayout[] = [];
    for (let offset = 0; ; offset += 500) {
      if (offset >= 20000) throw new Error('Outstanding payout report exceeds its safe limit');
      const { data, error } = await supabaseAdmin.from('job_payout_queue')
        .select('job_id,currency,amount_minor,status,last_error,terms')
        .in('status', ['pending', 'processing', 'reconcile', 'blocked']).order('job_id').range(offset, offset + 499);
      if (error) throw error;
      for (const row of data || []) {
        const currency = currencyCode(row.currency);
        const digits = currency === 'UNKNOWN' ? 2 : new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
        outstandingPayouts.push({ id: row.job_id, country: String(row.terms?.country || 'UNKNOWN').toUpperCase(), currency,
          amount: Number(row.amount_minor) / (10 ** digits), status: row.status, error: row.last_error });
      }
      if (!data || data.length < 500) break;
    }
    return { date, timezone, generatedAt: new Date().toISOString(), undatedCompletedCount: undatedCount || 0, bookings, outstandingPayouts };
  }
}
