/** Currency formatting never changes the value. Conversion must be explicit. */
export function currencyDecimals(currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('An explicit currency is required');
  return new Intl.NumberFormat('en', {style:'currency',currency}).resolvedOptions().maximumFractionDigits!;
}
export function toCurrencyMinor(major: number,currency: string): number {
  if (!Number.isFinite(major) || major<0) throw new Error('Invalid monetary amount');
  const scaled=major*Math.pow(10,currencyDecimals(currency));
  const rounded=Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled-rounded)>0.000001)
    throw new Error('Amount exceeds currency precision or safe integer range');
  return rounded;
}
export function formatCurrencyValue(amount: number,currency: string,locale='en'): string {
  if (!Number.isFinite(amount)) throw new Error('Invalid monetary amount');
  return new Intl.NumberFormat(locale,{style:'currency',currency}).format(amount);
}
