/** Recorded driver money only. Customer totals and platform fees are never earnings. */
export function driverMoneyView(job: unknown): { gross: number | null; net: number | null; deductions: number | null } {
    const raw = job && typeof job === 'object' ? job as Record<string, unknown> : {};
    const b = raw['fare_breakdown'] && typeof raw['fare_breakdown'] === 'object' ? raw['fare_breakdown'] as Record<string,unknown> : {};
    const amount = (value:unknown):number|null => {
        if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
        const n=Number(value);return Number.isFinite(n)&&n>=0?n:null;
    };
    const gross=amount(b['driverBase'] ?? b['serviceFareBeforePlatformFee'] ?? b['driverGrossEarnings']);
    const net=amount(b['driverEntitlement'] ?? b['driverNetEarnings'] ?? raw['driver_payout']);
    const deductions=amount(b['driverCommissionAmount'] ?? b['commissionFee'] ?? b['commissionAmount'] ?? raw['commission_fee']);
    return {gross,net,deductions};
}
