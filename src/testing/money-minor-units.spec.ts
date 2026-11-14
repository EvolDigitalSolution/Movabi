import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
vi.mock('../../server/services/supabase.service', () => ({ supabaseAdmin: {} }));
import { FareSplitService } from '../../server/services/fare-split.service';

/**
 * Shared minor-unit rules (2026-11-14). Promotions and referrals convert MAJOR to MINOR units with:
 *  - API: FareSplitService.toMinorExact (integer arithmetic on the decimal digits; refuses, never rounds);
 *  - database: wallet_currency_minor_exponent + exact numeric arithmetic (earn_referral, cancellation_fee_quote).
 * Both must use the same exponent table.
 */
const exact = (v: number | string, c: string) => FareSplitService.toMinorExact(v, c);

describe('toMinorExact: exact, explicit, no floating point', () => {
  it('converts two-decimal currencies exactly', () => {
    expect(exact(12.5, 'GBP')).toBe(1250);
    expect(exact('12.50', 'GBP')).toBe(1250);
    expect(exact(0.29, 'GBP')).toBe(29);          // 0.29 * 100 is 28.999999999999996 in floating point
    expect(exact(8.2, 'GBP')).toBe(820);          // 8.2 * 100 is 819.9999999999999
    expect(exact(1.15, 'GBP')).toBe(115);         // 1.15 * 100 is 114.99999999999999
    expect(exact(4.35, 'GBP')).toBe(435);         // 4.35 * 100 is 434.99999999999994
    expect(exact(0, 'GBP')).toBe(0);
    expect(exact(1000000.01, 'GBP')).toBe(100000001);
  });
  it('every amount from 0.00 to 500.00 converts to exactly its pence', () => {
    for (let pence = 0; pence <= 50000; pence++) {
      const major = Number((pence / 100).toFixed(2));
      if (exact(major, 'GBP') !== pence) throw new Error(`mismatch at ${pence}`);
    }
  });
  it('zero- and three-decimal currencies', () => {
    expect(exact(1500, 'JPY')).toBe(1500);
    expect(exact('1500.0', 'JPY')).toBe(1500);
    expect(exact(1.234, 'KWD')).toBe(1234);
    expect(exact(1.2, 'KWD')).toBe(1200);
    expect(exact(5000, 'NGN')).toBe(500000);
  });
  it('refuses instead of rounding', () => {
    expect(exact(12.505, 'GBP')).toBeNull();      // more decimals than GBP has
    expect(exact(0.1 + 0.2, 'GBP')).toBeNull();   // 0.30000000000000004
    expect(exact(1500.5, 'JPY')).toBeNull();
    expect(exact(1.2345, 'KWD')).toBeNull();
  });
  it('refuses anything that is not a plain non-negative decimal', () => {
    for (const bad of [-1, NaN, Infinity, 1e21, '1e3', '12,50', '', ' ', '£12.50', '12.5.0', null as any, undefined as any, {} as any])
      expect(exact(bad, 'GBP')).toBeNull();
    expect(exact(12.5, '')).toBeNull();
    expect(exact(12.5, 'gbpx')).toBeNull();
    expect(exact('9007199254740993', 'GBP')).toBeNull();   // beyond the safe integer range
  });
});

describe('the API and database exponent tables are the same', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/baseline/develop_live_public_schema_20261112.sql'), 'utf8');
  const start = sql.indexOf('CREATE FUNCTION public.wallet_currency_minor_exponent(');
  const body = sql.slice(start, sql.indexOf('$_$;', start));
  const list = (exponent: number) => {
    const m = new RegExp(`WHEN p_currency_code IN \\(([^)]*)\\) THEN ${exponent}`).exec(body);
    return (m ? m[1] : '').split(',').map((c) => c.trim().replace(/'/g, '')).filter(Boolean).sort();
  };
  it('zero-decimal and three-decimal lists match develop\'s wallet_currency_minor_exponent', () => {
    expect(start).toBeGreaterThan(0);
    const zero = list(0), three = list(3);
    expect(zero.length).toBeGreaterThan(10);
    expect(three.length).toBeGreaterThan(5);
    for (const c of zero) expect(FareSplitService.currencyExponent(c), c).toBe(0);
    for (const c of three) expect(FareSplitService.currencyExponent(c), c).toBe(3);
    expect([...(FareSplitService as any).ZERO_DECIMAL].sort()).toEqual(zero);
    expect([...(FareSplitService as any).THREE_DECIMAL].sort()).toEqual(three);
    for (const c of ['GBP', 'NGN', 'USD', 'EUR', 'KES', 'GHS', 'ZAR']) expect(FareSplitService.currencyExponent(c), c).toBe(2);
  });
});
