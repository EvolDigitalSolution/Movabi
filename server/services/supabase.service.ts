import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

let _supabaseAdmin: SupabaseClient | null = null;

export const getSupabaseAdmin = (): SupabaseClient => {
  if (!_supabaseAdmin) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in environment variables.');
    }

    _supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }
  return _supabaseAdmin;
};

// For backward compatibility, export a proxy that lazily initializes the client
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get: (target, prop) => {
    const client = getSupabaseAdmin();
    const value = (client as any)[prop];
    if (typeof value === 'function') {
      return value.bind(client);
    }
    return value;
  }
});

/**
 * Resolve the EXTERNALLY reachable Supabase base URL used ONLY for the
 * server-side registration `auth.signUp()` request, so email-confirmation links
 * use a public hostname instead of the private Kong hostname.
 *
 * Precedence:
 *   1. API_EXTERNAL_URL  (explicit public Supabase endpoint)
 *   2. MOVABI_SUPABASE_DOMAIN  (public Supabase domain, converted to https)
 *   3. SUPABASE_URL  (only in non-production, where it is the public URL)
 *
 * In production, if no external URL is available this THROWS rather than
 * silently emitting confirmation links with the private Kong hostname.
 */
export function resolveExternalSupabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.API_EXTERNAL_URL;
  if (explicit && /^https?:\/\//i.test(explicit)) return explicit;

  const domain = env.MOVABI_SUPABASE_DOMAIN;
  if (domain) {
    const host = String(domain).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (host) return `https://${host}`;
  }

  if (env.NODE_ENV !== 'production') {
    const url = env.SUPABASE_URL;
    if (url) return url;
  }

  throw new Error('API_EXTERNAL_URL (or MOVABI_SUPABASE_DOMAIN) is required to generate external confirmation links.');
}

let _authRegistrationClient: SupabaseClient | null = null;

/**
 * Narrowly scoped Supabase Auth client for the server-side registration
 * signUp() call. It targets the externally reachable Supabase endpoint while
 * the normal `supabaseAdmin` continues to use the internal SUPABASE_URL for
 * ordinary DB/service operations.
 */
export const getSupabaseAuthRegistrationClient = (): SupabaseClient => {
  if (!_authRegistrationClient) {
    const supabaseUrl = resolveExternalSupabaseUrl();
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseServiceKey) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY is required in environment variables.');
    }
    _authRegistrationClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }
  return _authRegistrationClient;
};
