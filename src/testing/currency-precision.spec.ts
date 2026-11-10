import { describe, it, expect } from 'vitest';
import { FareSplitService } from '../../server/services/fare-split.service';

describe('currency precision at the adapter/settlement boundary', () => {
  it('GBP major -> minor', () => {
    expect(FareSplitService.toMinor(6.66, 'GBP')).toBe(666);
  });
  it('JPY (zero-decimal) major -> minor, no x100', () => {
    expect(FareSplitService.toMinor(666, 'JPY')).toBe(666);
  });
  it('KWD (three-decimal) major -> minor', () => {
    expect(FareSplitService.toMinor(6.666, 'KWD')).toBe(6666);
  });
  it('round-trips exactly with no double conversion', () => {
    for (const [v, c] of [[6.66, 'GBP'], [666, 'JPY'], [6.666, 'KWD']] as const) {
      expect(FareSplitService.toMinor(FareSplitService.fromMinor(FareSplitService.toMinor(v, c), c), c)).toBe(FareSplitService.toMinor(v, c));
    }
  });
  it('excess precision rounds to the currency exponent, never truncates to 0', () => {
    expect(FareSplitService.toMinor(6.666, 'GBP')).toBe(667);
    expect(FareSplitService.currencyExponent('JPY')).toBe(0);
    expect(FareSplitService.currencyExponent('KWD')).toBe(3);
  });
});

