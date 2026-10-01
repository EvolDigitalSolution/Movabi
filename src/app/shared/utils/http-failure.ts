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
const INTERNAL_LEAK = /stack|\bat\s+[\w.$<>]+\s*\(|\.js:\d+|:\d+:\d+|postgres|postgrest|supabase|\bsql\b|relation\s|column\s|syntax|ECONN|ETIMEDOUT|ENOTFOUND|undefined is not|null is not|SyntaxError|TypeError/i;

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
