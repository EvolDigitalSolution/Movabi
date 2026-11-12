import { describe, it, expect } from 'vitest';
import { cancellationFeeMessage, formatQuotedMinor } from '../app/shared/utils/cancellation-fee-preview';

const base = { due: false, reasonCode: 'no_active_policy', feeMinor: 0, currency: 'GBP', exponent: 2, graceSeconds: 300, graceUntil: null, driverAssigned: true };

describe('customer cancellation fee message (states the server quote)', () => {
    it('formats with the exponent the server returned (0, 2, 3 decimals)', () => {
        expect(formatQuotedMinor(400, 'GBP', 2)).toBe('GBP 4.00');
        expect(formatQuotedMinor(1500, 'JPY', 0)).toBe('JPY 1,500');
        expect(formatQuotedMinor(1000, 'KWD', 3)).toBe('KWD 1.000');
        expect(formatQuotedMinor(-1, 'GBP', 2)).toBe('an amount we could not display');
    });
    it('states a due fee with its amount', () => {
        expect(cancellationFeeMessage({ ...base, due: true, reasonCode: 'due', feeMinor: 400 }))
            .toBe('A cancellation fee of GBP 4.00 applies because your driver accepted this booking and the free cancellation period has ended.');
    });
    it('states the free period, no fee, and a failed check distinctly', () => {
        expect(cancellationFeeMessage({ ...base, reasonCode: 'within_grace' })).toContain('without a fee');
        expect(cancellationFeeMessage(base)).toBe('No cancellation fee applies.');
        expect(cancellationFeeMessage(null)).toContain('could not check');
    });
});
