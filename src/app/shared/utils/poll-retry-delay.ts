/** Respect numeric or HTTP-date Retry-After values; never shorten the server pause. */
export function pollRetryDelay(error: any, now = Date.now()): number {
 const raw=String(error?.headers?.get?.('Retry-After') || '').trim();
 const seconds=raw ? Number(raw) : NaN;
 const date=raw ? Date.parse(raw) : NaN;
 const requested=Number.isFinite(seconds)&&seconds>=0 ? seconds*1000 : Number.isFinite(date)?Math.max(0,date-now):0;
 return Math.max(error?.status===429?60000:10000,requested);
}
