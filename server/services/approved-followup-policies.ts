/** Approved P10/P11/P12 policy calculations for the next feature release.
 * These functions classify evidence; they do not suspend, transfer money, reserve budget or waive
 * a fee. Callers must obtain their inputs from scoped server records. Never accept evidence or
 * remaining budget from a customer request. Persistence/integration is tracked separately. */
export interface PolicyScope { tenantId: string; userId: string; market: string; currency: string }
const gb = (scope: PolicyScope) => !!scope.tenantId && !!scope.userId && scope.market === 'GB' && scope.currency === 'GBP';
const validTime = (value: string) => Number.isFinite(Date.parse(value));
export interface SharingObservation {
    tenantId: string; userId: string; observedAt: string; country: string | null; deviceHash: string | null;
    latitude?: number | null; longitude?: number | null;
}
export type SharingSignal = 'two_countries_1h' | 'more_than_two_devices_24h' | 'over_200km_10min';
const coordinates = (o: SharingObservation) => Number.isFinite(o.latitude) && Number.isFinite(o.longitude)
    && Math.abs(o.latitude!) <= 90 && Math.abs(o.longitude!) <= 180;
function km(a: SharingObservation, b: SharingObservation): number {
    const rad = Math.PI / 180;
    const lat = (b.latitude! - a.latitude!) * rad, lon = (b.longitude! - a.longitude!) * rad;
    const h = Math.sin(lat / 2) ** 2 + Math.cos(a.latitude! * rad) * Math.cos(b.latitude! * rad) * Math.sin(lon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
/** P10: signals produce admin review only, never automatic suspension. Country/device/GPS values
 * remain evidence claims; they are not proof of fraud. Boundaries use server observation time. */
export function accountSharingSignals(scope: PolicyScope, observations: SharingObservation[], now: number):
    { signals: SharingSignal[]; action: 'admin_review' | 'none' } {
    if (!gb(scope) || !Number.isFinite(now)) return { signals: [], action: 'none' };
    const recent = observations.filter(o => o.tenantId === scope.tenantId && o.userId === scope.userId
        && validTime(o.observedAt) && Date.parse(o.observedAt) <= now && Date.parse(o.observedAt) >= now - 86_400_000);
    const hour = recent.filter(o => Date.parse(o.observedAt) >= now - 3_600_000);
    const signals: SharingSignal[] = [];
    if (new Set(hour.map(o => o.country).filter(c => c && /^[A-Z]{2}$/.test(c))).size >= 2) signals.push('two_countries_1h');
    if (new Set(recent.map(o => o.deviceHash).filter(Boolean)).size > 2) signals.push('more_than_two_devices_24h');
    const gps = recent.filter(coordinates).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    let jump = false;
    for (let i = 0; i < gps.length && !jump; i++) for (let j = i + 1; j < gps.length; j++) {
        if (Date.parse(gps[j].observedAt) - Date.parse(gps[i].observedAt) > 600_000) break;
        if (km(gps[i], gps[j]) > 200) { jump = true; break; }
    }
    if (jump) signals.push('over_200km_10min');
    return { signals, action: signals.length ? 'admin_review' : 'none' };
}

/** P11 uses the GB calendar: Monday through Sunday in Europe/London, including DST transitions.
 * A week key is a LOCAL calendar date, not a UTC midnight or a fixed 168-hour interval. */
export function gbBonusWeek(value: string): string {
    if (!validTime(value)) throw new Error('Invalid completion timestamp');
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(value));
    const part = (type: string) => Number(parts.find(p => p.type === type)!.value);
    const day = new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
    day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
    return day.toISOString().slice(0, 10);
}
export interface BonusRide {
    id: string; tenantId: string; driverId: string; country: string; currency: string;
    service: string; status: string; completedAt: string | null;
}
export function driverBonusEligibility(scope: PolicyScope, rides: BonusRide[], at: string):
    { week: string; qualifyingRides: number; eligible: boolean; awardMinor: number; weeklyBudgetMinor: number } {
    const week = gbBonusWeek(at);
    const ids = new Set(gb(scope) ? rides.filter(r => r.tenantId === scope.tenantId && r.driverId === scope.userId
        && r.country === 'GB' && r.currency === 'GBP' && r.service === 'ride'
        && ['completed', 'settled'].includes(r.status) && r.completedAt && validTime(r.completedAt)
        && Date.parse(r.completedAt) <= Date.parse(at) && gbBonusWeek(r.completedAt) === week).map(r => r.id) : []);
    return { week, qualifyingRides: ids.size, eligible: ids.size >= 25,
        awardMinor: ids.size >= 25 ? 2000 : 0, weeklyBudgetMinor: 20000 };
}

export const cancellationExemptionReasons = ['driver_late', 'driver_not_moving', 'wrong_vehicle', 'safety'] as const;
export type CancellationExemptionReason = typeof cancellationExemptionReasons[number];
export interface CancellationExemptionEvidence {
    // Derived from server-held timing/location evidence, not customer-provided durations.
    driverLateSeconds?: number | null;
    stationarySeconds?: number | null;
}
/** P12: explicit structured reasons only. Unsupported/missing evidence is reported for review,
 * never fabricated from free text. Safety/wrong-vehicle claims require a review record.
 * The atomic cancellation/quote integration must decide and freeze the resulting fee. */
export function classifyCancellationExemption(scope: PolicyScope, reason: unknown, evidence: CancellationExemptionEvidence):
    'out_of_scope' | 'invalid_reason' | 'evidence_satisfied' | 'evidence_not_satisfied' | 'review_required' {
    if (!gb(scope)) return 'out_of_scope';
    if (!(cancellationExemptionReasons as readonly unknown[]).includes(reason)) return 'invalid_reason';
    if (reason === 'safety' || reason === 'wrong_vehicle') return 'review_required';
    const seconds = reason === 'driver_late' ? evidence.driverLateSeconds : evidence.stationarySeconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return 'review_required';
    return (reason === 'driver_late' ? seconds > 600 : seconds >= 300) ? 'evidence_satisfied' : 'evidence_not_satisfied';
}
