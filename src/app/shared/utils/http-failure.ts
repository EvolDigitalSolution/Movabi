/**
 * Safe, useful customer-facing messages from HTTP failures.
 *
 * Angular's `HttpErrorResponse` does NOT extend `Error`, so the previous
 * `e instanceof Error ? e.message : 'An error occurred'` discarded the server's authoritative
 * message and code -- a 401 `AUTHENTICATION_REQUIRED` surfaced to the customer as the useless
 * "An error occurred". Internal detail is never shown.
 */
export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please sign in again.';

/** Never surface stack traces, SQL/PostgREST detail or internal identifiers. */
const INTERNAL_LEAK = /stack|\bat\s+[\w.$<>]+\s*\(|\.js:\d+|:\d+:\d+|postgres|postgrest|supabase|\bsql\b|relation\s|column\s|syntax|ECONN|ETIMEDOUT|ENOTFOUND|undefined is not|null is not|SyntaxError|TypeError|failed to fetch|network\s*request\s*failed|networkerror|load failed|net::err_|err_internet|err_connection|err_name_not_resolved|cannot read prop|is not a function|is not defined|unexpected token|quotaexceeded|aborterror|invalidstateerror|notallowederror|securityerror|domexception|unknown error/i;

export interface HttpFailure {
  status: number | null;
  code: string | null;
  message: string;
}

const firstSafeText = (values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed && !INTERNAL_LEAK.test(trimmed)) return trimmed;
  }
  return null;
};

export function describeHttpFailure(error: unknown, fallback = 'An error occurred'): HttpFailure {
  const value = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>;
  const status = typeof value['status'] === 'number' ? (value['status'] as number) : null;
  const body = (value['error'] && typeof value['error'] === 'object' ? value['error'] : null) as Record<string, unknown> | null;
  const code = typeof body?.['code'] === 'string'
    ? (body['code'] as string)
    : (typeof value['code'] === 'string' ? (value['code'] as string) : null);

  // An expired/missing session must produce an intentional customer state, not a mystery.
  if (status === 401 || code === 'AUTHENTICATION_REQUIRED') {
    return { status, code: code ?? 'AUTHENTICATION_REQUIRED', message: SESSION_EXPIRED_MESSAGE };
  }

  const serverText = firstSafeText([body?.['error'], body?.['message']]);
  if (serverText) return { status, code, message: serverText };

  // Real Error instances (e.g. the local 'Please sign in again.' guard) keep their message.
  const errorText = error instanceof Error ? firstSafeText([error.message]) : null;
  return { status, code, message: errorText || firstSafeText([value['message']]) || fallback };
}

/**
 * The ONE user-facing string for a failed action.
 *
 * Contract for every Customer/Driver toast, inline error and alert:
 *   * a KNOWN failure maps to safe, intentional copy — an expired session, a
 *     server-authored message, or a domain error we raised ourselves
 *     (e.g. a curated negotiation/authority message);
 *   * anything else — a raw JavaScript Error, network/PostgREST/SQL/Stripe/
 *     internal text — returns the caller's curated `fallback`.
 *
 * Never returns arbitrary technical detail, and never returns `undefined`,
 * `null` or an empty string (the caller's fallback wins instead).
 *
 * The RAW error is intentionally NOT swallowed here: callers keep logging it
 * (console.error/warn) for diagnostics.
 */
export function userFacingError(error: unknown, fallback: string): string {
  const described = describeHttpFailure(error, fallback).message;
  const text = String(described ?? '').trim();
  return text && !INTERNAL_LEAK.test(text) ? text : fallback;
}
