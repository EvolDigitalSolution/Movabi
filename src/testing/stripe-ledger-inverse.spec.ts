import { describe, it, expect } from 'vitest';
import { ledgerMinorFromStripeApi, stripeApiAmountFromLedger } from '../../server/services/payments/stripe-currency-amounts';

describe('ledgerMinorFromStripeApi (provider-confirmed amount back into the ledger)', () => {
    it('is the exact inverse for the Stripe-configured 2- and 0-decimal currencies', () => {
        expect(ledgerMinorFromStripeApi(400, 'GBP', 2)).toBe(400);
        expect(ledgerMinorFromStripeApi(500, 'JPY', 0)).toBe(500);
        for (const [minor, cur, exp] of [[400, 'GBP', 2], [500, 'JPY', 0], [12345, 'EUR', 2]] as const) {
            expect(ledgerMinorFromStripeApi(stripeApiAmountFromLedger(minor, cur, exp), cur, exp)).toBe(minor);
        }
    });
    it('never rounds: an amount that does not map exactly is refused', () => {
        expect(() => ledgerMinorFromStripeApi(150, 'GBP', 0)).toThrow('STRIPE_AMOUNT_PRECISION_REQUIRES_REVIEW');
        expect(() => ledgerMinorFromStripeApi(-1, 'GBP', 2)).toThrow('INVALID_STRIPE_AMOUNT');
        expect(() => ledgerMinorFromStripeApi(1.5, 'GBP', 2)).toThrow('INVALID_STRIPE_AMOUNT');
        // A currency without a configured Stripe route (e.g. KWD, 3 decimals) is refused, so a card fee in it
        // is never captured or booked; the cancel route fails closed to review.
        expect(() => ledgerMinorFromStripeApi(1500, 'KWD', 3)).toThrow('STRIPE_CURRENCY_NOT_CONFIGURED');
    });
});
