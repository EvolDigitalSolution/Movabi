/** Recorded ledger money; never uses the user's selected country or display currency. */
export type EarningsMetric = 'paid' | 'pending' | 'failed' | 'fees' | 'review';
export function recordedCurrency(row: any): string | null {
  const value = String(row?.currency_code || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : null;
}
function digits(currency: string): number {
  return new Intl.NumberFormat('en-GB', {style: 'currency', currency}).resolvedOptions().maximumFractionDigits!;
}
function minor(value: unknown, currency: string): bigint | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const places = digits(currency), negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  if (/[1-9]/.test(fraction.slice(places))) return null;
  const result = BigInt(whole) * (10n ** BigInt(places)) + BigInt(fraction.slice(0, places).padEnd(places, '0') || '0');
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return negative ? -result : result;
}
function formatted(amount: bigint, currency: string): string {
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < -BigInt(Number.MAX_SAFE_INTEGER)) return currency + ' amount unavailable';
  return new Intl.NumberFormat('en-GB', {style: 'currency', currency, currencyDisplay: 'code'}).format(Number(amount) / 10 ** digits(currency));
}
export function recordedEarningAmount(row: any, value: unknown = row?.amount): string {
  const currency = recordedCurrency(row);
  if (!currency) return 'Currency unavailable';
  const amount = minor(value, currency);
  return amount === null ? currency + ' amount unavailable' : formatted(amount, currency);
}
function fee(row: any, currency: string): bigint | null {
  const gross = minor(row?.gross_amount, currency), net = minor(row?.amount, currency);
  if (gross !== null && net !== null && gross >= net && net >= 0n) return gross - net;
  return minor(row?.platform_fee ?? row?.commission_fee, currency);
}
export function recordedFeeAmount(row: any): string {
  const currency = recordedCurrency(row);
  if (!currency) return 'Currency unavailable';
  const amount = fee(row, currency);
  return amount === null ? currency + ' amount unavailable' : formatted(amount, currency);
}
export function recordedGrossAmount(row: any): string {
  const currency = recordedCurrency(row);
  if (!currency) return 'Currency unavailable';
  const explicit = minor(row?.gross_amount, currency);
  if (explicit !== null) return formatted(explicit, currency);
  const net = minor(row?.amount, currency), deductions = fee(row, currency);
  return net === null || deductions === null ? currency + ' amount unavailable' : formatted(net + deductions, currency);
}
export function earningsSummary(rows: readonly any[], metric: EarningsMetric): string {
  const groups = new Map<string, {sum: bigint; valid: boolean}>();
  let missing = 0;
  for (const row of rows) {
    const status=String(row?.status || '').toLowerCase();
    const applies = metric === 'fees' || (metric==='pending' ? ['pending','processing','queued','claimed'].includes(status) : metric==='review' ? ['unknown','requires_review','review'].includes(status) : status===metric);
    const currency = recordedCurrency(row);
    if (!currency) { if (applies) missing++; continue; }
    const group = groups.get(currency) || {sum: 0n, valid: true};
    groups.set(currency, group);
    if (!applies) continue;
    const amount = metric === 'fees' ? fee(row, currency) : minor(row?.amount, currency);
    if (amount === null) group.valid = false;
    else group.sum += amount;
  }
  const parts = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([currency, group]) =>
    group.valid ? formatted(group.sum, currency) : currency + ' amount unavailable');
  if (missing) parts.push('Currency unavailable (' + missing + ' records)');
  return parts.join(' · ') || 'No recorded earnings';
}
export function recordedPayoutLabel(row: any): string {
  const status = String(row?.status || '').toLowerCase();
  if (status === 'failed') return 'Payout failed';
  if (row?.stripe_transfer_id) return 'Transferred to Stripe account';
  if (status === 'paid') return 'Paid (recorded)';
  if (['pending','processing','queued','claimed'].includes(status)) return 'Pending payout';
  if (['unknown','requires_review','review'].includes(status)) return 'Payout needs reconciliation';
  return 'Payout status unavailable';
}
