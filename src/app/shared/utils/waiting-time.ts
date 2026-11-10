/** Friendly countdown text; the server deadline, not this display, controls eligibility. */
export function formatWaitingTime(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return 'Checking arrival time...';
    const seconds = Math.max(0, Math.ceil(value));
    if (seconds === 0) return 'Waiting period ended';
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    if (minutes === 0) return `${remainder} sec`;
    return remainder === 0 ? `${minutes} min` : `${minutes} min ${remainder} sec`;
}
