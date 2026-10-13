import { describe, expect, it } from 'vitest';
import { actionableDriverRequests, liveRequestSelection, driverHasCurrentWork } from '../app/shared/utils/driver-request-feed';
import { Booking } from '../app/shared/models/booking.model';
const job = (changes = {}) => ({ id: 'request', status: 'searching', payment_status: 'authorized', driver_id: null, ...changes } as Booking);
describe('driver request feed eligibility', () => {
    it('includes paid and wallet-funded requests waiting for drivers', () => {
        expect(actionableDriverRequests([job(), job({ id: 'wallet', status: 'waiting', payment_status: 'wallet_funded' })]).map(j => j.id)).toEqual(['request', 'wallet']);
    });
    it('removes a request as soon as another driver claims it', () => {
        expect(actionableDriverRequests([job({ driver_id: 'other-driver' })])).toEqual([]);
    });
    it('does not offer cancelled, completed, accepted or unpaid jobs', () => {
        expect(actionableDriverRequests(['cancelled', 'completed', 'accepted'].map(status => job({ status })))).toEqual([]);
        expect(actionableDriverRequests([job({ payment_status: 'pending' })])).toEqual([]);
    });
});
describe('live request selection', () => {
    it('keeps the preview while another request arrives', () => {
        expect(liveRequestSelection(['new', 'chosen'], 'chosen')).toBe('chosen');
    });
    it('moves to the remaining request when the current one is taken', () => {
        expect(liveRequestSelection(['remaining'], 'taken')).toBe('remaining');
    });
    it('clears the preview when no requests remain', () => {
        expect(liveRequestSelection([], 'gone')).toBeNull();
    });
});

describe('request acceptance during current work', () => {
    it('blocks another acceptance while an assigned job or negotiation is active', () => {
        expect(driverHasCurrentWork(job({ status: 'en_route_to_customer' }), null, 0)).toBe(true);
        expect(driverHasCurrentWork(null, { status: 'negotiating' }, 0)).toBe(true);
        expect(driverHasCurrentWork(null, null, 1)).toBe(true);
    });
    it('allows acceptance again after work finishes', () => {
        expect(driverHasCurrentWork(job({ status: 'completed' }), { status: 'completed' }, 0)).toBe(false);
        expect(driverHasCurrentWork(null, null, 0)).toBe(false);
    });
});
