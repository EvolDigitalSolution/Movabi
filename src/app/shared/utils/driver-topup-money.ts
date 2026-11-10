export function driverTopupMinor(text: string, exponent: number): number {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 3) throw Error('Currency unavailable');
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(text.trim());
  if (!match || (match[2]?.length ?? 0) > exponent) throw Error('Enter an amount with at most ' + exponent + ' decimal places.');
  const minor = BigInt(match[1]) * 10n ** BigInt(exponent) + BigInt((match[2] ?? '').padEnd(exponent, '0') || '0');
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Enter a smaller positive amount.');
  return Number(minor);
}
export function driverTopupMoney(minor: number, currency: string, exponent: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0 || !Number.isInteger(exponent) || exponent < 0 || exponent > 3) throw Error('Invalid quote');
  const text = String(minor).padStart(exponent + 1, '0');
  return currency + ' ' + (exponent ? text.slice(0, -exponent) + '.' + text.slice(-exponent) : text);
}
