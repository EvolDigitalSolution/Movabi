/**
 * Customer-facing copy for authoritative market rejections.
 *
 * The server returns a machine-readable `code` alongside a human message. The client used
 * to discard the code and let the caller replace everything with a single generic fare
 * message, so a market rejection ("we cannot price in this area") was indistinguishable
 * from a genuine pricing/network failure. Codes are preserved here and mapped to truthful
 * states; unknown failures still fall back safely.
 */
export type MarketFailureCode =
  | 'MARKET_LOCATION_UNRESOLVED'
  | 'MARKET_COMING_SOON'
  | 'MARKET_NOT_CONFIGURED'
  | 'MARKET_PAUSED'
  | 'MARKET_CAPABILITY_DISABLED';

export const MARKET_FAILURE_COPY: Record<MarketFailureCode, string> = {
  MARKET_LOCATION_UNRESOLVED: 'We need a valid pickup location to check prices in your area.',
  MARKET_COMING_SOON: "Movabi isn't available in this area yet.",
  MARKET_NOT_CONFIGURED: "Movabi isn't available in this area yet.",
  MARKET_PAUSED: 'Movabi is temporarily unavailable in this area. Please try again later.',
  MARKET_CAPABILITY_DISABLED: 'Price estimates are temporarily unavailable in this area.'
};

/** Safe fallback for anything that is not a recognised, customer-safe market rejection. */
export const MARKET_FAILURE_GENERIC = 'Movabi is not available in this area yet.';

export class MarketAvailabilityFailure extends Error {
  constructor(public readonly code: string | null, message: string) {
    super(message);
    this.name = 'MarketAvailabilityFailure';
  }
}

export function isMarketFailureCode(value: unknown): value is MarketFailureCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MARKET_FAILURE_COPY, value);
}

/**
 * Never surface stack traces, database/PostgREST detail or internal identifiers: an
 * unrecognised server message is only echoed when it looks like ordinary customer copy.
 * The stack-frame pattern must tolerate `Object.<anonymous>` style frames and file:line.
 */
const INTERNAL_LEAK = /stack|\bat\s+[\w.$<>]+\s*\(|\.js:\d+|:\d+:\d+|postgres|postgrest|supabase|\bsql\b|relation\s|column\s|syntax|ECONN|ETIMEDOUT|ENOTFOUND|undefined is not|null is not|SyntaxError|TypeError/i;

export function marketFailureMessage(code: unknown, serverMessage?: unknown): string {
  if (isMarketFailureCode(code)) return MARKET_FAILURE_COPY[code];
  const text = typeof serverMessage === 'string' ? serverMessage.trim() : '';
  if (text && !INTERNAL_LEAK.test(text)) return text;
  return MARKET_FAILURE_GENERIC;
}

/** Extracts a market rejection from any thrown value, or null when it is not one. */
export function describeMarketFailure(error: unknown): { code: string | null; message: string } | null {
  if (error instanceof MarketAvailabilityFailure) return { code: error.code, message: error.message };
  const value = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>;
  const nested = (value['error'] && typeof value['error'] === 'object' ? value['error'] : null) as Record<string, unknown> | null;
  const code = (typeof value['code'] === 'string' ? value['code'] : nested && typeof nested['code'] === 'string' ? nested['code'] : null) as string | null;
  if (!code) return null;
  const message = nested && typeof nested['message'] === 'string' ? nested['message'] : value['message'];
  return { code, message: marketFailureMessage(code, message) };
}
