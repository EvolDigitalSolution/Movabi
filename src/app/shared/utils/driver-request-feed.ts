import { Booking } from '../models/booking.model';

export function actionableDriverRequests(jobs: Booking[]): Booking[] {
    return jobs.filter(job => !job.driver_id &&
        ['searching', 'requested', 'broadcasting', 'waiting'].includes(String(job.status)) &&
        ['paid', 'wallet_funded', 'authorized', 'requires_capture', 'succeeded'].includes(String(job.payment_status)));
}

/** Keep a live selection only while its request remains available. */
export function liveRequestSelection(ids: string[], selected: string | null): string | null {
    return selected && ids.includes(selected) ? selected : ids[0] || null;
}

export function driverHasCurrentWork(job: Booking | null, session: { status?: string } | null, recoverableCount: number): boolean {
    return !!(job && !['completed', 'cancelled', 'no_driver_found', 'expired'].includes(String(job.status))) ||
        !!(session && ['driver_claimed', 'negotiating', 'fare_agreed'].includes(String(session.status))) || recoverableCount > 0;
}
