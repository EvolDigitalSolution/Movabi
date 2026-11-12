import { describe, it, expect } from 'vitest';
import { driverCancellationSummary, excludedCancellationSummary } from '../app/shared/models/driver-offer-metrics';

const none = { customer: 0, admin: 0, otherDriver: 0, customerNoShow: 0 };

describe('driver cancellation summaries (D9: driver-initiated only)', () => {
    it('states the counted cancellations and how many were handbacks', () => {
        expect(driverCancellationSummary({ driverCancellations: 2, acceptedBookings: 12, driverHandoffs: 1 })).toBe('2 of 12 bookings (1 handed back)');
        expect(driverCancellationSummary({ driverCancellations: 1, acceptedBookings: 1, driverHandoffs: 0 })).toBe('1 of 1 booking');
    });

    it('lists what was not counted, and nothing when there is nothing to list', () => {
        expect(excludedCancellationSummary({ excludedCancellations: none, unattributedCancellations: 0 })).toBe('');
        expect(excludedCancellationSummary({ excludedCancellations: { customer: 3, admin: 1, otherDriver: 1, customerNoShow: 2 }, unattributedCancellations: 4 }))
            .toBe('Not counted: 3 by customer, 2 customer no-show, 1 by support, 1 after reassignment, 4 with no recorded actor.');
    });
});
