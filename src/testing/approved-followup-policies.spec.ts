import { describe, expect, it } from 'vitest';
import { accountSharingSignals, classifyCancellationExemption, driverBonusEligibility, gbBonusWeek,
    type BonusRide, type SharingObservation } from '../../server/services/approved-followup-policies';

const scope = { tenantId: 'tenant-a', userId: 'driver-a', market: 'GB', currency: 'GBP' };
const at = '2026-11-16T12:00:00Z', now = Date.parse(at);
const observation = (changes: Partial<SharingObservation> = {}): SharingObservation =>
    ({ tenantId: scope.tenantId, userId: scope.userId, observedAt: at, country: 'GB', deviceHash: 'device-a', ...changes });

describe('P10 approved review-only signals', () => {
    it('two countries inside one hour produce review, never suspension', () => {
        expect(accountSharingSignals(scope, [observation(), observation({ country: 'FR', observedAt: '2026-11-16T11:00:00Z' })], now))
            .toEqual({ signals: ['two_countries_1h'], action: 'admin_review' });
    });
    it('country observations older than an hour and future observations do not count', () => {
        expect(accountSharingSignals(scope, [observation(), observation({ country: 'FR', observedAt: '2026-11-16T10:59:59Z' }),
            observation({ country: 'NG', observedAt: '2026-11-16T12:00:01Z' })], now).signals).toEqual([]);
    });
    it('three distinct devices in 24h trigger; repeats, two devices, null and older devices do not', () => {
        const two = [observation(), observation({ deviceHash: 'b' }), observation({ deviceHash: null }), observation()];
        expect(accountSharingSignals(scope, two, now).signals).toEqual([]);
        expect(accountSharingSignals(scope, [...two, observation({ deviceHash: 'c', observedAt: '2026-11-15T12:00:00Z' })], now).signals)
            .toEqual(['more_than_two_devices_24h']);
        expect(accountSharingSignals(scope, [...two, observation({ deviceHash: 'c', observedAt: '2026-11-15T11:59:59Z' })], now).signals).toEqual([]);
    });
    it('over 200 km within ten minutes triggers, an eleven-minute journey does not', () => {
        const london = observation({ latitude: 51.5074, longitude: -0.1278 });
        const manchester = observation({ latitude: 53.4808, longitude: -2.2426, observedAt: '2026-11-16T11:50:00Z' });
        expect(accountSharingSignals(scope, [london, manchester], now).signals).toEqual(['over_200km_10min']);
        expect(accountSharingSignals(scope, [london, { ...manchester, observedAt: '2026-11-16T11:49:59Z' }], now).signals).toEqual([]);
    });
    it('coordinates crossing the date line use the short distance; invalid coordinates are ignored', () => {
        const points = [observation({ latitude: 0, longitude: 179.9 }), observation({ latitude: 0, longitude: -179.9 }),
            observation({ latitude: 95, longitude: 0 })];
        expect(accountSharingSignals(scope, points, now).signals).toEqual([]);
    });
    it('another tenant, another user and non-GB scope cannot contribute signals', () => {
        const rows = [observation(), observation({ tenantId: 'tenant-b', country: 'FR', deviceHash: 'b' }),
            observation({ userId: 'driver-b', country: 'NG', deviceHash: 'c' })];
        expect(accountSharingSignals(scope, rows, now).signals).toEqual([]);
        expect(accountSharingSignals({ ...scope, market: 'NG', currency: 'NGN' }, rows, now).signals).toEqual([]);
    });
});

describe('P11 bonus eligibility (not budget/payment authority)', () => {
    const rides = Array.from({ length: 25 }, (_, i): BonusRide => ({ id: String(i), tenantId: scope.tenantId, driverId: scope.userId,
        country: 'GB', currency: 'GBP', service: 'ride', status: 'completed', completedAt: '2026-11-16T11:00:00Z' }));
    it('25 distinct completed rides qualify for GBP 20, 24 do not; the global weekly cap is GBP 200', () => {
        expect(driverBonusEligibility(scope, rides, at)).toMatchObject({ eligible: true, awardMinor: 2000, weeklyBudgetMinor: 20000 });
        expect(driverBonusEligibility(scope, rides.slice(1), at)).toMatchObject({ eligible: false, awardMinor: 0 });
        expect(driverBonusEligibility(scope, [...rides.slice(1), rides[1]], at).eligible).toBe(false);
    });
    it('cross-tenant/driver/market/currency/service, unfinished, future and previous-week rides are excluded', () => {
        for (const changes of [{ tenantId: 'b' }, { driverId: 'b' }, { country: 'NG' }, { currency: 'NGN' }, { service: 'delivery' },
            { status: 'cancelled' }, { completedAt: null }, { completedAt: '2026-11-17T00:00:00Z' }, { completedAt: '2026-11-15T23:59:59Z' }]) {
            expect(driverBonusEligibility(scope, [...rides.slice(1), { ...rides[0], ...changes }], at).eligible).toBe(false);
        }
        expect(driverBonusEligibility({ ...scope, market: 'NG' }, rides, at).eligible).toBe(false);
    });
    it('uses local Monday boundaries in summer and winter and across both clock changes', () => {
        expect(gbBonusWeek('2026-07-05T22:59:59Z')).toBe('2026-06-29');
        expect(gbBonusWeek('2026-07-05T23:00:00Z')).toBe('2026-07-06');
        expect(gbBonusWeek('2026-11-15T23:59:59Z')).toBe('2026-11-09');
        expect(gbBonusWeek('2026-11-16T00:00:00Z')).toBe('2026-11-16');
        expect(gbBonusWeek('2026-03-29T23:00:00Z')).toBe('2026-03-30');
        expect(gbBonusWeek('2026-10-25T23:00:00Z')).toBe('2026-10-19');
        expect(() => gbBonusWeek('invalid')).toThrow();
    });
});

describe('P12 structured exemption evidence classification', () => {
    it('requires more than ten minutes late and at least five stationary minutes', () => {
        expect(classifyCancellationExemption(scope, 'driver_late', { driverLateSeconds: 600 })).toBe('evidence_not_satisfied');
        expect(classifyCancellationExemption(scope, 'driver_late', { driverLateSeconds: 601 })).toBe('evidence_satisfied');
        expect(classifyCancellationExemption(scope, 'driver_not_moving', { stationarySeconds: 299 })).toBe('evidence_not_satisfied');
        expect(classifyCancellationExemption(scope, 'driver_not_moving', { stationarySeconds: 300 })).toBe('evidence_satisfied');
    });
    it('missing, invalid and unproven evidence requires review; claims never become proven facts', () => {
        for (const seconds of [undefined, null, NaN, Infinity, -1])
            expect(classifyCancellationExemption(scope, 'driver_late', { driverLateSeconds: seconds })).toBe('review_required');
        expect(classifyCancellationExemption(scope, 'safety', {})).toBe('review_required');
        expect(classifyCancellationExemption(scope, 'wrong_vehicle', {})).toBe('review_required');
    });
    it('free-text reasons never select an exemption, and other regions are unchanged', () => {
        expect(classifyCancellationExemption(scope, 'The driver was late', { driverLateSeconds: 700 })).toBe('invalid_reason');
        expect(classifyCancellationExemption({ ...scope, market: 'NG', currency: 'NGN' }, 'safety', {})).toBe('out_of_scope');
    });
});
