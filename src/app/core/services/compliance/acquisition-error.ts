/**
 * Batch 2C Phase B — the acquisition error contract.
 *
 * Reserved SQLSTATEs, distinct and never interchangeable:
 *   MB001 -> DRIVER_BUSY       the driver already owns an occupying job (N12)
 *   MB002 -> DRIVER_NOT_ELIGIBLE  the driver is not compliance-eligible
 *
 * MB002 carries requirement CODES only. Compliance documents, admin notes and
 * reviewer identity never travel through an acquisition error, so nothing here
 * renders or forwards them.
 *
 * Every acquisition path uses this mapper so a compliance rejection can never be
 * reported as "busy", as "already accepted", or as a false success.
 */

export const DRIVER_BUSY_SQLSTATE = 'MB001';
export const DRIVER_NOT_ELIGIBLE_SQLSTATE = 'MB002';
export const DRIVER_BUSY_CODE = 'DRIVER_BUSY';
export const DRIVER_NOT_ELIGIBLE_CODE = 'DRIVER_NOT_ELIGIBLE';

export interface AcquisitionFailure {
    /** Machine-readable application code. */
    code: string;
    /** User-facing message for this specific failure. */
    message: string;
    /** Requirement codes reported by the database. Codes only. */
    blockingCodes: string[];
    /** The reserved SQLSTATE that produced this failure. */
    sqlState: string;
}

/** A blocking code is a lowercase dotted requirement code and nothing else. */
const BLOCKING_CODE = /^[a-z][a-z0-9_.]*$/;

/**
 * Normalise a Supabase/PostgREST/RPC error into the acquisition contract.
 * Returns null when the error is not one of the reserved acquisition failures.
 */
export function mapAcquisitionError(error: unknown): AcquisitionFailure | null {
    const candidate = error as { code?: unknown; details?: unknown; message?: unknown } | null | undefined;
    if (!candidate) return null;

    const sqlState = String(candidate.code ?? '');
    if (sqlState !== DRIVER_NOT_ELIGIBLE_SQLSTATE && sqlState !== DRIVER_BUSY_SQLSTATE) return null;

    if (sqlState === DRIVER_BUSY_SQLSTATE) {
        return {
            code: DRIVER_BUSY_CODE,
            message: 'You already have an active job. Finish or release it before accepting another.',
            blockingCodes: [],
            sqlState
        };
    }

    const reported = String(candidate.details ?? candidate.message ?? '')
        .split(',')
        .map(value => value.trim())
        .filter(value => BLOCKING_CODE.test(value));

    return {
        code: DRIVER_NOT_ELIGIBLE_CODE,
        message: 'You are not eligible for this service yet. Complete the outstanding requirements and try again.',
        blockingCodes: reported,
        sqlState
    };
}

/** True only for the compliance rejection. Never true for busy or generic errors. */
export function isDriverNotEligibleError(error: unknown): boolean {
    return mapAcquisitionError(error)?.code === DRIVER_NOT_ELIGIBLE_CODE;
}

/** True only for the N12 busy rejection. */
export function isDriverBusyError(error: unknown): boolean {
    return mapAcquisitionError(error)?.code === DRIVER_BUSY_CODE;
}

/**
 * Message for a failed acquisition: the specific contract message when the error
 * is a reserved acquisition failure, otherwise the caller's own fallback. The
 * fallback is never silently replaced by a success.
 */
export function acquisitionErrorMessage(error: unknown, fallback: string): string {
    return mapAcquisitionError(error)?.message ?? fallback;
}
