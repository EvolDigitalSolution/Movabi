import { describe, expect, it, vi } from 'vitest';
vi.mock('../../server/services/supabase.service', () => ({ supabaseAdmin: {} }));
import { financeBooking, dayInZone, reportBounds } from '../../server/services/admin-finance.service';
const row = { id:'job-1',tenant_id:'tenant-1',country_code:'GB',currency_code:'GBP',completed_at:'2026-10-10T12:00:00Z',payment_method:'wallet',payment_status:'paid',total_price:7.07,commission_fee:0.69,platform_fee:0.14,driver_payout:6.24,total_service_refunded_minor:0,stripe_transfer_status:'pending' };
describe('admin daily financial reporting',()=>{
 it('uses stored historical commission rather than current rate',()=>{const b=financeBooking(row);expect(b.commission).toBe(.69);expect(b.platformIncome).toBeCloseTo(.83);expect(b.driverEarnings).toBe(6.24);expect(b.splitValid).toBe(true);});
 it('flags incomplete split and never assumes missing fees mean zero',()=>{expect(financeBooking({...row,commission_fee:null}).splitValid).toBe(false);});
 it('flags unreconciled payout split',()=>{expect(financeBooking({...row,driver_payout:6.93}).splitValid).toBe(false);});
 it('preserves zero commission for Pro bookings',()=>{expect(financeBooking({...row,commission_fee:0,driver_payout:6.93}).splitValid).toBe(true);});
 it('does not assign unknown currency or region to GB/GBP',()=>{const b=financeBooking({...row,currency_code:null,country_code:null});expect(b.currency).toBe('UNKNOWN');expect(b.country).toBe('UNKNOWN');});
 it('uses London completion date across summer midnight',()=>{expect(dayInZone('2026-10-09T23:30:00Z','Europe/London')).toBe('2026-10-10');});
 it('handles London DST change without a fixed UTC offset',()=>{expect(dayInZone('2026-10-24T23:30:00Z','Europe/London')).toBe('2026-10-25');expect(dayInZone('2026-10-25T23:30:00Z','Europe/London')).toBe('2026-10-25');});
 it('rejects invalid dates and timezones',()=>{expect(()=>reportBounds('2026-02-30','Europe/London')).toThrow();expect(()=>reportBounds('2026-10-10','Unknown/City')).toThrow();});
 it('uses currency-specific minor units for recorded refunds',()=>{expect(financeBooking({...row,currency_code:'JPY',total_service_refunded_minor:100}).serviceRefunds).toBe(100);expect(financeBooking({...row,total_service_refunded_minor:123}).serviceRefunds).toBe(1.23);});
});
